/**
 * 启动期回收：清理上一次运行遗留的临时目录
 *
 * 背景：解压过程中的临时目录 `.sz333-tmp-*` 与分层目录 `_L*` 建在**用户输出目录**里；
 * 进程被强杀 / 崩溃 / 断电时来不及清理，下次启动必须回收，否则残留会一直堆在用户目录。
 *
 * 关键约束：启动时无从扫描全盘，因此需要一份"进行中输出目录"清单（inflight.json）——
 * 任务开始时登记、结束时注销；启动时只清理清单里这些目录，且**只删**：
 *   · `.sz333-tmp-*`（我们自己的临时目录，递归删）
 *   · **空的** `_L*` 分层目录（非空一律保留 —— 那是真产物）
 * 绝不触碰用户文件，也不删非空目录。
 *
 * 同一输出目录可能被多个任务共用（并发闸门只限全局、输出目录锁才串行），
 * 故用**引用计数**登记，最后一个持有者注销后才从清单移除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths';
import { logger } from './logger';

/** 临时目录前缀（与 tasks.ts 的 tempDirOf 保持一致） */
const TMP_PREFIX = '.sz333-tmp-';
/** 分层目录形如 `资源名_L1` / `_L2` */
const LAYER_RE = /_L\d+$/;

/** 进程内引用计数：outDir → 正在使用它的任务数 */
const active = new Map<string, number>();

function inflightFile(): string {
  return path.join(userDataDir(), 'inflight.json');
}

function persist(): void {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(inflightFile(), JSON.stringify(Array.from(active.keys()), null, 2), 'utf8');
  } catch (e) {
    logger.warn(`写入 inflight 清单失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 任务开始使用某输出目录时登记 */
export function registerInflight(outDir: string): void {
  if (!outDir) return;
  active.set(outDir, (active.get(outDir) ?? 0) + 1);
  persist();
}

/** 任务结束（成功/失败/取消）时注销 */
export function unregisterInflight(outDir: string): void {
  if (!outDir) return;
  const n = (active.get(outDir) ?? 0) - 1;
  if (n <= 0) active.delete(outDir);
  else active.set(outDir, n);
  persist();
}

/**
 * 清理单个输出目录里我们自己的临时目录与**空**的分层目录。
 * @returns 清理掉的条目数
 */
export function cleanupOutDir(outDir: string): number {
  let removed = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(outDir, e.name);

    if (e.name.startsWith(TMP_PREFIX)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        logger.warn(`清理临时目录失败：${full} -> ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    if (LAYER_RE.test(e.name)) {
      try {
        // 只删空的分层目录；非空保留（那是真产物）
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
          removed += 1;
        }
      } catch {
        /* 被占用等：跳过，不影响其它条目 */
      }
    }
  }
  return removed;
}

/** 启动期回收：读取清单 → 逐个清理 → 清空清单 */
export function recoverInflight(): void {
  let list: string[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(inflightFile(), 'utf8'));
    if (Array.isArray(raw)) list = raw.filter((x): x is string => typeof x === 'string' && !!x);
  } catch {
    return; // 无清单或损坏：无事可做
  }
  if (!list.length) return;

  let total = 0;
  for (const dir of list) total += cleanupOutDir(dir);
  active.clear();
  persist();
  logger.info(`启动回收：清理了 ${total} 个残留临时/空目录（涉及 ${list.length} 个输出目录）`);
}
