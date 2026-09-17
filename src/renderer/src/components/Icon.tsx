import {
  Package,
  Archive,
  FolderArchive,
  FileArchive,
  Upload,
  Download,
  FolderPlus,
  FolderOpen,
  Play,
  Pause,
  Square,
  Trash2,
  Plus,
  Minus,
  X,
  Check,
  CheckCircle2,
  TriangleAlert,
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
  ShieldCheck,
  HardDrive,
  Layers,
  Gauge,
  RefreshCw,
  Loader,
  File,
  Eye,
  RotateCcw,
  Lock,
  Unlock,
  ExternalLink,
  Timer,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Search,
  Copy,
  Github
} from 'lucide-react';

/**
 * 唯一图标来源：全部取自 Lucide，统一 stroke-width = 1.5
 * 语义别名集中在此，禁止在组件里直接换用其它图标库
 */
const MAP = {
  package: Package,
  archive: Archive,
  'folder-archive': FolderArchive,
  'file-archive': FileArchive,
  upload: Upload,
  download: Download,
  'folder-plus': FolderPlus,
  'folder-open': FolderOpen,
  play: Play,
  pause: Pause,
  stop: Square,
  trash: Trash2,
  plus: Plus,
  minus: Minus,
  close: X,
  check: Check,
  'check-circle': CheckCircle2,
  alert: TriangleAlert,
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
  shield: ShieldCheck,
  disk: HardDrive,
  layers: Layers,
  gauge: Gauge,
  refresh: RefreshCw,
  loader: Loader,
  file: File,
  eye: Eye,
  retry: RotateCcw,
  lock: Lock,
  unlock: Unlock,
  external: ExternalLink,
  timer: Timer,
  'arrow-up-right': ArrowUpRight,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  search: Search,
  copy: Copy,
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
