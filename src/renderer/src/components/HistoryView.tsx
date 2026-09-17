import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Chip, EmptyState } from './ui';
import { fmtSize, fmtTime, shortPath } from '../lib/format';

import type { HistoryEntry } from '@shared/types';

export function HistoryView() {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const toast = useStore((s) => s.toast);

  const load = async () => {
    const data = await window.api.getHistory();
    setItems(data);
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = query.trim()
    ? items.filter((i) => `${i.label} ${i.source} ${i.output}`.toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  const clear = async () => {
    await window.api.clearHistory();
    setItems([]);
    toast('info', '历史记录已清空', undefined);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-auto bg-[rgb(var(--app-bg))]">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">历史记录</h2>
          <Chip>{items.length} 条</Chip>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint">
                <Icon name="search" size={16} />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称或路径…"
                aria-label="搜索历史记录"
                className="h-8 w-[220px] rounded-btn border border-line bg-ink-0 pl-8 pr-2 text-xs transition-colors duration-150 ease-out placeholder:text-fg-faint hover:border-line-strong focus:border-brand"
              />
            </div>
            <Button size="sm" variant="ghost" icon="trash" disabled={!items.length} onClick={() => void clear()}>
              一键清空
            </Button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon="history"
            title={items.length ? '没有匹配的记录' : '还没有历史记录'}
            desc={items.length ? '换个关键词试试' : '完成一次解压后，记录会出现在这里'}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((h) => (
              <li key={h.id} className="grid animate-fade-up grid-cols-[auto_1fr_auto] items-center gap-3 rounded-card border border-line bg-ink-0 p-3">
                <span
                  className={[
                    'grid h-8 w-8 place-items-center rounded-btn border',
                    h.status === 'done' ? 'border-ok/30 bg-ok-soft text-ok' : 'border-bad/30 bg-bad-soft text-bad'
                  ].join(' ')}
                >
                  <Icon name="package" size={16} />
                </span>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium" title={h.label}>
                      {h.label}
                    </p>
                    <Chip tone="accent">解压</Chip>
                    {h.status !== 'done' ? <Chip tone="bad">失败</Chip> : null}
                  </div>
                  <p className="mono-num mt-1 truncate text-xs text-fg-faint" title={h.output || h.source}>
                    {h.op === 'extract' ? `${h.fileCount ?? 0} 个文件 · ` : ''}
                    {fmtSize(h.size)} · {shortPath(h.output || h.source, 2)} · {fmtTime(h.at)}
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  {h.output ? (
                    <>
                      <Button size="sm" icon="folder-open" onClick={() => void window.api.openPath(h.output)}>
                        打开
                      </Button>
                      <Button size="sm" variant="ghost" icon="eye" onClick={() => void window.api.revealPath(h.output)}>
                        定位
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
