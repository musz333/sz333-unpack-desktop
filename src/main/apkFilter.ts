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
import { logger } from './logger';
import { fmtBytes } from '@shared/bytes';

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

/**
 * 单遍遍历：同时收集 .apk 列表与目录总字节数。
 *
 * 修复 P1-5：旧实现是 `collectApks()` + `totalBytes()` **各自完整遍历一遍**，
 * 对十万级条目的产物目录等于双倍开销。这里合并为一次遍历。
 */
async function scanTree(root: string): Promise<{ apks: ApkEntry[]; total: number }> {
  const apks: ApkEntry[] = [];
  let total = 0;
  // 修复 ②：改用 fs.promises —— 十万级产物的目录同步递归会冻结主进程事件循环
  // （同项目 dirStats 已异步化，这里保持口径一致）。
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (e) {
      logger.debug(`读取目录失败（跳过）：${d} -> ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      let size = 0;
      try {
        size = (await fs.promises.stat(p)).size;
      } catch {
        /* 取不到大小按 0 算，apk 仍然会被剔除 */
      }
      total += size;
      if (/\.apk$/i.test(e.name)) apks.push({ file: p, size });
    }
  };
  await walk(root);
  return { apks, total };
}

export interface ApkFilterOptions {
  /**
   * 是否允许"删除整份产物"。
   *   · 未指定 / true → 允许（默认，保持既有行为：自建目录可以整包删）
   *   · false         → 禁止递归删除目录，降级为"仅剔除 apk"
   *                     （用于**用户指定的输出目录**，见修复 P1-6）
   */
  allowDropWholeDir?: boolean;
}

/**
 * 执行 APK 过滤。
 *
 * @param outDir     解压产物目录
 * @param threshold  占比阈值（百分比，0-100）。单个 apk 占比 ≥ 此值 → 删整包
 * @param opts       allowDropWholeDir：是否允许删除整份产物（用户指定目录应传 false）
 * @returns          处理结果（含给用户看的说明行）
 */
export async function filterApks(outDir: string, threshold = 70, opts: ApkFilterOptions = {}): Promise<ApkFilterResult> {
  const allowDropWholeDir = opts.allowDropWholeDir !== false;
  const res: ApkFilterResult = {
    apkRemoved: 0,
    apkBytes: 0,
    wholePackageDropped: false,
    dropRatio: 0,
    dropApk: '',
    log: []
  };

  if (!fs.existsSync(outDir)) return res;

  const scan = await scanTree(outDir);
  const apks = scan.apks;
  if (!apks.length) return res;

  // 占比基准用"剔除前"的总量，这样"这个包是不是个 apk 壳"才判得准
  const before = scan.total;

  // 找出最大的那个 apk，判断它是不是占了整包的绝对大头
  const biggest = apks.reduce((a, b) => (b.size > a.size ? b : a), apks[0]);
  const ratio = before > 0 ? (biggest.size / before) * 100 : 0;

  const safeThreshold = Math.max(1, Math.min(100, threshold));

  if (ratio >= safeThreshold && allowDropWholeDir) {
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
      await fs.promises.rm(outDir, { recursive: true, force: true });
      await fs.promises.mkdir(outDir, { recursive: true });
    } catch (e) {
      logger.warn(`APK 整包删除失败（产物已保留）：${e instanceof Error ? e.message : String(e)}`);
    }
    return res;
  }

  /* 达到阈值但**不允许删整目录**（用户指定目录）→ 降级为仅剔除 apk，并如实说明。
   * 修复 P1-6：旧实现无论 outDir 来自哪里都直接 `rmSync(outDir, {recursive:true})`，
   * 当 outDir 是用户自己的目录时会把目录里的**无关文件一并删掉**。 */
  if (ratio >= safeThreshold && !allowDropWholeDir) {
    res.log.push(
      `APK 过滤：${path.basename(biggest.file)} 占整包 ${ratio.toFixed(1)}%（阈值 ${safeThreshold}%），` +
        `但输出目录是你指定的目录，已跳过「删除整份产物」（仅剔除 apk，其余内容保留）`
    );
  }

  // 只是顺带剔掉 apk，其他内容原样保留
  for (const a of apks) {
    try {
      await fs.promises.rm(a.file, { force: true });
      res.apkRemoved += 1;
      res.apkBytes += a.size;
    } catch (e) {
      logger.warn(`剔除 apk 失败（已跳过）：${a.file} -> ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (res.apkRemoved > 0) {
    res.log.push(
      `APK 过滤：剔除 ${res.apkRemoved} 个 apk（共 ${fmtBytes(res.apkBytes)}）` +
        `，最大一个占整包 ${ratio.toFixed(1)}%（未达 ${safeThreshold}% 阈值，其余内容保留）`
    );
  }
  return res;
}
