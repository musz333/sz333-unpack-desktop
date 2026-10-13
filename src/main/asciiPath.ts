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
import { toAsciiName, shortHash } from './asciiName';
import { logger } from './logger';

/** 异步判断路径是否存在（修复 ② 配套；避免在改名/搬家路径上再引入同步 existsSync） */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 我们主动创建的路径（输出根 + 改名后的目录树）总长度上限。
 *
 * 为什么需要：Windows 传统 MAX_PATH 是 260，而中文经 ASCII 化后**每个汉字膨胀成
 * 9 个 ASCII 字符**（UTF-8 三字节 → 三个 `uXX`），深层嵌套的中文路径极易破 260，
 * 表现是 7z 报错或产出诡异结果。这里留出余量给"包内自己解出来的文件名"。
 */
export const PATH_BUDGET = 240;

/**
 * 深层路径的预留策略：下面每层至少留这么多字符（段名 + 分隔符）。
 *
 * **必须 ≥ 18**，这不是拍脑袋：`toAsciiName` 在预算极小的情况下依然会产出
 * 「8 字符前缀 + `_` + 8 字符短哈希」= 17 字符（它内部有 `Math.max(16, …)` 下限），
 * 再加 1 个分隔符。预留值比这个小，路径总长就会超出预算 ——
 * 实测踩到过：按 10 预留 → 8 层下来 273 字符 > 预算 240；改成 18 才能压住。
 * 若以后调整 `toAsciiName` 的最小产出，这里必须同步。
 */
const CHILD_RESERVE = 18;
/** 目录还要为最深处的文件名预留的长度 */
const FILE_RESERVE = 30;

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
 * 输出目录含非 ASCII、**或整体过长**时，生成一个可用的目录。
 *
 * 注意三点：
 *  ① **只处理叶子目录名，父目录段一律原样保留。**
 *     旧实现对盘符之后的**每一段**都做 ASCII 化，随后 `renameSync` 把整个
 *     输出目录搬到新的镜像路径 —— 结果 `D:\我的下载\资源名` 被搬到
 *     `D:\u6211u7684u4E0Bu8F7D\资源名`，凭空多出一层镜像目录，
 *     产物也不再位于源文件旁边，与"不破坏用户原本指定的目录"的承诺相悖。
 *     父目录是用户自己的目录结构，不该被我们改写。
 *  ② 长度也要管 —— 纯 ASCII 的长路径一样会破 260，所以**无论有没有中文**，
 *     只要总长超过 PATH_BUDGET 就压缩叶子目录名（截短 + 短哈希）。
 *  ③ 不改动父目录后，预算按"真实的父目录长度"计算，不会低估。
 */
export function ensureAsciiOutDir(outDir: string, preferBase?: string): { dir: string; changed: boolean; from?: string } {
  const hasNonAscii = /[^\x00-\x7F]/.test(outDir);
  if (!hasNonAscii && outDir.length <= PATH_BUDGET) return { dir: outDir, changed: false };

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

  /* 父目录段**原样保留**（见函数头 ①）。
   * 只有叶子目录会被 ASCII 化 —— 它是"我们按包名建的目录"或"用户指定的目录名"，
   * 前者可以改名，后者由调用方通过 allowRenameDir 决定是否改名。 */
  const nonLeafParts = parts.slice(0, -1);
  const headLen =
    (prefix ? prefix.length + 1 : 0) +
    nonLeafParts.reduce((sum, n) => sum + n.length + 1, 0);
  const leafBudget = Math.max(8, PATH_BUDGET - headLen);

  const leafSource = preferBase && preferBase.trim() ? preferBase : parts[parts.length - 1];
  const leafName = toAsciiName(leafSource, { maxLen: leafBudget }).name;
  // 兜底用**确定性**短哈希而不是时间戳：同名输入必须得到同名结果，否则探针无法复现
  const safeLeaf =
    !leafName || !/^[A-Za-z0-9._-]+$/.test(leafName) ? 'dir_' + shortHash(outDir) : leafName;

  const asciiParts = [...nonLeafParts, safeLeaf];

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
export async function renameTreeToAscii(root: string): Promise<{ renames: RenamePair[]; conflicts: number }> {
  const renames: RenamePair[] = [];
  let conflicts = 0;

  /** 收集所有条目（含目录），按路径深度从深到浅排序 */
  const all: { p: string; isDir: boolean }[] = [];
  // 修复 ②：改用 fs.promises —— 本函数会对整棵产物树做两次遍历（收集 + 改名），
  // 同步 readdirSync/renameSync 在十万级目录上会冻结主进程事件循环。
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      all.push({ p, isDir: e.isDirectory() });
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(root);

  /* ------------------------------------------------------------------
   * 阶段 1：自顶向下**规划**每个条目的最终名字，以及它最终的完整路径长度
   *
   * 为什么不能一边改名一边用 `path.dirname(item.p).length` 算预算：
   * 自底向上改名时，父路径**还是原始中文**，长度被严重低估 ——
   * 而每个汉字 ASCII 化后会膨胀成 9 个字符，于是每一段都"以为还有富余"，
   * 结果 8 层下来 736 字符、直接撑破 260（实测踩到过）。
   * 所以先按"最终长度"算，并且给下面每一层预留最小额度、给最深处文件名再留一份。
   * ------------------------------------------------------------------ */
  const depthOf = (p: string) => p.slice(root.length).split(/[\\/]/).filter(Boolean).length;
  let maxDepth = 0;
  for (const it of all) maxDepth = Math.max(maxDepth, depthOf(it.p));

  const finalLen = new Map<string, number>();
  finalLen.set(root, root.length);
  const planned = new Map<string, string>();

  for (const item of [...all].sort((a, b) => depthOf(a.p) - depthOf(b.p))) {
    const dir = path.dirname(item.p);
    const parentLen = finalLen.get(dir) ?? dir.length;
    const below = maxDepth - depthOf(item.p);
    const reserve = below * CHILD_RESERVE + (item.isDir ? FILE_RESERVE : 0);
    const budget = Math.max(8, PATH_BUDGET - parentLen - 1 - reserve);
    const original = path.basename(item.p);
    const { name: safe, changed } = toAsciiName(original, { maxLen: budget });
    finalLen.set(item.p, parentLen + 1 + safe.length);
    if (changed) planned.set(item.p, safe);
  }

  // 阶段 2：深路径先改名（子项改完再改父目录，任何时刻**原始路径**都还有效）
  all.sort((a, b) => b.p.length - a.p.length);

  for (const item of all) {
    const dir = path.dirname(item.p);
    const original = path.basename(item.p);
    const safe = planned.get(item.p);
    if (!safe || safe === original) continue;

    let target = path.join(dir, safe);
    // 同名冲突 → 追加序号
    if ((await pathExists(target)) && path.resolve(target) !== path.resolve(item.p)) {
      const ext = path.extname(safe);
      const stem = safe.slice(0, safe.length - ext.length);
      let i = 2;
      let candidate = path.join(dir, `${stem}_${i}${ext}`);
      while (await pathExists(candidate)) {
        i += 1;
        candidate = path.join(dir, `${stem}_${i}${ext}`);
      }
      target = candidate;
      conflicts += 1;
    }

    try {
      await fs.promises.rename(item.p, target);
      renames.push({ from: item.p, to: target });
    } catch (e) {
      // 单个条目失败不影响整体（例如被占用），但要留下诊断线索
      logger.debug(`中文名转 ASCII 失败（已跳过）：${item.p} -> ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { renames, conflicts };
}

/**
 * 一步到位：必要时的目录替换 + 树内 ASCII 化。
 *
 * @param opts.allowRenameDir
 *   · `true` / 未指定（默认）→ 允许把**输出目录本身**换成英文名。
 *     只用于「我们按包名自建」的目录（`outDirAuto`）。
 *   · `false` → **绝不动目录名**，只做树内文件/子目录的 ASCII 化。
 *     用于「用户显式指定的输出目录」：那是用户自己的目录，
 *     不该被我们改名，更不该被整体搬走（旧实现会 `renameSync` 整个目录）。
 */
export async function applyAsciiPolicy(
  outDir: string,
  preferBase?: string,
  opts: { allowRenameDir?: boolean } = {}
): Promise<AsciiResult> {
  const allowRenameDir = opts.allowRenameDir !== false;
  const dirRes: { dir: string; changed: boolean; from?: string } = allowRenameDir
    ? ensureAsciiOutDir(outDir, preferBase)
    : { dir: outDir, changed: false };
  let finalDir = dirRes.dir;

  // 目录被替换后，原解压结果还在旧目录里，需要整体搬过去
  // 修复 ②：搬家与树内改名全部改用 fs.promises（调用链同步改 async）。
  if (dirRes.changed && (await pathExists(outDir))) {
    try {
      await fs.promises.mkdir(path.dirname(finalDir), { recursive: true });
      await fs.promises.rename(outDir, finalDir);
    } catch (e) {
      // 搬家失败（跨卷等）→ 保持原目录，仅做树内改名
      logger.warn(`输出目录改英文名失败（保持原目录）：${outDir} -> ${e instanceof Error ? e.message : String(e)}`);
      finalDir = outDir;
    }
  }

  const tree = (await pathExists(finalDir))
    ? await renameTreeToAscii(finalDir)
    : { renames: [], conflicts: 0 };

  return {
    outDir: finalDir,
    dirChanged: dirRes.changed && finalDir !== outDir,
    renames: tree.renames,
    conflicts: tree.conflicts
  };
}
