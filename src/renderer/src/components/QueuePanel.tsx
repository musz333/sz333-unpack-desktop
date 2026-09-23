import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, EmptyState, Progress } from './ui';
import { fmtDuration, fmtSize } from '../lib/format';
import type { TaskRecord } from '@shared/types';

const STATUS_TEXT: Record<TaskRecord['status'], string> = {
  queued: '排队中',
  running: '处理中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  'needs-password': '需要密码'
};

function statusTone(s: TaskRecord['status']): 'brand' | 'ok' | 'bad' | 'warn' {
  if (s === 'done') return 'ok';
  if (s === 'failed') return 'bad';
  if (s === 'needs-password' || s === 'paused') return 'warn';
  return 'brand';
}

function statusIcon(s: TaskRecord['status']) {
  if (s === 'done') return 'check-circle' as const;
  if (s === 'failed') return 'error' as const;
  if (s === 'needs-password') return 'lock' as const;
  if (s === 'paused') return 'pause' as const;
  if (s === 'running') return 'loader' as const;
  return 'clock' as const;
}

function TaskCard({ task }: { task: TaskRecord }) {
  const removeTask = useStore((s) => s.removeTask);
  const updateTask = useStore((s) => s.updateTask);
  const requestPassword = useStore((s) => s.requestPassword);
  const toast = useStore((s) => s.toast);
  const tone = statusTone(task.status);

  return (
    <li
      className="animate-fade-up rounded-card border border-line bg-ink-0 p-3"
      style={task.status === 'running' ? { borderColor: 'rgb(var(--c-accent-border))' } : undefined}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={[
            'mt-0.5 shrink-0',
            tone === 'ok' ? 'text-ok' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-brand'
          ].join(' ')}
        >
          <Icon name={statusIcon(task.status)} size={16} className={task.status === 'running' ? 'animate-spin' : ''} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium" title={task.label}>
              {task.label}
            </p>
            <span className="shrink-0 text-xs text-fg-faint">{STATUS_TEXT[task.status]}</span>
          </div>

          <p className="mt-0.5 truncate text-xs text-fg-muted">
            {task.status === 'done'
              ? `${task.fileCount ? `${task.fileCount} 个文件 · ` : ''}${fmtSize(task.outputSize)} · ${fmtDuration(task.startedAt, task.endedAt)}`
              : task.status === 'failed' || task.status === 'needs-password'
                ? (task.error?.message ?? '处理失败')
                : task.status === 'cancelled'
                  ? (task.error?.message ?? '已取消')
                  : (task.currentFile ?? '准备解压…')}
          </p>

          {task.status === 'running' || task.status === 'queued' || task.status === 'paused' ? (
            <div className="mt-2">
              <Progress value={task.progress} tone={tone === 'warn' ? 'brand' : tone} indeterminate={task.progress == null} />
            </div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(task.status === 'running' || task.status === 'queued') && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="pause"
                  onClick={async () => {
                    await window.api.pauseTask(task.id);
                    toast('info', '已暂停', '恢复后将重新开始（Windows 无法挂起外部进程）');
                  }}
                >
                  暂停
                </Button>
                <Button size="sm" variant="ghost" icon="close" onClick={() => void window.api.cancelTask(task.id)}>
                  取消
                </Button>
              </>
            )}

            {task.status === 'paused' && (
              <Button size="sm" icon="play" onClick={() => void window.api.resumeTask(task.id)}>
                恢复
              </Button>
            )}

            {task.status === 'needs-password' && (
              <Button size="sm" variant="primary" icon="lock" onClick={() => requestPassword(task.id)}>
                输入密码
              </Button>
            )}

            {task.status === 'failed' && (
              <Button size="sm" icon="retry" onClick={async () => {
                const t = await window.api.retryTask(task.id);
                if (t) updateTask(t);
              }}>
                重试
              </Button>
            )}

            {task.status === 'done' && task.outputPath ? (
              <>
                <Button size="sm" icon="folder-open" onClick={() => void window.api.openPath(task.outputPath!)}>
                  打开
                </Button>
                <Button size="sm" variant="ghost" icon="eye" onClick={() => void window.api.revealPath(task.outputPath!)}>
                  定位
                </Button>
              </>
            ) : null}

            <Button size="sm" variant="ghost" icon="trash" className="ml-auto" onClick={() => removeTask(task.id)}>
              移除
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

export function QueuePanel() {
  const tasks = useStore((s) => s.tasks);
  const clearFinished = useStore((s) => s.clearFinished);
  const finished = tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status)).length;

  return (
    <>
      <div className="panel-title">
        <Icon name="activity" size={16} />
        <span>任务队列</span>
        <span className="mono-num ml-auto text-fg-faint">{tasks.length}</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {tasks.length === 0 ? (
          <EmptyState icon="inbox" title="暂无任务" desc="添加压缩包后，任务会出现在这里" />
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </ul>
        )}

        {finished > 0 ? (
          <Button size="sm" variant="ghost" icon="trash" onClick={clearFinished} className="mt-auto">
            清除失败/已取消（{finished}）
          </Button>
        ) : null}
      </div>
    </>
  );
}
