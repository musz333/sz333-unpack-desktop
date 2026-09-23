/**
 * 共享类型与 IPC 契约（主进程 / preload / 渲染进程三端共用）
 */

/* ------------------------------ 格式与分组 ------------------------------ */

export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar' | 'gz' | 'bz2' | 'xz' | 'unknown';

export interface FormatMeta {
  label: string;
  extractable: boolean;
  compressible: boolean;
  note?: string;
}

export const FORMATS: Record<ArchiveFormat, FormatMeta> = {
  zip: { label: 'ZIP', extractable: true, compressible: true },
  '7z': { label: '7Z', extractable: true, compressible: true },
  rar: { label: 'RAR', extractable: true, compressible: false, note: '可解压，不能创建（7-Zip 不提供 RAR 压缩）' },
  tar: { label: 'TAR', extractable: true, compressible: true },
  gz: { label: 'GZIP', extractable: true, compressible: false },
  bz2: { label: 'BZIP2', extractable: true, compressible: false },
  xz: { label: 'XZ', extractable: true, compressible: false },
  unknown: { label: '未知', extractable: false, compressible: false, note: '不是可识别的压缩格式' }
};

/** 一组待处理资源包（分卷会被自动归为一组） */
export interface PackItem {
  id: string;
  kind: 'single' | 'multi';
  baseName: string;
  files: string[];
  primary: string;
  size: number;
  format: ArchiveFormat;
  formatLabel: string;
  extractable: boolean;
  note: string;
  /** 批内去重：这份代表了几份（>1 表示合并了重复包） */
  mergedCount?: number;
  /** 去重依据 */
  dupReason?: string;
  /** 被剔除的重复份路径 */
  dupPaths?: string[];
  /** 同名但大小不同的提示 */
  conflictNote?: string;
  /** 逐分卷字节数（与 files 顺序一致），用于前端比对重复 */
  volumeSizes?: number[];
}

/* ------------------------------ 压缩包内容（只读） ------------------------------ */

export interface ArchiveEntry {
  path: string;
  size: number;
  packedSize: number;
  isDir: boolean;
  encrypted: boolean;
  crc?: string;
  modified?: string;
}

export interface ArchiveInfo {
  format: ArchiveFormat;
  formatLabel: string;
  physicalSize: number;
  totalSize: number;
  packedSize: number;
  fileCount: number;
  dirCount: number;
  encrypted: boolean;
  entries: ArchiveEntry[];
  /** 条目过多时只回传前 N 条 */
  truncated: boolean;
  passwordRequired?: boolean;
}

/* ------------------------------ 任务队列 ------------------------------ */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'needs-password';

export type TaskOp = 'extract';

export interface TaskError {
  code: 'password' | 'not-archive' | 'disk' | 'permission' | 'cancelled' | 'unknown';
  message: string;
  raw?: string;
}

export interface TaskRecord {
  id: string;
  op: TaskOp;
  label: string;
  sourcePaths: string[];
  outDir: string;
  status: TaskStatus;
  /** 0~100；列表阶段未知则为 null */
  progress: number | null;
  /** 当前正在处理的条目 */
  currentFile?: string;
  /** 处理计数 */
  processed?: number;
  total?: number;
  startedAt?: number;
  endedAt?: number;
  /** 结果 */
  outputPath?: string;
  outputSize?: number;
  fileCount?: number;
  error?: TaskError;
  /** 需要用户输入密码时回传，便于界面直接弹输入 */
  archivePath?: string;
}

/* ------------------------------ 设置 ------------------------------ */

export type ThemeMode = 'system' | 'light' | 'dark';
export type OverwritePolicy = 'overwrite' | 'skip' | 'rename';

/** 源文件处理策略：保留 / 彻底删除 */
export type SourcePolicy = 'keep' | 'delete';

/** 中文路径策略：auto = 仅在需要时自动转英文 / force = 始终转英文 / off = 保持原样 */
export type NonAsciiPolicy = 'auto' | 'force' | 'off';

/** 重复包策略：silent 无感直接剔除 / ask 每次询问 / off 不处理 */
export type DupPolicy = 'silent' | 'ask' | 'off';

/** 任务完成后是否自动收起（仅对成功任务生效） */
export type AutoCollapsePolicy = 'on' | 'off';

export interface AppSettings {
  theme: ThemeMode;
  language: 'zh-CN' | 'en-US';
  defaultOutDir: string;
  /** 解压到「源文件所在目录 / 以包名新建子目录」 */
  extractToSubfolder: boolean;
  overwrite: OverwritePolicy;
  keepDirStructure: boolean;
  /** 源文件处理：保留 / 彻底删除（默认；回收站方案已按用户要求取消——大体积资源会占满回收站） */
  sourcePolicy: SourcePolicy;
  /** 中文路径策略：auto（默认，输出目录含中文时自动换英文目录并改包内中文名）/ force / off */
  nonAsciiPolicy: NonAsciiPolicy;
  /** 重复包处理：默认无感直接剔除 */
  dupPolicy: DupPolicy;
  /** 成功任务完成后自动从队列收起（失败/取消/待密码的任务常驻） */
  autoCollapseDone: AutoCollapsePolicy;
  maxConcurrent: 1 | 2 | 4;
  notifyOnFinish: boolean;
  autoOpenOutDir: boolean;
  rememberPasswords: boolean;
  /** 工作流页视图：卡片 / 列表 */
  wfView: 'card' | 'list';
  /** 已知密码列表（按尝试顺序） */
  passwords: string[];
  /** 是否已完成首次使用引导 */
  firstRunDone: boolean;
  windowBounds?: { width: number; height: number; x?: number; y?: number };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'zh-CN',
  defaultOutDir: '',
  extractToSubfolder: true,
  overwrite: 'rename',
  keepDirStructure: true,
  sourcePolicy: 'delete',
  nonAsciiPolicy: 'auto',
  dupPolicy: 'silent',
  autoCollapseDone: 'on',
  maxConcurrent: 1,
  notifyOnFinish: true,
  autoOpenOutDir: false,
  rememberPasswords: false,
  wfView: 'card',
  firstRunDone: false,
  passwords: []
};

/* ------------------------------ IPC 结果包装 ------------------------------ */

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

/* ------------------------------ IPC 频道 ------------------------------ */

export const CH = {
  // 对话框
  pickArchives: 'dialog:pick-archives',
  pickFolder: 'dialog:pick-folder',

  // 设置
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  // 资源包
  packScan: 'pack:scan',
  // 压缩包
  archiveList: 'archive:list',
  // 任务
  taskStartExtract: 'task:start-extract',

  taskPause: 'task:pause',
  taskResume: 'task:resume',
  taskCancel: 'task:cancel',
  taskRetry: 'task:retry',
  taskRemove: 'task:remove',
  // 系统
  revealPath: 'sys:reveal',
  openPath: 'sys:open',
  openExternal: 'sys:open-external',
  minimizable: 'sys:win',
  // 主 → 渲染 事件
  evTask: 'ev:task',
  evToast: 'ev:toast',
  evTheme: 'ev:theme'
} as const;

/** 工作流卡片（渲染层视图模型） */
export interface WorkflowCard {
  id: string;
  name: string;
  anchorPassword: string;
  nameHint: string;
  chain: string;
  layerCount: number;
  volCount: number;
  primVolSize: number;
  hitCount: number;
  missCount: number;
  lastUsedAt: number;
  createdAt: number;
  enabled: boolean;
  autoDisabled: boolean;
  missPasswordError: boolean;
  usable: boolean;
  note: string;
}

/** 导入预览（渲染层视图模型） */
export interface ImportPreviewData {
  sourceFile: string;
  items: {
    anchorPassword: string;
    kind: 'new' | 'conflict' | 'low-confidence' | 'skipped';
    summary: string;
    localSummary: string;
    selected: boolean;
  }[];
  newCount: number;
  conflictCount: number;
  lowConfidenceCount: number;
  skippedCount: number;
}

/** 工作流命中/匹配进度事件 */
export interface WorkflowProgressEvent {
  taskId: string;
  kind: 'matched' | 'probe' | 'saved' | 'miss' | 'disabled';
  text: string;
  workflowId?: string;
  anchorPassword?: string;
}

/** 历史记录条目 */
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

/** preload 暴露给渲染进程的 API 形状 */
export interface DesktopApi {
  pickArchives(): Promise<string[]>;
  pickFolder(): Promise<string | null>;


  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  scanPacks(paths: string[]): Promise<PackItem[]>;
  listArchive(path: string, password?: string): Promise<Result<ArchiveInfo>>;

  startExtract(input: { paths: string[]; outDir?: string; password?: string; label?: string }): Promise<TaskRecord>;

  /* ---- 工作流 ---- */
  workflowList(): Promise<WorkflowCard[]>;
  workflowToggle(id: string): Promise<boolean>;
  workflowRemove(id: string): Promise<boolean>;
  workflowApply(id: string): Promise<boolean>;
  workflowExport(ids?: string[]): Promise<{ ok: boolean; path?: string; count?: number; error?: string }>;
  workflowImportPreview(): Promise<{ ok: boolean; preview?: ImportPreviewData; error?: string }>;
  workflowImportApply(input: {
    selectedAnchors: string[];
    overwrite: boolean;
  }): Promise<{ added: number; overwritten: number; skipped: number }>;
  pauseTask(id: string): Promise<boolean>;
  resumeTask(id: string): Promise<boolean>;
  cancelTask(id: string): Promise<boolean>;
  retryTask(id: string, password?: string, outDir?: string): Promise<TaskRecord | null>;
  removeTask(id: string): Promise<boolean>;

  revealPath(p: string): Promise<void>;
  openPath(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void>;

  /** 标记首次引导已完成 */
  markFirstRunDone(): Promise<boolean>;
  /** 重置首次引导标记（用于"重新查看首次引导"） */
  resetFirstRun(): Promise<boolean>;

  /** 应用信息（设置页"关于"） */
  appInfo(): Promise<{ version: string; electron: string; githubUrl: string; configDir: string; packaged: boolean }>;

  /** 7-Zip 引擎自检（设置页可手动触发） */
  engineSelfCheck(): Promise<{ ok: boolean; path: string; version?: string; error?: string }>;

  /** 历史记录 */
  getHistory(): Promise<HistoryEntry[]>;
  clearHistory(): Promise<boolean>;

  onTask(cb: (task: TaskRecord) => void): () => void;
  onWorkflows(cb: (cards: WorkflowCard[]) => void): () => void;
  onWorkflowProgress(cb: (e: WorkflowProgressEvent) => void): () => void;
  /** 中文路径转英文的改名对照 */
  onRenamed(cb: (info: {
    taskId: string;
    outDir: string;
    dirChanged: boolean;
    renames: { from: string; to: string }[];
    conflicts: number;
  }) => void): () => void;
  onToast(cb: (t: { kind: 'ok' | 'warn' | 'bad' | 'info'; title: string; desc?: string }) => void): () => void;
  onTheme(cb: (mode: ThemeMode) => void): () => void;

  /** 拖拽文件取真实路径（Electron 中 File.path 已被移除，必须走此桥） */
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    api: DesktopApi;
  }
}
