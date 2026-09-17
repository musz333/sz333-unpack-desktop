import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH } from '@shared/types';
import type { DesktopApi, TaskRecord, AppSettings, ArchiveInfo, PackItem, Result, ArchiveFormat, ThemeMode } from '@shared/types';

const api: DesktopApi = {
  pickArchives: () => ipcRenderer.invoke(CH.pickArchives),
  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),

  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(CH.setSettings, patch),

  scanPacks: (paths: string[]) => ipcRenderer.invoke(CH.packScan, paths),
  listArchive: (p: string, password?: string): Promise<Result<ArchiveInfo>> =>
    ipcRenderer.invoke(CH.archiveList, p, password),

  startExtract: (input) => ipcRenderer.invoke(CH.taskStartExtract, input),
  workflowList: () => ipcRenderer.invoke('workflow:list'),
  workflowToggle: (id: string) => ipcRenderer.invoke('workflow:toggle', id),
  workflowRemove: (id: string) => ipcRenderer.invoke('workflow:remove', id),
  workflowApply: (id: string) => ipcRenderer.invoke('workflow:apply', id),
  workflowExport: (ids?: string[]) => ipcRenderer.invoke('workflow:export', ids),
  workflowImportPreview: () => ipcRenderer.invoke('workflow:importPreview'),
  workflowImportApply: (input: { selectedAnchors: string[]; overwrite: boolean }) =>
    ipcRenderer.invoke('workflow:importApply', input),
  pauseTask: (id: string) => ipcRenderer.invoke(CH.taskPause, id),
  resumeTask: (id: string) => ipcRenderer.invoke(CH.taskResume, id),
  cancelTask: (id: string) => ipcRenderer.invoke(CH.taskCancel, id),
  retryTask: (id: string, password?: string, outDir?: string) => ipcRenderer.invoke(CH.taskRetry, id, password, outDir),
  removeTask: (id: string) => ipcRenderer.invoke(CH.taskRemove, id),

  engineSelfCheck: () => ipcRenderer.invoke('engine:selfcheck'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  getHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  revealPath: (p: string) => ipcRenderer.invoke(CH.revealPath, p),
  openPath: (p: string) => ipcRenderer.invoke(CH.openPath, p),
  openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url),
  windowAction: (action) => ipcRenderer.invoke(CH.minimizable, action),

  onTask: (cb: (task: TaskRecord) => void) => {
    const h = (_e: unknown, t: TaskRecord) => cb(t);
    ipcRenderer.on(CH.evTask, h);
    return () => ipcRenderer.removeListener(CH.evTask, h);
  },
  onWorkflows: (cb: (cards: import('@shared/types').WorkflowCard[]) => void) => {
    const h = (_e: unknown, cards: import('@shared/types').WorkflowCard[]) => cb(cards);
    ipcRenderer.on('ev:workflows', h);
    return () => ipcRenderer.removeListener('ev:workflows', h);
  },
  onWorkflowProgress: (cb: (e: import('@shared/types').WorkflowProgressEvent) => void) => {
    const h = (_e: unknown, p: import('@shared/types').WorkflowProgressEvent) => cb(p);
    ipcRenderer.on('ev:wf-progress', h);
    return () => ipcRenderer.removeListener('ev:wf-progress', h);
  },

  onToast: (cb) => {
    const h = (_e: unknown, t: { kind: 'ok' | 'warn' | 'bad' | 'info'; title: string; desc?: string }) => cb(t);
    ipcRenderer.on(CH.evToast, h);
    return () => ipcRenderer.removeListener(CH.evToast, h);
  },
  onTheme: (cb: (mode: ThemeMode) => void) => {
    const h = (_e: unknown, m: ThemeMode) => cb(m);
    ipcRenderer.on(CH.evTheme, h);
    return () => ipcRenderer.removeListener(CH.evTheme, h);
  },

  // Electron 高版本已移除 File.path，必须通过 webUtils 取真实路径
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
};

contextBridge.exposeInMainWorld('api', api);

// 菜单事件（主进程 → 渲染）
contextBridge.exposeInMainWorld('menuBridge', {
  onAdd: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('menu:add', h);
    return () => ipcRenderer.removeListener('menu:add', h);
  }
});
