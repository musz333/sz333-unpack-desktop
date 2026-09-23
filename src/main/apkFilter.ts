/**
 * APK 过滤（用户要求）
 *
 * 背景：这类资源包里经常塞了一个巨大的 .apk（安卓安装包），对 PC 用户毫无用处，
 * 却占了整包 90%+ 的体积。留着它：
 *   - 白白占磁盘
 *   - 让"解压完成"的体积统计看起来很大、实际有用内容很小
 *
 * 两条规则（用户指定）：
 *  ① 解压产物里的 .apk 一律剔除；
 *  ② 若**单个 apk** 的体积占"整个包解出来的总量"达到阈值（默认 70%，可调），
 *     判定这个包本质上就是个 apk 壳 → 连整份产物一起删掉，不留空壳。
 *
 * 注意：这里删的是**解压产物**，不是用户的源压缩包 —— 源包的去留由
 * sourcePolicy 单独决定，两者互不影响。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ApkFilterResult {
  /** 被删掉的 apk 文件数 */
  apkRemoved: number;
  /** 被删掉的 apk 总体积 */
  apkBytes: number;
  /** 是否因为某个 apk 占比过高而删掉了整份产物 */
  wholePackageDropped: boolean;
  /** 触发整包删除时，那个 apk 的占比（0-100） */
  dropRatio: number;
  /** 触发整包删除时，那个 apk 的名字 */
  dropApk: string;
  /** 给用户看的说明行 */
  log: string[];
}

interface ApkEntry {
  file: string;
  size: number;
}

/** 递归收集目录下所有 .apk 文件 */
function collectApks(root: string): ApkEntry[] {
  const out: ApkEntry[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.apk$/i.test(e.name)) continue;
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {
        /* 取不到大小按 0 算，仍然会被剔除 */
      }
      out.push({ file: p, size });
    }
  };
  walk(root);
  return out;
}

/** 目录总字节数 */
function totalBytes(root: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return total;
}

/**
 * 执行 APK 过滤。
 *
 * @param outDir     解压产物目录
 * @param threshold  占比阈值（百分比，0-100）。单个 apk 占比 ≥ 此值 → 删整包
 * @returns          处理结果（含给用户看的说明行）
 */
export function filterApks(outDir: string, threshold = 70): ApkFilterResult {
  const res: ApkFilterResult = {
    apkRemoved: 0,
    apkBytes: 0,
    wholePackageDropped: false,
    dropRatio: 0,
    dropApk: '',
    log: []
  };

  if (!fs.existsSync(outDir)) return res;

  const apks = collectApks(outDir);
  if (!apks.length) return res;

  // 占比基准用"剔除前"的总量，这样"这个包是不是个 apk 壳"才判得准
  const before = totalBytes(outDir);

  // 找出最大的那个 apk，判断它是不是占了整包的绝对大头
  const biggest = apks.reduce((a, b) => (b.size > a.size ? b : a), apks[0]);
  const ratio = before > 0 ? (biggest.size / before) * 100 : 0;

  const safeThreshold = Math.max(1, Math.min(100, threshold));

  if (ratio >= safeThreshold) {
    // 整包就是个 apk 壳 → 连产物一起删
    res.dropRatio = ratio;
    res.dropApk = path.basename(biggest.file);
    res.apkRemoved = apks.length;
    res.apkBytes = apks.reduce((s, a) => s + a.size, 0);
    res.wholePackageDropped = true;
    res.log.push(
      `APK 过滤：${res.dropApk} 占整包 ${ratio.toFixed(1)}%（阈值 ${safeThreshold}%）` +
        ` → 判定为 apk 壳，已删除整份解压产物`
    );
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
    } catch {
      /* 删不掉就保留，用户至少还能看到内容 */
    }
    return res;
  }

  // 只是顺带剔掉 apk，其他内容原样保留
  for (const a of apks) {
    try {
      fs.rmSync(a.file, { force: true });
      res.apkRemoved += 1;
      res.apkBytes += a.size;
    } catch {
      /* 被占用就跳过 */
    }
  }

  if (res.apkRemoved > 0) {
    res.log.push(
      `APK 过滤：剔除 ${res.apkRemoved} 个 apk（共 ${formatBytes(res.apkBytes)}）` +
        `，最大一个占整包 ${ratio.toFixed(1)}%（未达 ${safeThreshold}% 阈值，其余内容保留）`
    );
  }
  return res;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
