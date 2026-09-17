import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Chip, EmptyState } from './ui';
import { fmtSize, ratio } from '../lib/format';

export function ArchiveDetail() {
  const packs = useStore((s) => s.packs);
  const selectedId = useStore((s) => s.selectedId);
  const cache = useStore((s) => (selectedId ? s.archives[selectedId] : undefined));
  const loadArchive = useStore((s) => s.loadArchive);
  const startExtract = useStore((s) => s.startExtract);
  const [query, setQuery] = useState('');
  const [onlyFiles, setOnlyFiles] = useState(true);

  const pack = packs.find((p) => p.id === selectedId) ?? null;

  const entries = useMemo(() => {
    const list = cache?.info?.entries ?? [];
    const filtered = onlyFiles ? list.filter((e) => !e.isDir) : list;
    if (!query.trim()) return filtered;
    const q = query.trim().toLowerCase();
    return filtered.filter((e) => e.path.toLowerCase().includes(q));
  }, [cache?.info?.entries, query, onlyFiles]);

  if (!pack) {
    return (
      <>
        <div className="panel-title">
          <Icon name="info" size={16} />
          <span>压缩包详情</span>
        </div>
        <div className="p-3">
          <EmptyState icon="select" title="未选中资源包" desc="在左侧选择任意资源包，这里会显示元数据与文件预览" />
        </div>
      </>
    );
  }

  const info = cache?.info;

  return (
    <>
      <div className="panel-title">
        <Icon name="info" size={16} />
        <span>压缩包详情</span>
        {cache?.status === 'loading' ? <Icon name="loader" size={16} className="ml-auto animate-spin text-fg-faint" /> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        {/* 元数据 */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-btn border border-line bg-ink-1 text-fg-muted">
              <Icon name={pack.kind === 'multi' ? 'layers' : 'file-archive'} size={16} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={pack.baseName}>
                {pack.baseName}
              </p>
              <p className="mono-num truncate text-xs text-fg-faint">{pack.formatLabel} · {fmtSize(pack.size)}</p>
            </div>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-fg-faint">文件数</dt>
            <dd className="mono-num text-right text-fg">{info ? info.fileCount : '—'}</dd>

            <dt className="text-fg-faint">解压后大小</dt>
            <dd className="mono-num text-right text-fg">{info ? fmtSize(info.totalSize) : '—'}</dd>

            <dt className="text-fg-faint">压缩率</dt>
            <dd className="mono-num text-right text-fg">
              {info && info.totalSize ? ratio(info.totalSize - info.packedSize, info.totalSize) : '—'}
            </dd>

            <dt className="text-fg-faint">加密</dt>
            <dd className="text-right">
              {info ? (
                info.encrypted ? (
                  <Chip tone="warn" icon="lock">
                    已加密
                  </Chip>
                ) : (
                  <Chip tone="ok" icon="unlock">
                    未加密
                  </Chip>
                )
              ) : (
                '—'
              )}
            </dd>

            <dt className="text-fg-faint">分卷</dt>
            <dd className="mono-num text-right text-fg">{pack.files.length}</dd>
          </dl>

          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" icon="play" block disabled={!pack.extractable} onClick={() => void startExtract(pack.id)}>
              解压此包
            </Button>
            <Button size="sm" icon="folder-open" onClick={() => void window.api.revealPath(pack.primary)}>
              定位
            </Button>
          </div>

          {!pack.extractable ? (
            <p className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-warn">
              <Icon name="warn" size={16} className="mt-0.5 shrink-0" />
              {pack.note || '该格式暂不支持解压'}
            </p>
          ) : null}
        </div>

        <div className="divider" />

        {/* 文件预览 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-fg-faint">文件预览</span>
            <button
              onClick={() => setOnlyFiles((v) => !v)}
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-full border border-line bg-ink-1 px-2 text-xs text-fg-muted transition-colors duration-150 ease-out hover:border-line-strong"
            >
              <Icon name={onlyFiles ? 'file' : 'list'} size={16} />
              {onlyFiles ? '仅文件' : '含目录'}
            </button>
          </div>

          <div className="relative mb-2">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint">
              <Icon name="search" size={16} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选文件名…"
              aria-label="筛选文件名"
              className="h-8 w-full rounded-btn border border-line bg-ink-0 pl-8 pr-2 text-xs transition-colors duration-150 ease-out placeholder:text-fg-faint hover:border-line-strong focus:border-brand"
            />
          </div>

          {cache?.status === 'loading' ? (
            <div className="flex items-center gap-2 rounded-card border border-line bg-ink-0 px-3 py-4 text-xs text-fg-muted">
              <Icon name="loader" size={16} className="animate-spin" />
              正在读取压缩包目录…
            </div>
          ) : cache?.status === 'error' ? (
            <EmptyState icon="error" title="读取失败" desc={cache.error} action={
              <Button size="sm" icon="retry" onClick={() => void loadArchive(pack.id)}>重试</Button>
            } />
          ) : cache?.status === 'needs-password' ? (
            <EmptyState icon="lock" title="压缩包已加密" desc="解压时输入密码即可；密码正确后这里会显示文件列表" />
          ) : entries.length === 0 ? (
            <EmptyState icon="file" title="没有匹配的文件" desc={query ? '换个关键词试试' : '该压缩包没有文件条目'} />
          ) : (
            <ul className="flex flex-col gap-px overflow-hidden rounded-card border border-line">
              {entries.slice(0, 200).map((e, i) => (
                <li
                  key={`${e.path}-${i}`}
                  className={[
                    'flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-xs',
                    i % 2 ? 'bg-ink-1' : 'bg-ink-0'
                  ].join(' ')}
                >
                  <Icon name={e.isDir ? 'folder-archive' : 'file'} size={16} className="shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate" title={e.path}>
                    {e.path}
                  </span>
                  {e.encrypted ? <Icon name="lock" size={16} className="shrink-0 text-warn" /> : null}
                  <span className="mono-num shrink-0 text-fg-faint">{e.isDir ? '—' : fmtSize(e.size)}</span>
                </li>
              ))}
            </ul>
          )}

          {cache?.info?.truncated ? (
            <p className="mt-2 text-xs text-fg-faint">条目过多，仅显示前 {cache.info.entries.length} 条</p>
          ) : null}
        </div>
      </div>
    </>
  );
}
