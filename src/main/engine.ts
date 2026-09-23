import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ArchiveFormat, ArchiveInfo, ArchiveEntry } from '@shared/types';
import { FORMATS } from '@shared/types';
import { findDuplicates } from './dedup';

const execFileAsync = promisify(execFile);

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
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return '7z.exe'; // 交给 PATH
}

/* ------------------------------------------------------------------ *
 * 魔数识别（按文件头判断真实格式，不信任扩展名）
 * ------------------------------------------------------------------ */
export function sniffFormat(buf: Buffer): ArchiveFormat {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7) && buf[3] === 4) return 'zip';
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

/* ------------------------------------------------------------------ *
 * 分卷归组：partN / .NNN / .zNN / .rNN 都识别为同一组
 * ------------------------------------------------------------------ */
export function volumeKey(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
  }
  return s.toLowerCase();
}

export function isVolumeMember(fileName: string): boolean {
  return /\.(part\d+(\.(rar|zip|7z))?|z\d{2}|r\d{2}|\d{3})$/i.test(fileName);
}

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

export function scanPaths(inputs: string[]): ScannedPack[] {
  const files: string[] = [];
  for (const p of inputs) {
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        if (entry.isFile()) files.push(path.join(p, entry.name));
      }
    } else {
      files.push(p);
    }
  }

  // 分组键 = 所在目录 + 分卷基名
  //   v1.0.2 修正：原先只用「文件基名」，导致不同目录下的同名包
  //   （如 D:\下载\RX.rar 与 D:\备份\RX.rar）被错误合并成一组，
  //   其中一个会被 pickPrimary 静默忽略 —— 该解的包可能根本没解。
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const dir = path.dirname(f);
    const base = volumeKey(path.basename(f)) || path.basename(f);
    const key = dir + '\u0000' + base;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  const packs: ScannedPack[] = [];
  for (const [key, members] of groups) {
    const primary = pickPrimary(members);
    let format: ArchiveFormat = sniffByExt(primary);
    try {
      const fd = fs.openSync(primary, 'r');
      const buf = Buffer.alloc(600);
      const read = fs.readSync(fd, buf, 0, 600, 0);
      fs.closeSync(fd);
      const byMagic = sniffFormat(buf.subarray(0, read));
      if (byMagic !== 'unknown') format = byMagic;
    } catch {
      /* 读不到就沿用扩展名判断 */
    }

    const size = members.reduce((s, f) => {
      try {
        return s + fs.statSync(f).size;
      } catch {
        return s;
      }
    }, 0);

    const meta = FORMATS[format];
    packs.push({
      id: `${key}-${Math.random().toString(36).slice(2, 8)}`,
      kind: members.length > 1 ? 'multi' : 'single',
      baseName: path.basename(members[0]).replace(/\.[^.]+$/, ''),
      files: members.sort(),
      /** 逐分卷字节数（按文件名排序后，与 files 顺序一致）——用于前端比对重复 */
      volumeSizes: members.map((f) => safeStatSize(f)),
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
    safeStatSize
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

function safeStatSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 调用 7z（统一入口，支持取消与实时进度回调）
 * ------------------------------------------------------------------ */
export interface Run7zOptions {
  args: string[];
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
}

export function run7z(opts: Run7zOptions): { promise: Promise<Run7zResult>; cancel: () => void } {
  const bin = resolve7z();
  let child: ChildProcess | null = null;
  let stdout = '';
  let stderr = '';
  let cancelled = false;
  let settled = false;

  const promise = new Promise<Run7zResult>((resolve) => {
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, cancelled });
    };

    try {
      // 用 spawn 而不是 execFile：7z 的进度用 \r 在同一行刷新，
      // 逐块回调才能实时拿到百分比，同时避免"回调 + 事件"双写同一份输出。
      child = spawn(bin, opts.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');

      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
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
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
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

export function parseListing(stdout: string): ParsedListing {
  const lines = stdout.split(/\r?\n/);
  const entries: ArchiveEntry[] = [];
  let cur: PendingEntry = {};
  let archiveType: ArchiveFormat = 'unknown';
  let encrypted = false;
  let fileCount = 0;

  const flush = () => {
    if (!cur.path) return;
    const isDir = cur.attributes?.includes('D') || cur.path.endsWith('\\') || cur.path.endsWith('/');
    entries.push({
      path: cur.path,
      size: cur.size ?? 0,
      packedSize: cur.packedSize ?? 0,
      isDir: !!isDir,
      encrypted: !!cur.encrypted,
      crc: cur.crc,
      modified: cur.modified
    });
    if (!isDir) fileCount += 1;
    cur = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (i === 0 && line.startsWith('Listing archive:')) continue;

    // 分隔线开启了新条目
    if (line.startsWith('----------')) {
      flush();
      continue;
    }
    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 3).trim();

    switch (k) {
      case 'Path':
        cur.path = v;
        break;
      case 'Type':
        // 头部块的 Type = 压缩格式；条目块的 Type = File / Folder
        if (!cur.path) {
          if (v === '7z' || v === 'zip' || v === 'rar' || v === 'tar' || v === 'bzip2' || v === 'xz' || v === 'cab') {
            archiveType = v as ArchiveFormat;
          } else if (v === 'gzip') {
            archiveType = 'gz';
          }
        } else if (v === 'Directory') {
          cur.attributes = 'D';
        }
        break;
      case 'Size':
        if (cur.path) cur.size = Number(v) || 0;
        break;
      case 'Packed Size':
        if (cur.path) cur.packedSize = Number(v) || 0;
        break;
      case 'Attributes':
        cur.attributes = v;
        break;
      case 'Encrypted':
        if (cur.path) cur.encrypted = v === '+';
        else if (v === '+') encrypted = true;
        break;
      case 'CRC':
        cur.crc = v;
        break;
      case 'Modified':
        cur.modified = v;
        break;
      case 'Method':
        if (v && cur.path && v !== 'Store' && /AES/i.test(v)) cur.encrypted = true;
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
    packedSize
  };
}

/** 列出压缩包内容 */
export async function listArchive(archivePath: string, password?: string, maxEntries = 3000): Promise<ArchiveInfo> {
  const args = ['l', '-slt', '-sccUTF-8', `-p${password ?? ''}`, '--', archivePath];
  const { promise } = run7z({ args });
  const res = await promise;
  const out = res.stdout || res.stderr;
  const parsed = parseListing(out);
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
    truncated: parsed.entries.length > maxEntries,
    passwordRequired: enc
  };
}

/** 测试压缩包是否需要密码（只读取列表即可判断） */
export async function needsPassword(archivePath: string): Promise<boolean> {
  const { promise } = run7z({ args: ['l', '-slt', '-p', '--', archivePath] });
  const res = await promise;
  return /Wrong password|Cannot open encrypted|Enter password/i.test(res.stdout + res.stderr);
}

/* ------------------------------------------------------------------ *
 * 输出目录命名（同名自动避让）
 * ------------------------------------------------------------------ */
export function uniqueDir(parent: string, name: string): string {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || '解压结果';
  let target = path.join(parent, safe);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(parent, `${safe}_${n}`);
    n += 1;
  }
  return target;
}

export function uniqueFile(parent: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'archive';
  let target = path.join(parent, name);
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(parent, `${stem}_${n}${ext}`);
    n += 1;
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * 7-Zip 进度解析：形如 " 45% 12 - filename"
 * ------------------------------------------------------------------ */
export function parsePercent(chunk: string): { percent: number; current?: string } | null {
  const m = chunk.match(/(\d{1,3})%/g);
  if (!m) return null;
  const percent = Math.max(0, Math.min(100, parseInt(m[m.length - 1], 10)));
  const fm = chunk.match(/%[^\r\n]*?-\s+([^\r\n]+)/);
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

/** 读配置目录（用户级，避免 Program Files 只读问题） */
export function userDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'sz333-unpack-desktop');
}
