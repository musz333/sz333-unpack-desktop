import { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Notification, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { CH, DEFAULT_SETTINGS } from '@shared/types';
import { fmtBytes } from '@shared/bytes';
import type { AppSettings, TaskRecord, Result, ArchiveInfo, ImportPreviewData } from '@shared/types';
import { scanPaths, listArchive, run7z, userDataDir, resolve7z } from './engine';
import { logger, initLogger } from './logger';
import { recoverInflight } from './recovery';
import { TaskManager } from './tasks';
import {
  loadWorkflows,
  saveWorkflows,
  manualEnable,
  mergeDuplicateAnchors,
  isUsable,
  chainText,
  setSecretCodec,
  type Workflow
} from './workflows';
import { exportPack, previewPack, applyImport, type WorkflowCardDto as CardDto } from './workflowPack';

/* ------------------------------------------------------------------ *
 * 窗口与单实例
 * ------------------------------------------------------------------ */
let win: BrowserWindow | null = null;
const isDev = !app.isPackaged;

/* 统一日志出口：尽早初始化，保证后续所有日志都能落到 app.log（dev 下同时镜像到 console） */
initLogger({ consoleMirror: isDev });

process.env.SZ333_RESOURCES = isDev
  ? path.join(app.getAppPath(), 'resources')
  : process.resourcesPath;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 设置持久化（用户级 JSON，避免 Program Files 只读）
 * ------------------------------------------------------------------ */
const settingsFile = () => path.join(userDataDir(), 'settings.json');

/* ------------------------------------------------------------------ *
 * 落盘密码加解密
 *
 * 记住的密码与工作流锚点密码**绝不能以明文 JSON 落盘**（同机任意进程都能读配置目录）。
 * 用 `safeStorage`（Windows 底层 DPAPI，按当前用户加密）：落盘形态 = `enc:` + base64；
 * 无前缀视为旧明文（向后兼容）；`isEncryptionAvailable()` 为 false 时降级为明文并记日志，
 * 绝不因此崩溃。加密只作用于**落盘那一刻**，内存/IPC/导出包内仍是明文。
 * ------------------------------------------------------------------ */
const ENC_PREFIX = 'enc:';
/** 只在首次降级时记一条日志，避免刷屏 */
let warnedNoEncryption = false;

function sealSecret(plain: string): string {
  if (!plain) return plain;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch (e) {
    logger.warn(`密码加密失败，降级为明文：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!warnedNoEncryption) {
    warnedNoEncryption = true;
    logger.warn('safeStorage 不可用：解压密码将**明文**落盘（功能不受影响，但请勿在多用户机器上共享配置目录）');
  }
  return plain;
}

function openSecret(stored: string): string {
  if (!stored) return stored;
  // 无前缀 = 旧版明文，直接放行（向后兼容）
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (e) {
    // 解密失败（换机/换用户导致 DPAPI 密钥不匹配）→ 丢弃该条，绝不用密文当密码
    logger.warn(`密码解密失败（已忽略该条）：${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    if (fs.existsSync(settingsFile())) {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>;
      // 与默认值合并：保证旧配置文件里缺失的新字段也能拿到默认值
      settings = { ...DEFAULT_SETTINGS, ...raw };
      /* 修复 P0-②：磁盘上的 passwords 可能是加密形态（或旧明文）→ 统一还原成内存明文。
       * 同时兜底：字段缺失/损坏（非数组）时归一为 []，避免后续 includes/indexOf 抛错。 */
      const rawPwd = Array.isArray(settings.passwords) ? settings.passwords : [];
      settings.passwords = rawPwd
        .filter((p): p is string => typeof p === 'string')
        .map((p) => openSecret(p))
        .filter((p) => !!p);
    }
  } catch (e) {
    logger.warn(`读取设置失败，已回退默认值：${e instanceof Error ? e.message : String(e)}`);
    settings = { ...DEFAULT_SETTINGS };
  }
  /* ------------------------------------------------------------
   * 注意：这里**不再**把空的 defaultOutDir 回填成「下载」目录。
   *
   * 原来的写法 `if (!settings.defaultOutDir) settings.defaultOutDir = app.getPath('downloads')`
   * 让 `defaultOutDir === ''` 这个语义（**与源文件同级**）永远无法成立：
   * tasks.ts 里的 `const base = settings.defaultOutDir || srcDir` 兜底因此变成死代码，
   * 引导页承诺的「默认放在源文件所在目录旁边」也就实现不了。
   *
   * 现在空字符串就是"未设置"，真正的"与源文件同级"由 tasks.ts 的 `|| srcDir` 落地。
   * 其它需要"下载目录"兜底的地方（工作流导出/导入对话框）各自带 `|| app.getPath('downloads')`，
   * 不受影响 —— 只是不再把这个值**写回 settings**。
   * ------------------------------------------------------------ */
}

function persistSettings() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    /* 修复 P0-②：落盘前把密码列表整体加密。
     * 内存里 settings.passwords 始终是明文（匹配、UI 展示都要用），
     * 只有这里写盘时替换成密文形态，避免改动其它所有调用点。 */
    const onDisk: AppSettings = {
      ...settings,
      passwords: Array.isArray(settings.passwords)
        ? settings.passwords.filter((p): p is string => typeof p === 'string').map(sealSecret)
        : []
    };
    fs.writeFileSync(settingsFile(), JSON.stringify(onDisk, null, 2), 'utf8');
  } catch (e) {
    logger.warn(`写入设置失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 历史记录
 * ------------------------------------------------------------------ */
export interface HistoryEntry {
  id: string;
  op: 'extract';
  label: string;
  source: string;
  output: string;
  size: number;
  fileCount?: number;
  status: 'done' | 'failed' | 'cancelled';
  at: number;
}

const historyFile = () => path.join(userDataDir(), 'history.json');
let history: HistoryEntry[] = [];

function loadHistory() {
  try {
    if (fs.existsSync(historyFile())) {
      history = JSON.parse(fs.readFileSync(historyFile(), 'utf8')).slice(0, 200);
    }
  } catch (e) {
    logger.warn(`读取历史记录失败，已清空：${e instanceof Error ? e.message : String(e)}`);
    history = [];
  }
}
function persistHistory() {
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, 200), null, 2), 'utf8');
  } catch (e) {
    logger.warn(`写入历史记录失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 工作流（以解压密码为锚点的解压链路记忆）
 * ------------------------------------------------------------------ */
let workflows: Workflow[] = [];
/** 导入预览缓存：文件路径 → 完整预览（含卡片数据，提交时用） */
const importCache = new Map<string, ReturnType<typeof previewPack>>();

function loadWorkflowState() {
  workflows = loadWorkflows();
  const merged = mergeDuplicateAnchors(workflows);
  if (merged > 0) {
    saveWorkflows(workflows);
    logger.info(`已合并同锚点重复工作流 ${merged} 条`);
  }
}

/** 把内部结构转成渲染层需要的卡片形状 */
function toCard(w: Workflow) {
  return {
    id: w.id,
    name: w.name,
    anchorPassword: w.anchorPassword,
    nameHint: w.nameHint,
    chain: chainText(w),
    layerCount: w.steps.length,
    volCount: w.volCount,
    primVolSize: w.primVolSize,
    hitCount: w.hitCount,
    missCount: w.missCount,
    lastUsedAt: w.lastUsedAt,
    createdAt: w.createdAt,
    enabled: w.enabled,
    autoDisabled: w.autoDisabled,
    missPasswordError: w.missPasswordError,
    usable: isUsable(w),
    note: w.note
  };
}

function describeCardDto(c: CardDto): string {
  const layers = c.steps?.length ?? c.layerCount;
  return '锚点 ' + (c.anchorPassword || '（无锚点）') + ' · ' + layers + ' 层 · 命中 ' + c.hitCount + ' 次';
}

function emitWorkflows() {
  win?.webContents.send('ev:workflows', workflows.map(toCard));
}

const workflowApi = {
  list: () => workflows,
  save: () => {
    saveWorkflows(workflows);
    emitWorkflows();
  }
};

/* ------------------------------------------------------------------ *
 * 任务管理
 * ------------------------------------------------------------------ */
/** 删源确认的"本次会话不再提示"标记（修复 P1-⑤） */
let suppressDeleteConfirm = false;

/* 人类可读体积：统一走 `@shared/bytes`（原本地实现已收敛，避免多处口径漂移）。 */

const tasks = new TaskManager({
  getSettings: () => settings,
  workflows: workflowApi,
  /* 修复 P1-2 / P1-3：密码记忆统一在这里"写入 + 落盘"。
   * 旧实现是在 tasks.ts 里直接改 getSettings() 返回的对象：既不落盘，
   * 又会被随后的 setSettings()（整体替换 settings 引用）丢弃。 */
  rememberPassword: (pwd: string) => {
    if (!settings.rememberPasswords || !pwd) return;
    if (settings.passwords.includes(pwd)) return;
    settings.passwords = [pwd, ...settings.passwords].slice(0, 30);
    persistSettings();
  },
  /* 删源前二次确认（删除不可恢复）。返回 false = 用户取消，tasks.ts 会原样保留源文件。
   * 安全兜底：拿不到窗口时返回 false —— 宁可不删，也不在无确认的情况下删。 */
  confirmDeleteSource: async (info: { count: number; bytes: number; paths: string[] }) => {
    if (suppressDeleteConfirm) return true;
    if (!win) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['删除源文件', '保留源文件'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      checkboxLabel: '本次会话不再提示',
      title: '确认删除源文件',
      message: `即将永久删除 ${info.count} 个源文件（共 ${fmtBytes(info.bytes)}），不可恢复。`,
      detail:
        '当前【源文件处理】为「彻底删除」：删除**不进回收站**，删除后无法还原。\n' +
        '如需保留源包，请点「保留源文件」，或到【设置】→ 源文件处理 改为「保留原始文件」。'
    });
    if (r.checkboxChecked) suppressDeleteConfirm = true;
    return r.response === 0;
  },
  onWorkflowProgress: (payload) => win?.webContents.send('ev:wf-progress', payload),
  onWorkflowsChanged: () => emitWorkflows(),
  onRenamed: (info) => {
    win?.webContents.send('ev:renamed', info);
    logger.info(`中文路径转英文：目录变更=${info.dirChanged} 改名=${info.renames.length} 同名加序号=${info.conflicts}`);
  },
  emit: (task) => {
    win?.webContents.send(CH.evTask, task);
    if (task.status === 'done' || task.status === 'failed') {
      /* 按 id 幂等 upsert：成功任务会 emit 两次（setStatus('done') 后又 patch 清理字段），
       * 若每次都 unshift，同一任务会在历史里出现两条。 */
      const entry: HistoryEntry = {
        id: task.id,
        op: 'extract',
        label: task.label,
        source: task.sourcePaths[0] ?? '',
        output: task.outputPath ?? '',
        size: task.outputSize ?? 0,
        fileCount: task.fileCount,
        status: task.status === 'done' ? 'done' : 'failed',
        at: Date.now()
      };
      const idx = history.findIndex((h) => h.id === task.id);
      if (idx >= 0) history[idx] = entry;
      else history.unshift(entry);
      persistHistory();
    }
  },
  toast: (kind, title, desc) => {
    win?.webContents.send(CH.evToast, { kind, title, desc });
    if (settings.notifyOnFinish && (kind === 'ok' || kind === 'bad') && Notification.isSupported()) {
      try {
        new Notification({ title, body: desc ?? '', silent: false }).show();
      } catch {
        /* ignore */
      }
    }
  }
});

tasks.on('removed', () => {
  /* 渲染层靠任务列表刷新即可 */
});
tasks.on('open', (p: string) => {
  void shell.openPath(p);
});

/* ------------------------------------------------------------------ *
 * 创建窗口
 * ------------------------------------------------------------------ */
function createWindow() {
  const b: NonNullable<AppSettings['windowBounds']> = settings.windowBounds ?? { width: 1240, height: 800 };
  win = new BrowserWindow({
    width: b.width ?? 1240,
    height: b.height ?? 800,
    x: b.x,
    y: b.y,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e10' : '#fafafa',
    title: 'sz333 解压工具',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* 修复 P1-④：开启渲染进程沙箱。
       *
       * 原来 sandbox:false 让渲染进程脱离 Chromium 沙箱运行；一旦渲染层被注入
       * （恶意压缩包内容、被篡改的前端资源），逃逸/提权面更大。
       *
       * 评估结论：本项目的 preload 只用到 `electron` 里在沙箱预加载中**依然可用**
       * 的模块（contextBridge / ipcRenderer / webUtils），且经 electron-vite 打包成
       * 单文件、不 require 任何 Node 内置模块，因此可以安全开启。
       * 注意：请勿在 preload 里引入 fs/path 等 Node 内置模块，否则沙箱下会失效。 */
      sandbox: true,
      spellcheck: false
    }
  });

  /* 修复 P2-⑦：拦截一切导航与新窗口。
   *
   * 本窗口只应展示本地打包的页面。若前端被注入脚本诱导 `location = 'https://…'`，
   * 外部站点会带着 preload 暴露的 IPC 桥运行 —— 等于把 IPC 交给不可信页面。
   * 因此：① 阻止一切"换页"导航；② 一切 window.open 一律拒绝
   * （打开外部链接走 sys:open-external，仅允许 http/https）。
   *
   * 放行"同 URL 重载"（url === 当前 URL）：这样 dev 下 Vite 的 HMR 全量刷新、
   * 以及菜单「重新加载」都不会被误杀；首屏 loadURL/loadFile 属程序化加载，
   * 本就不触发 will-navigate。 */
  win.webContents.on('will-navigate', (e, url) => {
    if (url === win?.webContents.getURL()) return; // 同 URL 重载：放行
    e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /* 窗口保显兜底（修复"进程在跑但窗口永不出现"）：
   * 正常情况下 ready-to-show 在首帧绘制后触发；若渲染进程在首帧前崩溃 /
   * 加载失败，ready-to-show 永不触发，窗口将永久隐藏（用户表现为"双击打不开"）。
   * 这里用 did-finish-load + 8 秒超时双保险强制显示，并把渲染层故障写进 app.log。 */
  let shown = false;
  const showOnce = () => {
    if (shown || !win) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', showOnce);
  win.webContents.on('did-finish-load', () => {
    showOnce();
    // 首帧可能仍晚于 did-finish-load，留 8s 宽限；期间 ready-to-show 触发也无妨（幂等）
    setTimeout(showOnce, 8000);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`渲染层加载失败：code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`渲染进程崩溃：reason=${details.reason} exitCode=${details.exitCode}`);
  });

  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  const url = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && url) {
    void win.loadURL(url);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

function saveBounds() {
  if (!win) return;
  try {
    const b = win.getBounds();
    settings.windowBounds = { width: b.width, height: b.height, x: b.x, y: b.y };
    persistSettings();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * IPC 入参校验（修复 P2-⑥）
 *
 * 主进程**不能信任渲染层传来的任何东西**：即便当前渲染层是我们自己写的，
 * 一旦前端被注入（恶意压缩包内容 / 被篡改的静态资源），恶意代码就能调用
 * `window.api.*` 把任意值喂进 IPC。因此每个 handler 落库/落盘/起进程之前，
 * 都先做类型与范围校验：非法入参直接拒绝（返回空值 / 抛错 / 返回 Err）。
 *
 * 这些校验是"纵深防御"，不是用来替代渲染层自身的合法性判断。
 * ------------------------------------------------------------------ */
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

const THEMES = ['system', 'light', 'dark'] as const;
const OUT_POLICIES = ['source', 'custom'] as const;
const OVERWRITE_POLICIES = ['overwrite', 'skip', 'rename'] as const;
const SOURCE_POLICIES = ['keep', 'delete'] as const;
const NON_ASCII_POLICIES = ['auto', 'force', 'off'] as const;
const DUP_POLICIES = ['silent', 'ask', 'off'] as const;
const AUTO_COLLAPSE = ['on', 'off'] as const;
const WF_VIEWS = ['card', 'list'] as const;
const MAX_CONCURRENCY = [1, 2, 4] as const;

/**
 * 只接受**白名单字段**并逐一校验类型/取值范围，其余字段一律丢弃。
 * 这样即便渲染层塞进 `__proto__` / 未知字段，也污染不到 settings。
 */
function sanitizeSettingsPatch(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};

  const theme = pickEnum(p.theme, THEMES);
  if (theme) out.theme = theme;
  const outDirPolicy = pickEnum(p.outDirPolicy, OUT_POLICIES);
  if (outDirPolicy) out.outDirPolicy = outDirPolicy;
  if (isString(p.defaultOutDir)) out.defaultOutDir = p.defaultOutDir;
  if (typeof p.extractToSubfolder === 'boolean') out.extractToSubfolder = p.extractToSubfolder;
  const overwrite = pickEnum(p.overwrite, OVERWRITE_POLICIES);
  if (overwrite) out.overwrite = overwrite;
  const sourcePolicy = pickEnum(p.sourcePolicy, SOURCE_POLICIES);
  if (sourcePolicy) out.sourcePolicy = sourcePolicy;
  const nonAsciiPolicy = pickEnum(p.nonAsciiPolicy, NON_ASCII_POLICIES);
  if (nonAsciiPolicy) out.nonAsciiPolicy = nonAsciiPolicy;
  const dupPolicy = pickEnum(p.dupPolicy, DUP_POLICIES);
  if (dupPolicy) out.dupPolicy = dupPolicy;
  const autoCollapseDone = pickEnum(p.autoCollapseDone, AUTO_COLLAPSE);
  if (autoCollapseDone) out.autoCollapseDone = autoCollapseDone;
  if (typeof p.maxConcurrent === 'number' && (MAX_CONCURRENCY as readonly number[]).includes(p.maxConcurrent)) {
    out.maxConcurrent = p.maxConcurrent as 1 | 2 | 4;
  }
  if (typeof p.notifyOnFinish === 'boolean') out.notifyOnFinish = p.notifyOnFinish;
  if (typeof p.autoOpenOutDir === 'boolean') out.autoOpenOutDir = p.autoOpenOutDir;
  if (typeof p.rememberPasswords === 'boolean') out.rememberPasswords = p.rememberPasswords;
  if (typeof p.apkFilterEnabled === 'boolean') out.apkFilterEnabled = p.apkFilterEnabled;
  if (typeof p.apkDropThreshold === 'number' && Number.isFinite(p.apkDropThreshold)) {
    out.apkDropThreshold = Math.max(0, Math.min(100, p.apkDropThreshold));
  }
  const wfView = pickEnum(p.wfView, WF_VIEWS);
  if (wfView) out.wfView = wfView;
  if (Array.isArray(p.passwords)) {
    out.passwords = p.passwords
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.slice(0, 1024))
      .slice(0, 200);
  }
  if (typeof p.firstRunDone === 'boolean') out.firstRunDone = p.firstRunDone;
  if (p.windowBounds && typeof p.windowBounds === 'object' && !Array.isArray(p.windowBounds)) {
    const b = p.windowBounds as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const width = num(b.width);
    const height = num(b.height);
    if (width && height) out.windowBounds = { width, height, x: num(b.x), y: num(b.y) };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * IPC 注册
 * ------------------------------------------------------------------ */
function registerIpc() {
  /* ---- 对话框 ---- */
  ipcMain.handle(CH.pickArchives, async () => {
    if (!win) return [];
    const r = await dialog.showOpenDialog(win, {
      title: '选择压缩包',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '压缩包', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', '001', 'z01', 'r00'] },
        { name: '分卷/全部', extensions: ['*'] }
      ]
    });
    return r.canceled ? [] : r.filePaths;
  });


  ipcMain.handle(CH.pickFolder, async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.defaultOutDir
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  /* ---- 设置 ---- */
  ipcMain.handle(CH.getSettings, () => settings);
  ipcMain.handle(CH.setSettings, (_e, patch: unknown) => {
    // 修复 P2-⑥：白名单 + 类型校验后再合并，非法字段被静默丢弃
    const clean = sanitizeSettingsPatch(patch);
    settings = { ...settings, ...clean };
    if (clean.theme) {
      nativeTheme.themeSource = clean.theme === 'system' ? 'system' : clean.theme;
    }
    persistSettings();
    return settings;
  });

  /* ---- 资源包扫描 ---- */
  ipcMain.handle(CH.packScan, async (_e, paths: unknown) => {
    // 修复 P2-⑥：paths 必须是字符串数组，否则直接返回空
    if (!isStringArray(paths)) return [];
    const packs = await scanPaths(paths);
    return packs.map((p) => ({
      id: p.id,
      kind: p.kind,
      baseName: p.baseName,
      files: p.files,
      primary: p.primary,
      size: p.size,
      format: p.format,
      formatLabel: p.formatLabel,
      extractable: p.extractable,
      note: p.note,
      // 去重相关信息必须一并带出，否则渲染层拿不到"合并了几份/依据/被剔除的路径/冲突提示"
      volumeSizes: p.volumeSizes,
      mergedCount: p.mergedCount,
      dupReason: p.dupReason,
      dupPaths: p.dupPaths,
      conflictNote: p.conflictNote
    }));
  });

  /* ---- 列出压缩包内容 ---- */
  ipcMain.handle(CH.archiveList, async (_e, archivePath: unknown, password?: unknown): Promise<Result<ArchiveInfo>> => {
    // 修复 P2-⑥：archivePath 必须是非空字符串；password 必须是字符串或省略
    if (!isString(archivePath) || !archivePath) return { ok: false, error: '参数非法：archivePath' };
    const pwd = isString(password) ? password : undefined;
    try {
      if (!fs.existsSync(archivePath)) return { ok: false, error: '文件不存在' };
      const info = await listArchive(archivePath, pwd);
      info.physicalSize = fs.statSync(archivePath).size;
      return { ok: true, data: info };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /* ---- 任务 ---- */
  ipcMain.handle(
    CH.taskStartExtract,
    (_e, input: unknown): TaskRecord => {
      // 修复 P2-⑥：paths 必须是非空字符串数组；其余字段类型不符则回落默认
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('参数非法：input');
      }
      const i = input as Record<string, unknown>;
      const paths = isStringArray(i.paths) ? i.paths.filter((p) => !!p) : [];
      if (!paths.length) throw new Error('参数非法：paths');
      const first = paths[0];
      const label = isString(i.label) && i.label ? i.label : path.basename(first);
      const outDir = isString(i.outDir) ? i.outDir : '';
      return tasks.add({
        op: 'extract',
        label,
        sourcePaths: paths,
        outDir,
        password: isString(i.password) ? i.password : undefined
      });
    }
  );

  /* ---- 工作流 ---- */
  ipcMain.handle('workflow:list', () => workflows.map(toCard));

  ipcMain.handle('workflow:remove', (_e, id: unknown) => {
    // 修复 P2-⑥：id 必须是字符串
    if (!isString(id)) return false;
    workflows = workflows.filter((w) => w.id !== id);
    saveWorkflows(workflows);
    emitWorkflows();
    return true;
  });

  ipcMain.handle('workflow:toggle', (_e, id: unknown) => {
    if (!isString(id)) return false;
    const w = workflows.find((x) => x.id === id);
    if (!w) return false;
    if (w.enabled) {
      w.enabled = false;
      w.autoDisabled = false;
    } else {
      manualEnable(w);
    }
    saveWorkflows(workflows);
    emitWorkflows();
    return true;
  });

  /** 用某张卡片的锚点密码优先尝试，并立即开始解压 */
  ipcMain.handle('workflow:apply', (_e, id: unknown) => {
    if (!isString(id)) return false;
    const w = workflows.find((x) => x.id === id);
    if (!w) return false;
    if (w.anchorPassword) {
      settings.passwords = [w.anchorPassword, ...settings.passwords.filter((p) => p !== w.anchorPassword)].slice(0, 30);
      persistSettings();
    }
    return true;
  });

  /** 批量导出：不传 ids 则导出全部 */
  ipcMain.handle('workflow:export', async (_e, ids?: unknown) => {
    // 修复 P2-⑥：ids 若提供必须是字符串数组
    const idList = isStringArray(ids) ? ids : undefined;
    const picked = idList?.length ? workflows.filter((w) => idList.includes(w.id)) : workflows;
    if (!picked.length) return { ok: false, error: '没有可导出的工作流' };

    const withPwd = picked.filter((w) => !!w.anchorPassword).length;
    const confirm = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['继续导出', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '批量导出工作流卡片',
      message: `即将导出 ${picked.length} 张卡片（${withPwd} 张带锚点密码）。`,
      detail:
        '导出文件含【解压密码明文】，因为锚点密码就是这张卡片的身份。\n' +
        '请只分享给可信的人，或仅用于自己换机搬运。'
    });
    if (confirm.response !== 0) return { ok: false, error: 'cancelled' };

    const r = await dialog.showSaveDialog(win!, {
      title: '导出工作流卡片',
      defaultPath: path.join(settings.defaultOutDir || app.getPath('downloads'), `工作流卡片_${picked.length}张.json`),
      filters: [{ name: '工作流卡片包', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };

    try {
      const n = exportPack(r.filePath, picked);
      logger.info(`导出工作流 ${n} 张 -> ${r.filePath}`);
      return { ok: true, path: r.filePath, count: n };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 批量导入：解析 → 返回预览（不写数据），由界面勾选后再提交 */
  ipcMain.handle('workflow:importPreview', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '选择工作流卡片包（可多选）',
      defaultPath: settings.defaultOutDir || app.getPath('downloads'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '工作流卡片包', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, error: 'cancelled' };

    /* 每次预览都是**独立一批**：先清掉上一批的缓存。
     * 否则用户"预览了 A 但没提交，又预览 B 并提交"时，importApply 会
     * 遍历到 A 和 B 两份缓存（旧实现只在 apply 末尾 clear）。 */
    importCache.clear();

    const merged: ImportPreviewData = {
      sourceFile: r.filePaths.map((p) => path.basename(p)).join('、'),
      items: [],
      newCount: 0,
      conflictCount: 0,
      lowConfidenceCount: 0,
      skippedCount: 0
    };
    let error: string | undefined;

    for (const f of r.filePaths) {
      const pv = previewPack(f, workflows);
      if (pv.error) {
        error = `${path.basename(f)}：${pv.error}`;
        continue;
      }
      for (const it of pv.items) {
        merged.items.push({
          anchorPassword: it.card.anchorPassword,
          kind: it.kind,
          summary: describeCardDto(it.card),
          localSummary: it.localSummary,
          selected: it.selected
        });
        if (it.kind === 'new') merged.newCount += 1;
        else if (it.kind === 'conflict') merged.conflictCount += 1;
        else if (it.kind === 'low-confidence') merged.lowConfidenceCount += 1;
        else merged.skippedCount += 1;
      }
      // 记住原始数据，供 apply 时使用
      importCache.set(f, pv);
    }
    return { ok: true, preview: merged, error };
  });

  /** 提交导入：按勾选项写入 */
  ipcMain.handle(
    'workflow:importApply',
    (_e, input: unknown) => {
      // 修复 P2-⑥：selectedAnchors 必须是字符串数组；overwrite 必须是布尔
      const i = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const sel = new Set(isStringArray(i.selectedAnchors) ? i.selectedAnchors : []);
      const overwrite = i.overwrite === true;
      let added = 0;
      let overwritten = 0;
      let skipped = 0;
      for (const [, pv] of importCache) {
        const filtered = {
          ...pv,
          items: pv.items.map((it) => ({ ...it, selected: sel.has(it.card.anchorPassword) }))
        };
        const r = applyImport(filtered, workflows, overwrite);
        added += r.added;
        overwritten += r.overwritten;
        skipped += r.skipped;
      }
      importCache.clear();
      if (added || overwritten) {
        saveWorkflows(workflows);
        emitWorkflows();
      }
      return { added, overwritten, skipped };
    }
  );


  ipcMain.handle(CH.taskPause, (_e, id: unknown) => (isString(id) ? tasks.pause(id) : false));
  ipcMain.handle(CH.taskResume, (_e, id: unknown) => (isString(id) ? tasks.resume(id) : false));
  ipcMain.handle(CH.taskCancel, (_e, id: unknown) => (isString(id) ? tasks.cancel(id) : false));
  ipcMain.handle(CH.taskRetry, (_e, id: unknown, password?: unknown, outDir?: unknown) =>
    isString(id) ? tasks.retry(id, isString(password) ? password : undefined, isString(outDir) ? outDir : undefined) : null
  );
  ipcMain.handle(CH.taskRemove, (_e, id: unknown) => (isString(id) ? tasks.remove(id) : false));
  /* 修复 P2-⑩：补上 clearFinished 的 IPC 入口（此前只有渲染层本地清理 + 主进程死代码）。
   * 渲染层点「清空已完成」时，主进程队列也要一起清，否则下次 list() 又会把它们推回来。 */
  ipcMain.handle(CH.taskClearFinished, () => tasks.clearFinished());

  /* ---- 首次引导 ---- */
  ipcMain.handle('app:firstRunDone', () => {
    settings.firstRunDone = true;
    persistSettings();
    return true;
  });
  ipcMain.handle('app:resetFirstRun', () => {
    settings.firstRunDone = false;
    persistSettings();
    return true;
  });

  /* ---- 应用信息（设置页展示） ---- */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    githubUrl: 'https://github.com/musz333/sz333-unpack-desktop',
    configDir: userDataDir(),
    packaged: app.isPackaged
  }));

  /* ---- 引擎自检 ---- */
  ipcMain.handle('engine:selfcheck', () => engineSelfCheck());

  /* ---- 历史 ---- */
  ipcMain.handle('history:list', () => history);
  ipcMain.handle('history:clear', () => {
    history = [];
    persistHistory();
    return true;
  });

  /* ---- 系统 ---- */
  ipcMain.handle(CH.revealPath, (_e, p: unknown) => {
    // 修复 P2-⑥：必须是字符串路径
    if (!isString(p) || !p) return;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) void shell.openPath(p);
      else shell.showItemInFolder(p);
    } catch {
      /* ignore */
    }
  });
  ipcMain.handle(CH.openPath, (_e, p: unknown) => {
    // 修复 P2-⑥：必须是字符串路径（避免非字符串被当作 path 传给 shell）
    if (!isString(p) || !p) return;
    void shell.openPath(p);
  });
  ipcMain.handle(CH.openExternal, (_e, url: unknown) => {
    // 修复 P2-⑥：只放行 http/https，且必须是字符串 —— 阻断 file:// / javascript: 等协议
    if (!isString(url) || !/^https?:\/\//i.test(url)) return;
    void shell.openExternal(url);
  });
  /* 修复 #32：windowAction / sys:win 已成死 IPC（渲染层零引用），
   * 连同 CH.minimizable 一并删除，避免留下无人调用的 handler。 */
}

/* ------------------------------------------------------------------ *
 * 应用生命周期
 * ------------------------------------------------------------------ */
/** 引擎自检：确认 7z.exe 可定位、可执行。设置页与启动日志共用。 */
async function engineSelfCheck(): Promise<{ ok: boolean; path: string; version?: string; error?: string }> {
  const bin = resolve7z();
  if (!fs.existsSync(bin)) {
    return { ok: false, path: bin, error: '找不到 7z.exe（内嵌资源缺失，且系统未安装 7-Zip）' };
  }
  try {
    const res = await run7z({ args: [], timeoutMs: 8000 }).promise;
    const version = (res.stdout + res.stderr).split(/\r?\n/).find((l) => l.trim().length > 0)?.trim();
    return { ok: true, path: bin, version };
  } catch (e) {
    return { ok: false, path: bin, error: e instanceof Error ? e.message : String(e) };
  }
}

/* 运行日志统一走 `./logger`（见 logger.ts 的级别/目标/接入范围说明）。 */

app.whenReady().then(() => {
  /* 修复 P0-②：把基于 safeStorage 的加解密注入工作流模块。
   * 必须在 loadWorkflowState()（会读 workflows.json 并解密）之前完成注入。 */
  setSecretCodec({ seal: sealSecret, open: openSecret });

  loadSettings();
  loadHistory();
  loadWorkflowState();

  /* 启动回收：清理上次异常退出遗留的 .sz333-tmp-* 与空 _L* 目录（见 recovery.ts） */
  recoverInflight();

  // 启动自检：把引擎定位结果写进日志，方便排查"打包后无法解压"这类问题
  void (async () => {
    const chk = await engineSelfCheck();
    logger.info(`启动 v${app.getVersion()} packaged=${app.isPackaged} resources=${process.resourcesPath}`);
    if (chk.ok) logger.info(`7z 引擎就绪：${chk.path}`);
    else logger.error(`7z 引擎异常：${chk.path} -> ${chk.error}`);
    if (!chk.ok) {
      win?.webContents.send(CH.evToast, {
        kind: 'bad',
        title: '7-Zip 引擎不可用',
        desc: chk.error ?? '请重新获取完整版程序'
      });
    }
  })();
  nativeTheme.themeSource = settings.theme === 'system' ? 'system' : settings.theme;

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '添加压缩包…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu:add') },
          { type: 'separator' },
          { role: 'quit', label: '退出' }
        ]
      },
      {
        label: '视图',
        submenu: [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '重置缩放' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }]
      },
      {
        label: '帮助',
        submenu: [
          { label: '打开配置目录', click: () => void shell.openPath(userDataDir()) },
          { label: '开源地址', click: () => void shell.openExternal('https://github.com/musz333/sz333-unpack-desktop') }
        ]
      }
    ])
  );

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  tasks.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  tasks.dispose();
  saveBounds();
  persistSettings();
});
