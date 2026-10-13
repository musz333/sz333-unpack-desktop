import {
  Package,
  FolderArchive,
  FileArchive,
  Upload,
  Download,
  FolderPlus,
  FolderOpen,
  Play,
  PlayCircle,
  Pause,
  Trash2,
  Plus,
  X,
  Check,
  CheckCircle2,
  AlertTriangle,
  CircleAlert,
  Info,
  Settings,
  SlidersHorizontal,
  Sun,
  Moon,
  Clock,
  History,
  Activity,
  List,
  Inbox,
  MousePointerClick,
  HardDrive,
  Layers,
  Gauge,
  RefreshCw,
  Loader,
  File,
  Eye,
  EyeOff,
  RotateCcw,
  Lock,
  Unlock,
  ExternalLink,
  ChevronRight,
  Search,
  Github
} from 'lucide-react';

/**
 * 唯一图标来源：全部取自 Lucide，统一 stroke-width = 1.5
 * 语义别名集中在此，禁止在组件里直接换用其它图标库。
 * 只保留实际被引用的图标（未引用的别名已清理，避免死代码堆积）。
 */
const MAP = {
  package: Package,
  'folder-archive': FolderArchive,
  'file-archive': FileArchive,
  upload: Upload,
  download: Download,
  'folder-plus': FolderPlus,
  'folder-open': FolderOpen,
  play: Play,
  'play-circle': PlayCircle,
  pause: Pause,
  trash: Trash2,
  plus: Plus,
  close: X,
  check: Check,
  'check-circle': CheckCircle2,
  warn: AlertTriangle,
  error: CircleAlert,
  info: Info,
  settings: Settings,
  sliders: SlidersHorizontal,
  sun: Sun,
  moon: Moon,
  clock: Clock,
  history: History,
  activity: Activity,
  list: List,
  inbox: Inbox,
  select: MousePointerClick,
  disk: HardDrive,
  layers: Layers,
  gauge: Gauge,
  refresh: RefreshCw,
  loader: Loader,
  file: File,
  eye: Eye,
  'eye-off': EyeOff,
  retry: RotateCcw,
  lock: Lock,
  unlock: Unlock,
  external: ExternalLink,
  'chevron-right': ChevronRight,
  search: Search,
  github: Github
} as const;

export type IconName = keyof typeof MAP;

export interface IconProps {
  name: IconName;
  size?: 16 | 20 | 24;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.5 }: IconProps) {
  const Cmp = MAP[name] ?? Info;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" focusable="false" />;
}
