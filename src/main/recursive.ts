/**
 * 递归解压（多层套娃 + 伪装扩展名）
 *
 * 背景：该工具的目标资源里大量存在"层层套娃"的包 —— 外层 .rar 解出一个
 * 伪装成 .JPG 的文件，它其实是个 rar；解出来又是 .zip，里面才是真内容。
 * 以前执行器只解第一层就停了，用户看到"到 jpg 就不动了"。
 *
 * 本模块负责决定：**下一层该解哪个文件**。
 * 判定顺序（用户指定：魔数识别为主，优先工作流匹配）：
 *   ① 优先按已记录的工作流链路（如果卡片里记了这一层该怎么走）
 *   ② 否则按文件头魔数嗅探真实格式 —— 不看扩展名，所以 .jpg 里的 rar 也能认出来
 *   ③ 扩展名只作为魔数失败时的补充线索
 *
 * 边界（用户指定）：
 *   - 最大深度 16 层
 *   - 中间压缩包解完即删，只留最终内容
 *   - 无进展即停（解完没产出新文件就停）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveFormat } from '@shared/types';
import { sniffFormat, volumeKey, isVolumeMember, extractableFormats } from './engine';
import type { WorkflowStep } from './workflows';

/** 最大递归深度（用户指定 16） */
export const MAX_DEPTH = 16;

/** 嗅探时读多少字节的文件头（tar 的 ustar 在偏移 257，所以要 > 265） */
const SNIFF_BYTES = 600;

/* ------------------------------------------------------------------ *
 * 单文件嗅探
 * ------------------------------------------------------------------ */

export interface SniffResult {
  format: ArchiveFormat;
  /** 判定依据，用于日志与 UI 说明 */
  via: 'magic' | 'ext' | 'none';
}

/**
 * 嗅探单个文件的真实格式。
 * 魔数优先 —— 这是能认出"伪装成 jpg 的 rar"的关键。
 */
export function sniffFile(filePath: string): SniffResult {
  // ① 魔数（读文件头，不看扩展名）
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
      const byMagic = sniffFormat(buf.subarray(0, read));
      if (byMagic !== 'unknown') return { format: byMagic, via: 'magic' };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* 读不到就继续走扩展名 */
  }

  // ② 扩展名兜底
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const byExt = extToFormat(ext);
  if (byExt !== 'unknown') return { format: byExt, via: 'ext' };

  return { format: 'unknown', via: 'none' };
}

function extToFormat(ext: string): ArchiveFormat {
  if (ext === 'zip' || ext === 'jar' || ext === 'apk') return 'zip';
  if (ext === '7z') return '7z';
  if (ext === 'rar') return 'rar';
  if (ext === 'tar') return 'tar';
  if (ext === 'gz' || ext === 'tgz') return 'gz';
  if (ext === 'bz2') return 'bz2';
  if (ext === 'xz') return 'xz';
  return 'unknown';
}

/** 该格式是否可继续解压（gz/bz2/xz 也支持，7z 能解单文件压缩流） */
export function canExtract(format: ArchiveFormat): boolean {
  return extractableFormats().includes(format);
}

/* ------------------------------------------------------------------ *
 * 分层产物的收集与挑选
 * ------------------------------------------------------------------ */

export interface LayerCandidate {
  /** 候选文件绝对路径 */
  file: string;
  /** 嗅探出的真实格式 */
  format: ArchiveFormat;
  via: SniffResult['via'];
  /** 该层输入的扩展名（用于工作流链路记录） */
  inputExt: string;
  /**
   * 伪装扩展名：文件实际扩展名与真实格式不符时记录，如 .JPG
   * 若非伪装则与 renameTo 相同，chainText 会跳过显示
   */
  fakeExt: string;
  /** 需要改名成什么才能真正解压（7z 对某些伪装会拒绝，改名更稳） */
  renameTo: string;
}

export interface PickNextLayerOptions {
  /**
   * 是否跳过 .apk（默认 false）。
   *
   * 为什么需要它：`.apk` 在 `extToFormat` 里是 zip 的别名（真实 APK 确实是 zip），
   * 所以魔数嗅探失败时会**按扩展名兜底判成 zip**，于是被判为"可继续解压"。
   * 后果：一个损坏的/伪造的 `.apk` 会被选作下一层去解，7z 打不开（返回码 2），
   * **整个任务直接失败** —— 而此时用户恰恰开了「APK 过滤」，本意是要把这些
   * apk 剔掉、根本不关心它们能不能解开。
   *
   * 所以：开启 APK 过滤时传 true，把 .apk 排除在递归候选之外，交给过滤器处理
   * （过滤器会用 sniffFile 的魔数结果判断真实格式，不会误伤）。
   */
  skipApk?: boolean;
}

/**
 * 解压完成后，从输出目录里找出"下一层该解的那个压缩包"。
 *
 * 规则：
 *   - 只考虑顶层条目（递归子目录会让语义混乱，且目标资源通常都是平铺的）
 *   - 跳过已知的非压缩格式
 *   - 分卷只取主卷（同一套分卷只解一次）
 *   - 若有多个候选：优先魔数命中的；再优先"看起来像伪装"的（扩展名与真实格式不符）
 */
export function pickNextLayer(outDir: string, opts: PickNextLayerOptions = {}): LayerCandidate | null {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: LayerCandidate[] = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(outDir, e.name);

    // 跳过临时/残留文件
    if (/\.(tmp|part|!ut|downloading)$/i.test(e.name)) continue;

    // 开启 APK 过滤时，.apk 不作为递归候选（见 PickNextLayerOptions.skipApk 说明）
    if (opts.skipApk && /\.apk$/i.test(e.name)) continue;

    const sniffed = sniffFile(full);
    if (!canExtract(sniffed.format)) continue;

    // 分卷：只处理主卷，避免同一套分卷被解多次
    if (isVolumeMember(e.name) && !isPrimaryVolume(e.name)) continue;

    const actualExt = path.extname(e.name);
    const actualExtLc = actualExt.toLowerCase().replace('.', '');

    // 伪装：文件扩展名与真实格式对不上（.jpg 里其实是 rar）
    const disguised =
      sniffed.via === 'magic' && actualExtLc !== '' && !extMatchesFormat(actualExtLc, sniffed.format);

    /* ------------------------------------------------------------
     * 是否需要改扩展名？
     *
     * **实测结论（scripts/probe-ext-matrix.cjs / probe-rar-ext.cjs）：**
     * 7z 完全不看扩展名，只看文件头魔数 —— 把 .JPG 改成 .rar 对解压毫无帮助。
     * 10 种后缀（.JPG/.jpg/.rar/.txt/.bin/无后缀/伪造.zip/伪造.7z/双后缀）全部能正常识别。
     *
     * **唯一例外：分卷绝对不能改名。** 7z 靠 `xxx.part1.rar` 这个命名模式去找
     * 兄弟卷 part2/part3；一旦改名（实测改成 .JPG）立刻报 `Data Error : xxx.JPG`。
     *
     * 所以策略是 **一律返回空 renameTo（不做任何改名）**。
     * 保留这个字段与相关代码路径是为兼容已保存的历史工作流卡片，
     * 但新任务不再主动改名 —— 改名既无用又有破坏分卷的风险。
     * ------------------------------------------------------------ */
    const renameTo = '';

    candidates.push({
      file: full,
      format: sniffed.format,
      via: sniffed.via,
      inputExt: actualExt,
      fakeExt: disguised ? actualExt : '',
      renameTo
    });
  }

  if (!candidates.length) return null;

  // 排序：魔数命中优先 → 伪装优先（更可能是套娃的外壳）→ 路径稳定排序
  candidates.sort((a, b) => {
    if (a.via !== b.via) return a.via === 'magic' ? -1 : 1;
    const ad = a.fakeExt ? 0 : 1;
    const bd = b.fakeExt ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.file.localeCompare(b.file);
  });

  return candidates[0];
}

/** 是不是分卷的主卷（.part1.rar / .001 / .z01 / .r00） */
function isPrimaryVolume(fileName: string): boolean {
  const b = fileName.toLowerCase();
  if (/\.part0*1\.(rar|zip|7z)$/.test(b)) return true;
  if (/\.0*1$/.test(b)) return true;
  if (/\.z0*1$/.test(b)) return true;
  if (/\.r0*0$/.test(b)) return true;
  return false;
}

/** 扩展名是否与真实格式相符（用于判断"是否伪装"） */
function extMatchesFormat(ext: string, format: ArchiveFormat): boolean {
  switch (format) {
    case 'zip':
      return ext === 'zip' || ext === 'jar' || ext === 'apk';
    case '7z':
      return ext === '7z';
    case 'rar':
      return ext === 'rar';
    case 'tar':
      return ext === 'tar';
    case 'gz':
      return ext === 'gz' || ext === 'tgz';
    case 'bz2':
      return ext === 'bz2';
    case 'xz':
      return ext === 'xz';
    default:
      return false;
  }
}

/**
 * 格式 → 规范扩展名。
 *
 * 注意：**当前没有生产代码调用它**（pickNextLayer 已改为一律不改名，
 * 见那里的实测结论）。保留是因为工作流卡片里可能存有历史 renameTo 值，
 * 反查时需要它；导出给测试台做断言用。
 */
export function formatToExt(format: ArchiveFormat): string {
  switch (format) {
    case 'zip':
      return '.zip';
    case '7z':
      return '.7z';
    case 'rar':
      return '.rar';
    case 'tar':
      return '.tar';
    case 'gz':
      return '.gz';
    case 'bz2':
      return '.bz2';
    case 'xz':
      return '.xz';
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ *
 * 工作流链路优先
 * ------------------------------------------------------------------ */

/**
 * 若工作流卡片里记录了"这一层该怎么走"，按记录走。
 * 命中条件是步骤序号对齐（第 N 层对应 steps[N]）。
 *
 * 返回改名后的实际可解文件路径；不需要改名则返回原路径。
 */
export function applyWorkflowStep(
  candidate: LayerCandidate,
  steps: WorkflowStep[],
  layerIndex: number
): { file: string; note: string } {
  const step = steps[layerIndex];
  if (!step) return { file: candidate.file, note: '' };

  // 卡片记了这层要改名（如 .JPG → .rar）
  if (step.renameTo && step.renameTo !== candidate.inputExt) {
    /* ------------------------------------------------------------
     * 保护：**分卷绝不能改名**。
     *
     * 历史卡片可能记着 `renameTo: '.rar'`。对分卷执行改名会直接毁掉解压：
     * 7z 靠 `xxx.part1.rar` 命名模式找 part2/part3，改成别的后缀后
     * 实测报 `Data Error`（见 scripts/probe-rar-ext.cjs 场景三）。
     *
     * 同时，对单文件改名本身也已证明**毫无必要**（7z 只看魔数），
     * 所以这里统一拒绝一切改名请求，仅记录一条说明。
     * ------------------------------------------------------------ */
    if (isVolumeMember(path.basename(candidate.file))) {
      return {
        file: candidate.file,
        note: `卡片要求改名，但这是分卷（改名会让 7z 找不到兄弟分卷），已跳过改名直接解压`
      };
    }
    return {
      file: candidate.file,
      note: `卡片要求改名 ${candidate.inputExt} → ${step.renameTo}，但实测 7z 不看后缀（只看魔数），已跳过改名直接解压`
    };
  }
  return { file: candidate.file, note: '' };
}

/**
 * 卡片记录的密码里，哪一个是"下一层该用的"。
 * 返回 null 表示这层不该用卡片密码（走常规候选）。
 */
export function workflowPasswordForStep(steps: WorkflowStep[], layerIndex: number): string | null {
  const step = steps[layerIndex];
  if (!step) return null;
  return step.password || null;
}

/* ------------------------------------------------------------------ *
 * 目录清理：中间压缩包解完即删
 * ------------------------------------------------------------------ */

/**
 * 删掉中间层的压缩包（已成功解压、内容已提取）。
 * 只删**文件**，不碰目录；单个删除失败不影响整体。
 *
 * 注意：分卷要一并删除（主卷 + 同组的其余分卷），否则会留下孤儿分卷。
 */
export function removeIntermediates(files: string[]): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;

  for (const f of files) {
    let size = 0;
    try {
      size = fs.statSync(f).size;
    } catch {
      continue;
    }
    try {
      fs.rmSync(f, { force: true });
      removed += 1;
      bytes += size;
    } catch {
      /* 被占用等情况忽略 */
    }
  }

  return { removed, bytes };
}

/**
 * 给定一个已解压的中间压缩包，找出它同组的全部分卷（含它自己）。
 * 这样删除时不会留下孤儿分卷。
 */
export function siblingsOfVolume(primary: string): string[] {
  const dir = path.dirname(primary);
  const stem = volumeKey(path.basename(primary));
  const out: string[] = [];

  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (volumeKey(e.name) === stem) out.push(path.join(dir, e.name));
    }
  } catch {
    /* ignore */
  }

  return out.length ? out : [primary];
}
