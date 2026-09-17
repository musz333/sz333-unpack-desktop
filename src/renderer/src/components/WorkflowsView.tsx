import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Chip, EmptyState, Switch } from './ui';
import { fmtSize, fmtTime, ratio } from '../lib/format';
import type { WorkflowCard } from '@shared/types';

/* ==================================================================
   单张卡片：状态色条 + 锚点密码 + 来源签名 + 链路 + 战绩
   ================================================================== */
function Card({ card, view }: { card: WorkflowCard; view: 'card' | 'list' }) {
  const toggle = useStore((s) => s.workflowToggle);
  const remove = useStore((s) => s.workflowRemove);
  const apply = useStore((s) => s.workflowApply);
  const exportOne = useStore((s) => s.workflowExport);
  const toast = useStore((s) => s.toast);
  const packs = useStore((s) => s.packs);
  const startExtract = useStore((s) => s.startExtract);

  const accent = card.autoDisabled ? 'bad' : !card.enabled ? 'muted' : 'ok';
  const statusText = card.autoDisabled
    ? `自动停用${card.missPasswordError ? '（锚点密码失效）' : '（连续失败）'}`
    : !card.enabled
      ? '手动停用'
      : '启用';

  const sig = useMemo(() => {
    // 从链路里取一个可读的来源线索（扩展名序列）
    return card.chain.length > 46 ? card.chain.slice(0, 46) + '…' : card.chain;
  }, [card.chain]);

  /** 用这张卡解压：把锚点密码置顶，并解压当前选中的资源包 */
  const useCard = async () => {
    await apply(card.id);
    const target = packs[0];
    if (!target) {
      toast('warn', '还没有可解压的资源包', '先在「解压」页添加压缩包，再回到这里点用这张卡解压');
      return;
    }
    await startExtract(target.id);
    toast('info', '已按卡片开始解压', `锚点密码已置顶：${card.anchorPassword || '（无）'}`);
  };

  if (view === 'list') {
    return (
      <li className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-card border border-line bg-ink-0 p-3 transition-colors duration-150 ease-out hover:border-line-strong">
        <span
          className={[
            'grid h-8 w-8 place-items-center rounded-btn border',
            accent === 'ok' ? 'border-brand-line bg-brand-soft text-brand' : accent === 'bad' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-line bg-ink-1 text-fg-faint'
          ].join(' ')}
        >
          <Icon name="layers" size={16} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{card.anchorPassword || '（无锚点）'}</p>
            <Chip tone={accent === 'ok' ? 'accent' : accent === 'bad' ? 'bad' : 'default'}>{statusText}</Chip>
            <Chip>{card.layerCount} 层</Chip>
            {card.volCount > 1 ? <Chip>{card.volCount} 个分卷</Chip> : null}
          </div>
          <p className="mt-1 truncate text-xs text-fg-faint" title={card.chain}>
            {card.chain} · 命中 {card.hitCount} 次 · 连续失败 {card.missCount} · 最近 {fmtTime(card.lastUsedAt)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="primary" icon="play" onClick={() => void useCard()}>
            用它解压
          </Button>
          <Button size="sm" variant="ghost" icon={card.enabled ? 'pause' : 'play'} onClick={() => void toggle(card.id)}>
            {card.enabled ? '停用' : '启用'}
          </Button>
          <Button size="sm" variant="ghost" icon="download" onClick={() => void exportOne([card.id])}>
            导出
          </Button>
          <Button size="sm" variant="ghost" icon="trash" className="hover:text-bad" onClick={() => void remove(card.id)}>
            删除
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li
      className="flex animate-fade-up flex-col gap-3 rounded-card border bg-ink-0 p-3.5 transition-colors duration-150 ease-out"
      style={{
        borderColor:
          accent === 'ok' ? 'rgb(var(--c-accent-border))' : accent === 'bad' ? 'rgb(var(--c-bad) / 0.35)' : 'rgb(var(--c-border))'
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className={[
            'mt-0.5 h-2 w-2 shrink-0 rounded-full',
            accent === 'ok' ? 'bg-brand' : accent === 'bad' ? 'bg-bad' : 'bg-fg-faint'
          ].join(' ')}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-fg-faint">{statusText}</p>
          <p className="mono-num truncate text-base font-semibold tracking-tight" title={card.anchorPassword}>
            {card.anchorPassword || '（无锚点）'}
          </p>
        </div>
        <span className="mono-num shrink-0 text-xs text-fg-faint">{card.layerCount} 层</span>
      </div>

      <div className="flex flex-col gap-1 text-xs">
        <span className="truncate text-fg-muted" title={card.chain}>
          链路　{sig}
        </span>
        <span className="truncate text-fg-faint">
          指纹　{card.volCount > 1 ? `${card.volCount} 个分卷 · ` : ''}
          {card.primVolSize > 0 ? `基准 ${fmtSize(card.primVolSize)}` : '未记录体积'}
        </span>
        <span className="text-fg-faint">
          战绩　命中 {card.hitCount} · 连续失败 {card.missCount} · 最近 {fmtTime(card.lastUsedAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
        <Button size="sm" variant="primary" icon="play" onClick={() => void useCard()}>
          用它解压
        </Button>
        <Button size="sm" variant="ghost" icon="download" onClick={() => void exportOne([card.id])}>
          导出
        </Button>
        <Button size="sm" variant="ghost" icon={card.enabled ? 'pause' : 'play'} onClick={() => void toggle(card.id)}>
          {card.enabled ? '停用' : '启用'}
        </Button>
        <Button size="sm" variant="ghost" icon="trash" className="ml-auto hover:text-bad" onClick={() => void remove(card.id)}>
          删除
        </Button>
      </div>
    </li>
  );
}

/* ==================================================================
   导入预览弹窗
   ================================================================== */
function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const preview = useStore((s) => s.importPreview);
  const applyImport = useStore((s) => s.workflowImportApply);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState(false);

  useEffect(() => {
    if (preview) {
      setSelected(new Set(preview.items.filter((i) => i.selected).map((i) => i.anchorPassword)));
      setOverwrite(false);
    }
  }, [preview]);

  if (!open || !preview) return null;

  const toggleOne = (anchor: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(anchor)) next.delete(anchor);
      else next.add(anchor);
      return next;
    });
  };

  const list = preview.items.filter((i) => i.kind !== 'skipped');

  return (
    <div className="fixed inset-0 z-40 grid animate-fade-in place-items-center bg-black/35 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="导入工作流卡片"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(720px,calc(100vh-64px))] w-[min(680px,100%)] animate-fade-up flex-col overflow-hidden rounded-panel border border-line bg-ink-0 shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <Icon name="download" size={16} />
          <span className="text-sm font-semibold">导入工作流卡片</span>
          <button aria-label="关闭" onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-btn text-fg-faint hover:bg-ink-1 hover:text-fg">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-xs">
          <span className="mono-num text-fg-faint">{preview.sourceFile}</span>
          <Chip tone="accent">新增 {preview.newCount}</Chip>
          {preview.conflictCount ? <Chip tone="warn">冲突 {preview.conflictCount}</Chip> : null}
          {preview.lowConfidenceCount ? <Chip>低置信 {preview.lowConfidenceCount}</Chip> : null}
          {preview.skippedCount ? <Chip>无锚点跳过 {preview.skippedCount}</Chip> : null}
          <span className="ml-auto text-fg-faint">已勾选 {selected.size} 张</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {list.length === 0 ? (
            <EmptyState icon="info" title="没有可导入的卡片" desc="该文件里的记录都缺少锚点密码，无法参与匹配" />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {list.map((it) => (
                <li
                  key={it.anchorPassword}
                  className="flex items-start gap-2.5 rounded-card border border-line bg-ink-0 p-2.5"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(it.anchorPassword)}
                    onChange={() => toggleOne(it.anchorPassword)}
                    aria-label={`导入 ${it.anchorPassword}`}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--c-accent))]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono-num truncate text-sm font-medium">{it.anchorPassword}</span>
                      <Chip tone={it.kind === 'new' ? 'accent' : it.kind === 'conflict' ? 'warn' : 'default'}>
                        {it.kind === 'new' ? '新增' : it.kind === 'conflict' ? '与本地冲突' : '低置信'}
                      </Chip>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-fg-muted">{it.summary}</p>
                    {it.kind === 'conflict' && it.localSummary ? (
                      <p className="mt-0.5 truncate text-xs text-warn">本地已有：{it.localSummary}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line bg-ink-1 px-4 py-3">
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            <Switch label="覆盖本地同锚点卡片" checked={overwrite} onChange={setOverwrite} />
            同锚点冲突时用导入的覆盖本地（只换链路，保留本地战绩）
          </label>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={!selected.size}
              onClick={async () => {
                await applyImport([...selected], overwrite);
                onClose();
              }}
            >
              导入选中项
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================
   工作流页
   ================================================================== */
export function WorkflowsView() {
  const cards = useStore((s) => s.workflows);
  const viewMode = useStore((s) => s.wfViewMode);
  const setViewMode = useStore((s) => s.setWfViewMode);
  const exportCards = useStore((s) => s.workflowExport);
  const openImport = useStore((s) => s.openImportPreview);
  const loadWorkflows = useStore((s) => s.loadWorkflows);
  const progressLog = useStore((s) => s.wfLog);

  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const usable = cards.filter((c) => c.usable).length;
  const disabled = cards.length - usable;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[rgb(var(--app-bg))]">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ink-0 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Icon name="layers" size={16} />
          工作流卡片
        </span>
        <Chip>{cards.length} 张</Chip>
        {usable ? <Chip tone="accent">可用 {usable}</Chip> : null}
        {disabled ? <Chip tone="warn">停用 {disabled}</Chip> : null}

        <div className="ml-auto flex items-center gap-1.5">
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-fg-faint">已选 {selected.size}</span>
              <Button size="sm" icon="download" onClick={() => void exportCards([...selected])}>
                导出选中
              </Button>
              <Button size="sm" variant="ghost" icon="close" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" icon="download" disabled={!cards.length} onClick={() => void exportCards()}>
                批量导出
              </Button>
              <Button size="sm" icon="upload" onClick={() => void openImport().then(() => setImportOpen(true))}>
                批量导入
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={viewMode === 'card' ? 'list' : 'layers'}
            onClick={() => setViewMode(viewMode === 'card' ? 'list' : 'card')}
          >
            {viewMode === 'card' ? '列表视图' : '卡片视图'}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 卡片区 */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {cards.length === 0 ? (
            <EmptyState
              icon="layers"
              title="还没有工作流卡片"
              desc="解压成功一次后会自动记住这条套路（锚点密码 + 链路 + 指纹），下次遇到同一来源就能一键跳过探测与密码试错。也可以从别人那里批量导入卡片包。"
              action={
                <Button size="sm" icon="upload" onClick={() => void openImport().then(() => setImportOpen(true))}>
                  批量导入
                </Button>
              }
            />
          ) : (
            <ul className={viewMode === 'card' ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-2'}>
              {cards.map((c) => (
                <div
                  key={c.id}
                  onClick={() => {
                    if (viewMode !== 'card') return;
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.id)) next.delete(c.id);
                      else next.add(c.id);
                      return next;
                    });
                  }}
                  style={viewMode === 'card' && selected.has(c.id) ? { outline: '1px solid rgb(var(--c-accent))', borderRadius: 10 } : undefined}
                >
                  <Card card={c} view={viewMode} />
                </div>
              ))}
            </ul>
          )}
        </div>

        {/* 匹配日志：让"是否命中、为什么走探测"可见 */}
        <aside className="hidden w-[300px] shrink-0 flex-col border-l border-line bg-ink-0 xl:flex">
          <div className="panel-title">
            <Icon name="activity" size={16} />
            <span>匹配日志</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3">
            {progressLog.length === 0 ? (
              <p className="text-xs leading-5 text-fg-faint">
                解压时这里会显示是否命中卡片、为什么走探测、以及卡片是否被自动停用。
              </p>
            ) : (
              progressLog.map((l, i) => (
                <div key={i} className="flex items-start gap-2 rounded-btn border border-line bg-ink-1 px-2 py-1.5">
                  <Icon
                    name={l.kind === 'matched' || l.kind === 'saved' ? 'check-circle' : l.kind === 'disabled' || l.kind === 'miss' ? 'warn' : 'info'}
                    size={16}
                    className={
                      l.kind === 'matched' || l.kind === 'saved'
                        ? 'mt-px shrink-0 text-ok'
                        : l.kind === 'disabled' || l.kind === 'miss'
                          ? 'mt-px shrink-0 text-warn'
                          : 'mt-px shrink-0 text-fg-faint'
                    }
                  />
                  <div className="min-w-0">
                    <p className="text-xs leading-5 text-fg-muted">{l.text}</p>
                    {l.anchorPassword ? <p className="mono-num mt-0.5 text-xs text-fg-faint">{l.anchorPassword}</p> : null}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-line p-3">
            <p className="text-xs leading-5 text-fg-faint">
              命中判定 = 锚点密码（主依据）+ 内容指纹 + 层数，名称仅作辅助；
              证据不足或有同分冲突时会改走常规探测，绝不静默走错链路。
            </p>
          </div>
        </aside>
      </div>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </section>
  );
}

export { ratio };
