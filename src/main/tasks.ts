import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, TaskRecord, TaskStatus, TaskOp, WorkflowProgressEvent } from '@shared/types';
import { classifyError, parsePercent, run7z, uniqueDir } from './engine';
import { applyAsciiPolicy, archiveStem, type RenamePair } from './asciiPath';
import { hasNonAscii } from './asciiName';
import {
  matchWorkflow,
  buildFromResult,
  buildFingerprint,
  onHit,
  onMiss,
  isUsable,
  normalizeWorkflow,
  type Workflow,
  type WorkflowStep
} from './workflows';

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

interface InternalTask extends TaskRecord {
  abort?: AbortController;
  password?: string;
  extra?: Record<string, unknown>;
}

export interface TaskManagerDeps {
  getSettings: () => AppSettings;
  emit: (task: TaskRecord) => void;
  toast: (kind: 'ok' | 'warn' | 'bad' | 'info', title: string, desc?: string) => void;
  /** 工作流读写（由主进程注入，保证单一数据源） */
  workflows: { list: () => Workflow[]; save: () => void };
  /** 工作流匹配过程上报（界面显示"命中/走探测/已停用"） */
  onWorkflowProgress?: (e: WorkflowProgressEvent) => void;
  /** 工作流数据变更（界面刷新卡片） */
  onWorkflowsChanged?: () => void;
  /** ASCII 改名上报（界面在日志里逐条列出 原名 → 新名，保证用户找得到文件） */
  onRenamed?: (info: {
    taskId: string;
    outDir: string;
    dirChanged: boolean;
    renames: RenamePair[];
    conflicts: number;
  }) => void;
}

/**
 * 任务管理：队列 + 并发闸门 + 暂停/恢复/取消/重试
 *
 * 说明（诚实设计）：
 *  - 「取消」立即终止 7z 进程（Windows 上通过 kill），未完成的输出目录会被清理。
 *  - 「暂停」在 Windows 下无法挂起外部进程，实现为"取消当前进程并保留任务状态"，
 *    恢复时从头开始（进度不保留）。UI 上会明确标注"暂停后恢复将重新开始"。
 */
export class TaskManager extends EventEmitter {
  private tasks = new Map<string, InternalTask>();
  private order: string[] = [];
  private running = new Map<string, { cancel: () => void }>();
  private slots = 0;
  private deps: TaskManagerDeps;
  private disposed = false;

  constructor(deps: TaskManagerDeps) {
    super();
    this.deps = deps;
  }

  list(): TaskRecord[] {
    return this.order.map((id) => this.publicTask(this.tasks.get(id)!)).filter(Boolean);
  }

  private publicTask(t: InternalTask): TaskRecord {
    const { abort: _a, password: _p, extra: _e, ...rest } = t;
    return rest;
  }

  private patch(id: string, patch: Partial<InternalTask>) {
    const t = this.tasks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    this.deps.emit(this.publicTask(t));
  }

  private setStatus(id: string, status: TaskStatus, extra: Partial<InternalTask> = {}) {
    const ended = status === 'done' || status === 'failed' || status === 'cancelled';
    this.patch(id, {
      status,
      ...(ended ? { endedAt: Date.now(), progress: status === 'cancelled' ? null : undefined } : {}),
      ...extra
    });
  }

  /* ------------------------------ 入队 ------------------------------ */

  add(input: {
    op: TaskOp;
    label: string;
    sourcePaths: string[];
    outDir: string;
    password?: string;
    extra?: Record<string, unknown>;
  }): TaskRecord {
    const t: InternalTask = {
      id: nextId(),
      op: input.op,
      label: input.label,
      sourcePaths: input.sourcePaths,
      outDir: input.outDir,
      status: 'queued',
      progress: 0,
      processed: 0,
      total: input.sourcePaths.length,
      password: input.password,
      extra: input.extra
    };
    this.tasks.set(t.id, t);
    this.order.push(t.id);
    this.deps.emit(this.publicTask(t));
    void this.pump();
    return this.publicTask(t);
  }

  /* ------------------------------ 并发闸门 ------------------------------ */

  private async pump() {
    if (this.disposed) return;
    const max = Math.max(1, this.deps.getSettings().maxConcurrent || 1);
    while (this.slots < max) {
      const next = this.order
        .map((id) => this.tasks.get(id)!)
        .find((t) => t && t.status === 'queued');
      if (!next) return;
      this.slots += 1;
      void this.execute(next.id).finally(() => {
        this.slots -= 1;
        void this.pump();
      });
    }
  }

  /* ------------------------------ 执行 ------------------------------ */

  private async execute(id: string) {
    const t = this.tasks.get(id);
    if (!t) return;

    const settings = this.deps.getSettings();
    const abort = new AbortController();
    t.abort = abort;
    this.patch(id, { status: 'running', startedAt: Date.now(), progress: 0, error: undefined, endedAt: undefined });

    try {
      await this.runExtract(t, settings, abort);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(id, 'failed', { error: { code: 'unknown', message: msg } });
    }
  }

  /** 解压：分卷只需给主分卷路径 */
  private async runExtract(t: InternalTask, settings: AppSettings, abort: AbortController) {
    const src = t.sourcePaths[0];
    const srcDir = path.dirname(src);
    let outDir = t.outDir;
    if (!outDir) {
      const base = settings.defaultOutDir || srcDir;
      outDir = settings.extractToSubfolder
        ? uniqueDir(base, path.basename(src).replace(/\.[^.]+$/, ''))
        : base;
    }
    fs.mkdirSync(outDir, { recursive: true });

    // 覆盖策略 → 7z 开关
    const overwriteFlag =
      settings.overwrite === 'skip' ? '-aos' : settings.overwrite === 'rename' ? '-aou' : '-aoa';

    /* ============================================================
     * 工作流匹配：以「该来源第一层命中的解压密码」为锚点
     *  1) 先用锚点密码直接按链路解压（跳过探测与试错）
     *  2) 若锚点密码失效 → 记一次失误（密码错即刻停用），回退常规探测
     *  3) 解压成功后把本次链路存成卡片，或累计命中次数
     *
     * 注意：源文件集合与指纹必须在**解压开始前**采集。
     *   源文件处理默认是"彻底删除"，解压成功后源包就没了；
     *   若在解压后才采集，指纹会算成空值，导致工作流记录退化、同源再也匹配不上。
     * ============================================================ */
    const sourceFiles = collectSourceFiles(t.sourcePaths, src);
    const fingerprint = buildFingerprint(sourceFiles);
    const primVolSize = sourceFiles[0] ? safeSize(sourceFiles[0]) : 0;
    const baseName = path.basename(src).replace(/\.[^.]+$/, '');
    const wfList = this.deps.workflows.list();
    const m = matchWorkflow(wfList, baseName, fingerprint, 0, 1, settings.passwords);
    let matched: Workflow | null = m.flow;

    if (matched) {
      this.deps.onWorkflowProgress?.({
        taskId: t.id,
        kind: 'matched',
        text: m.reason,
        workflowId: matched.id,
        anchorPassword: matched.anchorPassword
      });
      this.patch(t.id, { currentFile: `命中工作流：${matched.name}` });
    } else if (m.reason) {
      this.deps.onWorkflowProgress?.({ taskId: t.id, kind: 'probe', text: m.reason });
    }

    /** 本次解压用于生成/更新工作流记录的链路步骤 */
    const steps: WorkflowStep[] = [];

    /** 候选密码顺序：命中卡片时锚点密码优先 */
    const candidates: string[] = [];
    if (matched?.anchorPassword) candidates.push(matched.anchorPassword);
    for (const p of settings.passwords) {
      if (p && !candidates.includes(p)) candidates.push(p);
    }

    let password = t.password ?? '';
    let lastErrCode = 'unknown';
    let lastErrMsg = '';
    let ranOnce = false;

    // 先探是否需要密码（不加密的包直接无密码解压；避免多余的一次探测开销之外还拖慢首次匹配）
    if (!password) {
      const probe = await run7z({ args: ['l', '-slt', '-p', '--', src] }).promise;
      const enc = /Wrong password|Cannot open encrypted|Enter password/i.test(probe.stdout + probe.stderr);
      if (enc) {
        password = candidates.length ? candidates[0] : '';
      }
    }

    for (let attempt = 0; attempt <= candidates.length; attempt++) {
      // 第 0 次：命中卡片时用锚点密码（或上面探出的第一个候选）；之后逐个尝试
      if (attempt > 0) {
        const next = candidates[attempt - 1];
        if (!next || next === password) continue;
        password = next;
      }

      // 覆盖策略：同名文件按设置处理
      const args = [
        'x',
        '-y',
        '-bso0',
        '-bsp1',
        '-sccUTF-8',
        overwriteFlag,
        `-o${outDir}`,
        `-p${password}`,
        '--',
        src
      ];

      let lastFile: string | undefined;
      const runner = run7z({
        args,
        signal: abort.signal,
        onStdout: (chunk) => {
          const p = parsePercent(chunk);
          if (p) {
            if (p.current) lastFile = p.current;
            this.patch(t.id, { progress: p.percent, currentFile: lastFile });
          }
        }
      });
      this.running.set(t.id, runner);

      const res = await runner.promise;
      this.running.delete(t.id);
      ranOnce = true;

      if (abort.signal.aborted || res.cancelled) {
        this.cleanupPartial(outDir, src);
        this.setStatus(t.id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
        return;
      }

      const out = res.stdout + res.stderr;

      if (res.code === 0 || res.code === 1) {
        // 成功：记录本层命中密码，形成链路
        steps.push({ inputExt: path.extname(src), fakeExt: '', realFormat: '', password, renameTo: '' });
        break;
      }

      const err = classifyError(res.code, out);
      lastErrCode = err.code;
      lastErrMsg = err.message;

      if (err.code === 'password') {
        // 锚点密码失效 → 该卡片记一次失误（密码错立即停用）
        if (matched) {
          const disabled = onMiss(matched, true);
          this.deps.workflows.save();
          this.deps.onWorkflowsChanged?.();
          this.deps.onWorkflowProgress?.({
            taskId: t.id,
            kind: disabled ? 'disabled' : 'miss',
            text: disabled
              ? `工作流【${matched.name}】锚点密码已失效，已自动停用`
              : `工作流【${matched.name}】密码未命中，本次改为常规探测`,
            workflowId: matched.id
          });
          matched = null;
        }
        this.patch(t.id, { progress: 0, currentFile: '密码不正确，尝试下一个…' });
        continue; // 换下一个密码
      }

      // 非密码类失败：直接失败
      this.setStatus(t.id, 'failed', { error: { code: err.code, message: err.message, raw: res.stderr.slice(-2000) } });
      return;
    }

    if (!ranOnce) {
      this.setStatus(t.id, 'failed', { error: { code: 'unknown', message: '未能启动解压进程' } });
      return;
    }

    // 所有候选密码都失败 → 请用户输入
    const stillFailed = steps.length === 0;
    if (stillFailed) {
      if (lastErrCode === 'password') {
        this.setStatus(t.id, 'needs-password', {
          archivePath: src,
          error: { code: 'password', message: lastErrMsg || '密码错误，请提供正确密码' }
        });
      } else {
        this.setStatus(t.id, 'failed', {
          error: { code: 'unknown', message: lastErrMsg || '解压失败' }
        });
      }
      return;
    }

    // ---- 中文路径处理（老资源包对中文路径不友好）----
    let finalOutDir = outDir;
    if (settings.nonAsciiPolicy !== 'off') {
      const needByPolicy = settings.nonAsciiPolicy === 'force' || hasNonAscii(outDir);
      if (needByPolicy) {
        try {
          const ascii = applyAsciiPolicy(outDir, archiveStem(path.basename(src), sourceFiles));
          finalOutDir = ascii.outDir;
          if (ascii.dirChanged || ascii.renames.length > 0) {
            this.deps.onRenamed?.({
              taskId: t.id,
              outDir: finalOutDir,
              dirChanged: ascii.dirChanged,
              renames: ascii.renames,
              conflicts: ascii.conflicts
            });
            this.deps.toast(
              'info',
              '已将中文路径转为英文',
              `目录${ascii.dirChanged ? '已改为 ' + finalOutDir.split(/[\\/]/).pop() : '保持不变'} · ` +
                `改名 ${ascii.renames.length} 项${ascii.conflicts ? ` · 同名加序号 ${ascii.conflicts} 项` : ''}`
            );
          }
        } catch (e) {
          this.deps.toast('warn', '中文路径转换失败', e instanceof Error ? e.message : String(e));
        }
      }
    }

    // 统计结果
    const stat = dirStats(finalOutDir);

    // ---- 源文件处理：保留 / 彻底删除 ----
    const sources = t.sourcePaths.filter((p) => fs.existsSync(p));
    if (settings.sourcePolicy === 'delete' && sources.length) {
      let deleted = 0;
      for (const p of sources) {
        try {
          fs.rmSync(p, { force: true });
          deleted += 1;
        } catch {
          /* ignore */
        }
      }
      this.deps.toast('info', '源文件已彻底删除', `共 ${deleted} 个文件（不可恢复）`);
    }
    if (settings.rememberPasswords && password && !settings.passwords.includes(password)) {
      this.deps.emit({ ...this.publicTask(t) });
    }

    // ---- 工作流收尾：命中则累计，未命中则把本次链路存成卡片 ----
    if (matched) {
      onHit(matched, 1);
      this.deps.workflows.save();
      this.deps.onWorkflowsChanged?.();
      this.deps.onWorkflowProgress?.({
        taskId: t.id,
        kind: 'saved',
        text: `工作流【${matched.name}】命中成功（累计 ${matched.hitCount} 次）`,
        workflowId: matched.id
      });
    } else if (steps.length > 0 && steps.some((s) => s.password)) {
      const list = this.deps.workflows.list();
      const fresh = buildFromResult({
        baseName,
        steps,
        primVolSize,
        files: sourceFiles
      });
      if (fresh) {
        // 同锚点覆盖旧记录，保持"一个锚点一条生效记录"
        const dupIdx = list.findIndex((w) => w.anchorPassword && w.anchorPassword === fresh.anchorPassword);
        if (dupIdx >= 0) list.splice(dupIdx, 1);
        list.push(fresh);
        this.deps.workflows.save();
        this.deps.onWorkflowsChanged?.();
        this.deps.onWorkflowProgress?.({
          taskId: t.id,
          kind: 'saved',
          text: `已记住这条解压套路：【${fresh.name}】（锚点密码 ${fresh.anchorPassword || '无'}）`,
          workflowId: fresh.id
        });
      }
    }

    this.setStatus(t.id, 'done', {
      progress: 100,
      outputPath: finalOutDir,
      outputSize: stat.size,
      fileCount: stat.files
    });
    this.deps.toast('ok', '解压完成', `${t.label} → ${stat.files} 个文件`);
    if (settings.autoOpenOutDir) this.emit('open', finalOutDir);
  }

  /** 取消后清理未完成的输出目录（只在目录为空或仅含部分文件时删除，避免误删用户已有数据） */
  private cleanupPartial(outDir: string, src: string) {
    try {
      if (!outDir || outDir === path.dirname(src)) return;
      if (!fs.existsSync(outDir)) return;
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------ 外部控制 ------------------------------ */

  pause(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return false;
    const r = this.running.get(id);
    r?.cancel();
    this.setStatus(id, 'paused', { error: { code: 'cancelled', message: '已暂停，恢复后将重新开始' } });
    return true;
  }

  resume(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'paused') return false;
    this.setStatus(id, 'queued', { error: undefined, progress: 0, currentFile: undefined });
    void this.pump();
    return true;
  }

  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === 'running') {
      this.running.get(id)?.cancel();
      return true;
    }
    if (t.status === 'queued' || t.status === 'paused' || t.status === 'needs-password') {
      this.setStatus(id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
      return true;
    }
    return false;
  }

  retry(id: string, password?: string, outDir?: string): TaskRecord | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    if (password) {
      t.password = password;
      const s = this.deps.getSettings();
      if (s.rememberPasswords && !s.passwords.includes(password)) {
        s.passwords = [password, ...s.passwords].slice(0, 30);
      }
    }
    if (outDir) t.outDir = outDir;
    this.setStatus(id, 'queued', { error: undefined, progress: 0, currentFile: undefined, endedAt: undefined });
    void this.pump();
    return this.publicTask(t);
  }

  remove(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    if (t.status === 'running') this.running.get(id)?.cancel();
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit('removed', id);
    return true;
  }

  clearFinished(): number {
    const keep: string[] = [];
    let n = 0;
    for (const id of this.order) {
      const t = this.tasks.get(id);
      if (!t) continue;
      if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') {
        this.tasks.delete(id);
        n += 1;
      } else {
        keep.push(id);
      }
    }
    this.order = keep;
    return n;
  }

  dispose() {
    this.disposed = true;
    for (const [, r] of this.running) r.cancel();
    this.running.clear();
  }
}

/* ------------------------------ 小工具 ------------------------------ */

/** 收集该分组的全部源文件（分卷包要把所有分卷都算进指纹） */
function collectSourceFiles(sourcePaths: string[], primary: string): string[] {
  const dir = path.dirname(primary);
  const stem = volumeKeyOf(path.basename(primary));
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (volumeKeyOf(entry.name) === stem) out.push(path.join(dir, entry.name));
    }
  } catch {
    /* ignore */
  }
  if (!out.length) out.push(...sourcePaths.filter((p) => fs.existsSync(p)));
  return out.sort();
}

/** 与 engine.volumeKey 同口径：去掉扩展名与分卷尾号 */
function volumeKeyOf(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
  }
  return s.toLowerCase();
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function dirStats(dir: string): { files: number; size: number } {
  let files = 0;
  let size = 0;
  const walk = (d: string) => {
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
        files += 1;
        try {
          size += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return { files, size };
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
