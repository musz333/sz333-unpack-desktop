import { create } from 'zustand';
import type { AppSettings, ArchiveInfo, PackItem, TaskRecord, ThemeMode, WorkflowCard, ImportPreviewData } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

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

  // actions
  init(): Promise<void>;
  setView(v: ViewKey): void;
  setTheme(mode: ThemeMode): void;
  applySystemTheme(dark: boolean): void;

  addPaths(paths: string[]): Promise<number>;
  clearPacks(): void;
  selectPack(id: string | null): void;
  loadArchive(id: string, password?: string): Promise<void>;

  startExtractFromSelection(): Promise<void>;
  startExtract(packId: string, opts?: { outDir?: string; password?: string }): Promise<void>;

  updateTask(t: TaskRecord): void;
  removeTask(id: string): void;
  clearFinished(): void;

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
  submitPassword(pwd: string): Promise<void>;
}

const uid = () => Math.random().toString(36).slice(2, 9);

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

  /* ------------------------------------------------------------------ */

  async init() {
    const settings = await window.api.getSettings();
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    set({ settings, theme: settings.theme, resolvedDark: dark, ready: true });

    window.api.onTask((t) => get().updateTask(t));
    window.api.onToast((t) => get().toast(t.kind, t.title, t.desc ?? ''));
    window.api.onWorkflows((cards) => set({ workflows: cards }));
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
    const existing = get().packs;
    const merged = [...existing];
    let added = 0;
    for (const p of incoming) {
      const dup = merged.find((x) => x.primary === p.primary);
      if (dup) continue;
      merged.push(p);
      added += 1;
    }
    set({ packs: merged });
    if (!get().selectedId && merged.length) {
      set({ selectedId: merged[0].id });
      void get().loadArchive(merged[0].id);
    }
    if (added) get().toast('ok', `已添加 ${added} 个资源包`, undefined);
    return added;
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
  },

  removeTask(id) {
    void window.api.removeTask(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  clearFinished() {
    set((s) => ({
      tasks: s.tasks.filter((t) => !['done', 'failed', 'cancelled'].includes(t.status))
    }));
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

  async submitPassword(pwd) {
    const id = get().passwordFor;
    if (!id) return;
    const task = get().tasks.find((t) => t.id === id);
    const res = await window.api.retryTask(id, pwd, task?.outDir || undefined);
    if (res) {
      get().updateTask(res);
      get().closePassword();
      get().toast('info', '已用新密码重试', task?.label);
    }
  }
}));
