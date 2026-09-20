/**
 * 解压产物的 ASCII 化（为"老资源包不支持中文路径"而做）
 *
 * 两类处理：
 *  ① 输出目录本身含中文 → 换成一个纯英文的兄弟目录（不破坏用户原本指定的目录）；
 *  ② 解压出来的**文件/文件夹名含中文** → 就地改成 ASCII 名（自底向上重命名，避免路径失效），
 *     并回传「原名 → 新名」对照表，界面在日志里逐条列出，保证用户找得到文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { toAsciiName } from './asciiName';

export interface RenamePair {
  from: string;
  to: string;
}

export interface AsciiResult {
  /** 处理后的输出目录 */
  outDir: string;
  /** 目录本身是否被替换 */
  dirChanged: boolean;
  /** 文件/目录重命名对照表 */
  renames: RenamePair[];
  /** 是否出现了同名冲突（已自动加序号） */
  conflicts: number;
}

/**
 * 去掉分卷号、压缩格式、以及被改过名的后缀，得到**原始包名**作为结果目录名。
 * 例：资源包.part1.7z.001 / 资源包.part1.7z / 资源包.7z.001 → 资源包
 *     RX-4114.part1.rar → RX-4114
 */
export function archiveStem(anyMember: string, allMembers?: string[]): string {
  const strip = (s: string): string => {
    let cur = s;
    for (let i = 0; i < 5; i++) {
      const before = cur;
      cur = cur.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
      cur = cur.replace(/\.(7z|zip|rar|tar|gz|tgz|bz2|xz|cab|jpg|jpeg|png|txt|bin)$/i, '');
      if (cur === before) break;
    }
    return cur;
  };

  const candidates: string[] = [strip(anyMember)];
  for (const m of allMembers ?? []) {
    const base = m.split(/[\\/]/).pop() ?? m;
    const s = strip(base);
    if (s) candidates.push(s);
  }

  // 取最短的候选（通常就是最干净的原始包名），避免留下 .part1.7z 之类残渣
  let best = candidates[0] ?? anyMember;
  for (const c of candidates) {
    if (c.length > 0 && c.length < best.length) best = c;
  }
  return best || anyMember;
}

/**
 * 输出目录含非 ASCII 时，生成一个**整条路径都纯 ASCII** 的目录。
 *
 * 注意：不能只改叶子目录 —— 父目录里的中文同样会让老资源包出问题，
 * 所以这里对盘符之后的每一段都做 ASCII 化（盘符/UNC 前缀原样保留）。
 */
export function ensureAsciiOutDir(outDir: string, preferBase?: string): { dir: string; changed: boolean; from?: string } {
  if (!/[^\x00-\x7F]/.test(outDir)) return { dir: outDir, changed: false };

  const sep = outDir.includes('\\') ? '\\' : '/';

  // 盘符或 UNC 前缀原样保留
  let prefix = '';
  let rest = outDir;
  const drive = /^([A-Za-z]:)[\\/]?/.exec(outDir);
  const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)[\\/]?/.exec(outDir);
  if (drive) {
    prefix = drive[1];
    rest = outDir.slice(drive[0].length);
  } else if (unc) {
    prefix = unc[1];
    rest = outDir.slice(unc[0].length);
  }

  const parts = rest.split(/[\\/]/).filter((s) => s !== '');
  if (!parts.length) return { dir: outDir, changed: false };

  // 逐段 ASCII 化；叶子目录优先用包名（更可读），否则用原叶子名
  const asciiParts = parts.map((seg, i) => {
    const isLeaf = i === parts.length - 1;
    const source = isLeaf && preferBase && preferBase.trim() ? preferBase : seg;
    const r = toAsciiName(source);
    return !r.name || !/^[A-Za-z0-9._-]+$/.test(r.name) ? 'dir_' + Date.now().toString(36) : r.name;
  });

  let candidate = prefix ? prefix + sep + asciiParts.join(sep) : asciiParts.join(sep);

  // 同名避让
  if (fs.existsSync(candidate) && path.resolve(candidate) !== path.resolve(outDir)) {
    const base = candidate;
    let n = 2;
    while (fs.existsSync(candidate)) {
      candidate = `${base}_${n}`;
      n += 1;
    }
  }

  if (path.resolve(candidate) === path.resolve(outDir)) return { dir: outDir, changed: false };
  return { dir: candidate, changed: true, from: outDir };
}

/** 递归把目录下的所有条目改成 ASCII 名（自底向上，避免父路径先变导致子路径失效） */
export function renameTreeToAscii(root: string): { renames: RenamePair[]; conflicts: number } {
  const renames: RenamePair[] = [];
  let conflicts = 0;

  /** 收集所有条目（含目录），按路径深度从深到浅排序 */
  const all: { p: string; isDir: boolean }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      all.push({ p, isDir: e.isDirectory() });
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);

  // 深路径先改名：子项改完再改父目录，任何时刻路径都有效
  all.sort((a, b) => b.p.length - a.p.length);

  for (const item of all) {
    const dir = path.dirname(item.p);
    const original = path.basename(item.p);
    const { name: safe, changed } = toAsciiName(original);
    if (!changed) continue;

    let target = path.join(dir, safe);
    // 同名冲突 → 追加序号
    if (fs.existsSync(target) && path.resolve(target) !== path.resolve(item.p)) {
      const ext = path.extname(safe);
      const stem = safe.slice(0, safe.length - ext.length);
      let i = 2;
      let candidate = path.join(dir, `${stem}_${i}${ext}`);
      while (fs.existsSync(candidate)) {
        i += 1;
        candidate = path.join(dir, `${stem}_${i}${ext}`);
      }
      target = candidate;
      conflicts += 1;
    }

    try {
      fs.renameSync(item.p, target);
      renames.push({ from: item.p, to: target });
    } catch {
      // 单个条目失败不影响整体（例如被占用）
    }
  }

  return { renames, conflicts };
}

/** 一步到位：必要时的目录替换 + 树内 ASCII 化 */
export function applyAsciiPolicy(outDir: string, preferBase?: string): AsciiResult {
  const dirRes = ensureAsciiOutDir(outDir, preferBase);
  let finalDir = dirRes.dir;

  // 目录被替换后，原解压结果还在旧目录里，需要整体搬过去
  if (dirRes.changed && fs.existsSync(outDir)) {
    try {
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.renameSync(outDir, finalDir);
    } catch {
      // 搬家失败（跨卷等）→ 保持原目录，仅做树内改名
      finalDir = outDir;
    }
  }

  const tree = fs.existsSync(finalDir) ? renameTreeToAscii(finalDir) : { renames: [], conflicts: 0 };

  return {
    outDir: finalDir,
    dirChanged: dirRes.changed && finalDir !== outDir,
    renames: tree.renames,
    conflicts: tree.conflicts
  };
}
