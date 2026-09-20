import { useEffect, useState } from 'react';
import { useStore } from './store';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import { ArchiveDetail } from './components/ArchiveDetail';
import { WorkflowsView } from './components/WorkflowsView';
import { HistoryView } from './components/HistoryView';
import { PasswordDialog, SettingsDialog, Toasts } from './components/Dialogs';
import { FirstRunWizard } from './components/FirstRunWizard';
import { Button } from './components/ui';

export default function App() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const view = useStore((s) => s.view);
  const packs = useStore((s) => s.packs);
  const resolvedDark = useStore((s) => s.resolvedDark);
  const applySystemTheme = useStore((s) => s.applySystemTheme);
  const addPaths = useStore((s) => s.addPaths);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardFromSettings, setWizardFromSettings] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [wide, setWide] = useState(true);

  useEffect(() => {
    void init();
  }, [init]);

  // 首次运行：自动弹出引导（设置里已有 firstRunDone 则不再打扰）
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    if (ready && settings && settings.firstRunDone === false) {
      setWizardFromSettings(false);
      setWizardOpen(true);
    }
    // 只在首次加载后判断一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 主题：跟随系统时监听系统切换
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => applySystemTheme(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [applySystemTheme]);

  // 深色类名挂到 <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedDark);
  }, [resolvedDark]);

  // 响应式：窄窗时把侧栏变为可开合的抽屉
  useEffect(() => {
    const check = () => setWide(window.innerWidth >= 1180);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // 侧栏里的「设置」按钮通过自定义事件打开对话框
  useEffect(() => {
    const h = () => setSettingsOpen(true);
    window.addEventListener('open-settings', h);
    return () => window.removeEventListener('open-settings', h);
  }, []);

  const pick = async () => {
    const paths = await window.api.pickArchives();
    if (paths.length) await addPaths(paths);
  };

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-[rgb(var(--app-bg))] text-fg-muted">
        <span className="text-sm">正在启动…</span>
      </div>
    );
  }

  const showDetail = view === 'extract' && wide;

  return (
    <div className="flex h-full flex-col bg-[rgb(var(--app-bg))]">
      <TopBar onOpenSettings={() => setSettingsOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <Sidebar open={wide || queueOpen} />

        {view === 'extract' ? (
          <>
            <Workspace onPick={() => void pick()} />
            {showDetail ? (
              <aside className="flex min-h-0 w-[336px] shrink-0 flex-col border-l border-line bg-ink-0">
                <ArchiveDetail />
              </aside>
            ) : null}
          </>
        ) : view === 'workflows' ? (
          <WorkflowsView />
        ) : (
          <HistoryView />
        )}
      </div>

      {/* 窄窗下的抽屉开关 */}
      {!wide ? (
        <div className="fixed bottom-4 left-4 z-30">
          <Button size="sm" icon="list" onClick={() => setQueueOpen((v) => !v)}>
            队列
          </Button>
        </div>
      ) : null}

      {view === 'extract' && !wide && packs.length > 0 ? (
        <div className="fixed bottom-4 right-4 z-30">
          <Button size="sm" icon="info" onClick={() => useStore.getState().selectPack(packs[0].id)}>
            详情
          </Button>
        </div>
      ) : null}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onRestartWizard={() => {
          setWizardFromSettings(true);
          setWizardOpen(true);
        }}
      />
      <FirstRunWizard
        open={wizardOpen}
        fromSettings={wizardFromSettings}
        onClose={() => setWizardOpen(false)}
      />
      <PasswordDialog />
      <Toasts />
    </div>
  );
}
