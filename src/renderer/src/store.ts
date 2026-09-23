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
  /** 对清单再做一次重复剔除（手动触发），返回剔除数量 */
  dedupePacks(): number;
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

/** 成功任务的自动收起定时器（避免重复挂号） */
const collapseTimers = new Map<string, number>();

/** 规范化包名（与主进程 dedup.ts 的同名函数保持完全一致） */
function normalizeCopyName(name: string): string {
  let s = name;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
    s = s.replace(/\.(7z|zip|rar|tar|gz|tgz|bz2|xz|cab)$/i, '');
    if (s === before) break;
  }
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/[\s_-]*[(（]\s*\d+\s*[)）]$/, '');
    s = s.replace(/[\s_-]+(?:副本|复制|copy|copia)$/i, '');
    s = s.replace(/[\s_-]+copy\d*$/i, '');
    // 浏览器"另存为"产生的单位数后缀，如 foo_1 / foo-2（两位数以上视为不同包名，不动）
    s = s.replace(/[_-]+[1-9]$/, '');
  }
  s = s.replace(/[\s_-]+$/, '');
  return s.trim().toLowerCase();
}

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
        const keepDropped = window.confirm(
          `检测到 ${count} 个重复包（同名且分卷大小完全一致），已自动剔除：\n\n` +
            dupDetails.slice(0, 8).join('\n') +
            (dupDetails.length > 8 ? `\n… 其余 ${dupDetails.length - 8} 条` : '') +
            `\n\n点【确定】保持剔除；点【取消】把它们加回清单。`
        );
        if (!keepDropped) {
          const back = await window.api.scanPacks(paths);
          const cur = [...get().packs];
          for (const p of back) {
            if (!cur.some((x) => x.primary === p.primary)) cur.push(p);
          }
          set({ packs: cur });
          get().toast('warn', '已把重复包加回清单', `共 ${count} 份，同一内容会出现多张卡片`);
          return added;
        }
        get().toast('info', `已剔除 ${count} 个重复包`, '同名且分卷大小一致，清单中保留一份');
      } else {
        // silent（默认）
        get().toast('info', `已剔除 ${count} 个重复包`, '同名且逐分卷大小一致，清单中保留一份');
      }
    } else if (added) {
      get().toast('ok', `已添加 ${added} 个资源包`, undefined);
    }
    return added;
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
