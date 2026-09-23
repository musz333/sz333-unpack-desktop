import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Chip, EmptyState } from './ui';
import { fmtSize, shortPath } from '../lib/format';
import type { PackItem } from '@shared/types';

/* ==================================================================
   拖拽区：无内容时的视觉中心
   ================================================================== */
export function Dropzone({ onPick }: { onPick: () => void }) {
  const [active, setActive] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.api.pathForFile(f))
          .filter(Boolean);
        if (paths.length) void useStore.getState().addPaths(paths);
      }}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="添加压缩包：点击选择或拖拽文件到此处"
      className={[
        'm-6 flex flex-1 cursor-pointer flex-col items-center justify-center gap-4 rounded-panel border border-dashed p-8 text-center',
        'transition-all duration-180 ease-out',
        active
          ? 'border-brand bg-brand-soft scale-[1.005]'
          : 'border-line-strong bg-ink-0 hover:border-brand hover:bg-brand-soft'
      ].join(' ')}
    >
      <span
        className={[
          'grid h-12 w-12 place-items-center rounded-panel border transition-colors duration-180 ease-out',
          active ? 'border-brand-line bg-ink-0 text-brand' : 'border-line bg-ink-1 text-fg-muted'
        ].join(' ')}
      >
        <Icon name="upload" size={24} />
      </span>

      <div>
        <p className="text-base font-semibold tracking-tight">拖拽压缩包到这里</p>
        <p className="mx-auto mt-1.5 max-w-[52ch] text-sm leading-6 text-fg-muted">
          支持 zip · 7z · rar · tar · gz · bz2 · xz，分卷（.part1 / .001 / .z01 / .r00）会自动归为一组。
        </p>
      </div>

      <Button variant="primary" icon="folder-plus" onClick={(e) => { e.stopPropagation(); onPick(); }}>
        选择文件
      </Button>
    </div>
  );
}

/* ==================================================================
   资源包列表
   ================================================================== */
function PackRow({
  pack,
  selected,
  onSelect,
  onExtract
}: {
  pack: PackItem;
  selected: boolean;
  onSelect: () => void;
  onExtract: () => void;
}) {
  return (
    <li
      onClick={onSelect}
      className={[
        'grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-card border p-3.5',
        'transition-colors duration-150 ease-out animate-fade-up',
        selected ? 'border-brand bg-brand-soft' : 'border-line bg-ink-0 hover:border-line-strong'
      ].join(' ')}
    >
      <span
        className={[
          'grid h-9 w-9 place-items-center rounded-btn border',
          selected ? 'border-brand-line bg-ink-0 text-brand' : 'border-line bg-ink-1 text-fg-muted'
        ].join(' ')}
      >
        <Icon name={pack.kind === 'multi' ? 'layers' : 'file-archive'} size={20} />
      </span>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium" title={pack.primary}>
            {pack.baseName}
          </p>
          <Chip tone={selected ? 'accent' : 'default'}>{pack.formatLabel}</Chip>
          {pack.kind === 'multi' ? <Chip>{pack.files.length} 个分卷</Chip> : null}
          {!pack.extractable ? (
            <Chip tone="warn" icon="warn">
              不可解压
            </Chip>
          ) : null}
          {pack.mergedCount && pack.mergedCount > 1 ? (
            <span
              title={
                (pack.dupReason ?? '同名且逐分卷大小一致') +
                '\n\n已剔除的重复份：\n' +
                (pack.dupPaths ?? []).join('\n')
              }
            >
              <Chip tone="accent" icon="layers">
                已合并 {pack.mergedCount} 份
              </Chip>
            </span>
          ) : null}
          {pack.conflictNote ? (
            <span title={pack.conflictNote}>
              <Chip tone="warn" icon="warn">
                同名不同大小
              </Chip>
            </span>
          ) : null}
        </div>
        <p className="mono-num mt-1 truncate text-xs text-fg-faint">
          {fmtSize(pack.size)} · {shortPath(pack.primary)}
        </p>
      </div>

      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="primary" icon="play" disabled={!pack.extractable} onClick={onExtract}>
          解压
        </Button>
      </div>
    </li>
  );
}

export function PackList({ onAdd, onPick }: { onAdd: () => void; onPick: () => void }) {
  const packs = useStore((s) => s.packs);
  const selectedId = useStore((s) => s.selectedId);
  const selectPack = useStore((s) => s.selectPack);
  const clearPacks = useStore((s) => s.clearPacks);
  const startExtract = useStore((s) => s.startExtract);
  const startExtractFromSelection = useStore((s) => s.startExtractFromSelection);
  const dedupePacks = useStore((s) => s.dedupePacks);
  const [active, setActive] = useState(false);

  const total = packs.reduce((s, p) => s + p.size, 0);
  /** 清单里被判定为"重复并被合并"的份数（合并前 - 1 之和） */
  const dupCount = packs.reduce((s, p) => s + Math.max(0, (p.mergedCount ?? 1) - 1), 0);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setActive(false);
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.api.pathForFile(f))
          .filter(Boolean);
        if (paths.length) void useStore.getState().addPaths(paths);
      }}
    >
      <div
        className={[
          'flex flex-wrap items-center gap-2 px-6 pb-3',
          active ? 'rounded-card ring-1 ring-brand' : ''
        ].join(' ')}
      >
        <Button size="sm" icon="plus" onClick={onAdd}>
          添加
        </Button>
        <Button size="sm" icon="play" onClick={() => void startExtractFromSelection()}>
          解压选中
        </Button>
        <Button
          size="sm"
          icon="layers"
          disabled={dupCount === 0}
          onClick={() => dedupePacks()}
          title="按「同名 + 逐分卷大小完全一致」剔除重复包；只从清单移除，不会删除硬盘文件"
        >
          剔除重复包{dupCount > 0 ? `（${dupCount}）` : ''}
        </Button>
        <Button size="sm" variant="ghost" icon="trash" onClick={clearPacks}>
          清空
        </Button>
        <span className="ml-auto inline-flex items-center gap-2">
          <Chip>{packs.length} 个资源包</Chip>
          <Chip tone="accent">{fmtSize(total)}</Chip>
          {dupCount > 0 ? <Chip tone="accent" icon="layers">已合并 {dupCount} 份重复</Chip> : null}
        </span>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-6 pb-6">
        {packs.map((p) => (
          <PackRow
            key={p.id}
            pack={p}
            selected={p.id === selectedId}
            onSelect={() => selectPack(p.id)}
            onExtract={() => void startExtract(p.id)}
          />
        ))}
        <li className="mt-1">
          <button
            onClick={onPick}
            className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line-strong py-3 text-xs text-fg-faint transition-colors duration-150 ease-out hover:border-brand hover:text-brand"
          >
            <Icon name="plus" size={16} />
            继续添加压缩包
          </button>
        </li>
      </ul>
    </div>
  );
}

/* ==================================================================
   主区：按状态在「拖拽区 ↔ 资源列表」之间原位切换
   ================================================================== */
export function Workspace({ onPick }: { onPick: () => void }) {
  const packs = useStore((s) => s.packs);
  const addPaths = useStore((s) => s.addPaths);
  const [active, setActive] = useState(false);

  // 全局拖拽高亮（拖到窗口任意位置都提示）
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setActive(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setActive(false);
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => window.api.pathForFile(f))
        .filter(Boolean);
      if (paths.length) void addPaths(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [addPaths]);

  return (
    <section className="relative flex min-h-0 flex-1 flex-col bg-[rgb(var(--app-bg))]">
      {packs.length === 0 ? <Dropzone onPick={onPick} /> : <PackList onAdd={onPick} onPick={onPick} />}

      {active ? (
        <div className="pointer-events-none absolute inset-3 grid place-items-center rounded-panel border-2 border-dashed border-brand bg-brand-soft/60">
          <span className="inline-flex items-center gap-2 rounded-btn border border-brand-line bg-ink-0 px-3 py-2 text-sm font-medium text-brand">
            <Icon name="download" size={16} />
            松开即可添加
          </span>
        </div>
      ) : null}
    </section>
  );
}

/* ==================================================================
   空状态（复用）
   ================================================================== */
export function PanelEmpty({ icon, title, desc }: { icon: Parameters<typeof EmptyState>[0]['icon']; title: string; desc?: string }) {
  return (
    <div className="p-6">
      <EmptyState icon={icon} title={title} desc={desc} />
    </div>
  );
}
