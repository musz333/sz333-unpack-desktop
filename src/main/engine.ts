import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveFormat, ArchiveInfo, ArchiveEntry } from '@shared/types';
import { FORMATS } from '@shared/types';
import { findDuplicates } from './dedup';
import { volumeKey, isVolumeMember } from '@shared/volumeKey';

/* ------------------------------------------------------------------ *
 * 7z 引擎定位
 *   打包后：resources/7z.exe（extraResources，asar 之外）
 *   开发期：resources/7z.exe（项目内）
 *   兜底：系统安装的 7-Zip
 * ------------------------------------------------------------------ */
export function resolve7z(): string {
  const candidates = [
    // 打包后（process.resourcesPath 由主进程注入）
    process.env.SZ333_RESOURCES ? path.join(process.env.SZ333_RESOURCES, '7z.exe') : '',
    path.join(process.cwd(), 'resources', '7z.exe'),
    path.join(process.cwd(), '..', 'resources', '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      // 修复 ③：只接受**绝对路径**且**确实存在**的候选，不再回退到裸 `7z.exe`（交 PATH 解析）。
      // 为什么去掉 PATH 兜底：主进程会以较高权限 spawn 这个可执行文件，而 PATH 可能被
      // 用户环境或其它安装器污染 —— 一旦命中被劫持/伪造的 `7z.exe`，等于以主进程权限
      // 执行任意程序（提权面）。正常定位链（SZ333_RESOURCES → cwd/resources → ..\resources
      // → Program Files\7-Zip）全部是绝对路径，不受影响。
      if (path.isAbsolute(c) && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  // 缺引擎时返回空串（而非交 PATH）：由 engineSelfCheck 的 existsSync('') 分支
  // 给出明确错误，run7z 也会立即以清晰错误失败，绝不静默走 PATH。
  return '';
}

/* ------------------------------------------------------------------ *
 * 魔数识别（按文件头判断真实格式，不信任扩展名）
 * ------------------------------------------------------------------ */
export function sniffFormat(buf: Buffer): ArchiveFormat {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7) && buf[3] === 4) return 'zip';
  // 修复 ⑤：**空 zip** 只有一个 22 字节的 EOCD（`PK\x05\x06`），没有本地文件头 ——
  // 旧实现要求 `buf[3]===4` 会把它漏判成 unknown。补一个专门的空归档魔数分支。
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06) return 'zip';
  if (buf.length >= 8 && buf.toString('latin1', 0, 7) === 'Rar!\u001a\u0007\u0000') return 'rar';
  if (buf.length >= 8 && buf.toString('latin1', 0, 7) === 'Rar!\u001a\u0007\u0001') return 'rar';
  if (buf.length >= 6 && buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf && buf[4] === 0x27 && buf[5] === 0x1c) return '7z';
  if (buf.length >= 3 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) return 'gz';
  if (buf.length >= 3 && buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68) return 'bz2';
  if (buf.length >= 6 && buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58 && buf[4] === 0x5a) return 'xz';
  if (buf.length >= 265 && buf.toString('latin1', 257, 262) === 'ustar') return 'tar';
  return 'unknown';
}

function sniffByExt(name: string): ArchiveFormat {
  const ext = path.extname(name).toLowerCase().replace('.', '');
  if (ext === 'zip' || ext === 'jar' || ext === 'apk' || ext === 'docx' || ext === 'xlsx') return 'zip';
  if (ext === '7z') return '7z';
  if (ext === 'rar') return 'rar';
  if (ext === 'tar') return 'tar';
  if (ext === 'gz' || ext === 'tgz') return 'gz';
  if (ext === 'bz2') return 'bz2';
  if (ext === 'xz') return 'xz';
  return 'unknown';
}

/** 7z 能继续解压的格式集合（递归解压时判断"这一层还能不能再往下解"） */
export function extractableFormats(): ArchiveFormat[] {
  return (Object.keys(FORMATS) as ArchiveFormat[]).filter(
    (f) => f !== 'unknown' && FORMATS[f].extractable
  );
}

/* ------------------------------------------------------------------ *
 * 分卷归组：partN / .NNN / .zNN / .rNN 都识别为同一组
 *
 * 实现已收敛到 `shared/volumeKey.ts`（渲染层去重预览也要用同一套规则）。
 * 这里保留 re-export，避免改动既有导入路径（recursive.ts 等）。
 * ------------------------------------------------------------------ */
export { volumeKey, isVolumeMember } from '@shared/volumeKey';

function pickPrimary(members: string[]): string {
  const base = (n: string) => path.basename(n).toLowerCase();
  const sorted = [...members].sort((a, b) => base(a).localeCompare(base(b)));
  const pick =
    sorted.find((f) => /\.part0*1\.(rar|zip|7z)$/i.test(base(f))) ??
    sorted.find((f) => /\.0*1$/i.test(base(f))) ??
    sorted.find((f) => /\.z0*1$/i.test(base(f))) ??
    sorted.find((f) => /\.r0*0$/i.test(base(f))) ??
    sorted[0];
  return pick;
}

/* ------------------------------------------------------------------ *
 * 扫描：把用户选中的文件/文件夹整理成"资源包"列表
 * ------------------------------------------------------------------ */
export interface ScannedPack {
  id: string;
  kind: 'single' | 'multi';
  baseName: string;
  files: string[];
  primary: string;
  size: number;
  format: ArchiveFormat;
  formatLabel: string;
  extractable: boolean;
  note: string;
  /** 批内去重：被合并掉的重复份数（>1 表示这份代表了几份） */
  mergedCount?: number;
  /** 去重依据（界面提示用） */
  dupReason?: string;
  /** 被剔除的那些份的路径（界面可展开查看） */
  dupPaths?: string[];
  /** 同名但大小不同时的提示 */
  conflictNote?: string;
  /** 逐分卷字节数（与 files 顺序一致） */
  volumeSizes?: number[];
}

export async function scanPaths(inputs: string[]): Promise<ScannedPack[]> {
  // 修复 ②：全流程改用 fs.promises（async/await）。旧实现用
  // statSync/readdirSync/openSync/readSync 在**主进程事件循环**上同步遍历用户选中的
  // 目录 —— 十万级产物的目录会冻结 UI/IPC 数百毫秒到数秒（与项目里已异步化的
  // dirStats 口径不一致）。对外语义与返回结构保持不变，只把 IO 换成异步。
  const files: string[] = [];
  for (const p of inputs) {
    let st: fs.Stats | null = null;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(p, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile()) files.push(path.join(p, entry.name));
      }
    } else {
      files.push(p);
    }
  }

  // 每个文件的大小只取一次（并发 stat），供 size / volumeSizes / 批内去重共用，
  // 既避免同步阻塞，也避免对同一文件重复 stat。
  const sizeMap = new Map<string, number>();
  await Promise.all(
    files.map(async (f) => {
      sizeMap.set(f, await statSize(f));
    })
  );

  // 分组键 = 所在目录 + 分卷基名（仅对"分卷成员"生效）
  //   v1.0.2 修正：原先只用「文件基名」，导致不同目录下的同名包
  //   （如 D:\下载\RX.rar 与 D:\备份\RX.rar）被错误合并成一组，
  //   其中一个会被 pickPrimary 静默忽略 —— 该解的包可能根本没解。
  //   v2.0.1 修正：只有「分卷成员」才允许按基名归组。volumeKey 只剥分卷尾号、
  //   不剥格式后缀，于是 `movie.7z` 与 `movie.nfo` 的 key 都是 `movie`，
  //   两者会被并成一组 —— 其中一个被静默忽略，另一个在「删除源文件」时
  //   被当成兄弟分卷**永久删除**。非分卷文件一律以完整名单独成组。
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.dirname(f);
    const name = path.basename(f);
    const key = isVolumeMember(name)
      ? dir + '\u0000' + (volumeKey(name) || name)
      : dir + '\u0000\u0001' + name; // \u0001 前缀把"独立包/普通文件"与分卷组彻底隔离
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  const packs: ScannedPack[] = [];
  for (const [key, members] of groups) {
    const primary = pickPrimary(members);
    let format: ArchiveFormat = sniffByExt(primary);
    try {
      const fh = await fs.promises.open(primary, 'r');
      try {
        const buf = Buffer.alloc(600);
        const { bytesRead } = await fh.read(buf, 0, 600, 0);
        const byMagic = sniffFormat(buf.subarray(0, bytesRead));
        if (byMagic !== 'unknown') format = byMagic;
      } finally {
        await fh.close();
      }
    } catch {
      /* 读不到就沿用扩展名判断 */
    }

    const size = members.reduce((s, f) => s + (sizeMap.get(f) ?? 0), 0);
    const baseName = path.basename(members[0]).replace(/\.[^.]+$/, '');
    const sortedMembers = members.sort();

    const meta = FORMATS[format];
    packs.push({
      id: `${key}-${Math.random().toString(36).slice(2, 8)}`,
      kind: members.length > 1 ? 'multi' : 'single',
      baseName,
      files: sortedMembers,
      /** 逐分卷字节数（按文件名排序后，与 files 顺序一致）——用于前端比对重复 */
      volumeSizes: sortedMembers.map((f) => sizeMap.get(f) ?? 0),
      primary,
      size,
      format,
      formatLabel: meta.label,
      extractable: meta.extractable,
      note: meta.note ?? ''
    });
  }

  // 批内去重：同名同大小（含逐分卷大小一致）只保留一份
  const dedup = findDuplicates(
    packs.map((p) => ({
      id: p.id,
      primary: p.primary,
      files: p.files,
      size: p.size,
      name: path.basename(p.primary)
    })),
    (f) => sizeMap.get(f) ?? 0
  );
  if (dedup.droppedIds.length || dedup.conflicts.length) {
    const dropSet = new Set(dedup.droppedIds);
    const kept = packs.filter((p) => !dropSet.has(p.id));

    // 把"被合并了几份"记录到保留的那一份上，界面可展示
    for (const g of dedup.groups) {
      const keepPack = kept.find((p) => p.id === g.keep);
      if (keepPack) {
        keepPack.mergedCount = (keepPack.mergedCount ?? 1) + g.drop.length;
        keepPack.dupReason = g.reason;
        keepPack.dupPaths = g.drop
          .map((id) => packs.find((p) => p.id === id)?.primary)
          .filter((x): x is string => !!x);
      }
    }
    for (const c of dedup.conflicts) {
      for (const id of c.ids) {
        const p = kept.find((x) => x.id === id);
        if (p) p.conflictNote = '同名但大小不同，已保留两份';
      }
    }
    return kept;
  }
  return packs;
}

/** 取文件大小（异步；取不到按 0 算） */
async function statSize(p: string): Promise<number> {
  try {
    return (await fs.promises.stat(p)).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 调用 7z（统一入口，支持取消与实时进度回调）
 * ------------------------------------------------------------------ */
export interface Run7zOptions {
  args: string[];
  /**
   * 解压密码。**通过 stdin 传给 7z，绝不放进命令行**。
   *
   * 为什么必须这样：Windows 上任何进程都能用 WMI（`Win32_Process.CommandLine`）
   * 读到其它进程的完整命令行，把密码写成 `-p<密码>` 等于在整个解压期间
   * （大包可能数分钟）把明文密码挂在系统里，同机的其它用户/程序都能读到。
   *
   * 已实测（7-Zip 26.02 x64）：stdin 为管道时 7z 会从 stdin 读密码，
   *   · 加密包解压（含 -mhe=on 头部加密）→ 成功；
   *   · 加密包 `l -slt` 列表 → 成功；
   *   · 密码错误 / 未提供（EOF）→ 快速失败，**不会挂起**；
   *   · 无密码包 + stdin 立即 EOF → 正常解压。
   *
   * 限制：密码里若含换行符会被截断（7z 按行读取），实际密码几乎不会含换行。
   */
  password?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Run7zResult {
  code: number;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  /** stdout 是否因超过 8MB 上限被截断（截断后只保留末尾 4MB）。
   *  调用方若依赖 stdout 做累加统计（如 listArchive 的 totalSize），必须检查此标记。 */
  stdoutTruncated: boolean;
}

export function run7z(opts: Run7zOptions): { promise: Promise<Run7zResult>; cancel: () => void } {
  const bin = resolve7z();
  let child: ChildProcess | null = null;
  let stdout = '';
  let stderr = '';
  let cancelled = false;
  let settled = false;
  let stdoutTruncated = false;

  const promise = new Promise<Run7zResult>((resolve) => {
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, cancelled, stdoutTruncated });
    };

    // 修复 ③：引擎定位失败（resolve7z 返回空串）时立即以**明确错误**失败，
    // 不要带着空串去 spawn（空命令会抛 ERR_INVALID_ARG_VALUE，信息不友好）。
    if (!bin) {
      stderr += '找不到 7z.exe（内嵌资源缺失，且系统未安装 7-Zip）';
      done(1);
      return;
    }

    try {
      // 用 spawn 而不是 execFile：7z 的进度用 \r 在同一行刷新，
      // 逐块回调才能实时拿到百分比，同时避免"回调 + 事件"双写同一份输出。
      child = spawn(bin, opts.args, {
        // cwd 固定到 7z.exe 所在目录：7z 需要同目录的 7z.dll，
        // 显式指定可避免"从被重定向/受限的 cwd 启动导致找不到编解码器"。
        cwd: path.dirname(bin) || undefined,
        windowsHide: true,
        // stdin 必须是管道：密码从这里进（见 Run7zOptions.password）
        stdio: ['pipe', 'pipe', 'pipe']
      });

      /* 密码经 stdin 传递。必须**总是** end()：
       *  · 有密码 → 写一行后关闭，7z 读到密码；
       *  · 无密码 → 立即 EOF，7z 若需要密码会快速失败而不是等待输入。 */
      if (child.stdin) {
        child.stdin.on('error', () => {
          /* 子进程提前退出时写 stdin 会得到 EPIPE —— 忽略，close 事件里已有结论 */
        });
        if (opts.password) child.stdin.write(opts.password + '\n');
        child.stdin.end();
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 8 * 1024 * 1024) {
          stdout = stdout.slice(-4 * 1024 * 1024);
          /* 记录"输出被截断"这一事实：listArchive 的 totalSize 是逐条累加的，
             一旦截断，累加值就会漏掉前面的条目（超大归档会严重低估解出体积），
             磁盘预检必须据此走保守分支。 */
          stdoutTruncated = true;
        }
        opts.onStdout?.(chunk);
      });

      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
        opts.onStderr?.(chunk);
      });

      child.on('error', (e: Error) => {
        stderr += String(e);
        done(1);
      });

      child.on('close', (code: number | null) => {
        done(code ?? (cancelled ? 255 : 1));
      });

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timer = setTimeout(() => {
          try {
            child?.kill();
          } catch {
            /* ignore */
          }
          done(255);
        }, opts.timeoutMs);
        child.on('close', () => clearTimeout(timer));
      }

      if (opts.signal) {
        const onAbort = () => {
          cancelled = true;
          try {
            child?.kill();
          } catch {
            /* ignore */
          }
        };
        /* 修复 ④：监听器必须在子进程结束时**移除**。
         * 旧实现用 { once:true } 注册后，**正常完成路径**（未触发 abort）从不移除；
         * 而任务会跨 16 层 × 多次密码尝试复用同一个 AbortController 反复调用 run7z，
         * 监听器不断累积 → 超过 Node 默认上限 10 → MaxListenersExceededWarning，
         * 且遗留的监听器还会对已结束的进程重复 kill。 */
        const detach = () => {
          try {
            opts.signal?.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
        child.on('close', detach);
        child.on('exit', detach);
      }
    } catch (e) {
      stderr += String(e);
      done(1);
    }
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * 解析 7z l -slt 输出
 * ------------------------------------------------------------------ */
export interface ParsedListing {
  archiveType: ArchiveFormat;
  entries: ArchiveEntry[];
  encrypted: boolean;
  totalSize: number;
  packedSize: number;
  /** 输入输出被 run7z 的 8MB 上限截断过 → 上面的累加值（totalSize/packedSize/fileCount）**不可信**，
   *  因为截断只保留末尾 4MB。磁盘预检必须据此走保守分支，见 preflightCheck。 */
  truncated: boolean;
}

/** 7z l -slt 的条目累加器（字段名沿用输出中的 PascalCase，flush 时转成驼峰） */
interface PendingEntry {
  path?: string;
  size?: number;
  packedSize?: number;
  encrypted?: boolean;
  crc?: string;
  modified?: string;
  attributes?: string;
}

/**
 * 解析 `7z l -slt` 输出。
 *
 * **切分依据（修复 P0-2）**：以「出现新的 `Path` 字段」作为块边界，**不依赖分隔线**。
 *
 * 为什么不能用分隔线 —— 实测 7-Zip 26.02 的 `l -slt` 输出结构是：
 *   · 头部块与条目区之间是 `--`（2 个短横）；
 *   · 条目区之前有 `----------`（10 个短横），但**整份输出里只出现这一次**；
 *   · **条目与条目之间没有任何分隔线**。
 *
 * 旧实现把 `----------` 当作"新条目开始"，于是只有头部块和**最后一个**条目被
 * flush 出来：多文件包永远只显示 1 个文件 + 压缩包自身。同时 `archiveType` 用
 * `!cur.path` 判断"是否头部块"，而实测 **`Path` 行在 `Type` 行之前**，判断恒为 false
 * → 压缩格式永远识别不出，末尾兜底成 `zip`。
 *
 * 现在的做法：
 *   · `inHeader` 显式状态机 —— 首个 10 短横分隔线之前视为头部块，头部块不产出条目；
 *   · 每遇到 `Path` 且当前块已有 path → 先 flush 再开新块；
 *   · `archiveType` 只从头部块读取。
 */
export function parseListing(stdout: string, outputTruncated = false): ParsedListing {
  const lines = stdout.split(/\r?\n/);
  const entries: ArchiveEntry[] = [];
  let cur: PendingEntry = {};
  /** 是否仍在头部块（`Listing archive:` 之后的元数据区） */
  let inHeader = true;
  let archiveType: ArchiveFormat = 'unknown';
  let encrypted = false;

  const flush = () => {
    if (cur.path === undefined) {
      cur = {};
      return;
    }
    if (!inHeader) {
      const p = cur.path;
      const isDir = !!cur.attributes?.includes('D') || p.endsWith('\\') || p.endsWith('/');
      entries.push({
        path: p,
        size: cur.size ?? 0,
        packedSize: cur.packedSize ?? 0,
        isDir,
        encrypted: !!cur.encrypted,
        crc: cur.crc,
        modified: cur.modified
      });
    }
    cur = {};
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Listing archive:')) continue;

    // 任意长度的短横线都是块边界；≥10 个表示"头部块结束，进入条目区"
    if (/^-{2,}$/.test(line)) {
      flush();
      if (line.length >= 10) inHeader = false;
      continue;
    }

    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 3).trim();

    // 关键：出现新的 Path 即切块（不再依赖分隔线）
    if (k === 'Path') {
      if (cur.path !== undefined) flush();
      cur.path = v;
      continue;
    }

    switch (k) {
      case 'Type':
        if (inHeader) {
          // 头部块的 Type = 压缩格式
          if (v === '7z' || v === 'zip' || v === 'rar' || v === 'tar' || v === 'bzip2' || v === 'xz' || v === 'cab') {
            archiveType = v as ArchiveFormat;
          } else if (v === 'gzip') {
            archiveType = 'gz';
          }
        } else if (v === 'Directory') {
          // 条目块的 Type = File / Directory
          cur.attributes = 'D';
        }
        break;
      case 'Size':
        cur.size = Number(v) || 0;
        break;
      case 'Packed Size':
        cur.packedSize = Number(v) || 0;
        break;
      case 'Attributes':
        cur.attributes = v;
        break;
      case 'Encrypted':
        // 头部块的 Encrypted = + 表示"整包加密"（如 7z -mhe=on）
        if (inHeader) {
          if (v === '+') encrypted = true;
        } else if (v === '+') {
          cur.encrypted = true;
        }
        break;
      case 'CRC':
        cur.crc = v;
        break;
      case 'Modified':
        cur.modified = v;
        break;
      case 'Method':
        if (v && v !== 'Store' && /AES/i.test(v)) cur.encrypted = true;
        break;
      default:
        break;
    }
  }
  flush();

  if (archiveType === 'unknown' && entries.length) archiveType = 'zip';
  const totalSize = entries.reduce((s, e) => s + e.size, 0);
  const packedSize = entries.reduce((s, e) => s + e.packedSize, 0);

  return {
    archiveType,
    entries,
    encrypted: encrypted || entries.some((e) => e.encrypted),
    totalSize,
    packedSize,
    truncated: outputTruncated
  };
}

/** 列出压缩包内容 */
export async function listArchive(archivePath: string, password?: string, maxEntries = 3000): Promise<ArchiveInfo> {
  /* 密码不再拼进 argv。原先的 `-p${password ?? ''}` 会把明文密码写进命令行，
   * 任何进程都能读到；现在改由 stdin 传入（见 Run7zOptions.password）。
   * 不传 `-p` 时 7z 会读 stdin：给了密码就能列出包头加密（-mhe=on）的包，
   * 没给则 EOF → 提示需要密码 —— 两种情况与原先的行为一致。 */
  const args = ['l', '-slt', '-sccUTF-8', '--', archivePath];
  const { promise } = run7z({ args, password: password || undefined });
  const res = await promise;
  const out = res.stdout || res.stderr;
  // 输出被截断时，totalSize/packedSize 是"漏掉前段"的累加值 → 必须把这一事实传下去
  const parsed = parseListing(out, res.stdoutTruncated);
  const enc = /Wrong password|Cannot open encrypted|Enter password|Data Error in encrypted file/i.test(out);

  const entries = parsed.entries.slice(0, maxEntries);
  return {
    format: parsed.archiveType,
    formatLabel: FORMATS[parsed.archiveType]?.label ?? '未知',
    physicalSize: 0,
    totalSize: parsed.totalSize,
    packedSize: parsed.packedSize,
    fileCount: parsed.entries.filter((e) => !e.isDir).length,
    dirCount: parsed.entries.filter((e) => e.isDir).length,
    encrypted: parsed.encrypted || enc,
    entries,
    // 两种截断都要如实上报：条目数受 maxEntries 限制，或 7z 输出本身被 8MB 上限截断
    truncated: parsed.entries.length > maxEntries || parsed.truncated,
    sizeEstimateReliable: !parsed.truncated,
    passwordRequired: enc
  };
}

/* ------------------------------------------------------------------ *
 * 输出目录命名（同名自动避让）
 * ------------------------------------------------------------------ */

/**
 * 目录段净化：去掉 Windows 非法字符（`<>:"/\|?*` 与控制字符）与结尾的点/空格，
 * 空串兜底为「解压结果」。
 *
 * 修复 ⑦：这段净化逻辑原先在本文件里写了**两遍**（`uniqueDir` 内联一份 +
 * `safeDirSegment` 一份），`tasks.ts` 里还有第三份 `safeDirName`。三处口径各自漂移，
 * 会出现"扫描算出的目录名与落盘用的目录名不一致"这类难查问题。现已收敛为
 * **唯一一份**并导出，供 `reserveUniqueDir` 与 `tasks.ts` 复用
 * （tasks.ts 的本地 `safeDirName` 已改为调用本函数）。
 *
 * 清理 #32：原先另有一个非原子的 `uniqueDir`（check-then-act 版）导出，经 grep 确认
 * 全仓无任何调用（`reserveUniqueDir` 也不依赖它），已删除。
 */
export function safeDirSegment(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '解压结果';
}

/**
 * 「**占用即创建**」的原子语义建目录（同名自动避让）。
 *
 * 为什么需要它（并发场景的真实缺陷）：
 *   先 `fs.existsSync(target)` 判重、再创建，属于 **check-then-act**：
 *   两个同名、不同来源的任务在**谁都没建目录**的窗口里会同时拿到同一个路径，
 *   于是两个 7z 进程往同一个目录里写，产物互相覆盖/被 `-aou` 改名，
 *   最终用户拿到的是"少文件"甚至"7-Zip 返回码 2"，且任务仍报 done（静默丢文件）。
 *
 *   本函数用**非递归** `fs.mkdirSync(target)` 把"检查 + 创建"合成一个原子操作：
 *   目录已被别人抢占（或已存在）就抛 `EEXIST`，递增序号重试。
 *   返回的是**已经被本次调用创建/确认存在**的目录绝对路径。
 *
 * 这是并发写入路径（`tasks.ts` 自动建子目录分支）唯一使用的建目录入口。
 */
export function reserveUniqueDir(parent: string, name: string): string {
  const safe = safeDirSegment(name);
  // 父目录不存在时，非递归 mkdir 会抛 ENOENT；先确保父目录存在。
  fs.mkdirSync(parent, { recursive: true });

  let target = path.join(parent, safe);
  let n = 2;
  for (;;) {
    try {
      // 非递归：目录已存在 → EEXIST（原子判重）
      fs.mkdirSync(target);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        target = path.join(parent, `${safe}_${n}`);
        n += 1;
        continue;
      }
      throw e;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7-Zip 进度解析：形如 " 45% 12 - filename"
 * ------------------------------------------------------------------ */
export function parsePercent(chunk: string): { percent: number; current?: string } | null {
  /* 修复 ⑤：旧实现用 `/(\d{1,3})%/g` 取 chunk 内**最后一个**百分号 —— 一旦文件名里含
   * `%`（如 `进度100%.txt`），就会把文件名里的数字当成进度，进度条瞬间跳错。
   *
   * 7z 的进度行（`-bsp1`）形如 `\r 45% 12 - name`，百分比位于**行首**。这里优先只认
   * 行首百分比（文件名里的 `%` 天然被排除）；一个 chunk 里可能含多次刷新
   * （`\r 10%\r 45%`）时取**最后一个行首匹配** = 最新进度。万一输出格式变化导致
   * 行首匹配不到，再退回"首个 `\d+%` 匹配"兜底，保证不丢进度。 */
  const lineRe = /(?:^|[\r\n])[ \t]*(\d{1,3})%/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = lineRe.exec(chunk)) !== null) last = m;

  let percent: number;
  if (last) {
    percent = parseInt(last[1], 10);
  } else {
    const any = chunk.match(/(\d{1,3})%/);
    if (!any) return null;
    percent = parseInt(any[1], 10);
  }
  percent = Math.max(0, Math.min(100, percent));

  // 文件名：优先锚定到进度行（`NN% ... - name`），同样避免被文件名里的 `%` 带偏。
  const fm =
    chunk.match(/(?:^|[\r\n])[ \t]*\d{1,3}%[^\r\n]*?-\s+([^\r\n]+)/) ??
    chunk.match(/\d{1,3}%[^\r\n]*?-\s+([^\r\n]+)/);
  return { percent, current: fm ? fm[1].trim() : undefined };
}

/** 把 7-Zip 的错误输出翻译成人话 */
export function classifyError(code: number, output: string): { code: 'password' | 'not-archive' | 'disk' | 'permission' | 'cancelled' | 'unknown'; message: string } {
  const o = output.toLowerCase();
  if (/wrong password|cannot open encrypted|enter password|data error in encrypted/i.test(output)) {
    return { code: 'password', message: '密码错误或压缩包已加密，请提供正确密码' };
  }
  if (/is not supported archive|cannot open file as archive|not a archive/.test(o)) {
    return { code: 'not-archive', message: '不是可识别的压缩文件，或文件已损坏' };
  }
  if (/there is not enough space|disk full|not enough space/.test(o)) {
    return { code: 'disk', message: '目标磁盘空间不足' };
  }
  if (/access is denied|cannot create file|permission denied/.test(o)) {
    return { code: 'permission', message: '没有写入权限，请更换输出目录或检查文件占用' };
  }
  if (code === 255 || /break signaled|terminated/.test(o)) {
    return { code: 'cancelled', message: '任务已取消' };
  }
  return { code: 'unknown', message: `解压/压缩失败（7-Zip 返回码 ${code}）` };
}

/* 读配置目录（用户级）。实现已抽到 `./paths`：`logger` 也要用，留在本文件会与
 * `logger` 形成循环依赖。这里 re-export，保持既有导入路径（index/workflows）不变。 */
export { userDataDir } from './paths';
