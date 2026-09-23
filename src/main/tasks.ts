import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AppSettings, TaskRecord, TaskStatus, TaskOp, WorkflowProgressEvent } from '@shared/types';
import { classifyError, parsePercent, run7z, uniqueDir } from './engine';
import { applyAsciiPolicy, archiveStem, type RenamePair } from './asciiPath';
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
    const resourceStem = safeDirName(archiveStem(path.basename(src), sourceFiles)) || 'resource';

    let outDir = t.outDir;
    /** 输出目录是不是我们**自己按包名新建**的（而不是用户指定的）。
     *  只有自己建的、且跑完还是空的，才允许回收；用户指定的目录一律不动。 */
    let outDirAuto = false;
    if (!outDir) {
      const base = settings.defaultOutDir || srcDir;
      if (settings.extractToSubfolder) {
        outDir = uniqueDir(base, resourceStem);
        outDirAuto = true;
      } else {
        outDir = base;
      }
      /* ------------------------------------------------------------
       * 把自己算出来的输出目录**写回任务**。
       *
       * 为什么必须写回（移植时修的缺陷，续解场景会真实踩到）：
       *   `uniqueDir` 遇到同名目录会加序号（`资源名` → `资源名_2`）。
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
    const resumeTarget = locateResumeTarget(t.resumeFrom, outDir, settings.apkFilterEnabled);
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
        this.cleanupPartial(outDir, src);
        this.setStatus(t.id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
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
          `-p${layerPassword}`,
          '--',
          currentInput
        ];

        let lastFile: string | undefined;
        const runner = run7z({
          args,
          signal: abort.signal,
          onStdout: (chunk) => {
            const p = parsePercent(chunk);
            if (p) {
              if (p.current) lastFile = p.current;
              this.patch(t.id, {
                progress: p.percent,
                currentFile: `${layerLabel}${p.percent}%${lastFile ? ' · ' + lastFile : ''}`
              });
            }
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
          this.cleanupPartial(outDir, src);
          this.setStatus(t.id, 'cancelled', { error: { code: 'cancelled', message: '已取消' } });
          return;
        }

        const out = res.stdout + res.stderr;

        if (res.code === 0 || res.code === 1) {
          layerSuccess = true;
          password = layerPassword;
          break;
        }

        const err = classifyError(res.code, out);
        lastErrCode = err.code;
        lastErrMsg = err.message;

        if (err.code === 'password') {
          // 只在第 0 层把锚点密码失效记成卡片失误：内层密码本来就可能是另一个，
          // 内层解不开不代表这张卡片的锚点错了。
          if (matched && layer === 0) {
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

      const layerStat = dirStats(fs.existsSync(layerDir) ? layerDir : tmpOut);
      layerDirs.push(fs.existsSync(layerDir) ? layerDir : tmpOut);
      layersLog.push(
        `第 ${layer + 1} 层：解开 ${path.basename(currentInput)}` +
          ` → ${layerStat.files} 个文件（${formatSize(layerStat.size)}）` +
          `${layerPassword ? ` · 密码 ${layerPassword}` : ' · 无密码'}`
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
          layersLog.push(`第 ${layer + 1} 层：清理上一层的 ${removed} 个中间压缩包（${formatSize(bytes)}）`);
        }
      }

      // ---- 从本层产物里找下一层：魔数识别为主，卡片链路优先 ----
      // 注意 skipApk：开启 APK 过滤时不要把 .apk 当下一层去解 ——
      // .apk 在扩展名兜底里被当成 zip，损坏的 apk 会让 7z 报错、整个任务失败，
      // 而用户的意图正是把这些 apk 剔掉（详见 recursive.ts 的 skipApk 说明）。
      const next = pickNextLayer(layerDir, { skipApk: settings.apkFilterEnabled });

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
          layersLog.push(`清理中间的 ${removed} 个压缩包（${formatSize(bytes)}）`);
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
        const movedCount = moveContentsInto(contentLayer, outDir);
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
        const lifted = collapseSingleRoot(outDir);
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
      const resolved = locateResumeTarget(failedInput, outDir, settings.apkFilterEnabled);
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

    // ---- APK 过滤（用户要求）----
    // ① 产物里的 .apk 一律剔除；② 若某单个 apk 占整包达到阈值，判定为 apk 壳 → 删整份产物。
    // 必须在"统计结果"之前做，否则体积统计里会算进已经被删的 apk。
    // 注意：删的是**解压产物**，源压缩包的去留仍由 sourcePolicy 单独决定。
    let apkDroppedWholePackage = false;
    if (settings.apkFilterEnabled) {
      const apkRes = filterApks(outDir, settings.apkDropThreshold);
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
            `共 ${apkRes.apkRemoved} 个（${formatSize(apkRes.apkBytes)}）`
          );
        }
      }
    }

    // 统计结果
    const stat = dirStats(finalOutDir);

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
    if (settings.sourcePolicy === 'delete') {
      const sources = collectSourceFiles(t.sourcePaths, src);
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
        } catch {
          /* ignore */
        }
      }
      if (deleted > 0) {
        this.deps.toast(
          'info',
          '源文件已彻底删除',
          `共 ${deleted} 个文件（含全部分卷，${formatSize(bytes)}，不可恢复）`
        );
      } else {
        this.deps.toast('warn', '源文件删除失败', '文件可能被占用或权限不足');
      }
    }
    if (settings.rememberPasswords && password && !settings.passwords.includes(password)) {
      this.deps.emit({ ...this.publicTask(t) });
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
    this.deps.toast('ok', '解压完成', `${t.label}${layerNote} → ${stat.files} 个文件`);
    // 多层时逐层播报过程，单层不啰嗦（只播本次新增的，不重播续解带来的旧日志）
    if (doneLayerCount > 1) {
      for (const line of layersLog.slice(resumeLogLen)) {
        this.deps.toast('info', `共 ${doneLayerCount} 层`, line);
      }
    }
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
    // 注意：**不要**在这里清掉 resumeFrom / resumeSteps。
    // 内层密码失败后的重试必须能从内层包续解，而不是把外层大分卷重解一遍。
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

/**
 * 定位续解目标（内层那个包现在在哪）。
 *
 * 三级回退（因为收尾会把最里层内容挪到输出目录根，原路径常常已经不在）：
 *  ① 原名路径还在吗
 *  ② 输出目录根下有没有同名文件（可能被 ASCII 改名或加了 _2 序号 → 模糊匹配）
 *  ③ 输出目录里再嗅探一遍，挑出可继续解压的包
 */
function locateResumeTarget(
  resumeFrom: string | undefined,
  outDir: string,
  skipApk = false
): string | null {
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

  // ③ 兜底：再嗅探一次，挑一个能继续解压的
  const guess = pickNextLayer(outDir, { skipApk });
  return guess ? guess.file : null;
}

/** 目录名安全化：去掉 Windows 非法字符与结尾的点/空格，并限制长度 */
function safeDirName(name: string): string {
  const s = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

/** 把 src 目录下的所有条目搬到 dest（同名冲突则加序号），然后清掉 src */
function moveContentsInto(src: string, dest: string): number {
  let moved = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const e of entries) {
    const from = path.join(src, e.name);
    let to = path.join(dest, e.name);

    // 同名冲突 → 加序号，绝不覆盖用户在 outDir 里已有的东西
    if (fs.existsSync(to)) {
      const ext = path.extname(e.name);
      const stem = e.name.slice(0, e.name.length - ext.length) || 'item';
      let n = 2;
      to = path.join(dest, `${stem}_${n}${ext}`);
      while (fs.existsSync(to)) {
        n += 1;
        to = path.join(dest, `${stem}_${n}${ext}`);
      }
    }

    try {
      fs.renameSync(from, to);
      moved += 1;
    } catch {
      // 跨卷等情况 rename 会失败 → 退回递归复制
      try {
        fs.cpSync(from, to, { recursive: true });
        moved += 1;
      } catch {
        /* 单个条目失败不影响整体 */
      }
    }
  }

  try {
    fs.rmSync(src, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return moved;
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
function collapseSingleRoot(dir: string): string | null {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.length !== 1) return null;
  const only = entries[0];
  if (!only.isDirectory()) return null;
  if (only.name.startsWith('.sz333-tmp-') || /_L\d+$/.test(only.name)) return null;

  const inner = path.join(dir, only.name);
  const moved = moveContentsInto(inner, dir);
  if (moved === 0) return null;
  try {
    fs.rmSync(inner, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return only.name;
}

function dirStats(dir: string): { files: number; size: number } {
  let files = 0;
  let size = 0;
  const walk = (d: string): void => {
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
