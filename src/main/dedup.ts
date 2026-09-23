/**
 * 重复包剔除引擎
 *
 * 判定基础：**不读内容哈希**。
 *   用户场景是几十 GB 级资源包，算一次 SHA 要读完全部字节（机械盘可能几十分钟），
 *   为了去重让用户等，不可接受。所以只用 stat 就能拿到的信息：
 *     ① 原始包名（去掉 " (1)" / " - 副本" 这类复制后缀后）
 *     ② 整套分卷的**逐个分卷大小序列**（这是很强的指纹：总量相同但分卷切法不同的概率极低）
 *     ③ 分卷数
 *
 * 分级判定：
 *   - 同名 + 分卷数相同 + 每个分卷大小逐一相同  → 确定重复（confidence: exact）
 *   - 同名 + 总分大小相同                        → 高度重复（confidence: high）
 *   - 规范化名相同 + 大小不同                    → 同名但不同内容（conflict，两份都留）
 *
 * 重要：剔除只作用于**待处理清单**，绝不触碰硬盘文件。
 */

export interface VolumeFingerprint {
  /** 分卷数 */
  count: number;
  /** 逐分卷字节数（按文件名排序后） */
  sizes: number[];
  /** 总字节 */
  total: number;
}

export type DupConfidence = 'exact' | 'high';

export interface PackLike {
  id: string;
  primary: string;
  files: string[];
  size: number;
  name?: string;
}

export interface DupGroup {
  /** 规范化后的包名（分组依据） */
  key: string;
  /** 保留的那一份 */
  keep: string;
  /** 被剔除的若干份 */
  drop: string[];
  confidence: DupConfidence;
  /** 用于界面展示的依据说明 */
  reason: string;
}

export interface DedupResult {
  groups: DupGroup[];
  /** 同名但大小不同（无法判定为重复，两份都保留） */
  conflicts: { key: string; ids: string[]; sizes: number[] }[];
  droppedIds: string[];
}

/**
 * 规范化包名：得到用于"同一份内容"比对的 key
 *
 * 顺序很重要（这里踩过坑）：
 *   ① **先**剥掉分卷尾号与压缩格式后缀 —— 否则 "已存在 (1).part1.7z" 与
 *      "已存在.part1.7z" 会得到不同的 key，导致重复判不出来
 *   ② **再**剥掉复制后缀 " (1)" / "（2）" / " - 副本" / " copy"
 *   ③ 最后统一小写
 */
export function normalizeCopyName(name: string): string {
  // ① 去分卷号与压缩格式后缀（反复剥，直到稳定）
  let s = name;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
    s = s.replace(/\.(7z|zip|rar|tar|gz|tgz|bz2|xz|cab)$/i, '');
    if (s === before) break;
  }

  // ② 去复制后缀
  //    注意：只处理"带括号/分隔符的副本标记"。像 RX-4114 这种以数字结尾的
  //    正常包名不能被吃掉尾号（否则 "RX-4114 (1)" 与 "RX-4114" 都被归一成 "rx"，
  //    会让所有同前缀的包互相误判为重复）。
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[\s_-]*[(（]\s*\d+\s*[)）]$/, '');
    s = s.replace(/[\s_-]+(?:副本|复制|copy|copia)$/i, '');
    s = s.replace(/[\s_-]+copy\d*$/i, '');
    // 浏览器"另存为"产生的单位数后缀，如 foo_1 / foo-2（两位数以上视为不同包名，不动）
    s = s.replace(/[_-]+[1-9]$/, '');
  }
  // 去掉剥完后残留的分隔符
  s = s.replace(/[\s_-]+$/, '');

  return s.trim().toLowerCase();
}

/** 去掉分卷尾号与压缩格式后缀，得到"这一套"的基名 */
export function volumeBase(fileName: string): string {
  let s = fileName;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
    s = s.replace(/\.(7z|zip|rar|tar|gz|tgz|bz2|xz|cab)$/i, '');
    if (s === before) break;
  }
  return s;
}

/** 由一组文件名 + 各自大小构建分卷指纹（按文件名排序，保证可比） */
export function buildFingerprint(
  files: string[],
  sizeOf: (path: string) => number
): VolumeFingerprint {
  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'zh'));
  const sizes = sorted.map((f) => {
    const n = sizeOf(f);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  return {
    count: sorted.length,
    sizes,
    total: sizes.reduce((a, b) => a + b, 0)
  };
}

function sameSizes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 在给定的包列表里找出重复项
 * @param packs     待检查的包（同一批次）
 * @param sizeOf    取文件大小的函数（主进程传 fs.statSync，渲染层传缓存值）
 */
export function findDuplicates(
  packs: PackLike[],
  sizeOf: (path: string) => number
): DedupResult {
  const groups: DupGroup[] = [];
  const conflicts: { key: string; ids: string[]; sizes: number[] }[] = [];
  const droppedIds: string[] = [];

  // 按"规范化包名"归并
  const byKey = new Map<string, PackLike[]>();
  for (const p of packs) {
    const key = normalizeCopyName(p.name ?? p.primary);
    const arr = byKey.get(key) ?? [];
    arr.push(p);
    byKey.set(key, arr);
  }

  for (const [key, members] of byKey) {
    if (members.length < 2) continue;

    // 先把成员按指纹分组：指纹完全一致 = 同一份内容
    const clusters: { fp: VolumeFingerprint; packs: PackLike[] }[] = [];
    for (const p of members) {
      const fp = buildFingerprint(p.files, sizeOf);
      const hit = clusters.find((c) => sameSizes(c.fp.sizes, fp.sizes) && c.fp.count === fp.count);
      if (hit) hit.packs.push(p);
      else clusters.push({ fp, packs: [p] });
    }

    // 有多个簇 → 存在"同名但内容不同"的情况
    if (clusters.length > 1) {
      // 簇内若有 >=2 份，仍然是确定重复（同名同分卷大小）
      for (const c of clusters) {
        if (c.packs.length >= 2) {
          const [keep, ...drop] = c.packs;
          groups.push({
            key,
            keep: keep.id,
            drop: drop.map((x) => x.id),
            confidence: 'exact',
            reason: `同名且 ${c.fp.count} 个分卷逐一大小相同（合计 ${fmtSize(c.fp.total)}）`
          });
          droppedIds.push(...drop.map((x) => x.id));
        }
      }
      // 不同簇之间：同名但大小不同 → 冲突，都保留
      conflicts.push({
        key,
        ids: clusters.map((c) => c.packs[0].id),
        sizes: clusters.map((c) => c.fp.total)
      });
      continue;
    }

    // 只有一个簇 → 全是同名同大小
    const c = clusters[0];
    if (c.packs.length >= 2) {
      const [keep, ...drop] = c.packs;
      groups.push({
        key,
        keep: keep.id,
        drop: drop.map((x) => x.id),
        confidence: 'exact',
        reason:
          c.fp.count > 1
            ? `同名且 ${c.fp.count} 个分卷逐一大小相同（合计 ${fmtSize(c.fp.total)}）`
            : `同名且大小完全相同（${fmtSize(c.fp.total)}）`
      });
      droppedIds.push(...drop.map((x) => x.id));
    }
  }

  return { groups, conflicts, droppedIds };
}

/** 跨批次检测：新包是否与清单里已有的包重复 */
export function findCrossBatchDuplicates(
  existing: PackLike[],
  incoming: PackLike[],
  sizeOf: (path: string) => number
): DedupResult {
  const groups: DupGroup[] = [];
  const conflicts: { key: string; ids: string[]; sizes: number[] }[] = [];
  const droppedIds: string[] = [];

  for (const np of incoming) {
    const nKey = normalizeCopyName(np.name ?? np.primary);
    const nFp = buildFingerprint(np.files, sizeOf);

    const match = existing.find((ep) => {
      if (normalizeCopyName(ep.name ?? ep.primary) !== nKey) return false;
      const eFp = buildFingerprint(ep.files, sizeOf);
      return eFp.count === nFp.count && sameSizes(eFp.sizes, nFp.sizes);
    });

    if (match) {
      groups.push({
        key: nKey,
        keep: match.id,
        drop: [np.id],
        confidence: 'exact',
        reason: `与清单中已有的一份完全相同（${fmtSize(nFp.total)}，${nFp.count} 个分卷）`
      });
      droppedIds.push(np.id);
      continue;
    }

    // 同名但大小不同 → 冲突
    const sameName = existing.find((ep) => normalizeCopyName(ep.name ?? ep.primary) === nKey);
    if (sameName) {
      const eFp = buildFingerprint(sameName.files, sizeOf);
      conflicts.push({ key: nKey, ids: [sameName.id, np.id], sizes: [eFp.total, nFp.total] });
    }
  }

  return { groups, conflicts, droppedIds };
}

export function fmtSize(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
