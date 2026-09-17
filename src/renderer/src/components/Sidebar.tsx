import { useStore } from '../store';
import { QueuePanel } from './QueuePanel';
import { Button } from './ui';

/**
 * 左侧常驻栏：任务队列 + 底部状态
 * （压缩功能已按需求移除；此处只保留与"解压"主线相关的内容）
 */
export function Sidebar({ open }: { open: boolean }) {
  const settings = useStore((s) => s.settings);
  const tasks = useStore((s) => s.tasks);

  const running = tasks.filter((t) => t.status === 'running').length;
  const queued = tasks.filter((t) => t.status === 'queued').length;

  return (
    <aside
      className={[
        'flex min-h-0 w-[264px] shrink-0 flex-col border-r border-line bg-ink-0',
        open ? 'flex' : 'hidden lg:flex'
      ].join(' ')}
    >
      <QueuePanel />

      <div className="h-px w-full bg-line" />

      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-xs text-fg-faint">
          运行 {running} · 排队 {queued} · 并发 {settings.maxConcurrent}
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="settings"
          onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
        >
          设置
        </Button>
      </div>
    </aside>
  );
}
