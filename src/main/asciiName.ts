/**
 * ASCII 路径安全化（为"老资源包不支持中文路径"而做）
 *
 * 背景：一些老资源包由 GBK 时代的工具打包，或内部用了老式编码/短文件名，
 *       解压到含中文的路径时会出现乱码、失败、文件丢失。用户要求：
 *       解压时**直接走全英文路径名**。
 *
 * 策略：
 *  · 解析出「英文 + 数字 + 少量安全符号」，其余字符按 UTF-8 字节转成 uXX 形式
 *    —— 完全 ASCII 且**可逆**（同一算法下不会出现两条不同路径撞成同名）；
 *  · 结果截断到安全长度，并避免 Windows 保留名；
 *  · 严格校验：只允许 [A-Za-z0-9._-]，若结果为空或含非法字符则回退到哈希名。
 */

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

const SAFE_RE = /^[A-Za-z0-9._-]+$/;

/** 是否含非 ASCII 字符（含中文、日文、emoji 等） */
export function hasNonAscii(s: string): boolean {
  return /[^\x00-\x7F]/.test(s);
}

/** 给一段文本生成稳定短哈希（用于兜底命名，避免同名冲突） */
export function shortHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + c * (i + 1)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

export interface AsciiNameResult {
  name: string;
  changed: boolean;
}

/**
 * 把一个路径组成部分转成纯 ASCII 安全名
 * @param name           原始名字（不含路径分隔符）
 * @param opts.fallback  兜底名（当结果为空时使用）
 * @param opts.maxLen    单段最大长度
 */
export function toAsciiName(name: string, opts: { fallback?: string; maxLen?: number } = {}): AsciiNameResult {
  const maxLen = opts.maxLen ?? 100;
  const original = name ?? '';
  if (original === '' ) return { name: opts.fallback ?? 'untitled', changed: false };

  // 已经是纯 ASCII 且合法 → 原样返回
  if (!hasNonAscii(original) && SAFE_RE.test(original)) {
    return { name: original, changed: false };
  }

  // 拆分扩展名（保留，提升可识别性）
  const dot = original.lastIndexOf('.');
  let stem = dot > 0 ? original.slice(0, dot) : original;
  let ext = dot > 0 ? original.slice(dot) : '';

  // 扩展名也必须是 ASCII，否则并入主干
  if (ext && !SAFE_RE.test(ext.replace(/^\./, ''))) {
    stem = original;
    ext = '';
  }

  // 未收录字符 → uXX（UTF-8 字节的十六进制），保证 ASCII 且可逆
  const toAscii = (s: string): string => {
    let out = '';
    for (const ch of s) {
      if (/[A-Za-z0-9._-]/.test(ch)) {
        out += ch;
      } else {
        const bytes = Buffer.from(ch, 'utf8');
        for (const b of bytes) out += 'u' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  };

  let result = toAscii(stem);
  // 去掉首尾的点和空格（Windows 不允许），并压缩多余下划线
  result = result.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').replace(/_{2,}/g, '_');

  if (!result) result = opts.fallback ?? 'item_' + shortHash(original);

  // 长度控制：截断主干，保留扩展名与哈希尾缀，降低冲突概率
  const budget = Math.max(16, maxLen - ext.length);
  if (result.length > budget) {
    result = result.slice(0, Math.max(8, budget - 13)) + '_' + shortHash(original).slice(0, 8);
  }

  // Windows 保留名
  if (RESERVED.has(result.toUpperCase())) result = '_' + result;

  // 最终校验：仍不合法则用哈希兜底（宁可难认，也不能出问题）
  if (!SAFE_RE.test(result)) {
    result = (opts.fallback ?? 'item') + '_' + shortHash(original);
    if (!SAFE_RE.test(result)) result = 'item_' + shortHash(original);
  }

  const finalName = result + ext;
  return { name: finalName, changed: finalName !== original };
}

/** 把一个绝对路径的每一段都 ASCII 化（保留盘符/UNC 前缀与分隔符） */
export function toAsciiPath(p: string): { path: string; changed: boolean; mapping: { from: string; to: string }[] } {
  const mapping: { from: string; to: string }[] = [];
  let changed = false;

  // 盘符或 UNC 前缀原样保留
  let prefix = '';
  let rest = p;
  const drive = /^([A-Za-z]:)([\\/]?)/.exec(p);
  const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)([\\/]?)/.exec(p);
  if (drive) {
    prefix = drive[1];
    rest = p.slice(drive[0].length);
  } else if (unc) {
    prefix = unc[1];
    rest = p.slice(unc[0].length);
  }

  const parts = rest.split(/[\\/]/).filter((s) => s !== '');
  const outParts = parts.map((seg) => {
    const r = toAsciiName(seg);
    if (r.changed) {
      changed = true;
      mapping.push({ from: seg, to: r.name });
    }
    return r.name;
  });

  const sep = p.includes('\\') ? '\\' : '/';
  return { path: prefix ? prefix + sep + outParts.join(sep) : outParts.join(sep), changed, mapping };
}

/** 中文等后缀：给"无扩展名或扩展名非 ASCII"的文件补一个安全后缀，避免系统无法识别 */
export function ensureSafeExtension(fileName: string): string {
  return SAFE_RE.test(fileName) ? fileName : toAsciiName(fileName).name;
}
