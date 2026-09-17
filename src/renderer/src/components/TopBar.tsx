import { useEffect, useState } from 'react';
import { useStore, type ViewKey } from '../store';
import { Icon, type IconName } from './Icon';
import { IconButton } from './ui';
import { GITHUB_REPO, GITHUB_URL } from '../lib/appInfo';

const NAV: { key: ViewKey; label: string; icon: IconName }[] = [
  { key: 'extract', label: '解压', icon: 'package' },
  { key: 'workflows', label: '工作流', icon: 'layers' },
  { key: 'history', label: '历史', icon: 'clock' }
];

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const theme = useStore((s) => s.theme);
  const resolvedDark = useStore((s) => s.resolvedDark);
  const setTheme = useStore((s) => s.setTheme);
  const tasks = useStore((s) => s.tasks);
  const [wide, setWide] = useState(true);

  useEffect(() => {
    const check = () => setWide(window.innerWidth >= 900);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  const activeCount = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;

  return (
    <header className="flex h-13 shrink-0 items-center gap-4 border-b border-line bg-ink-0 px-4" style={{ height: 52 }}>
      <div className="flex items-center gap-2.5 pr-4" style={{ borderRight: wide ? '1px solid rgb(var(--c-border))' : 'none' }}>
        <span className="grid h-7 w-7 place-items-center rounded-btn bg-brand text-white">
          <Icon name="package" size={16} />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">sz333 解压工具</div>
        </div>
      </div>

      <nav className="flex items-center gap-1" aria-label="主导航">
        {NAV.map((n) => {
          const active = view === n.key;
          return (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex h-8 items-center gap-1.5 rounded-btn border px-3 text-sm font-medium',
                'transition-colors duration-150 ease-out',
                active
                  ? 'border-brand-line bg-brand-soft text-brand'
                  : 'border-transparent text-fg-muted hover:bg-ink-1 hover:text-fg'
              ].join(' ')}
            >
              <Icon name={n.icon} size={16} />
              {wide ? <span>{n.label}</span> : null}
              {n.key === 'extract' && activeCount > 0 ? (
                <span className="mono-num ml-0.5 rounded-full bg-brand px-1.5 text-xs text-white">{activeCount}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* 开源地址常驻显示，点击打开仓库 */}
        <span className="hidden items-center gap-1.5 text-xs text-fg-faint md:flex">
          <Icon name="github" size={16} />
          <button
            onClick={() => void window.api.openExternal(GITHUB_URL)}
            title={'打开开源仓库：' + GITHUB_URL}
            className="transition-colors duration-150 ease-out hover:text-brand hover:underline"
          >
            {GITHUB_REPO}
          </button>
        </span>
        <IconButton
          icon={resolvedDark ? 'sun' : 'moon'}
          label={resolvedDark ? '切换到浅色模式' : '切换到深色模式'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
        <IconButton icon="settings" label="设置" onClick={onOpenSettings} />
      </div>
    </header>
  );
}
