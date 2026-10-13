import { create } from 'zustand';
import type { AppSettings, ArchiveInfo, PackItem, TaskRecord, ThemeMode, WorkflowCard, ImportPreviewData } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
/* 包名归一规则与主进程**共用同一份实现**（shared/volumeKey.ts）。
 * 原先这里手抄了一份，靠注释提醒"与 dedup.ts 保持一致" —— 一旦两边规则漂移，
 * 就会出现"渲染层判为重复、主进程却不认"的不一致。 */
import { normalizeCopyName } from '@shared/volumeKey';

export type ViewKey = 'extract' | 'workflows' | 'history';
export type ToastKind = 'ok' | 'warn' | 'bad' | 'info';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  title: string;
  desc?: string;
}

export interface ArchiveCache {
  status: 'idle' | 'loading' | 'ok' | 'error' | 'needs-password';
  info?: ArchiveInfo;
  error?: string;
}

/** 重复包询问（替代 window.confirm：非阻塞、与设计系统一致的对话框） */
export interface DupPrompt {
  count: number;
  details: string[];
  /** 本次拖入的原始路径：用户选择"加回清单"时用它重新扫描 */
  paths: string[];
}

interface State {
  ready: boolean;
  view: ViewKey;
  theme: ThemeMode;
  resolvedDark: boolean;
  settings: AppSettings;

  packs: PackItem[];
  selectedId: string | null;
  archives: Record<string, ArchiveCache>;

  tasks: TaskRecord[];
  toasts: ToastItem[];

  // 工作流
  workflows: WorkflowCard[];
  wfViewMode: 'card' | 'list';
  wfLog: { kind: 'matched' | 'probe' | 'saved' | 'miss' | 'disabled'; text: string; anchorPassword?: string }[];
  importPreview: ImportPreviewData | null;

  passwordFor: string | null;
  passwordError: string | null;

  /** 待用户确认的重复包询问（仅 dupPolicy==='ask' 时出现） */
  dupPrompt: DupPrompt | null;

  // actions
  init(): Promise<void>;
  setView(v: ViewKey): void;
  setTheme(mode: ThemeMode): void;
  applySystemTheme(dark: boolean): void;

  addPaths(paths: string[]): Promise<number>;
  /** 对清单再做一次重复剔除（手动触发），返回剔除数量 */
  dedupePacks(): number;
  clearPacks(): void;
  selectPack(id: string | null): void;
  loadArchive(id: string, password?: string): Promise<void>;

  startExtractFromSelection(): Promise<void>;
  /** 批量解压：对当前清单里所有可解压的包逐个入队 */
  startExtractAll(): Promise<void>;
  startExtract(packId: string, opts?: { outDir?: string; password?: string }): Promise<void>;

  updateTask(t: TaskRecord): void;
  removeTask(id: string): void;
  clearFinished(): void;

  /** 响应用户对重复包询问的选择：true=保持剔除 / false=加回清单 */
  resolveDupPrompt(keep: boolean): Promise<void>;

  patchSettings(patch: Partial<AppSettings>): Promise<void>;

  // 工作流
  loadWorkflows(): Promise<void>;
  setWfViewMode(mode: 'card' | 'list'): void;
  workflowToggle(id: string): Promise<void>;
  workflowRemove(id: string): Promise<void>;
  workflowApply(id: string): Promise<void>;
  workflowExport(ids?: string[]): Promise<void>;
  openImportPreview(): Promise<boolean>;
  workflowImportApply(selectedAnchors: string[], overwrite: boolean): Promise<void>;

  toast(kind: ToastKind, title: string, desc?: string): void;
  dismissToast(id: string): void;

  requestPassword(taskId: string): void;
  closePassword(): void;
  /** remember=true 时把该密码并入记忆（并开启「记住密码」），供工作流锚点命中 */
  submitPassword(pwd: string, remember?: boolean): Promise<void>;
}

const uid = () => Math.random().toString(36).slice(2, 9);

/** 成功任务的自动收起定时器（避免重复挂号） */
const collapseTimers = new Map<string, number>();

/** init() 幂等守卫：StrictMode 下 effect 会双调用，必须**同步**置位，避免重复注册 IPC 监听 */
let initStarted = false;

/** 取该包的分卷大小签名：分卷数 + 逐分卷字节数（主进程已按文件名排序算好） */
function volumeSignatureOf(p: PackItem): string {
  const sizes = p.volumeSizes ?? [];
  return `${p.files.length}:${sizes.join(',')}`;
}

function baseNameOf(p: PackItem): string {
  const s = p.primary.split(/[\\/]/).pop() ?? p.primary;
  return s.replace(/\.[^.]*$/, '');
}

/**
 * 两份资源包是否"同一份内容"
 *   ① 主分卷路径完全相同 → 是
 *   ② 规范化名相同 + 分卷数相同 + **逐分卷大小完全一致** → 是
 *   （只看 stat 就能拿到的信息，不读文件内容：几十 GB 的包算哈希代价不可接受）
 */
function isSamePack(a: PackItem, b: PackItem): boolean {
  if (a.primary === b.primary) return true;
  if (normalizeCopyName(baseNameOf(a)) !== normalizeCopyName(baseNameOf(b))) return false;
  if (a.files.length !== b.files.length) return false;
  return volumeSignatureOf(a) === volumeSignatureOf(b);
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  view: 'extract',
  theme: DEFAULT_SETTINGS.theme,
  resolvedDark: false,
  settings: DEFAULT_SETTINGS,

  packs: [],
  selectedId: null,
  archives: {},

  tasks: [],
  toasts: [],

  workflows: [],
  wfViewMode: 'card',
  wfLog: [],
  importPreview: null,

  passwordFor: null,
  passwordError: null,

  dupPrompt: null,

  /* ------------------------------------------------------------------ */

  async init() {
    // 幂等守卫：React.StrictMode 下 effect 双调用会重复注册监听；同步置位才能真正拦住
    if (initStarted) return;
    initStarted = true;
    const settings = await window.api.getSettings();
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    set({ settings, theme: settings.theme, resolvedDark: dark, ready: true });

    window.api.onTask((t) => get().updateTask(t));
    window.api.onToast((t) => get().toast(t.kind, t.title, t.desc ?? ''));
    window.api.onWorkflows((cards) => set({ workflows: cards }));
    window.api.onRenamed((info) => {
      // 把"原名 → 新名"写进任务日志，用户随时能对照找回文件
      const lines = info.renames.map((r) => {
        const from = r.from.split(/[\\/]/).pop() ?? r.from;
        const to = r.to.split(/[\\/]/).pop() ?? r.to;
        return `${from} → ${to}`;
      });
      set((s) => ({
        wfLog: [
          {
            kind: 'probe' as const,
            text:
              `中文路径已转英文：输出目录 ${info.dirChanged ? '已改为英文目录' : '未变'}，` +
              `共改名 ${info.renames.length} 项${info.conflicts ? `（同名加序号 ${info.conflicts} 项）` : ''}` +
              (lines.length ? `\n${lines.slice(0, 12).join('\n')}` : '')
          },
          ...s.wfLog
        ].slice(0, 60)
      }));
    });
    window.api.onWorkflowProgress((e) => {
      set((s) => ({ wfLog: [{ kind: e.kind, text: e.text, anchorPassword: e.anchorPassword }, ...s.wfLog].slice(0, 60) }));
      // 只对关键事件弹 Toast，避免"走探测/记失误"这类过程信息刷屏
      if (e.kind === 'matched') get().toast('ok', '命中工作流卡片', e.text);
      else if (e.kind === 'saved') get().toast('info', '已记住这条解压套路', e.text);
      else if (e.kind === 'disabled') get().toast('warn', '工作流已自动停用', e.text);
    });
    set({ wfViewMode: settings.wfView === 'list' ? 'list' : 'card' });

    window.menuBridge?.onAdd(() => {
      void (async () => {
        const paths = await window.api.pickArchives();
        if (paths.length) await get().addPaths(paths);
      })();
    });
  },

  setView(v) {
    set({ view: v });
  },

  setTheme(mode) {
    const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    set({ theme: mode, resolvedDark: dark });
    void get().patchSettings({ theme: mode });
  },

  applySystemTheme(dark) {
    if (get().theme === 'system') set({ resolvedDark: dark });
  },

  /* ------------------------------------------------------------------ */

  async addPaths(paths) {
    const incoming = await window.api.scanPacks(paths);
    const merged = [...get().packs];
    let added = 0;
    let mergedDup = 0;
    const dupDetails: string[] = [];

    for (const p of incoming) {
      const hit = merged.find((x) => isSamePack(x, p));
      if (hit) {
        // 与清单里已有的一份"同名 + 分卷大小一致" → 视为重复，合并到保留的那一份上
        hit.mergedCount = (hit.mergedCount ?? 1) + 1;
        hit.dupPaths = [...(hit.dupPaths ?? []), p.primary];
        mergedDup += 1;
        dupDetails.push(`${p.primary}  ←  与已添加的 ${hit.primary} 相同`);
        continue;
      }
      merged.push(p);
      added += 1;
    }

    set({ packs: merged });
    if (!get().selectedId && merged.length) {
      set({ selectedId: merged[0].id });
      void get().loadArchive(merged[0].id);
    }

    const count = mergedDup;
    if (count > 0) {
      if (get().settings.dupPolicy === 'ask') {
        /* 修复 P2-⑨：原先用 window.confirm —— 阻塞主线程、破坏设计一致性、无法显示完整清单。
         * 改为把询问写入状态，由 DuplicatePromptDialog 自绘（非阻塞，Esc/按钮皆可应答）。 */
        set({ dupPrompt: { count, details: dupDetails, paths } });
        return added;
      }
      // silent（默认）
      get().toast('info', `已剔除 ${count} 个重复包`, '同名且逐分卷大小一致，清单中保留一份');
    } else if (added) {
      get().toast('ok', `已添加 ${added} 个资源包`, undefined);
    }
    return added;
  },

  async resolveDupPrompt(keep) {
    const prompt = get().dupPrompt;
    if (!prompt) return;
    set({ dupPrompt: null });

    if (keep) {
      get().toast('info', `已剔除 ${prompt.count} 个重复包`, '同名且分卷大小一致，清单中保留一份');
      return;
    }
    // 用户选择"加回清单"：重新扫描本次拖入的路径，把不在清单里的补回去
    const back = await window.api.scanPacks(prompt.paths);
    const cur = [...get().packs];
    for (const p of back) {
      if (!cur.some((x) => x.primary === p.primary)) cur.push(p);
    }
    set({ packs: cur });
    get().toast('warn', '已把重复包加回清单', `共 ${prompt.count} 份，同一内容会出现多张卡片`);
  },

  dedupePacks() {
    const packs = get().packs;
    const kept: PackItem[] = [];
    let dropped = 0;
    const detail: string[] = [];

    for (const p of packs) {
      const hit = kept.find((x) => isSamePack(x, p));
      if (hit) {
        hit.mergedCount = (hit.mergedCount ?? 1) + 1;
        hit.dupPaths = [...(hit.dupPaths ?? []), p.primary];
        dropped += 1;
        detail.push(`${p.primary}  ←  与 ${hit.primary} 相同`);
        continue;
      }
      kept.push(p);
    }

    set({ packs: kept, selectedId: kept.some((k) => k.id === get().selectedId) ? get().selectedId : (kept[0]?.id ?? null) });
    if (dropped > 0) {
      const preview = detail.slice(0, 6).join('\n');
      get().toast('ok', `已剔除 ${dropped} 个重复包`, preview || '同名且逐分卷大小一致');
    } else {
      get().toast('info', '没有发现重复包', '同名且分卷大小完全一致才会被判为重复');
    }
    return dropped;
  },

  clearPacks() {
    set({ packs: [], selectedId: null, archives: {} });
  },

  selectPack(id) {
    set({ selectedId: id });
    if (id) void get().loadArchive(id);
  },

  async loadArchive(id, password) {
    const pack = get().packs.find((p) => p.id === id);
    if (!pack) return;
    set((s) => ({ archives: { ...s.archives, [id]: { status: 'loading' } } }));
    const res = await window.api.listArchive(pack.primary, password);
    if (!res.ok) {
      set((s) => ({ archives: { ...s.archives, [id]: { status: 'error', error: res.error } } }));
      return;
    }
    const info = res.data;
    if (info.passwordRequired && !password) {
      set((s) => ({ archives: { ...s.archives, [id]: { status: 'needs-password', info } } }));
      return;
    }
    set((s) => ({ archives: { ...s.archives, [id]: { status: 'ok', info } } }));
  },

  /* ------------------------------------------------------------------ */

  async startExtractFromSelection() {
    const { selectedId, packs } = get();
    const pack = packs.find((p) => p.id === selectedId) ?? packs[0];
    if (pack) await get().startExtract(pack.id);
  },

  async startExtractAll() {
    const targets = get().packs.filter((p) => p.extractable);
    if (!targets.length) {
      get().toast('warn', '没有可解压的资源包', '清单里没有支持的压缩格式');
      return;
    }
    // 逐个入队：主进程按 maxConcurrent 调度，这里只负责全部挂号
    for (const p of targets) {
      const task = await window.api.startExtract({ paths: [p.primary], label: p.baseName });
      get().updateTask(task);
    }
    get().toast('info', `已加入队列 ${targets.length} 个资源包`, '按设置里的并发数依次处理');
  },

  async startExtract(packId, opts = {}) {
    const pack = get().packs.find((p) => p.id === packId);
    if (!pack) return;
    if (!pack.extractable) {
      get().toast('warn', '该格式暂不支持解压', pack.note || '请确认文件类型');
      return;
    }
    const task = await window.api.startExtract({
      paths: [pack.primary],
      outDir: opts.outDir,
      password: opts.password,
      label: pack.baseName
    });
    get().updateTask(task);
    get().toast('info', '已加入队列', pack.baseName);
  },

  /* ------------------------------------------------------------------ */
  /* 工作流                                                              */
  /* ------------------------------------------------------------------ */

  async loadWorkflows() {
    const cards = await window.api.workflowList();
    set({ workflows: cards });
  },

  setWfViewMode(mode) {
    set({ wfViewMode: mode });
    void get().patchSettings({ wfView: mode } as Partial<AppSettings>);
  },

  async workflowToggle(id) {
    await window.api.workflowToggle(id);
    await get().loadWorkflows();
  },

  async workflowRemove(id) {
    await window.api.workflowRemove(id);
    await get().loadWorkflows();
    get().toast('info', '已删除卡片', undefined);
  },

  async workflowApply(id) {
    await window.api.workflowApply(id);
  },

  async workflowExport(ids) {
    const r = await window.api.workflowExport(ids);
    if (r.ok) get().toast('ok', `已导出 ${r.count} 张卡片`, r.path);
    else if (r.error && r.error !== 'cancelled') get().toast('bad', '导出失败', r.error);
  },

  async openImportPreview() {
    const r = await window.api.workflowImportPreview();
    if (!r.ok || !r.preview) {
      if (r.error && r.error !== 'cancelled') get().toast('bad', '无法导入', r.error);
      return false;
    }
    set({ importPreview: r.preview });
    if (r.error) get().toast('warn', '部分文件未能解析', r.error);
    return true;
  },

  async workflowImportApply(selectedAnchors, overwrite) {
    const r = await window.api.workflowImportApply({ selectedAnchors, overwrite });
    await get().loadWorkflows();
    set({ importPreview: null });
    get().toast('ok', '导入完成', `新增 ${r.added} · 覆盖 ${r.overwritten} · 跳过 ${r.skipped}`);
  },

  /* ------------------------------------------------------------------ */

  updateTask(t) {
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      const tasks = i >= 0 ? s.tasks.map((x) => (x.id === t.id ? t : x)) : [t, ...s.tasks];
      return { tasks };
    });

    if (t.status === 'needs-password') {
      set({ passwordFor: t.id, passwordError: null });
    }

    // 成功后自动收起（延时 8 秒，给用户点【打开】【定位】的窗口）
    // 只处理 done：失败 / 取消 / 待密码 一律常驻，方便回来排查
    if (t.status === 'done' && get().settings.autoCollapseDone === 'on') {
      if (collapseTimers.has(t.id)) return;
      const timer = window.setTimeout(() => {
        collapseTimers.delete(t.id);
        const cur = get().tasks.find((x) => x.id === t.id);
        if (!cur || cur.status !== 'done') return;   // 期间被重试/移除则不动
        set((s) => ({ tasks: s.tasks.filter((x) => x.id !== t.id) }));
      }, 8000);
      collapseTimers.set(t.id, timer);
    }

    // 若该任务被手动移除或状态变了，取消挂起的定时器
    if (t.status !== 'done' && collapseTimers.has(t.id)) {
      window.clearTimeout(collapseTimers.get(t.id)!);
      collapseTimers.delete(t.id);
    }
  },

  removeTask(id) {
    void window.api.removeTask(id);
    const timer = collapseTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      collapseTimers.delete(id);
    }
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  clearFinished() {
    for (const [id, timer] of collapseTimers) {
      window.clearTimeout(timer);
      void id;
    }
    collapseTimers.clear();
    set((s) => ({
      tasks: s.tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.status))
    }));
    /* 修复 P2-⑫：原先只清渲染层状态，主进程 tasks 里仍留着已完成任务，
     * 下次拉取会把它们又推回来。同步调用主进程「清除已完成任务」IPC（task:clear-finished）。 */
    void window.api.clearFinishedTasks();
  },

  /* ------------------------------------------------------------------ */

  async patchSettings(patch) {
    const next = await window.api.setSettings(patch);
    set({ settings: next });
  },

  /* ------------------------------------------------------------------ */

  toast(kind, title, desc) {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, desc }].slice(-4) }));
    window.setTimeout(() => get().dismissToast(id), kind === 'bad' ? 6000 : 3600);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  /* ------------------------------------------------------------------ */

  requestPassword(taskId) {
    set({ passwordFor: taskId, passwordError: null });
  },

  closePassword() {
    set({ passwordFor: null, passwordError: null });
  },

  async submitPassword(pwd, remember) {
    const id = get().passwordFor;
    if (!id) return;

    /* 修复 P0-⑩（UI 侧）：勾选「记住此密码」时，把该密码并入记忆并打开「记住密码」开关。
     * 主进程的 rememberPassword() 只有在 settings.rememberPasswords 为 true 时才写入，
     * 所以这里必须显式置位 + 落盘，才能让锚点工作流真正命中。 */
    if (remember) {
      const cur = get().settings.passwords;
      const next = [pwd, ...cur.filter((x) => x !== pwd)].slice(0, 30);
      await get().patchSettings({ rememberPasswords: true, passwords: next });
    }

    const task = get().tasks.find((t) => t.id === id);
    const res = await window.api.retryTask(id, pwd, task?.outDir || undefined);
    if (res) {
      get().updateTask(res);
      get().closePassword();
      get().toast('info', '已用新密码重试', task?.label);
    } else {
      // 主进程查无此任务（可能已被清理）：给出反馈，而不是静默卡住对话框
      set({ passwordError: '该任务已不存在，请关闭对话框后重试' });
    }
  }
}));
