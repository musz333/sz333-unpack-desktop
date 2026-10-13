import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';
import { registerInflight, unregisterInflight, cleanupOutDir } from './recovery';
import { fmtBytes } from '@shared/bytes';
import type { AppSettings, ArchiveInfo, TaskRecord, TaskStatus, TaskOp, WorkflowProgressEvent } from '@shared/types';
import { volumeKey, isVolumeMember } from '@shared/volumeKey';
import { classifyError, listArchive, parsePercent, reserveUniqueDir, run7z, safeDirSegment } from './engine';
import { applyAsciiPolicy, archiveStem, ensureAsciiOutDir, type RenamePair } from './asciiPath';
import { hasNonAscii } from './asciiName';
import { filterApks } from './apkFilter';
import {
  MAX_DEPTH,
  applyWorkflowStep,
  pickNextLayer,
  removeIntermediates,
  siblingsOfVolume,
  workflowPasswordForStep
} from './recursive';
import {
  matchWorkflow,
  buildFromResult,
  buildFingerprint,
  onHit,
  onMiss,
  type Workflow,
  type WorkflowStep
} from './workflows';

let seq = 0;
const nextId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

interface InternalTask extends TaskRecord {
  abort?: AbortController;
  password?: string;
  extra?: Record<string, unknown>;
  /**
   * 续解起点：上次因内层密码失败时，已经解出来的那个内层压缩包的绝对路径。
   *
   * 有它的意义：用户输对密码点重试时，**不要**把 200MB 的外层分卷再解一遍 ——
   * 那是白费时间、还可能在输出目录里留下一份重复副本（实测会生成 6345_2.JPG）。
   * 直接从内层包继续往下解即可。
   */
  resumeFrom?: string;
  /** 续解时已经完成的层数（用于日志与 layerCount 续算） */
  resumeLayers?: number;
  /** 续解时上一层留下的分层日志 */
  resumeLog?: string[];
  /**
   * 续解时上一层已经完成的链路步骤。
   *
   * 为什么必须带上：`steps` 是按**绝对层号**写入的数组。续解从第 N 层开始时，
   * 如果不把前 N 层补回来，`steps` 前段就是空洞（`steps[0] === undefined`），
   * 而 `buildFromResult` 会读 `steps[0].password` → TypeError → 被 execute()
   * 的 catch 兜成 `failed`。真实后果：**一次已经解压成功的任务被报成失败**，
   * 界面没有输出路径，用户以为"输完密码还是坏的"。同时存下来的工作流卡片
   * 也会只剩半截链路。
   */
  resumeSteps?: WorkflowStep[];
  /**
   * 本次任务持有的「输出目录写锁」释放函数（由 KeyedLock 返回）。
   *
   * 存在意义：同一输出目录同一时刻只允许一个任务写（见 KeyedLock 注释）。
   * 在 `execute()` 的 finally 里统一释放 —— 保证**任何退出路径**（成功 / 失败 /
   * 取消 / 抛异常）都不会漏放锁，否则后续同目录任务会永久等待。
   * 未取到锁（等待期间被取消）时该字段为 undefined。
   */
  releaseOutLock?: () => void;
}

/**
 * 按 key 串行化的互斥锁（同一个 key 同一时刻只允许一个持有者）。
 *
 * 为什么不用简单的计数：并发闸门 `slots` 只是**全局**并发上限，它不区分输出目录；
 * 多个任务完全可能同时写同一个目录，而 7z 的同名改名（`-aou`）是"先检查再写"，
 * 属于 TOCTOU —— JS 侧无法把它变原子。唯一正确的修法就是**让同一目录串行**。
 *
 * 不变量：
 *  1. 无死锁：每个任务只需要一把锁，持锁者从不等待别人。
 *  2. 等待可中断：`signal` 触发时 `acquire` 立即返回 null（调用方按取消处理）。
 *  3. `dispose()` 之后不再产生新的等待：`acquire` 立刻返回 null，且所有在等的人被唤醒。
 *  4. release 按获取顺序放行队尾，链式结构保证不会有人被永久饿死。
 */
class KeyedLock {
  /** key → 该 key 的队尾 promise（链式队列） */
  private tails = new Map<string, Promise<void>>();
  /** dispose 用：一旦 abort，所有在等的 acquire 立刻结束 */
  private ctrl = new AbortController();

  dispose(): void {
    this.ctrl.abort();
    this.tails.clear();
  }

  /**
   * 获取 key 的锁。
   * @returns 释放函数；返回 `null` 表示等待期间被取消或已 dispose（此时未持锁）。
   */
  async acquire(key: string, signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.ctrl.signal.aborted) return null;

    let releaseRaw!: () => void;
    const gate = new Promise<void>((res) => {
      releaseRaw = res;
    });

    const prev = this.tails.get(key);
    const tail = prev ? prev.then(() => gate) : gate;
    this.tails.set(key, tail);

    const release = () => {
      releaseRaw();
      // 若自己仍是队尾（后面没人排），清掉空条目，避免 Map 无限增长
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };

    if (!prev) return release; // 无人持锁 → 立即持有

    // 有人持锁 → 等它释放；可被 signal 或被 dispose 中断
    const aborted = await KeyedLock.wait(prev, signal, this.ctrl.signal);
    if (aborted) {
      // 中断后必须立刻放行队尾，否则后面的任务会永久等待（死锁）
      release();
      return null;
    }
    return release;
  }

  /** 等待 p 完成；signal / dispose 任一触发则提前返回 true（已中断） */
  private static wait(p: Promise<void>, signal?: AbortSignal, disposeSignal?: AbortSignal): Promise<boolean> {
    const aborted = (): boolean => !!signal?.aborted || !!disposeSignal?.aborted;
    if (aborted()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        disposeSignal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => done(true);
      signal?.addEventListener('abort', onAbort, { once: true });
      disposeSignal?.addEventListener('abort', onAbort, { once: true });
      p.then(() => done(false));
    });
  }
}

export interface TaskManagerDeps {
  getSettings: () => AppSettings;
  emit: (task: TaskRecord) => void;
  toast: (kind: 'ok' | 'warn' | 'bad' | 'info', title: string, desc?: string) => void;
  /**
   * 记住一个解压密码（写入设置并**落盘**）。
   *
   * 修复 P1-2 / P1-3：旧实现直接在 `getSettings()` 返回的对象上改 `passwords`
   * 数组 —— 既没有落盘，又会被随后的 `setSettings()`（整体替换 settings 引用）
   * 丢弃，等于白记；而"首轮成功解压"那条路径甚至只 emit 了一次任务、什么都没写。
   * 现在由主进程统一负责"写入 + persistSettings"。
   */
  rememberPassword: (pwd: string) => void;
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
  /**
   * 删源前二次确认（修复 P1-⑤）。
   *
   * 「源文件处理=彻底删除」是默认策略，但删除不可恢复。真正动手前由主进程弹窗
   * 让用户确认；返回 false = 用户取消 → 本次**原样保留**源文件。
   * 未注入该回调时按"允许删除"处理（保持旧行为，便于无 UI 场景/测试）。
   */
  confirmDeleteSource?: (info: { count: number; bytes: number; paths: string[] }) => Promise<boolean>;
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
  /**
   * 输出目录写锁：同一个归一化输出目录，同一时刻只允许一个任务在写。
   *
   * 为什么必须有它：`pump()` 的 `slots` 只是**全局**并发上限，不区分输出目录。
   * 当输出位置=源目录（或用户给所有任务指定同一个目录）时，多个任务会落到**同一个 outDir**；
   * 7z 的同名改名 `-aou` 是**7z 进程内部**的 check-then-act（我们改不了），
   * 并发写会互相覆盖 → 实测**静默丢文件**（4 个任务都报 done，却少了 26 个文件）。
   * 因此同一目录必须串行 —— 这是消除"7z 内部竞态"的正确做法。
   * 注意区分：**我们自己**的 check-then-act（`moveContentsInto` 的名字分配）是**可以**
   * 也必须原子化的，已改用 `COPYFILE_EXCL` / 非递归 mkdir（见该函数注释）。
   */
  private outLocks = new KeyedLock();

  /**
   * 暂停意图标记（修复 P0-4）。
   *
   * Windows 无法挂起外部进程，"暂停"实现为「终止 7z 进程 + 保留任务状态」。
   * 但终止进程会让 runExtract 走到取消分支 —— 若不分流，暂停会被异步改写成
   * "已取消"，并连带触发输出目录清理。命中取消分支时先消费本标记即可区分两者。
   */
  private pauseFlags = new Set<string>();

  constructor(deps: TaskManagerDeps) {
    super();
    this.deps = deps;
  }

  list(): TaskRecord[] {
    return this.order.map((id) => this.publicTask(this.tasks.get(id)!)).filter(Boolean);
  }

  private publicTask(t: InternalTask): TaskRecord {
    /* ------------------------------------------------------------
     * 只把「可结构化克隆」的纯数据字段送出去。
     *
     * `releaseOutLock` 是**函数**，必须在这里剥掉：
     * 它通过 IPC `webContents.send` 走 structured clone，函数**不可克隆**，
     * 一旦混进去，`send` 会同步抛「An object could not be cloned」，
     * 于是 `patch()` / `setStatus()` 全线炸掉 —— 症状极具迷惑性：
     * 任务在渲染层永远停在 running（因为它在拿到锁**之后**才会被赋值），
     * 而真实解压其实已经完成。`abort`（AbortController）同理。
     * ------------------------------------------------------------ */
    const { abort: _a, password: _p, extra: _e, releaseOutLock: _r, ...rest } = t;
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

    /* 清理可能残留的"暂停意图"（修复状态泄漏）。
     * 场景：pause() 先登记 pauseFlags 再终止进程；若任务几乎同时自然结束，
     * 该标记可能没有消费者而残留。下一次执行（resume / retry）时，
     * settleAborted 会因这个残留标记把一次**真实取消**误判成"暂停"。
     * 进入执行前先清一次，保证标记只对"本次 pause 调用"有效。 */
    this.pauseFlags.delete(id);

    const settings = this.deps.getSettings();
    const abort = new AbortController();
    t.abort = abort;
    this.patch(id, { status: 'running', startedAt: Date.now(), progress: 0, error: undefined, endedAt: undefined });

    try {
      await this.runExtract(t, settings, abort);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(id, 'failed', { error: { code: 'unknown', message: msg } });
    } finally {
      /* 释放输出目录写锁（**必须放在 finally**）—— 保证任何退出路径都不会漏放。 */
      const release = t.releaseOutLock;
      t.releaseOutLock = undefined;
      if (release) release();
      /* 注销"进行中输出目录"登记（与 runExtract 里的 registerInflight 配对）。 */
      unregisterInflight(t.outDir);
    }
  }

  /** 解压：分卷只需给主分卷路径 */
  private async runExtract(t: InternalTask, settings: AppSettings, abort: AbortController) {
    const src = t.sourcePaths[0];
    const srcDir = path.dirname(src);

    /**
     * 该分组的全部源文件（分卷包要把所有分卷都算进去）。
     *
     * **必须在解压开始之前采集**：源文件处理默认是"彻底删除"，解压成功后源包就没了；
     * 若在解压后才采集，指纹会算成空值 → 基准体积为 0 → 工作流第二批只拿 52 分并自动禁用。
     */
    const sourceFiles = collectSourceFiles(t.sourcePaths, src);

    /**
     * **资源名**：去掉分卷号与扩展名 —— `75.part1.rar` → `75`。
     *
     * 两处都用它：
     *  ① 「以包名新建子目录」时那个文件夹的名字
     *  ② 分层产物目录 `资源名_L1 / _L2`
     *
     * 首个参数传 `src`（确定是主卷）而不是 `sourceFiles[0]`：
     * collectSourceFiles 结尾做过 sort()，`sourceFiles[0]` 不保证是主卷。
     */
    /* 修复 #34：目录名净化统一走 engine.safeDirSegment（此前 tasks.ts 还留着一份
     * 本地 safeDirName，与 engine/asciiPath 的实现三处重复）。保留 80 字符长度上限。
     * 注：safeDirSegment 对空串返回「解压结果」，故 `|| 'resource'` 现为防御性兜底。 */
    const resourceStem = safeDirSegment(archiveStem(path.basename(src), sourceFiles)).slice(0, 80) || 'resource';

    let outDir = t.outDir;
    /** 输出目录是不是我们**自己按包名新建**的（而不是用户指定的）。
     *  只有自己建的、且跑完还是空的，才允许回收；用户指定的目录一律不动。 */
    let outDirAuto = false;
    if (!outDir) {
      /* ------------------------------------------------------------
       * 输出位置：由 outDirPolicy 决定（恢复 B 线 v1.9 的 UseSource 语义）。
       *   'source' → 源文件所在目录（默认）
       *   'custom' → 用户指定的 defaultOutDir；为空时**不静默**，
       *              明确提示后回落到源目录（避免"什么都没发生"的困惑）
       * ------------------------------------------------------------ */
      let base: string;
      if (settings.outDirPolicy === 'custom') {
        base = settings.defaultOutDir;
        if (!base) {
          base = srcDir;
          this.deps.toast(
            'warn',
            '未配置默认输出目录',
            '输出位置选了「指定目录」但目录为空，本次回落到源文件所在目录'
          );
        }
      } else {
        base = srcDir;
      }
      if (settings.extractToSubfolder) {
        // 占用即创建：并发下同名不同源的任务不会再拿到同一个目录（消除 check-then-act 竞态）
        outDir = reserveUniqueDir(base, resourceStem);
        outDirAuto = true;
      } else {
        outDir = base;
      }
      /* ------------------------------------------------------------
       * 把自己算出来的输出目录**写回任务**。
       *
       * 为什么必须写回（移植时修的缺陷，续解场景会真实踩到）：
       *   `reserveUniqueDir` 遇到同名目录会加序号（`资源名` → `资源名_2`）。
       *   续解（内层密码失败后重试）时若 outDir 还是空、又重算一次，
       *   算出来的就是 `资源名_2` —— 一个**全新的空目录**。
       *   而 `locateResumeTarget` 靠绝对路径/模糊匹配仍能在**旧目录**里
       *   找到内层包，于是续解成功、但内容落进新目录：
       *   用户看到的产物分裂在两处，`_L1` 还在旧的、最里层内容在 `_2` 里。
       *   写回后，续解复用同一个输出目录，产物归一。
       * ------------------------------------------------------------ */
      this.patch(t.id, { outDir });
    }
    fs.mkdirSync(outDir, { recursive: true });
    // 登记"进行中输出目录"：进程若被强杀，下次启动据此回收 .sz333-tmp-*（见 recovery.ts）
    registerInflight(outDir);

    /* ------------------------------------------------------------
     * 取「输出目录写锁」。
     *
     * 为什么在这一步（而不是更早）：outDir 在这里才最终确定并建好（含上面的
     * 「占用即创建」（reserveUniqueDir）分支），锁的 key 必须用**归一化后的最终路径**，
     * 否则 A 任务用 `D:\Out`、B 任务用 `d:\out` 会被当成两个不同的目录。
     *
     * 语义（严格按需求，不擅自改道、不直接判失败）：
     *   - 同一目录已有任务在写 → **等它结束再继续**（不是跳过、不是改目录）；
     *   - 等待期间任务被**取消**（abort）→ 立刻结束，不写任何文件；
     *   - `dispose()` 之后 → 不再产生新的等待。
     * 释放发生在 execute() 的 finally（任何退出路径都会放锁）。
     * ------------------------------------------------------------ */
    /* 锁 key 必须等于「最终会被写入的路径」（修复锁与真实资源不一致）。
     *
     * 收尾阶段可能把自建输出目录改成 ASCII 名（applyAsciiPolicy → renameSync），
     * 那时物理路径已经变了。若锁按改名**之前**的路径算，就会出现
     * 「A 持 `D:\中文\资源` 的锁、却写进 `D:\ascii\资源`；B 拿 `D:\ascii\资源` 的锁」
     * 这种锁不住同一目录的情况。这里提前算出最终路径，让锁与之对齐。
     *
     * 注意：ensureAsciiOutDir 是**纯路径计算**（只用 existsSync 做同名避让，
     * 不写文件系统），且输入与收尾阶段的 applyAsciiPolicy 完全一致
     * （同一个 outDir、同一个 resourceStem），因此两次结果一致。 */
    let plannedOutDir = outDir;
    if (outDirAuto && settings.nonAsciiPolicy !== 'off') {
      const needByPolicy = settings.nonAsciiPolicy === 'force' || hasNonAscii(outDir);
      if (needByPolicy) {
        try {
          plannedOutDir = ensureAsciiOutDir(outDir, resourceStem).dir;
        } catch {
          plannedOutDir = outDir;
        }
      }
    }
    const lockKey = path.resolve(plannedOutDir).toLowerCase();
    const releaseLock = await this.outLocks.acquire(lockKey, abort.signal);
    if (!releaseLock) {
      /* 走到这里只有两种可能：① 等待期间被 abort（取消/暂停）；② dispose（应用退出）。
       *
       * 修复 P0-6 之前 `abort.abort()` 从未被调用，`abort.signal.aborted` 恒为 false，
       * 这段实际上近乎死代码 —— 于是"取消一个正在等锁的任务"完全无效。
       * 现在 abort 会被真正触发，必须把暂停/取消分流清楚（P0-4）。 */
      if (this.disposed) return;
      if (this.pauseFlags.delete(t.id)) {
        this.setStatus(t.id, 'paused', {
          progress: 0,
          currentFile: undefined,
          error: { code: 'cancelled', message: '已暂停，恢复后将重新开始' }
        });
        return;
      }
      // 取消：自己建的（且为空的）输出子目录回收，用户指定的目录一律不动
      if (outDirAuto) removeDirIfEmpty(outDir);
      this.setStatus(t.id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
      return;
    }
    t.releaseOutLock = releaseLock;

    // 覆盖策略 → 7z 开关
    const overwriteFlag =
      settings.overwrite === 'skip' ? '-aos' : settings.overwrite === 'rename' ? '-aou' : '-aoa';

    /* ============================================================
     * 工作流匹配：以「该来源第一层命中的解压密码」为锚点
     *  1) 先用锚点密码直接按链路解压（跳过探测与试错）
     *  2) 若锚点密码失效 → 记一次失误（密码错即刻停用），回退常规探测
     *  3) 解压成功后把本次链路存成卡片，或累计命中次数
     *
     * 注意：源文件集合与指纹必须在**解压开始前**采集（见上面的 sourceFiles）。
     * ============================================================ */
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

    /**
     * 本次解压的链路步骤（一层一条，**按绝对层号索引**）。
     *
     * 续解（retry）时用上一次留下的 resumeSteps 打底，这解决两个问题：
     *  ① 数组保持**稠密**：续解从第 N 层开始时，前 N 层不会变成空洞，
     *     下游 `buildFromResult` / `chainText` 读 `steps[0]` 就不会崩。
     *  ② 存下来的工作流卡片是**完整链路**，而不是"从第 N 层开始"的半截链路。
     */
    const steps: WorkflowStep[] = [...(t.resumeSteps ?? [])];
    /** 已完成的层数（含续解前已经完成的层，所以初值是上一层留下的步数） */
    let doneLayerCount = steps.length;

    /** 递归解压用的累计状态 */
    let lastErrCode = 'unknown';
    let lastErrMsg = '';
    let ranOnce = false;
    /** 上一层是成功解出来的吗（决定要不要继续往下递归） */
    let layerOk = false;

    /** 当前层的输入文件（第 0 层就是主分卷） */
    let currentInput = src;
    /** 当前层已尝试过的密码（避免同一层重复试同一个） */
    let password = t.password ?? '';
    /**
     * 待清理的中间压缩包。
     *
     * 关键不变量：**只有"已经被成功解开"的包才能进这个清单**。
     * 以前是在挑出下一层时就登记，结果本层解失败（比如内层是加密 RAR 而密码不对）时，
     * 这个还没被消费掉的包会在收尾阶段被当"中间包"删掉 —— 用户的素材就没了。
     * 现在改为：**解开成功之后**才登记上一层的那一个包。
     */
    let pendingRemoval: string[] = [];
    /** 已完成的层目录（按层序），用于最后把最里层内容提到根 */
    const layerDirs: string[] = [];
    /** 分层日志：逐层记录"这层解出了什么、是第几层"，供 UI 展示 */
    const layersLog: string[] = [];
    /* ------------------------------------------------------------
     * 输出位置=源目录 且 并发>1 时的**明示**。
     *
     * 为什么必须写：此时多个任务会落到同一目录，我们有输出目录锁 → 它们会**串行**。
     * 不写的话用户以为在并发，实际在排队（这正是 B 线要弹窗降级所针对的情形）。
     * 我们没有降级（锁保证正确性，且并发设置对**其它**输出目录仍然生效），
     * 但必须让"现在其实是串行"这件事可见。
     * ------------------------------------------------------------ */
    if (settings.outDirPolicy === 'source' && Math.max(1, settings.maxConcurrent || 1) > 1) {
      layersLog.push('输出位置为源文件所在目录，同一目录的任务将串行处理（其它输出目录仍按并发设置并行）');
    }
    /**
     * 续解时被复用的旧日志条数。
     * 旧日志要保留在 layerLog 里（用户需要看到完整过程），但**不能再用 Toast 重播一遍**。
     */
    let resumeLogLen = 0;
    /** 已成功消费（成功解开）掉的压缩包 —— 收尾清理时只允许删这些 */
    const consumedInputs = new Set<string>();
    /**
     * 退出循环的那一层输入文件（仅当"本层没解开"时非空）。
     * 用它区分两种退出：
     *   failedInput === ''  → 到达内容层 / 解满深度上限，正常结束
     *   failedInput !== ''  → 某一层打不开，必须报 needs-password / failed，
     *                          绝不能报 done（以前这里静默假成功）
     */
    let failedInput = '';
    /**
     * 部分文件被跳过的提示（修复 P1-⑧）。
     * 7-Zip 退出码 1 = "完成但有警告"（部分条目被跳过/损坏），旧实现直接当纯成功。
     * 这里记录下来，最后在任务日志 + 完成 Toast 里显式提示，避免"静默少文件"。
     */
    let partialWarning = '';

    /* ------------------------------------------------------------
     * 分层输出目录（用户要求）：
     *   每一层的产物搬进 outDir/资源名_L<N>，最里层的内容最后挪到 outDir 根。
     *
     * 两个约束：
     *  ① 层目录名要能看出来源（用资源名做前缀），所以复用上面算好的 resourceStem。
     *  ② 第 0 层不能直接解到 outDir —— 它是最终根目录，直接被 7z 铺开的话
     *     后续层目录会和它混在一起。第 0 层也解到自己的 L1 目录。
     * ------------------------------------------------------------ */
    /** 每一层的产物目录：outDir/资源名_L1、_L2、… */
    const layerDirOf = (n: number) => path.join(outDir, `${resourceStem}_L${n + 1}`);
    /** 暂存目录（. 开头，完成后清掉）—— 7z 写完后由我们搬到 layerDirOf 语义位置 */
    const tempDirOf = (n: number) => path.join(outDir, `.sz333-tmp-${n + 1}`);

    /* ------------------------------------------------------------
     * 续解（retry）识别
     *
     * 上次因为内层加密包没密码而停在 needs-password，用户输密码点重试。
     * 此时外层分卷的内容**早就在输出目录里了**，绝不能从头再解一遍：
     *   - 白费几分钟 + 再读写 200MB
     *   - 会在输出目录里多出一份 6345_2.JPG（实测确实发生）
     *
     * 找内层包时不能只认原路径：收尾时会把最里层内容**挪到输出目录根**，
     * 原来的 `_L1/6345.JPG` 那时已经不存在了。所以按
     *   ① 记录的原路径 → ② 输出目录根下的同名文件 → ③ 输出目录里再嗅探一次
     * 三级回退去找，找到才续解。
     * ------------------------------------------------------------ */
    let layerOffset = 0;
    const resumeTarget = await locateResumeTarget(t.resumeFrom, outDir);
    if (resumeTarget) {
      currentInput = resumeTarget;
      // 层号以"已经完成的步数"为准：它和 steps 是同一个尺度，
      // 而 t.resumeLayers 只是上报值，两者不一致时以 steps 为准（不会错位）。
      layerOffset = steps.length || (t.resumeLayers ?? 0);
      layersLog.push(...(t.resumeLog ?? []));
      resumeLogLen = layersLog.length;
      ranOnce = true; // 已有产物，不算"从未启动"
      layersLog.push(
        `续解：从第 ${layerOffset + 1} 层（${path.basename(resumeTarget)}）继续 —— 复用已解出的内容，不重复解外层`
      );
      this.patch(t.id, { currentFile: `续解：${path.basename(resumeTarget)}` });
    }

    // 首次解压时才需要探测外层是否加密
    if (!password && layerOffset === 0) {
      const probe = await run7z({ args: ['l', '-slt', '-p', '--', currentInput] }).promise;
      const enc = /Wrong password|Cannot open encrypted|Enter password/i.test(probe.stdout + probe.stderr);
      if (enc) {
        const first = matched?.anchorPassword || settings.passwords[0] || '';
        password = first;
      }
    }

    /* ============================================================
     * 递归解压主循环（用户指定：最多 16 层，中间压缩包解完即删）
     *
     * 每轮做四件事：
     *   ① 解当前层到该层专属目录（失败时在该层内轮换候选密码）
     *   ② 删掉上一层遗留的中间压缩包（必须在解成功之后）
     *   ③ 从本层产物里找出下一层该解哪个文件（魔数为主、卡片链路优先）
     *   ④ 登记待清理项，把 currentInput 指向下一层输入
     * 无下一层 / 达深度上限 → 停止
     * ============================================================ */
    for (let layer = layerOffset; layer < MAX_DEPTH; layer++) {
      if (abort.signal.aborted) {
        this.settleAborted(t, outDir, outDirAuto, layersLog);
        return;
      }

      /* ------------------------------------------------------------
       * 修复 P1-③ + P3-⑪：解压**前**预检。
       *
       * 放在这里（取到输出目录锁、outDir 已确定并建好之后，真正调 7z 之前）：
       *   ① 解压炸弹/磁盘耗尽：估算解出体积 > 目标盘可用空间 × 90% → 拒绝；
       *   ② Zip Slip：抽样校验条目路径不越出 outDir。
       * 逐层都查 —— 嵌套包同样可能是炸弹，且外层解出后可用空间已变小。
       * ------------------------------------------------------------ */
      const pre = await preflightCheck(currentInput, outDir);
      if (pre) {
        layersLog.push(`预检拒绝：${pre.message}`);
        this.setStatus(t.id, 'failed', {
          error: { code: pre.code, message: pre.message },
          layerCount: doneLayerCount,
          layerLog: layersLog
        });
        this.deps.toast('bad', '已拒绝解压', pre.message);
        return;
      }

      /** 候选密码顺序：命中卡片时锚点密码优先；分层时优先卡片记录的该层密码 */
      const candidates: string[] = [];
      const cardPwd = matched ? workflowPasswordForStep(matched.steps, layer) : null;
      if (cardPwd) candidates.push(cardPwd);
      if (layer === 0 && matched?.anchorPassword) {
        if (!candidates.includes(matched.anchorPassword)) candidates.push(matched.anchorPassword);
      }
      for (const p of settings.passwords) {
        if (p && !candidates.includes(p)) candidates.push(p);
      }

      const layerLabel = layer === 0 ? '' : `第 ${layer + 1} 层 · `;
      let layerPassword = password;
      let layerSuccess = false;

      // 先在临时目录里解，成功后整体搬到 layerDirOf(layer)。
      // 为什么绕这一下：7z 中途失败会在目标目录留半截文件，直接解到正式层目录
      // 会让"失败的层"也留下残留；经临时目录中转可以做到失败即弃。
      const tmpOut = tempDirOf(layer);

      for (let attempt = 0; attempt <= candidates.length; attempt++) {
        if (attempt > 0) {
          const next = candidates[attempt - 1];
          if (!next || next === layerPassword) continue;
          layerPassword = next;
        }

        /*
         * 每次尝试前都把临时目录清空 —— **必须在循环里**。
         *
         * 真实事故（密码盘自动试密码时暴露）：
         *   以前只在进入循环前清一次。7z 用错密码解加密包时，会在失败前
         *   把条目**以 0 字节写出来**；下一次尝试又落在同一个目录里，
         *   而覆盖策略是 `-aou`（自动改名）→ 于是产物里多出一串
         *   `内容.txt`(0B) / `内容_1.txt`(0B) / `内容_2.txt`(0B) / `内容_3.txt`(正常)。
         *   用户拿到的是"一堆空文件 + 一个真的"。
         *   每轮清空后，失败尝试不留任何痕迹。
         */
        fs.rmSync(tmpOut, { recursive: true, force: true });
        fs.mkdirSync(tmpOut, { recursive: true });

        const args = [
          'x',
          '-y',
          '-bso0',
          '-bsp1',
          '-sccUTF-8',
          overwriteFlag,
          `-o${tmpOut}`,
          '--',
          currentInput
        ];

        let lastFile: string | undefined;
        /**
         * 进度节流。
         *
         * 7z `-bsp1` 会频繁输出百分比行，而每行都会 `patch()` 一次，把**整个 task 对象**
         * 序列化后过 IPC 发给渲染进程。十万级文件的包会打出十万条消息，把渲染进程压死
         * （界面卡住、进度条反而更卡）。
         *
         * 策略：**百分比变化立刻发**（进度条必须跟手），百分比不变时最多每 300ms 发一次
         * （只为刷新"当前文件"，纯节流不损失可用信息）。
         */
        let lastEmitAt = 0;
        let lastEmitPercent = -1;
        const runner = run7z({
          args,
          // 密码走 stdin，不再拼进 argv（否则会暴露在进程命令行里）
          password: layerPassword || undefined,
          signal: abort.signal,
          onStdout: (chunk) => {
            const p = parsePercent(chunk);
            if (!p) return;
            if (p.current) lastFile = p.current;

            const now = Date.now();
            if (p.percent === lastEmitPercent && now - lastEmitAt < 300) return;
            lastEmitAt = now;
            lastEmitPercent = p.percent;

            this.patch(t.id, {
              progress: p.percent,
              currentFile: `${layerLabel}${p.percent}%${lastFile ? ' · ' + lastFile : ''}`
            });
          }
        });
        this.running.set(t.id, runner);

        this.patch(t.id, {
          currentFile: layer === 0 ? (lastFile ?? '正在解压…') : `${layerLabel}正在解压…`
        });

        const res = await runner.promise;
        this.running.delete(t.id);
        ranOnce = true;

        if (abort.signal.aborted || res.cancelled) {
          this.settleAborted(t, outDir, outDirAuto, layersLog);
          return;
        }

        const out = res.stdout + res.stderr;

        if (res.code === 0 || res.code === 1) {
          layerSuccess = true;
          password = layerPassword;
          /* 修复 P1-⑧：退出码 1 = "完成但有警告"（部分条目被跳过/损坏/CRC 不符）。
           * 旧实现把 0 和 1 一视同仁当纯成功，用户完全不知道有文件没解出来。
           * 这里解析 7z 输出里的 Skipping/ERROR/Warning 关键字，显式记一条日志，
           * 并在任务收尾时用 Toast 提示 —— 不静默。 */
          if (res.code === 1) {
            const warned = /Skipping|ERROR|Warning|CRC Failed|Data Error/i.test(out);
            partialWarning = warned
              ? `部分文件被跳过（7-Zip 警告：${firstWarnLine(out) || '详见任务日志'}）`
              : '7-Zip 返回码 1（完成但有警告）';
            layersLog.push(`第 ${layer + 1} 层：${partialWarning}`);
          }
          break;
        }

        const err = classifyError(res.code, out);
        lastErrCode = err.code;
        lastErrMsg = err.message;

        if (err.code === 'password') {
          // 只在第 0 层把锚点密码失效记成卡片失误：内层密码本来就可能是另一个，
          // 内层解不开不代表这张卡片的锚点错了。
          if (matched && layer === 0) {
            /* 修复 P0-①：自证命中（锚点不在用户密码列表、仅靠体积一致）失败时，
             * 不按"用户确实持有该密码却错了"处理 —— 那会一次错就永久停用卡片。
             * 自证可能只是"另一个同尺寸的包"，退化为普通失误（连续 2 次才停用）。 */
            const disabled = onMiss(matched, !m.selfAttested);
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
          this.patch(t.id, { progress: 0, currentFile: `${layerLabel}密码不正确，尝试下一个…` });
          continue;
        }

        // 非密码类失败：直接失败
        this.setStatus(t.id, 'failed', {
          error: { code: err.code, message: err.message, raw: res.stderr.slice(-2000) }
        });
        return;
      }

      if (!layerSuccess) {
        // 本层没能解开：**绝不删除本层的输入文件**，它是用户的素材/结果。
        // 例如 6345.part1.rar 解出加密的 6345.JPG，若密码不对，
        // 那个 JPG 必须原样留着（用户还能自己找密码再解），不能当"中间包"删掉。
        failedInput = currentInput;
        break;
      }
      layerOk = true;
      doneLayerCount += 1;

      // ---- 本层成功后，把产物从临时目录搬到正式的层目录 ----
      // 层级名对外可见：outDir/资源名_L1、_L2…，日志里也写清"这层解出了什么"。
      const layerDir = layerDirOf(layer);
      fs.rmSync(layerDir, { recursive: true, force: true });
      try {
        fs.renameSync(tmpOut, layerDir);
      } catch {
        // 跨卷等情况下 rename 失败 → 退回递归复制
        try {
          fs.cpSync(tmpOut, layerDir, { recursive: true });
          fs.rmSync(tmpOut, { recursive: true, force: true });
        } catch {
          // 搬不动就留在临时目录，退化为原路径
        }
      }

      const layerStat = await dirStats(fs.existsSync(layerDir) ? layerDir : tmpOut);
      layerDirs.push(fs.existsSync(layerDir) ? layerDir : tmpOut);
      layersLog.push(
        `第 ${layer + 1} 层：解开 ${path.basename(currentInput)}` +
          ` → ${layerStat.files} 个文件（${fmtBytes(layerStat.size)}）` +
          // 修复 P3-⑨：日志里的密码打码（任务日志 UI 可见且随记录持久化，不能落明文）
          `${layerPassword ? ` · 密码 ${maskPassword(layerPassword)}` : ' · 无密码'}`
      );
      this.patch(t.id, {
        currentFile: `${layerLabel}已完成（${layerStat.files} 个文件）`
      });

      // ---- 删除「上一层已成功解出」的中间压缩包 ----
      // 走到这里说明本层确实解开了，此时**上一层登记的中间包**才算真正被消费掉。
      if (pendingRemoval.length) {
        const { removed, bytes } = removeIntermediates(pendingRemoval);
        for (const p of pendingRemoval) consumedInputs.add(path.resolve(p));
        pendingRemoval = [];
        if (removed > 0) {
          layersLog.push(`第 ${layer + 1} 层：清理上一层的 ${removed} 个中间压缩包（${fmtBytes(bytes)}）`);
        }
      }

      // ---- 从本层产物里找下一层：魔数识别为主，卡片链路优先 ----
      // .apk 一律不会被选作下一层（见 recursive.ts 顶部「设计决定」）：
      // 它是终端产物不是套娃外壳，且损坏的 apk 会被扩展名兜底误判成 zip 而让整任务失败。
      // 是否**删除** apk 由设置 apkFilterEnabled 单独控制 —— 两件事已解耦。
      // 注意：pickNextLayer 现为异步（读文件头魔数走异步 IO），必须 await。
      const next = await pickNextLayer(layerDir);

      // ---- 记这一层的链路（是否伪装、真实格式）----
      // 用绝对层号写入：续解时 layer 从 layerOffset 开始，steps 也必须从同一位置写，
      // 否则 steps[0] 会被当成"第 1 层"，工作流卡片的层级链路就全错位了。
      const inputExt = path.extname(currentInput);
      steps[layer] = {
        inputExt,
        fakeExt: next?.fakeExt ?? '',
        realFormat: next?.format ?? '',
        password: layerPassword,
        renameTo: next?.renameTo ?? ''
      };

      if (!next) {
        break; // 到达内容层：正常结束（failedInput 保持空）
      }

      let target = next.file;
      if (matched) {
        const applied = applyWorkflowStep(next, matched.steps, layer);
        target = applied.file;
        if (applied.note) layersLog.push(`第 ${layer + 1} 层：${applied.note}`);
      }
      if (next.fakeExt) {
        layersLog.push(
          `第 ${layer + 1} 层：识别出伪装 —— ${path.basename(next.file)} 真实格式是 ${next.format}` +
            `${next.renameTo ? `，改名 ${next.fakeExt} → ${next.renameTo}` : ''}`
        );
      }

      // 登记「下一层**解开成功后**」才允许清理的文件：本次消费掉的中间压缩包（含同组分卷）。
      // 只登记不删 —— 它还是下一层的输入；万一下一层没解开，它必须原样留着。
      //
      // 关键不变量：**用户的源文件永远不是"中间包"**。
      // currentInput 在第 0 层就是主分卷，它的兄弟卷（part2/part3）会被
      // siblingsOfVolume 一起捞进来 —— 以前只排除了 src（主卷）一个，
      // 于是 part2/part3 被当成中间包，在第二层解开后就被删掉：
      //   · 用户选了"保留源文件"照样被删（策略失效）
      //   · 用户选了"删除源文件"，也是在后半段链路还没跑完时就被提前删（无法重试）
      // 所以这里对**全部分卷**（sourceFiles）做排除，源文件只由 applySourcePolicy
      // 在整条链路成功之后统一处理。
      const sourceSet = new Set(sourceFiles.map((p) => path.resolve(p)));
      pendingRemoval = Array.from(
        new Set([...siblingsOfVolume(target), ...siblingsOfVolume(currentInput)])
      ).filter((p) => !sourceSet.has(path.resolve(p)));

      currentInput = target;
      password = ''; // 下一层重新按候选顺序决定密码
    }

    /* ============================================================
     * 循环结束后的补登记：最后一层的输入也是"被成功消费掉的中间包"
     *
     * 循环体里那处登记只在"还有下一层"时才执行（pickNextLayer 返回 null 就 break 了），
     * 所以**最内层那个包**永远登记不上。真实后果：
     *   6345.part1.rar 解出 217MB 的 6345.JPG，输对密码后内容解出来了，
     *   但那个 217MB 的 JPG 会一直躺在输出目录里不清理 ——
     *   用户看到"解出来的东西旁边还堆着个 200 多兆的怪文件"。
     *
     * 两种正常结束（解到内容层 / 解满深度上限）都适用：failedInput 为空且
     * 最后一层确实解开了，说明 currentInput 已经被消费掉。
     * 源文件依旧排除在外（由 applySourcePolicy 统一处理）。
     * ============================================================ */
    if (!failedInput && layerOk) {
      const sourceSet = new Set(sourceFiles.map((p) => path.resolve(p)));
      const consumedLast = siblingsOfVolume(currentInput).filter((p) => !sourceSet.has(path.resolve(p)));
      for (const p of consumedLast) consumedInputs.add(path.resolve(p));
      pendingRemoval = Array.from(new Set([...pendingRemoval, ...consumedLast]));
    }

    /* ============================================================
     * 收尾：只清理「确实被成功消费掉」的中间包
     *
     * 以前这里无条件 removeIntermediates(pendingRemoval)，把"解失败那一层的输入"
     * 也删了 —— 用户看到 6345.JPG 凭空消失就是这么来的。
     * 现在过滤两道：① 必须在 consumedInputs 里（即它的下一层已解开）
     *              ② 绝不能是本次任务的源文件（分卷/主卷都由 sourcePolicy 单独处理）
     * ============================================================ */
    if (pendingRemoval.length) {
      const safeToRemove = pendingRemoval.filter((p) => {
        const abs = path.resolve(p);
        if (!consumedInputs.has(abs)) return false;
        if (sourceFiles.some((s) => path.resolve(s) === abs)) return false;
        return true;
      });
      pendingRemoval = [];
      if (safeToRemove.length) {
        const { removed, bytes } = removeIntermediates(safeToRemove);
        if (removed > 0) {
          layersLog.push(`清理中间的 ${removed} 个压缩包（${fmtBytes(bytes)}）`);
        }
      }
    }

    // ---- 把最里层的内容挪到 outDir 根（用户要求）----
    // 规则：
    //   - 最里层是"内容层" → 提到根，用户一眼就能拿到成品
    //   - 过程层（L1..L(n-1)）里已经没有东西了（中间压缩包按策略删掉），
    //     所以**空的过程层一律清掉**，不留空壳。
    //
    // 为什么改（用户直接问过"6345_L2 这个文件夹是什么情况"）：
    //   上一版把空的过程层留着当"这一层在这里解过"的标记，结果用户目录里
    //   多出一个空目录，既没内容也没说明，纯困惑。层级信息本来就完整写在
    //   任务的逐层日志里，不需要用空目录承载。
    //   非空的过程层仍然保留 —— 那是真产物，不能删。
    {
      const contentLayer = layerDirs.length ? layerDirs[layerDirs.length - 1] : null;
      if (contentLayer && fs.existsSync(contentLayer)) {
        const movedCount = await moveContentsInto(contentLayer, outDir);
        if (movedCount > 0) {
          layerDirs.pop(); // 这一层已并入根目录
          layersLog.push(`已把最里层内容（${movedCount} 项）挪到输出目录根`);
        }
      }
      for (const dir of layerDirs) {
        removeDirIfEmpty(dir);
      }

      /* ------------------------------------------------------------
       * 单根目录折叠：输出目录里**只有一个文件夹**时，把它的内容提上来一层。
       *
       * 场景（用户反馈）：`75.part1.rar` 解出来的东西自带一个 `75\` 根目录，
       * 而我们已经按资源名建了输出目录 `75\` —— 结果是 `75\75\<文件>`，
       * 要连点两层才看到东西。折叠后就是 `75\<文件>`，和"解压到 75\"的直觉一致。
       *
       * 只在**我们自己按资源名建的**输出目录上做（outDirAuto）：
       * 用户显式指定的固定目录/手动目录一律不动，免得把别人的目录结构搅乱。
       * 目录里只要有第二个条目（文件或其他文件夹）就不折 —— 那种情况下这层是有意义的。
       * ------------------------------------------------------------ */
      if (outDirAuto) {
        const lifted = await collapseSingleRoot(outDir);
        if (lifted) {
          layersLog.push(`输出目录里只有「${lifted}」一个文件夹，已把它的内容提上来（少点一层）`);
        }
      }

      // 自己建的输出子目录：如果跑完还是空的（内容被挪走/改名到别处），不留空壳。
      // 用户显式指定的目录不在此列。
      if (outDirAuto && path.resolve(outDir) !== path.resolve(srcDir)) {
        removeDirIfEmpty(outDir);
      }
      // 临时目录一并清掉
      for (let n = 0; n < MAX_DEPTH; n++) {
        const tmp = tempDirOf(n);
        if (fs.existsSync(tmp)) {
          try {
            fs.rmSync(tmp, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
    }

    if (!ranOnce) {
      this.setStatus(t.id, 'failed', { error: { code: 'unknown', message: '未能启动解压进程' } });
      return;
    }

    // 连第一层都没解开（所有候选密码都失败）→ 请用户输入密码
    // 注意：**不删源文件**。第一层都没打开，源包是用户唯一素材，
    // 必须原样留着让他换个密码重试。（用户在设置里选了"删除源文件"，
    // 但那个策略只在**确实解出内容**时兑现。）
    if (!layerOk) {
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

    /* ============================================================
     * 深层解压中断（第 2 层及以后失败）
     *
     * 这里以前是**最危险的静默假成功**：
     *   6345.part1.rar 顺利解出 6345.JPG，但那个 JPG 是加密 RAR，
     *   候选密码全试完也没打开 → 循环 break，可代码继续往下走到 setStatus('done')，
     *   于是界面显示"解压完成 → 0 个文件"，用户完全不知道卡在哪。
     *
     * 现在把它当**需要用户介入**处理：
     *   - 密码问题 → needs-password，archivePath 指向**内层那个包**，
     *     这样界面弹出的密码框打进密码后，retry 会重新走这条链路；
     *   - 其他问题 → 明确报失败，并把已经解出来的层数说清楚。
     * ============================================================ */
    const deepFailed = !!failedInput && !!lastErrMsg;
    if (deepFailed) {
      /* ------------------------------------------------------------
       * failedInput 记的是"失败那一刻的路径"，但上面收尾时已经把最里层内容
       * 从 `资源名_L1/` 挪到了输出目录根，原路径**此时已经不存在**。
       *
       * 真实事故：用户输入密码点重试时，archivePath 指向 `6345_L1\6345.JPG`，
       * 而文件实际在根目录 → 续解定位不到 → 表现为"输入密码后还是不动"。
       * 所以这里必须解析出文件的**当前位置**再上报。
       * ------------------------------------------------------------ */
      const resolved = await locateResumeTarget(failedInput, outDir);
      const deepArchive = resolved ?? failedInput;
      const doneLayers = doneLayerCount;
      const detail = `已解开前 ${doneLayers} 层，第 ${doneLayers + 1} 层（${path.basename(deepArchive)}）无法打开`;

      /* ------------------------------------------------------------
       * 深层失败时**绝不删源文件**（用户明确要求）
       *
       * 用户原话："优先匹配密码盘和工作流。密码缺失后提示，输入正确密码后
       * 解压完成保存工作流；密码一直不对则保留源文件。"
       *
       * 所以 sourcePolicy='delete' 只在**整条链路成功**时才兑现。
       * 这里内层还锁着，源分卷必须原样留着 —— 用户输对密码后要能重试。
       * ------------------------------------------------------------ */

      if (lastErrCode === 'password') {
        // 记下续解起点：内容已经解出来了，重试时从**内层那个包**继续，
        // 不要从头再解一遍外层分卷（白费时间 + 会生成重复副本）。
        //
        // resumeSteps 必须一起带上：续解是"从第 N 层继续"，
        // 若不带前 N 层的链路，steps 前段就是空洞，收尾生成工作流卡片时会崩，
        // 把一次成功的续解改写成 failed（真实事故）。
        this.patch(t.id, {
          resumeFrom: deepArchive,
          resumeLayers: doneLayers,
          resumeLog: [...layersLog],
          resumeSteps: steps.filter(Boolean).map((s) => ({ ...s }))
        });
        this.setStatus(t.id, 'needs-password', {
          archivePath: deepArchive,
          error: {
            code: 'password',
            message: `${detail}：这是一个加密压缩包，需要正确的密码`
          },
          layerCount: doneLayers,
          layerLog: layersLog
        });
        this.deps.toast(
          'warn',
          '需要密码才能继续',
          `${detail} —— 已解出的内容保留在输出目录，源文件未删除，输入密码后可继续解压`
        );
      } else {
        this.setStatus(t.id, 'failed', {
          error: {
            code:
              lastErrCode === 'not-archive' || lastErrCode === 'disk' || lastErrCode === 'permission'
                ? lastErrCode
                : 'unknown',
            message: detail,
            raw: lastErrMsg
          },
          layerCount: doneLayers,
          layerLog: layersLog
        });
        this.deps.toast('bad', '深层解压失败', `${detail}：${lastErrMsg}`);
      }
      return;
    }

    // 中途某一层（非第一层）失败：内容已解出一部分，按部分成功处理并告知用户
    // 注意：此时 doneLayerCount 已 > 0，说明至少第一层成功，不应当整单失败。
    if (doneLayerCount > 1 && lastErrCode !== 'unknown' && lastErrMsg) {
      this.deps.toast('warn', '深层解压中断', `已解出前 ${doneLayerCount} 层，第 ${doneLayerCount + 1} 层失败：${lastErrMsg}`);
    }

    // ---- 中文路径处理（老资源包对中文路径不友好）----
    // 逐段 ASCII 化：不只是叶子目录，父目录里的中文同样会让老资源包出问题。
    let finalOutDir = outDir;
    if (settings.nonAsciiPolicy !== 'off') {
      const needByPolicy = settings.nonAsciiPolicy === 'force' || hasNonAscii(outDir);
      if (needByPolicy) {
        try {
          /* preferBase 必须与取锁前算 plannedOutDir 时用的**完全相同**（resourceStem），
           * 否则两次 ensureAsciiOutDir 可能得出不同的叶子名，锁又会错位。 */
          const ascii = await applyAsciiPolicy(outDir, resourceStem, {
            /* 只有我们自己按包名自建的目录才允许改目录名。
             * 用户显式指定的输出目录一律保持原样 —— 旧实现会把整个目录
             * renameSync 到一个镜像的 ASCII 路径上，等于"把用户的目录搬走了"。 */
            allowRenameDir: outDirAuto
          });
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

    /* 统一"当前产物目录"变量：上面的 ASCII 处理可能已经把输出目录整体改名，
     * 此后一律以 finalOutDir 为准，避免新旧两个变量并存被误用。 */
    outDir = finalOutDir;

    // ---- APK 过滤（用户要求）----
    // ① 产物里的 .apk 一律剔除；② 若某单个 apk 占整包达到阈值，判定为 apk 壳 → 删整份产物。
    // 必须在"统计结果"之前做，否则体积统计里会算进已经被删的 apk。
    // 注意：删的是**解压产物**，源压缩包的去留仍由 sourcePolicy 单独决定。
    let apkDroppedWholePackage = false;
    if (settings.apkFilterEnabled) {
      /* 修复 P0-5：必须用 finalOutDir。ASCII 处理可能已把目录整体改名
       * （applyAsciiPolicy 内部 renameSync），旧的 outDir 此时已不存在 ——
       * 旧实现传 outDir 会让 filterApks 首行 existsSync 直接返回，
       * 于是「中文路径转换 + APK 过滤」同时开启时过滤**静默失效**。
       * 修复 P1-6：用户指定目录不允许"删整份产物"，降级为仅剔除 apk。 */
      const apkRes = await filterApks(finalOutDir, settings.apkDropThreshold, { allowDropWholeDir: outDirAuto });
      for (const line of apkRes.log) layersLog.push(line);
      if (apkRes.log.length) {
        if (apkRes.wholePackageDropped) {
          apkDroppedWholePackage = true;
          this.deps.toast(
            'warn',
            '已剔除 APK 套壳包',
            `${apkRes.dropApk} 占整包 ${apkRes.dropRatio.toFixed(1)}%（阈值 ${settings.apkDropThreshold}%），整份产物已删除`
          );
        } else {
          this.deps.toast(
            'info',
            '已剔除 APK',
            `共 ${apkRes.apkRemoved} 个（${fmtBytes(apkRes.apkBytes)}）`
          );
        }
      }
    }

    // 统计结果
    const stat = await dirStats(finalOutDir);

    /* ------------------------------------------------------------
     * 最后一道不变量：报 done 就必须真的有东西落地。
     *
     * "解压完成 → 0 个文件"这种自相矛盾的结论，一定意味着上游某处静默失败了
     * （上一轮真实发生：内层加密包打不开，循环 break，界面照样说"解压完成"）。
     * 宁可报失败让用户看得见，也不能给一个假成功 —— 这个工具是会删源文件的，
     * 假成功的代价是数据丢失。
     *
     * 唯一豁免：APK 过滤主动删掉了整份产物（那是用户开的策略，不是失败）。
     * ------------------------------------------------------------ */
    if (stat.files === 0 && !apkDroppedWholePackage) {
      this.setStatus(t.id, 'failed', {
        error: {
          code: 'unknown',
          message: `解压过程没有产出任何文件（已完成 ${doneLayerCount} 层），已中止以避免误报成功`
        },
        layerCount: doneLayerCount,
        layerLog: layersLog
      });
      this.deps.toast(
        'bad',
        '没有解出任何文件',
        `已完成 ${doneLayerCount} 层但没有产出 —— 源文件未删除，请查看任务日志`
      );
      return;
    }

    // ---- 源文件处理：保留 / 彻底删除 ----
    // 只在**整条链路成功**、内容确实落地之后才兑现。
    // 必须删**该分组的全部分卷**，不能只删主卷 —— 用户传进来的通常只是
    // 6345.part1.rar，漏删 part2/part3 会留下孤儿分卷。
    //
    // **整包被判为 APK 套壳并已删除产物时，跳过自动删源**（修复数据丢失风险）：
    // APK 占比阈值是启发式判断，可能误判（例如正常资源包里恰好有个大 apk）。
    // 一旦误判，产物已被删，此时若再自动删掉源压缩包，用户就**两手空空、
    // 不可恢复**。所以这种情况只提示、不自动删 —— 由用户确认后手动处理。
    if (settings.sourcePolicy === 'delete' && apkDroppedWholePackage) {
      layersLog.push(
        '整份产物因「APK 占比达到阈值」被判为套壳并已删除；为避免误判导致源包不可恢复，本次**未**自动删除源文件'
      );
      this.deps.toast(
        'warn',
        '已跳过删除源文件',
        '整份产物被判为 APK 套壳并已删除；源压缩包已保留，请确认无误后手动清理'
      );
    }

    if (settings.sourcePolicy === 'delete' && !apkDroppedWholePackage) {
      const sources = collectSourceFiles(t.sourcePaths, src);

      /* 删源前先披露（写进任务日志 + Toast），让破坏性动作当场可见，而不是事后才发现。
       * 统计口径 = collectSourceFiles 的全部分卷（主卷 + part2/3…）。 */
      const planned = sources.filter((p) => fs.existsSync(p));
      const plannedBytes = planned.reduce((sum, p) => sum + safeSize(p), 0);
      const planLine = `本次将删除 ${planned.length} 个源文件，共 ${fmtBytes(plannedBytes)}，不可恢复（源文件处理=彻底删除）`;
      layersLog.push(planLine);

      /* 真正删除前的二次确认（删除不可恢复）。用户取消 → 原样保留源文件。
       * 不变量：失败/取消/APK 误判的路径永远走不到这里 —— 本块只在整条链路成功、
       * 内容确实落地之后执行。未注入确认回调（无 UI/测试）时按"允许删除"处理。 */
      let confirmed = true;
      if (planned.length && this.deps.confirmDeleteSource) {
        confirmed = await this.deps.confirmDeleteSource({ count: planned.length, bytes: plannedBytes, paths: planned });
      }

      if (!confirmed) {
        layersLog.push('用户取消：本次未删除源文件（源文件已保留）');
        this.deps.toast('info', '已保留源文件', '你取消了本次删除；可在【设置】→ 源文件处理 调整默认策略');
      } else {
        this.deps.toast('warn', '即将删除源文件', `${planLine} —— 如需保留请在【设置】→ 源文件处理 改为「保留原始文件」`);

        let deleted = 0;
        let bytes = 0;
        for (const p of sources) {
          if (!fs.existsSync(p)) continue;
          let size = 0;
          try {
            size = fs.statSync(p).size;
          } catch {
            /* 取不到大小不影响删除 */
          }
          try {
            fs.rmSync(p, { force: true });
            deleted += 1;
            bytes += size;
          } catch (e) {
            logger.warn(`删除源文件失败：${p} -> ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (deleted > 0) {
          layersLog.push(`已删除 ${deleted} 个源文件（${fmtBytes(bytes)}，不可恢复）`);
          this.deps.toast(
            'info',
            '源文件已彻底删除',
            `共 ${deleted} 个文件（含全部分卷，${fmtBytes(bytes)}，不可恢复）`
          );
        } else {
          layersLog.push('源文件删除：实际没有文件被删除（可能被占用或权限不足）');
          this.deps.toast('warn', '源文件删除失败', '文件可能被占用或权限不足');
        }
      }
    }
    // 修复 P1-3：首轮成功解压也要记住密码
    // （旧实现这里只是 `this.deps.emit(...)` 重新推了一次任务，是个 no-op）
    if (settings.rememberPasswords && password) {
      this.deps.rememberPassword(password);
    }

    /* ------------------------------------------------------------
     * 工作流收尾：命中则累计，未命中则把本次链路存成卡片。
     *
     * 整块包在 try/catch 里：这只是"记账"，任何记账异常都**不允许**
     * 把一次已经成功的解压改写成 failed。
     * 真实事故：buildFromResult 读到续解留下的空洞 steps[0] 抛 TypeError，
     * 异常冒到 execute() 的 catch，用户看到的是失败 + 没有输出路径，
     * 而内容其实已经好好地躺在输出目录里。
     * ------------------------------------------------------------ */
    try {
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
      } else if (doneLayerCount > 0 && steps.some((s) => s?.password)) {
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
    } catch (e) {
      // 记账失败不影响交付，但要说出来（否则又是一次"静默吞异常"）
      this.deps.toast('warn', '工作流记录保存失败', e instanceof Error ? e.message : String(e));
    }

    this.setStatus(t.id, 'done', {
      progress: 100,
      outputPath: finalOutDir,
      outputSize: stat.size,
      fileCount: stat.files,
      layerCount: doneLayerCount,
      layerLog: layersLog
    });
    // 跑通之后清掉续解起点：任务已完成，下次再跑就是全新一次
    this.patch(t.id, {
      resumeFrom: undefined,
      resumeLayers: undefined,
      resumeLog: undefined,
      resumeSteps: undefined,
      archivePath: undefined
    });
    const layerNote = doneLayerCount > 1 ? `（${doneLayerCount} 层套娃）` : '';
    /* 修复 P1-⑧：若过程中 7-Zip 报过"部分跳过/警告"，完成提示里必须带出来，
     * 不能让用户以为"全部解出来了"（层日志里也已有明细）。 */
    if (partialWarning) {
      this.deps.toast('warn', '解压完成（有警告）', `${t.label}${layerNote}：${partialWarning}`);
    }
    this.deps.toast('ok', '解压完成', `${t.label}${layerNote} → ${stat.files} 个文件`);
    // 多层时逐层播报过程，单层不啰嗦（只播本次新增的，不重播续解带来的旧日志）
    if (doneLayerCount > 1) {
      for (const line of layersLog.slice(resumeLogLen)) {
        this.deps.toast('info', `共 ${doneLayerCount} 层`, line);
      }
    }
    if (settings.autoOpenOutDir) this.emit('open', finalOutDir);
  }

  /**
   * 取消 / 暂停分支的统一收口（修复 P0-4 + P0-1）。
   *
   * 为什么单独抽一个方法：runExtract 里有两处（循环顶部 / 7z 进程返回后）需要
   * 完全相同的收口逻辑，分散写容易出现"改了一处漏了另一处"。
   *
   * 分流规则：
   *   · 有暂停意图 → `paused`（任务可恢复；自建目录清干净，用户目录保留）
   *   · 否则       → `cancelled`（终态）
   */
  private settleAborted(t: InternalTask, outDir: string, outDirAuto: boolean, layersLog: string[]) {
    if (this.pauseFlags.delete(t.id)) {
      this.cleanupPartial(outDir, outDirAuto);
      this.setStatus(t.id, 'paused', {
        progress: 0,
        currentFile: undefined,
        error: { code: 'cancelled', message: '已暂停，恢复后将重新开始' }
      });
      return;
    }
    const removed = this.cleanupPartial(outDir, outDirAuto);
    if (!removed && !outDirAuto) {
      // 用户指定目录：不清、也不装作清过 —— 如实告诉用户产物还在
      layersLog.push('输出目录为你指定的目录，未完成的产物已原样保留（未做删除）');
    }
    this.setStatus(t.id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
  }

  /**
   * 取消/暂停后清理本次未完成的输出目录。
   *
   * **安全边界（修复 P0-1）**：
   *   只有「本次按包名自建」的目录（auto=true）才允许递归删除；
   *   用户显式指定的目录一律**保留**。
   *
   * 旧实现只比较 `outDir === path.dirname(src)`，注释却写着"只在目录为空或仅含部分
   * 文件时删除" —— 实际是**无条件递归删除**。当输出位置 = 用户指定目录
   * （且未开启「以包名新建子目录」）时，取消任务会把**用户自己的整个目录**
   * （连同里面无关的文件）一起删掉，且不可恢复。
   *
   * @returns 是否真的删除了目录（供调用方决定要不要写"已保留"提示）
   */
  private cleanupPartial(outDir: string, auto: boolean): boolean {
    try {
      if (!outDir || !auto) return false;
      if (!fs.existsSync(outDir)) return false;
      fs.rmSync(outDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ 外部控制 ------------------------------ */

  pause(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return false;
    /* ------------------------------------------------------------
     * **修复 P0-4**：先登记"暂停意图"，再终止进程。
     *
     * 只调 `runner.cancel()` 时，7z 进程的 close 事件会在**下一个事件循环**
     * 让 runExtract 走到取消分支，把刚设好的 `paused` 异步改写回 `cancelled`
     * （并顺带清理输出目录）。登记 pauseFlags 后，取消分支会识别出"这是暂停"，
     * 从而正确落到 `paused`。
     * 同时 abort：让"正在等待输出目录锁"的任务也能被暂停（P0-6）。
     * ------------------------------------------------------------ */
    this.pauseFlags.add(id);
    t.abort?.abort();
    this.running.get(id)?.cancel();
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
    this.pauseFlags.delete(id); // 本次是"取消"而非"暂停"，先清掉可能残留的暂停意图
    if (t.status === 'running') {
      /* ------------------------------------------------------------
       * **修复 P0-6**：这里必须同时 abort。
       *
       * `status === 'running'` 其实包含两种子情形：
       *   ① 正在解压 —— `this.running` 里有 runner，`cancel()` 能杀掉 7z；
       *   ② **正在等待输出目录锁** —— `this.running.set()` 发生在取到锁**之后**，
       *      此时 Map 里还没有该任务，`?.cancel()` 是空操作；而 `abort` 此前
       *      从未被 abort() 过，KeyedLock 里那套 signal 中断逻辑形同虚设
       *      → 用户点了取消却毫无反应（任务继续排队等锁）。
       * 调用 `t.abort?.abort()` 后：`acquire` 立即返回 null，`run7z` 也会
       * kill 子进程 —— 两种子情形都能被真正取消。
       * ------------------------------------------------------------ */
      t.abort?.abort();
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
      // 修复 P1-2：交给主进程写入 + 落盘（旧实现只改内存对象，重启即丢）
      this.deps.rememberPassword(password);
    }
    if (outDir) t.outDir = outDir;
    // 注意：**不要**在这里清掉 resumeFrom / resumeSteps。
    // 内层密码失败后的重试必须能从内层包续解，而不是把外层大分卷重解一遍。
    this.setStatus(id, 'queued', { error: undefined, progress: 0, currentFile: undefined, endedAt: undefined });
    void this.pump();
    return this.publicTask(t);
  }

  remove(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t) return false;
    this.pauseFlags.delete(id);
    if (t.status === 'running') {
      /* **修复 P0-6**：等待锁中的任务不在 `this.running` 里，只调 `?.cancel()`
       * 会留下一个"幽灵任务" —— 它拿到锁后继续解压、继续写盘，但所有 patch
       * 都因任务已被删除而静默失效（`patch()` 里 `if (!t) return`）。
       * abort 后 runExtract 会尽快退出；锁由 execute() 的 finally 释放（见 P0-3）。 */
      t.abort?.abort();
      this.running.get(id)?.cancel();
    }
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
    // 先让所有"在等输出目录锁"的任务立刻结束（不变量 3：dispose 后不再产生新的等待），
    // 再取消正在跑的 7z 进程。
    this.outLocks.dispose();
    for (const [, r] of this.running) r.cancel();
    this.running.clear();
    /* 退出前尽力清理本次运行留下的临时目录（进程即将结束，不留半成品）。
     * 已取消所有 runner，此刻没有任务在写盘。 */
    for (const id of this.order) {
      const t = this.tasks.get(id);
      if (t?.outDir) cleanupOutDir(t.outDir);
    }
  }
}

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 收集该分组的全部源文件（分卷包要把所有分卷都算进指纹）。
 *
 * **必须叠加 isVolumeMember 判断（修复误删源文件）**：
 * `volumeKey` 只剥分卷尾号、不剥格式后缀，因此 `movie.7z` 与 `movie.nfo`
 * 的 key 都是 `movie`。若只比 key，同目录下任何与主卷同基名的文件
 * （`.nfo` / `.sfv` / `.txt` / 封面图 …）都会被算作"分卷"，在
 * 「彻底删除源文件」时被一并**永久删除** —— 不可逆的数据丢失。
 * 现在只收「确实是分卷成员」的文件，外加主卷本身。
 */
function collectSourceFiles(sourcePaths: string[], primary: string): string[] {
  const dir = path.dirname(primary);
  const primaryName = path.basename(primary);
  const stem = volumeKey(primaryName);
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (volumeKey(entry.name) !== stem) continue;
      // 同基名还不够 —— 必须真的是分卷成员，或者就是主卷本身
      if (entry.name !== primaryName && !isVolumeMember(entry.name)) continue;
      out.push(path.join(dir, entry.name));
    }
  } catch {
    /* ignore */
  }
  if (!out.length) out.push(...sourcePaths.filter((p) => fs.existsSync(p)));
  return out.sort();
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * 解压炸弹防护阈值（修复 P1-③）：估算解出体积超过目标盘**可用空间**的此比例即拒绝。
 * 取 90% 而非 100%：给系统与其它程序留余量，避免把盘写满导致整机卡死。
 */
const EXTRACT_FREE_SPACE_RATIO = 0.9;

/**
 * 体积估算不可信时的保守膨胀系数（新增）。
 * 当 `7z l -slt` 输出被 run7z 的 8MB 上限截断时，totalSize 会严重低估。
 * 此时改用「压缩包物理体积 × 本系数」粗估解出体积：常见资源包膨胀 1~3 倍，
 * 取 8 作为偏保守的预警线 —— 宁可误拦一次让用户确认，也不能静默放行写爆磁盘。
 */
const INFLATE_GUESS_RATIO = 8;

/** 取压缩包文件的物理体积（字节）；取不到返回 0。用于体积估算不可信时的粗估。 */
function physicalSizeOf(file: string): number {
  try {
    const st = fs.statSync(file);
    return Number.isFinite(st.size) && st.size > 0 ? st.size : 0;
  } catch {
    return 0;
  }
}

/** 取目标目录所在卷的可用字节数；取不到返回 null（此时跳过大小校验，不阻断解压） */
function freeSpaceOf(dir: string): number | null {
  try {
    // Node 18.15+ / 20：statfsSync 返回 bavail（可用块数）与 bsize（块大小）
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}

/**
 * 解压**前**的预检（修复 P1-③ + P3-⑪）：
 *   ① 解压炸弹 / 磁盘耗尽 —— 用 `7z l -slt` 累加解出体积，超过目标盘可用空间的
 *      EXTRACT_FREE_SPACE_RATIO 即拒绝，避免把磁盘写爆；
 *   ② Zip Slip / 路径穿越 —— 抽样校验列表条目的归一化路径仍落在 outDir 之内
 *      （7z 自身对 `..`/绝对路径有防护，这里是纵深防御）。
 * 返回 null 表示通过；否则返回 { code, message } 表示拒绝原因。
 * 列表读不出（损坏 / 需密码且未提供）时**放行** —— 交给 7z 在写入时报错，
 * 不能因为"读不出列表"就把一个正常包误杀。
 */
async function preflightCheck(
  archive: string,
  outDir: string
): Promise<{ code: 'disk' | 'unknown'; message: string } | null> {
  let info: ArchiveInfo;
  try {
    info = await listArchive(archive);
  } catch {
    return null;
  }

  // ② 路径穿越校验（用列表条目；listArchive 只回传前 N 条，属抽样校验）
  const root = path.resolve(outDir);
  for (const e of info.entries ?? []) {
    const rel = (e.path ?? '').replace(/\\/g, '/');
    if (!rel) continue;
    if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      return {
        code: 'unknown',
        message: `压缩包含绝对路径条目「${e.path}」，可能存在路径穿越风险，已拒绝以防写到输出目录之外`
      };
    }
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { code: 'unknown', message: `压缩包含越界条目「${e.path}」，可能写到输出目录之外，已拒绝` };
    }
  }

  // ① 解压炸弹 / 磁盘耗尽
  const need = info.totalSize;
  if (!Number.isFinite(need) || need <= 0) return null;
  const free = freeSpaceOf(outDir);
  if (free === null) return null;

  /* 体积估算不可信时的保守分支：
     当 `7z l -slt` 的输出被 run7z 的 8MB 上限截断（超大归档条目极多），
     info.totalSize 只累加了末尾那部分，**严重低估**真实解出体积，
     直接放行等于让"防解压炸弹"闸门失效。
     此时改用「压缩包物理体积 × 膨胀系数」做粗估：正常资源包解压后
     膨胀 1~3 倍，取保守系数 8 作为上限预警线。物理体积拿不到（为 0）则退回原逻辑。 */
  if (info.sizeEstimateReliable === false) {
    const physical = physicalSizeOf(archive);
    if (physical > 0) {
      const rough = physical * INFLATE_GUESS_RATIO;
      if (rough > free * EXTRACT_FREE_SPACE_RATIO) {
        const pct = Math.round(EXTRACT_FREE_SPACE_RATIO * 100);
        return {
          code: 'disk',
          message:
            `无法完整读取该压缩包的条目清单（条目过多），解出体积估算不可靠。` +
            `按压缩包体积 ${fmtBytes(physical)} 保守估算约需 ${fmtBytes(rough)}，` +
            `已超过目标磁盘可用空间（${fmtBytes(free)}）的安全上限（${pct}%），已拒绝以防写满磁盘`,
        };
      }
    }
    // 物理体积也不可知 → 退回基于（不可信的）totalSize 判断，但至少不静默放行
    if (need > free * EXTRACT_FREE_SPACE_RATIO) {
      const pct = Math.round(EXTRACT_FREE_SPACE_RATIO * 100);
      return {
        code: 'disk',
        message: `预计解出 ${fmtBytes(need)}，超过目标磁盘可用空间（${fmtBytes(free)}）的安全上限（${pct}%），已拒绝以防写满磁盘`,
      };
    }
    return null;
  }

  if (need > free * EXTRACT_FREE_SPACE_RATIO) {
    const pct = Math.round(EXTRACT_FREE_SPACE_RATIO * 100);
    return {
      code: 'disk',
      message: `预计解出 ${fmtBytes(need)}，超过目标磁盘可用空间（${fmtBytes(free)}）的安全上限（${pct}%），已拒绝以防写满磁盘`
    };
  }
  return null;
}

/**
 * 任务日志里的密码打码（修复 P3-⑨）。
 * 逐层日志会写进任务卡片、UI 可见（并随任务记录持久化），绝不能出现明文密码。
 * 规则：保留首尾各 1 个字符，中间以 *** 代替；长度 ≤2 时整体打码。
 */
function maskPassword(pwd: string): string {
  if (!pwd) return '';
  if (pwd.length <= 2) return '***';
  return `${pwd[0]}***${pwd[pwd.length - 1]}`;
}

/** 从 7z 输出里挑出第一条警告/跳过行，供日志与提示使用（修复 P1-⑧） */
function firstWarnLine(out: string): string {
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /Skipping|ERROR|Warning|CRC Failed|Data Error/i.test(l));
  if (!line) return '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/**
 * 定位续解目标（内层那个包现在在哪）。
 *
 * 三级回退（因为收尾会把最里层内容挪到输出目录根，原路径常常已经不在）：
 *  ① 原名路径还在吗
 *  ② 输出目录根下有没有同名文件（可能被 ASCII 改名或加了 _2 序号 → 模糊匹配）
 *  ③ 输出目录里再嗅探一遍，挑出可继续解压的包
 */
async function locateResumeTarget(resumeFrom: string | undefined, outDir: string): Promise<string | null> {
  if (!resumeFrom) return null;

  // ① 原路径
  if (fs.existsSync(resumeFrom)) return resumeFrom;

  // ② 输出目录根下的同名文件（内容被挪到根了）
  const base = path.basename(resumeFrom);
  const atRoot = path.join(outDir, base);
  if (fs.existsSync(atRoot)) return atRoot;

  // ②'. 模糊匹配：ASCII 改名 / 加了序号的情况
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(outDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const fuzzy = entries.find((e) => {
    if (!e.isFile()) return false;
    const ns = e.name.toLowerCase().replace(/\.[^.]+$/, '');
    return ns === stem || ns.startsWith(`${stem}_`);
  });
  if (fuzzy) return path.join(outDir, fuzzy.name);

  // ③ 兜底：再嗅探一次，挑一个能继续解压的（pickNextLayer 现为异步）
  const guess = await pickNextLayer(outDir);
  return guess ? guess.file : null;
}

/** 目录名安全化已统一到 engine.safeDirSegment（见 runExtract 顶部 resourceStem），
 *  本地 safeDirName 已删除，避免三处重复实现。 */

/**
 * 把 src 目录下的所有条目搬到 dest（同名冲突则加序号），然后清掉 src。
 * **异步**（修复 #6）：用 fs.promises 遍历与搬运，避免大目录阻塞主进程事件循环。
 *
 * **名字分配必须是原子的**（这里就是本项目真正的 JS 侧 check-then-act）：
 *
 * 旧实现是 `if (fs.existsSync(to))` 预判 + `fs.renameSync(from, to)` —— 这是典型的
 * check-then-act。两个隐患叠加会**静默丢文件**：
 *   ① 判重与落盘之间没有原子性：并发时两个条目的目标名会算成同一个；
 *   ② Node 在 Windows 上 `fs.renameSync` 底层走 `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`，
 *      **目标已存在时是静默覆盖，不报错** —— 于是"先判断再改名"一旦并发，
 *      后来者会直接覆盖先到者，且双方都以为成功。
 *
 * 现在改为**占用即创建**：
 *   · 文件：`fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)` —— 内核对
 *     "仅当目标不存在时创建"（O_EXCL 语义）是**原子**的；抛 `EEXIST` 就换序号重试。
 *   · 目录：`fs.renameSync` 把目录改名到**已存在**的目标会失败（非空目录不可覆盖），
 *     本身即原子；跨卷（EXDEV）时改用非递归 `fs.mkdirSync(to)` 排他占名后再复制。
 * 兜底路径同样**绝不覆盖**已存在的目标。
 *
 * 两个调用点（`contentLayer → outDir`、`collapseSingleRoot` 的 `inner → dir`）都在
 * runExtract 内、且都作用于该任务的 outDir → 均在**输出目录写锁**保护范围内。
 */
async function moveContentsInto(src: string, dest: string): Promise<number> {
  let moved = 0;
  let entries: fs.Dirent[] = [];
  try {
    // 修复 #6：readdirSync → fs.promises.readdir（异步遍历，不阻塞事件循环）
    entries = await fs.promises.readdir(src, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const e of entries) {
    const from = path.join(src, e.name);
    const ok = e.isDirectory()
      ? await moveDirExclusive(from, dest, e.name)
      : await moveFileExclusive(from, dest, e.name);
    if (ok) moved += 1;
  }

  try {
    // 修复 #6：rmSync → fs.promises.rm
    await fs.promises.rm(src, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return moved;
}

/** 名称序号上限：防止异常错误码导致无限重试 */
const MAX_NAME_TRY = 10000;

/** 该错误码是否表示"目标已存在"（需换序号重试） */
function isExistsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}

/**
 * 原子移动**单个文件**。
 *
 * 优先用**硬链接**：`fs.linkSync` 在同卷 NTFS 上是 O(1) 且原子
 * （目标已存在时抛 `EEXIST`，绝不覆盖），再 `unlink` 源即可 ——
 * 语义等价于 rename，却不像 `fs.renameSync` 那样在目标已存在时**静默覆盖**。
 *
 * 为什么需要它（修复 P1-4）：旧实现一律用 `COPYFILE_EXCL` 复制再删源，
 * 对 GB 级产物是**全量二次 IO**，且复制期间源与目标同时存在
 * （峰值需要双倍磁盘空间）—— 与"几十 GB 资源包"的场景叠加时代价明显。
 *
 * 回退：跨卷（`EXDEV`）或文件系统不支持硬链接（exFAT/FAT32、部分网络盘，
 * 返回 `EPERM`/`ENOSYS`/`EACCES`）→ 退回 `COPYFILE_EXCL` 排他复制。
 * 同名冲突时按 `名字_2` / `名字_3` … 递增重试。
 */
async function moveFileExclusive(from: string, dest: string, name: string): Promise<boolean> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'item';
  for (let n = 1; n <= MAX_NAME_TRY; n += 1) {
    const to = n === 1 ? path.join(dest, name) : path.join(dest, `${stem}_${n}${ext}`);

    // ① 硬链接（同卷零拷贝、原子；目标已存在 → EEXIST）—— 修复 #6：改 fs.promises
    try {
      await fs.promises.link(from, to);
      try {
        await fs.promises.unlink(from);
      } catch {
        /* 链接成功但删源失败：内容已在目标，源残留无害 */
      }
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') continue; // 目标已存在 → 换序号
      // 其余（EXDEV / EPERM / ENOSYS / EACCES：跨卷或不支持硬链接）→ 走下面的复制回退
    }

    // ② 回退：排他复制（原子，但需要全量 IO）—— 修复 #6：改 fs.promises.copyFile
    try {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      try {
        await fs.promises.unlink(from);
      } catch {
        /* 复制成功但删源失败：内容已在目标，源残留无害 */
      }
      return true;
    } catch (e) {
      if (isExistsError(e)) continue; // 换序号重试
      logger.warn(`移动文件失败（放弃该条目）：${from} -> ${e instanceof Error ? e.message : String(e)}`);
      return false; // 其它错误（权限/空间等）：放弃该条目
    }
  }
  return false;
}

/**
 * 原子移动**单个目录**：`renameSync` 对目录天然排他（目标已存在会失败）；
 * 跨卷等场景退回「非递归 mkdir 占名 + 递归复制」。同名冲突按 `名字_2`… 递增。
 */
async function moveDirExclusive(from: string, dest: string, name: string): Promise<boolean> {
  for (let n = 1; n <= MAX_NAME_TRY; n += 1) {
    const to = n === 1 ? path.join(dest, name) : path.join(dest, `${name}_${n}`);
    try {
      // 修复 #6：renameSync → fs.promises.rename
      await fs.promises.rename(from, to);
      return true;
    } catch (e) {
      if (isExistsError(e)) continue; // 目标已存在 → 换名（目录不会被静默覆盖）
      // 跨卷（EXDEV）等：先排他占名，再复制（不覆盖）
      try {
        await fs.promises.mkdir(to); // 非递归：已存在 → EEXIST
      } catch (e2) {
        if (isExistsError(e2)) continue;
        logger.warn(`创建目标目录失败（放弃该条目）：${to} -> ${e2 instanceof Error ? e2.message : String(e2)}`);
        return false;
      }
      try {
        await fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: true });
        await fs.promises.rm(from, { recursive: true, force: true });
        return true;
      } catch (e) {
        try {
          await fs.promises.rm(to, { recursive: true, force: true });
        } catch {
          /* 回滚失败：目标目录可能残留，但不影响已搬运的其它条目 */
        }
        logger.warn(`跨卷复制目录失败（放弃该条目）：${from} -> ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
  }
  return false;
}

/** 空目录就删掉（只删确实为空的；非空一律不动） */
function removeDirIfEmpty(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    if (fs.readdirSync(dir).length > 0) return false;
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 输出目录里只有一个子文件夹时，把它的内容提上来一层（并返回那个文件夹名）。
 *
 * 为什么要有它：不少资源包在打包时自带一个与包同名的根目录，而我们已经按资源名
 * 建了输出目录 —— 于是变成 `75\75\<文件>`。折叠一次就是 `75\<文件>`。
 *
 * 保守边界：
 *  · 目录里有 ≥2 个条目 → 不动（那层结构是有意义的）
 *  · 唯一的条目不是文件夹（例如内层加密包失败时留在根上的那个 .JPG）→ 不动
 *  · 唯一条目是我们自己的临时/分层目录 → 不动
 */
async function collapseSingleRoot(dir: string): Promise<string | null> {
  let entries: fs.Dirent[] = [];
  try {
    // 修复 #6：readdirSync → fs.promises.readdir
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length !== 1) return null;
  const only = entries[0];
  if (!only.isDirectory()) return null;
  if (only.name.startsWith('.sz333-tmp-') || /_L\d+$/.test(only.name)) return null;

  const inner = path.join(dir, only.name);
  const moved = await moveContentsInto(inner, dir);
  if (moved === 0) return null;
  try {
    await fs.promises.rm(inner, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return only.name;
}

/**
 * 统计目录的文件数与总字节数（**异步**遍历）。
 *
 * 修复 P1-5：旧实现用 `readdirSync` + `statSync` 同步递归，十万级条目的产物目录
 * 会长时间阻塞主进程事件循环（UI 卡顿、IPC 无响应）。改用 `fs.promises` 后
 * 不再阻塞事件循环，结果口径与旧实现完全一致。
 */
async function dirStats(dir: string): Promise<{ files: number; size: number }> {
  let files = 0;
  let size = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      files += 1;
      try {
        size += (await fs.promises.stat(p)).size;
      } catch {
        /* ignore */
      }
    }
  };
  await walk(dir);
  return { files, size };
}
