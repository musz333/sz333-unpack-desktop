import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Chip, EmptyState, Switch } from './ui';
import { shortPath } from '../lib/format';
import type { ThemeMode } from '@shared/types';
import { EngineStatus } from './EngineStatus';

/* ==================================================================
   Toast
   ================================================================== */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => {
        const tone =
          t.kind === 'ok' ? 'border-l-2 border-l-ok text-ok' : t.kind === 'bad' ? 'border-l-2 border-l-bad text-bad' : t.kind === 'warn' ? 'border-l-2 border-l-warn text-warn' : 'border-l-2 border-l-brand text-brand';
        const icon = t.kind === 'ok' ? 'check-circle' : t.kind === 'bad' ? 'error' : t.kind === 'warn' ? 'warn' : 'info';
        return (
          <div
            key={t.id}
            className={['pointer-events-auto flex animate-fade-up items-start gap-2.5 rounded-card border border-line bg-ink-0 p-3 shadow-toast', tone].join(' ')}
          >
            <Icon name={icon} size={16} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">{t.title}</p>
              {t.desc ? <p className="mt-0.5 break-words text-xs text-fg-muted">{t.desc}</p> : null}
            </div>
            <button
              aria-label="关闭提示"
              onClick={() => dismiss(t.id)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-btn text-fg-faint transition-colors duration-150 ease-out hover:bg-ink-1 hover:text-fg"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ==================================================================
   密码输入
   ================================================================== */
export function PasswordDialog() {
  const taskId = useStore((s) => s.passwordFor);
  const tasks = useStore((s) => s.tasks);
  const close = useStore((s) => s.closePassword);
  const submit = useStore((s) => s.submitPassword);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const task = tasks.find((t) => t.id === taskId);

  useEffect(() => {
    if (taskId) {
      setValue('');
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [taskId]);

  if (!taskId) return null;

  return (
    <div className="fixed inset-0 z-40 grid animate-fade-in place-items-center bg-black/35 p-4">
      <div role="dialog" aria-modal="true" aria-label="输入解压密码" className="w-[min(460px,100%)] animate-fade-up overflow-hidden rounded-panel border border-line bg-ink-0 shadow-pop">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <Icon name="lock" size={16} className="text-warn" />
          <span className="text-sm font-semibold">该压缩包已加密</span>
          <button aria-label="关闭" onClick={close} className="ml-auto grid h-7 w-7 place-items-center rounded-btn text-fg-faint hover:bg-ink-1 hover:text-fg">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3 p-4">
          <p className="text-xs leading-5 text-fg-muted">
            任务「{task?.label}」需要密码才能继续。输入后会立即用该密码重试；在设置里开启「记住密码」可积累常用密码。
          </p>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) void submit(value.trim());
            }}
            placeholder="输入解压密码"
            aria-label="解压密码"
            className="h-9 rounded-btn border border-line bg-ink-0 px-2.5 text-sm transition-colors duration-150 ease-out placeholder:text-fg-faint hover:border-line-strong focus:border-brand"
          />
          {task?.error?.code === 'password' ? <p className="text-xs text-bad">{task.error.message}</p> : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-line bg-ink-1 px-4 py-3">
          <Button size="sm" variant="ghost" onClick={close}>
            取消
          </Button>
          <Button size="sm" variant="primary" icon="play" disabled={!value.trim()} onClick={() => void submit(value.trim())}>
            用此密码重试
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================
   设置
   ================================================================== */
export function SettingsDialog({
  open,
  onClose,
  onRestartWizard
}: {
  open: boolean;
  onClose: () => void;
  onRestartWizard: () => void;
}) {
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.patchSettings);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const toast = useStore((s) => s.toast);

  if (!open) return null;

  const pickOutDir = async () => {
    const dir = await window.api.pickFolder();
    if (dir) await patch({ defaultOutDir: dir });
  };

  return (
    <div className="fixed inset-0 z-40 grid animate-fade-in place-items-center bg-black/35 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(720px,calc(100vh-64px))] w-[min(620px,100%)] animate-fade-up flex-col overflow-hidden rounded-panel border border-line bg-ink-0 shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3.5">
          <Icon name="settings" size={16} />
          <span className="text-sm font-semibold">设置</span>
          <button aria-label="关闭设置" onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-btn text-fg-faint hover:bg-ink-1 hover:text-fg">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-6 overflow-auto p-4">
          {/* 外观 */}
          <Section title="外观" icon="sun">
            <div className="flex items-center gap-2">
              {(['system', 'light', 'dark'] as ThemeMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setTheme(m)}
                  className={[
                    'inline-flex h-8 items-center gap-1.5 rounded-btn border px-3 text-xs transition-colors duration-150 ease-out',
                    theme === m ? 'border-brand-line bg-brand-soft font-semibold text-brand' : 'border-line text-fg-muted hover:border-line-strong'
                  ].join(' ')}
                >
                  <Icon name={m === 'system' ? 'gauge' : m === 'light' ? 'sun' : 'moon'} size={16} />
                  {m === 'system' ? '跟随系统' : m === 'light' ? '浅色' : '深色'}
                </button>
              ))}
            </div>
          </Section>

          {/* 输出 */}
          <Section title="输出与覆盖" icon="folder-open">
            <Field label="默认输出目录">
              <div className="flex items-center gap-2">
                <span className="mono-num min-w-0 flex-1 truncate rounded-btn border border-line bg-ink-1 px-2.5 py-2 text-xs" title={settings.defaultOutDir}>
                  {settings.defaultOutDir || '（未设置）'}
                </span>
                <Button size="sm" icon="folder-open" onClick={() => void pickOutDir()}>
                  更改
                </Button>
              </div>
            </Field>

            <Field label="同名文件处理">
              <select
                value={settings.overwrite}
                onChange={(e) => void patch({ overwrite: e.target.value as never })}
                className="h-9 w-full rounded-btn border border-line bg-ink-0 px-2.5 text-sm transition-colors duration-150 ease-out hover:border-line-strong focus:border-brand"
              >
                <option value="rename">自动改名（推荐）</option>
                <option value="overwrite">覆盖已有文件</option>
                <option value="skip">跳过已有文件</option>
              </select>
            </Field>

            <ToggleRow label="以压缩包名新建子目录" checked={settings.extractToSubfolder} onChange={(v) => void patch({ extractToSubfolder: v })} />
            <ToggleRow label="解压完成后打开输出目录" checked={settings.autoOpenOutDir} onChange={(v) => void patch({ autoOpenOutDir: v })} />
          </Section>

          {/* 源文件处理：保留 / 彻底删除 */}
          <Section title="源文件处理" icon="trash">
            <p className="text-xs leading-5 text-fg-faint">
              解压成功后，原始分卷与中间压缩包怎么处理。处理失败或中途取消的分组，无论选哪项都不会删源文件。
            </p>
            <PolicyRadio
              checked={settings.sourcePolicy === 'keep'}
              onClick={() => void patch({ sourcePolicy: 'keep' })}
              title="保留原始文件"
              desc="最安全，磁盘占用更高。"
            />

            <PolicyRadio
              checked={settings.sourcePolicy === 'delete'}
              onClick={() => void patch({ sourcePolicy: 'delete' })}
              title="彻底删除（默认，不可恢复）"
              desc="不进回收站、不额外占磁盘，适合大体积资源。一经删除无法恢复。"
              tone="bad"
            />
          </Section>

          {/* 中文路径 */}
          <Section title="中文路径" icon="file">
            <p className="text-xs leading-5 text-fg-faint">
              不少老资源包解压到中文路径时会乱码或失败。开启后，解压时中文目录名与包内中文文件名会被替换为全英文名，
              并逐条写入任务日志（原名 → 新名），保证你能对照找回文件。
            </p>
            <PolicyRadio
              checked={settings.nonAsciiPolicy === 'auto'}
              onClick={() => void patch({ nonAsciiPolicy: 'auto' })}
              title="自动（推荐）"
              desc="仅在输出路径含中文时转换。"
            />
            <PolicyRadio
              checked={settings.nonAsciiPolicy === 'force'}
              onClick={() => void patch({ nonAsciiPolicy: 'force' })}
              title="始终转成全英文路径"
              desc="无论原路径是否含中文，一律使用英文目录名与文件名。"
              tone="warn"
            />
            <PolicyRadio
              checked={settings.nonAsciiPolicy === 'off'}
              onClick={() => void patch({ nonAsciiPolicy: 'off' })}
              title="保持原样（不做任何转换）"
              desc="保留中文名称。"
            />
          </Section>

          {/* 重复包 */}
          <Section title="重复包处理" icon="layers">
            <p className="text-xs leading-5 text-fg-faint">
              判定依据：同名 + 逐分卷大小完全一致（只看文件大小，不读内容 —— 几十 GB 的包算哈希太慢）。
              剔除只作用于待处理清单，不会删除硬盘上的文件；带「(1)」这类复制后缀的会被识别为同一份。
            </p>
            <PolicyRadio
              checked={settings.dupPolicy === 'silent'}
              onClick={() => void patch({ dupPolicy: 'silent' })}
              title="无感直接剔除（默认）"
              desc="拖入时发现重复包立即只保留一份，仅用一条提示告知。"
            />
            <PolicyRadio
              checked={settings.dupPolicy === 'ask'}
              onClick={() => void patch({ dupPolicy: 'ask' })}
              title="每次询问"
              desc="剔除前弹窗列出重复项，可一键把它们加回清单。"
              tone="warn"
            />
            <PolicyRadio
              checked={settings.dupPolicy === 'off'}
              onClick={() => void patch({ dupPolicy: 'off' })}
              title="不自动处理"
              desc="全部保留，需要时在解压页点【剔除重复包】手动清理。"
            />
          </Section>

          {/* 任务队列 */}
          <Section title="任务队列" icon="activity">
            <PolicyRadio
              checked={settings.autoCollapseDone === 'on'}
              onClick={() => void patch({ autoCollapseDone: 'on' })}
              title="成功任务完成后自动收起（默认）"
              desc="完成后停留 8 秒再从队列移出，方便你点【打开】【定位】；失败、取消、待输入密码的任务一直保留，便于排查。"
            />
            <PolicyRadio
              checked={settings.autoCollapseDone === 'off'}
              onClick={() => void patch({ autoCollapseDone: 'off' })}
              title="不自动收起"
              desc="所有任务卡都留在队列里，由你手动清除。"
            />
          </Section>

          {/* 性能与行为 */}
          <Section title="性能与行为" icon="gauge">
            <Field label="同时处理任务数">
              <div className="flex items-center gap-2">
                {([1, 2, 4] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => void patch({ maxConcurrent: n })}
                    className={[
                      'h-8 w-12 rounded-btn border text-xs transition-colors duration-150 ease-out',
                      settings.maxConcurrent === n ? 'border-brand-line bg-brand-soft font-semibold text-brand' : 'border-line text-fg-muted hover:border-line-strong'
                    ].join(' ')}
                  >
                    {n}
                  </button>
                ))}
                <span className="text-xs text-fg-faint">机械硬盘建议 1；固态硬盘可尝试 2</span>
              </div>
            </Field>

            <ToggleRow label="完成后发送系统通知" checked={settings.notifyOnFinish} onChange={(v) => void patch({ notifyOnFinish: v })} />
          </Section>

          {/* APK 过滤 */}
          <Section title="APK 过滤" icon="package">
            <ToggleRow
              label="剔除解压出来的 .apk"
              checked={settings.apkFilterEnabled}
              onChange={(v) => void patch({ apkFilterEnabled: v })}
            />
            <p className="text-xs leading-5 text-fg-faint">
              开启后，解压产物里的安卓安装包会被删除。若单个 apk 占整个包解出体积超过下面的比例，
              判定这个包只是个 apk 外壳，连整份解压产物一起删掉（不影响源压缩包，源包去留由上面的「源文件处理」决定）。
            </p>
            <Field label="整包删除阈值">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={5}
                  value={settings.apkDropThreshold}
                  disabled={!settings.apkFilterEnabled}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) void patch({ apkDropThreshold: Math.max(1, Math.min(100, Math.round(n))) });
                  }}
                  className="mono-num h-9 w-24 rounded-btn border border-line bg-ink-0 px-2.5 text-sm disabled:text-fg-disabled transition-colors duration-150 ease-out hover:border-line-strong focus:border-brand"
                  aria-label="APK 整包删除阈值（百分比）"
                />
                <span className="text-xs text-fg-muted">%（单个 apk 占整包达到此比例即删整包）</span>
              </div>
            </Field>
          </Section>

          {/* 密码 */}
          <Section title="密码" icon="lock">
            <ToggleRow label="记住成功的密码（供下次自动尝试）" checked={settings.rememberPasswords} onChange={(v) => void patch({ rememberPasswords: v })} />
            {settings.passwords.length ? (
              <div className="flex flex-wrap gap-1.5">
                {settings.passwords.map((p) => (
                  <span key={p} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-1 px-2 py-1 text-xs">
                    <Icon name="lock" size={16} className="text-fg-faint" />
                    <span className="mono-num">{p}</span>
                    <button
                      aria-label={`删除密码 ${p}`}
                      onClick={() => void patch({ passwords: settings.passwords.filter((x) => x !== p) })}
                      className="text-fg-faint hover:text-bad"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-fg-faint">暂无记住的密码。</p>
            )}
          </Section>

          {/* 关于 */}
          <Section title="关于" icon="info">
            <AboutBlock />
            <EngineStatus />
          </Section>
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ink-1 px-4 py-3">
          <Button size="sm" variant="ghost" icon="sliders" onClick={() => { void window.api.resetFirstRun(); onRestartWizard(); }}>
            重新查看首次运行引导
          </Button>
          <span className="ml-auto" />
          <Button size="sm" variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 局部构件 ------------------------------ */

/** 关于区块：版本 / 开源地址 / 配置目录，信息从主进程读取，避免写死 */
function AboutBlock() {
  const [info, setInfo] = useState<{
    version: string;
    electron: string;
    githubUrl: string;
    configDir: string;
    packaged: boolean;
  } | null>(null);

  useEffect(() => {
    void window.api
      .appInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const repo = info?.githubUrl?.replace(/^https?:\/\//, '') ?? '';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <Chip tone="accent">sz333 解压工具</Chip>
        {info ? <Chip>v{info.version}</Chip> : null}
        <Chip>Electron + React</Chip>
        <Chip>内嵌 7-Zip 引擎</Chip>
      </div>

      <div className="flex flex-col gap-1 rounded-card border border-line bg-ink-1 p-2.5">
        <span className="text-xs text-fg-muted">开源地址（点击打开）</span>
        <button
          onClick={() => info && void window.api.openExternal(info.githubUrl)}
          className="inline-flex items-center gap-1.5 text-xs text-brand hover:underline"
          title={'打开 ' + (info?.githubUrl ?? '')}
        >
          <Icon name="github" size={16} />
          {repo || 'github.com/muszz333/sz333-unpack-desktop'}
          <Icon name="external" size={16} />
        </button>
      </div>

      <p className="mono-num break-all text-xs leading-5 text-fg-faint">
        配置目录：{info?.configDir ?? '%APPDATA%\\sz333-unpack-desktop'}
      </p>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: Parameters<typeof Icon>[0]['name']; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <Icon name={icon} size={16} />
        {title}
      </div>
      <div className="flex flex-col gap-3 rounded-card border border-line bg-ink-0 p-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}    </div>
  );
}

/** 策略单选项（源文件处理 / 中文路径 共用） */
function PolicyRadio({
  checked,
  onClick,
  title,
  desc,
  tone
}: {
  checked: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  tone?: 'warn' | 'bad';
}) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg';
  return (
    <button
      onClick={onClick}
      className={[
        'flex w-full items-start gap-2.5 rounded-card border p-2.5 text-left transition-colors duration-150 ease-out',
        checked ? 'border-brand bg-brand-soft' : 'border-line bg-ink-0 hover:border-line-strong'
      ].join(' ')}
    >
      <span
        className={[
          'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border',
          checked ? 'border-brand bg-brand' : 'border-line-strong bg-ink-0'
        ].join(' ')}
      >
        {checked ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
      </span>
      <span className="min-w-0">
        <span className={['block text-sm font-medium', color].join(' ')}>{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{desc}</span>
      </span>
    </button>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-fg-muted">{label}</span>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

export function PanelEmptyWrapper({ children }: { children: React.ReactNode }) {
  return <EmptyState icon="info" title="提示" desc={String(children)} />;
}
