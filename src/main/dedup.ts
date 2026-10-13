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
 * **实现已收敛到 `shared/volumeKey.ts`** —— 原先 `renderer/store.ts` 里手抄了
 * 一份一模一样的实现，靠注释提醒"保持一致"，迟早会漂移（改一处忘一处，
 * 就会出现"清单去重判为重复、但落盘时又当成两份"的诡异现象）。
 * 现在主进程与渲染层共用同一份纯函数。这里 re-export 以保持既有导入路径不变
 * （`scripts/verify-dedup.mjs` 也从这里取）。
 */
import { normalizeCopyName } from '@shared/volumeKey';
import { fmtBytes } from '@shared/bytes';

export { normalizeCopyName };

/**
 * 由一组文件名 + 各自大小构建分卷指纹（按文件名排序，保证可比）。
 *
 * 命名修复 ⑥：本函数原先叫 `buildFingerprint`，与 `workflows.ts` 的同名导出
 * 撞名（那个返回 `string` 的"体积|签名"指纹，本函数返回 `VolumeFingerprint`）。
 * 两者语义完全不同，同仓两个同名导出极易在维护/重构时张冠李戴，故改名为
 * `fingerprintVolumeSet`（调用点仅本文件内部）。
 */
export function fingerprintVolumeSet(
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
      const fp = fingerprintVolumeSet(p.files, sizeOf);
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
            reason: `同名且 ${c.fp.count} 个分卷逐一大小相同（合计 ${fmtBytes(c.fp.total)}）`
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
            ? `同名且 ${c.fp.count} 个分卷逐一大小相同（合计 ${fmtBytes(c.fp.total)}）`
            : `同名且大小完全相同（${fmtBytes(c.fp.total)}）`
      });
      droppedIds.push(...drop.map((x) => x.id));
    }
  }

  return { groups, conflicts, droppedIds };
}

/* 体积格式化统一走 `@shared/bytes`（原本地 fmtSize 已收敛）。 */
