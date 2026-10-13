/**
 * 统一日志出口
 *
 * 职责边界（重要）：
 *   · 本模块是**开发者诊断日志** —— 记录失败、异常、降级，供排查问题。
 *   · 面向用户的"任务逐层日志"是 `tasks.ts` 里的 `layerLog`（随任务卡片展示），
 *     两者分工不同，互不替代。
 *
 * 级别：error > warn > info > debug（默认 info）
 *   · 可用环境变量 `SZ333_LOG=debug` 提升到 debug。
 *
 * 输出目标：
 *   · 文件 `%APPDATA%\sz333-unpack-desktop\app.log`（主目标，带大小上限）
 *   · 开发期镜像到 console（由 index.ts 调用 initLogger({ consoleMirror: isDev }) 开启）
 *
 * 约定：日志写入失败**绝不能影响主流程** —— 所有写入都吞掉异常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** app.log 大小上限；超出后保留末尾一半，避免无限增长 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let minLevel: LogLevel = 'info';
let consoleMirror = false;
let initialized = false;

export function initLogger(opts: { level?: LogLevel; consoleMirror?: boolean } = {}): void {
  if (initialized) return;
  initialized = true;
  const env = process.env.SZ333_LOG as LogLevel | undefined;
  if (env && env in LEVEL_ORDER) minLevel = env;
  if (opts.level && opts.level in LEVEL_ORDER) minLevel = opts.level;
  consoleMirror = !!opts.consoleMirror;
}

function logFile(): string {
  return path.join(userDataDir(), 'app.log');
}

/** 超出上限时截断保留末尾一半 */
function rotateIfNeeded(file: string): void {
  try {
    const st = fs.statSync(file);
    if (st.size <= MAX_LOG_BYTES) return;
    const buf = fs.readFileSync(file);
    fs.writeFileSync(file, buf.subarray(Math.floor(buf.length - MAX_LOG_BYTES / 2)));
  } catch {
    /* 文件不存在等：无需处理 */
  }
}

function write(level: LogLevel, msg: string): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[minLevel]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`;
  if (consoleMirror) {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line.trimEnd());
  }
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    const file = logFile();
    rotateIfNeeded(file);
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 日志写不进去也不能影响主流程 */
  }
}

export const logger = {
  error: (msg: string) => write('error', msg),
  warn: (msg: string) => write('warn', msg),
  info: (msg: string) => write('info', msg),
  debug: (msg: string) => write('debug', msg)
};
