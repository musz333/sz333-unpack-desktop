import { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeTheme, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { CH, DEFAULT_SETTINGS } from '@shared/types';
import type { AppSettings, TaskRecord, Result, ArchiveInfo, ImportPreviewData } from '@shared/types';
import { scanPaths, listArchive, run7z, userDataDir, uniqueDir, resolve7z } from './engine';
import { TaskManager } from './tasks';
import {
  loadWorkflows,
  saveWorkflows,
  matchWorkflow,
  buildFromResult,
  onHit,
  onMiss,
  manualEnable,
  mergeDuplicateAnchors,
  isUsable,
  chainText,
  type Workflow,
  type WorkflowStep
} from './workflows';
import { exportPack, previewPack, applyImport, describeWorkflow, type WorkflowCardDto as CardDto } from './workflowPack';

/* ------------------------------------------------------------------ *
 * 窗口与单实例
 * ------------------------------------------------------------------ */
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const isDev = !app.isPackaged;

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

let settings: AppSettings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    if (fs.existsSync(settingsFile())) {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>;
      // 与默认值合并：保证旧配置文件里缺失的新字段也能拿到默认值
      settings = { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  if (!settings.defaultOutDir) {
    settings.defaultOutDir = app.getPath('downloads');
  }
}

function persistSettings() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch {
    /* ignore */
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
  } catch {
    history = [];
  }
}
function persistHistory() {
  try {
    fs.writeFileSync(historyFile(), JSON.stringify(history.slice(0, 200), null, 2), 'utf8');
  } catch {
    /* ignore */
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
    logLine(`已合并同锚点重复工作流 ${merged} 条`);
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
const tasks = new TaskManager({
  getSettings: () => settings,
  workflows: workflowApi,
  onWorkflowProgress: (payload) => win?.webContents.send('ev:wf-progress', payload),
  onWorkflowsChanged: () => emitWorkflows(),
  onRenamed: (info) => {
    win?.webContents.send('ev:renamed', info);
    logLine(`中文路径转英文：目录变更=${info.dirChanged} 改名=${info.renames.length} 同名加序号=${info.conflicts}`);
  },
  emit: (task) => {
    win?.webContents.send(CH.evTask, task);
    if (task.status === 'done' || task.status === 'failed') {
      history.unshift({
        id: task.id,
        op: 'extract',
        label: task.label,
        source: task.sourcePaths[0] ?? '',
        output: task.outputPath ?? '',
        size: task.outputSize ?? 0,
        fileCount: task.fileCount,
        status: task.status === 'done' ? 'done' : 'failed',
        at: Date.now()
      });
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
      sandbox: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win?.show());

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
  ipcMain.handle(CH.setSettings, (_e, patch: Partial<AppSettings>) => {
    settings = { ...settings, ...patch };
    if (patch.theme) {
      nativeTheme.themeSource = patch.theme === 'system' ? 'system' : patch.theme;
    }
    persistSettings();
    return settings;
  });

  /* ---- 资源包扫描 ---- */
  ipcMain.handle(CH.packScan, (_e, paths: string[]) => {
    const packs = scanPaths(paths);
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
      note: p.note
    }));
  });

  /* ---- 列出压缩包内容 ---- */
  ipcMain.handle(CH.archiveList, async (_e, archivePath: string, password?: string): Promise<Result<ArchiveInfo>> => {
    try {
      if (!fs.existsSync(archivePath)) return { ok: false, error: '文件不存在' };
      const info = await listArchive(archivePath, password);
      info.physicalSize = fs.statSync(archivePath).size;
      return { ok: true, data: info };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /* ---- 任务 ---- */
  ipcMain.handle(
    CH.taskStartExtract,
    (_e, input: { paths: string[]; outDir?: string; password?: string; label?: string }): TaskRecord => {
      const first = input.paths[0];
      const label = input.label ?? path.basename(first);
      const outDir = input.outDir ?? '';
      return tasks.add({
        op: 'extract',
        label,
        sourcePaths: input.paths,
        outDir,
        password: input.password
      });
    }
  );

  /* ---- 工作流 ---- */
  ipcMain.handle('workflow:list', () => workflows.map(toCard));

  ipcMain.handle('workflow:remove', (_e, id: string) => {
    workflows = workflows.filter((w) => w.id !== id);
    saveWorkflows(workflows);
    emitWorkflows();
    return true;
  });

  ipcMain.handle('workflow:toggle', (_e, id: string) => {
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
  ipcMain.handle('workflow:apply', (_e, id: string) => {
    const w = workflows.find((x) => x.id === id);
    if (!w) return false;
    if (w.anchorPassword) {
      settings.passwords = [w.anchorPassword, ...settings.passwords.filter((p) => p !== w.anchorPassword)].slice(0, 30);
      persistSettings();
    }
    return true;
  });

  /** 批量导出：不传 ids 则导出全部 */
  ipcMain.handle('workflow:export', async (_e, ids?: string[]) => {
    const picked = ids?.length ? workflows.filter((w) => ids.includes(w.id)) : workflows;
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
      logLine(`导出工作流 ${n} 张 -> ${r.filePath}`);
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
    (_e, input: { selectedAnchors: string[]; overwrite: boolean }) => {
      const sel = new Set(input.selectedAnchors);
      let added = 0;
      let overwritten = 0;
      let skipped = 0;
      for (const [, pv] of importCache) {
        const filtered = {
          ...pv,
          items: pv.items.map((it) => ({ ...it, selected: sel.has(it.card.anchorPassword) }))
        };
        const r = applyImport(filtered, workflows, input.overwrite);
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


  ipcMain.handle(CH.taskPause, (_e, id: string) => tasks.pause(id));
  ipcMain.handle(CH.taskResume, (_e, id: string) => tasks.resume(id));
  ipcMain.handle(CH.taskCancel, (_e, id: string) => tasks.cancel(id));
  ipcMain.handle(CH.taskRetry, (_e, id: string, password?: string, outDir?: string) => tasks.retry(id, password, outDir));
  ipcMain.handle(CH.taskRemove, (_e, id: string) => tasks.remove(id));

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
    githubUrl: 'https://github.com/muszz333/sz333-unpack-desktop',
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
  ipcMain.handle(CH.revealPath, (_e, p: string) => {
    if (!p) return;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) void shell.openPath(p);
      else shell.showItemInFolder(p);
    } catch {
      /* ignore */
    }
  });
  ipcMain.handle(CH.openPath, (_e, p: string) => {
    void shell.openPath(p);
  });
  ipcMain.handle(CH.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  ipcMain.handle(CH.minimizable, (_e, action: 'minimize' | 'maximize' | 'close') => {
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else win.close();
  });
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

/** 追加运行日志（便于用户反馈问题时定位） */
function logLine(msg: string) {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(path.join(userDataDir(), 'app.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
}

app.whenReady().then(() => {
  loadSettings();
  loadHistory();
  loadWorkflowState();

  // 启动自检：把引擎定位结果写进日志，方便排查"打包后无法解压"这类问题
  void (async () => {
    const chk = await engineSelfCheck();
    logLine(`启动 v${app.getVersion()} packaged=${app.isPackaged} resources=${process.resourcesPath}`);
    logLine(chk.ok ? `7z 引擎就绪：${chk.path}` : `7z 引擎异常：${chk.path} -> ${chk.error}`);
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
          { label: '开源地址', click: () => void shell.openExternal('https://github.com/muszz333/sz333-unpack-desktop') }
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
