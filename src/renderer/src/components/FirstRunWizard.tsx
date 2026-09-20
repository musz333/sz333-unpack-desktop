import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Button, Switch } from './ui';
import type { NonAsciiPolicy, SourcePolicy } from '@shared/types';

/**
 * 首次使用引导（4 步）
 *  ① 源文件处理：保留 / 彻底删除
 *  ② 中文路径：解压时是否转成全英文路径
 *  ③ 默认输出目录
 *  ④ 并发任务数
 *
 * 每一步都写明"以后在【设置】哪一项改"；
 * 首次启动自动弹出，设置页底部有【重新查看首次运行引导】常驻入口。
 */
const STEPS = 4;

export function FirstRunWizard({
  open,
  onClose,
  fromSettings
}: {
  open: boolean;
  onClose: () => void;
  fromSettings?: boolean;
}) {
  const settings = useStore((s) => s.settings);
  const patch = useStore((s) => s.patchSettings);
  const toast = useStore((s) => s.toast);

  const [step, setStep] = useState(1);
  const [sourcePolicy, setSourcePolicy] = useState<SourcePolicy>(settings.sourcePolicy);
  const [nonAscii, setNonAscii] = useState<NonAsciiPolicy>(settings.nonAsciiPolicy);
  const [outDir, setOutDir] = useState(settings.defaultOutDir);
  const [subfolder, setSubfolder] = useState(settings.extractToSubfolder);
  const [concurrent, setConcurrent] = useState<number>(settings.maxConcurrent);

  // 每次打开时用当前设置回填（"重新查看引导"时尤其重要）
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setSourcePolicy(settings.sourcePolicy);
    setNonAscii(settings.nonAsciiPolicy);
    setOutDir(settings.defaultOutDir);
    setSubfolder(settings.extractToSubfolder);
    setConcurrent(settings.maxConcurrent);
  }, [open, settings]);

  if (!open) return null;

  const pickDir = async () => {
    const d = await window.api.pickFolder();
    if (d) setOutDir(d);
  };

  const finish = async () => {
    await patch({
      sourcePolicy,
      nonAsciiPolicy: nonAscii,
      defaultOutDir: outDir,
      extractToSubfolder: subfolder,
      maxConcurrent: concurrent as 1 | 2 | 4
    });
    await window.api.markFirstRunDone();
    toast('ok', fromSettings ? '设置已更新' : '首次设置已保存', '随时可在【设置】页修改');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="首次使用引导"
        className="flex max-h-[min(680px,calc(100vh-64px))] w-[min(620px,100%)] animate-fade-up flex-col overflow-hidden rounded-panel border border-line bg-ink-0 shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="grid h-7 w-7 place-items-center rounded-btn bg-brand text-white">
            <Icon name="package" size={16} />
          </span>
          <span className="text-sm font-semibold">{fromSettings ? '首次设置（可随时重看）' : '首次使用，先做 3 分钟设置'}</span>
          <span className="mono-num ml-auto text-xs text-fg-faint">
            第 {step} / {STEPS} 步
          </span>
          <button
            aria-label="关闭"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-btn text-fg-faint hover:bg-ink-1 hover:text-fg"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
          {step === 1 ? (
            <>
              <Title text="解压成功后，原始压缩包怎么处理？" desc="这一项最容易造成不可恢复的后果，请按自己的习惯选。" />
              <Radio
                checked={sourcePolicy === 'keep'}
                onChange={() => setSourcePolicy('keep')}
                title="保留原始文件"
                desc="最安全。磁盘占用会变高，但随时能重新解压一次。"
                tone="ok"
              />

              <Radio
                checked={sourcePolicy === 'delete'}
                onChange={() => setSourcePolicy('delete')}
                title="彻底删除"
                desc="不进回收站、不额外占磁盘，适合大体积资源。一经删除无法恢复，请确认这些包可弃用。"
                tone="bad"
              />
              <Foot text="随时可在【设置】→ 源文件处理 中修改。" />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <Title
                text="解压出来的路径要不要强制用全英文？"
                desc="不少老资源包（GBK 时代打包、老式编码）解压到中文路径时会乱码或失败。开启后，解压时中文目录名与中文文件名会被替换为 ASCII 名。"
              />
              <Radio
                checked={nonAscii === 'auto'}
                onChange={() => setNonAscii('auto')}
                title="自动（推荐）"
                desc="检测到输出路径含中文时才转换：换成一个纯英文的兄弟目录，并把包内的中文名一并转成英文。"
                tone="ok"
              />
              <Radio
                checked={nonAscii === 'force'}
                onChange={() => setNonAscii('force')}
                title="始终转英文"
                desc="无论原路径是否含中文，一律使用全英文路径与文件名。"
                tone="warn"
              />
              <Radio
                checked={nonAscii === 'off'}
                onChange={() => setNonAscii('off')}
                title="保持原样"
                desc="完全不做转换，保留中文名（适合纯中文资源、且你的环境没有兼容问题）。"
              />
              <div className="rounded-card border border-line bg-ink-1 p-2.5">
                <p className="text-xs leading-5 text-fg-muted">
                  转换是**可追溯**的：每一条「原名 → 新名」都会写进任务日志，你可以随时对照找回文件。
                </p>
              </div>
              <Foot text="随时可在【设置】→ 中文路径 中修改。" />
            </>
          ) : null}

          {step === 3 ? (
            <>
              <Title text="解压结果放在哪里？" desc="默认放在源文件所在目录旁边，方便随手找到。" />
              <div className="flex flex-col gap-2">
                <span className="text-xs text-fg-muted">默认输出目录</span>
                <div className="flex items-center gap-2">
                  <span className="mono-num min-w-0 flex-1 truncate rounded-btn border border-line bg-ink-1 px-2.5 py-2 text-xs" title={outDir}>
                    {outDir || '（未设置，默认与源文件同级）'}
                  </span>
                  <Button size="sm" icon="folder-open" onClick={() => void pickDir()}>
                    更改
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-ink-1 p-3">
                <div className="min-w-0">
                  <p className="text-sm text-fg">以压缩包名新建子目录</p>
                  <p className="mt-0.5 text-xs text-fg-faint">避免多个压缩包的内容混在同一个目录里。</p>
                </div>
                <Switch label="以压缩包名新建子目录" checked={subfolder} onChange={setSubfolder} />
              </div>
              <Foot text="随时可在【设置】→ 输出与覆盖 中修改。" />
            </>
          ) : null}

          {step === 4 ? (
            <>
              <Title text="同时处理几个压缩包？" desc="解压既吃处理器也吃硬盘，开太多不一定更快，还会让磁盘临时占用翻倍。" />
              <div className="flex items-center gap-2">
                {([1, 2, 4] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => setConcurrent(n)}
                    className={[
                      'h-9 w-16 rounded-btn border text-sm transition-colors duration-150 ease-out',
                      concurrent === n
                        ? 'border-brand-line bg-brand-soft font-semibold text-brand'
                        : 'border-line text-fg-muted hover:border-line-strong'
                    ].join(' ')}
                  >
                    {n} 个
                  </button>
                ))}
                <span className="ml-2 text-xs text-fg-faint">
                  {concurrent === 1 ? '机械硬盘 / 处理大包：推荐' : concurrent === 2 ? '固态硬盘 + 多个小包' : '固态硬盘 + 多核，磁盘占用峰值更高'}
                </span>
              </div>
              <Foot text="随时可在【设置】→ 性能与行为 中修改。" />
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-ink-1 px-4 py-3">
          <Button size="sm" variant="ghost" disabled={step === 1} onClick={() => setStep((s) => s - 1)}>
            上一步
          </Button>
          <span className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              稍后再说
            </Button>
            {step < STEPS ? (
              <Button size="sm" variant="primary" icon="chevron-right" onClick={() => setStep((s) => s + 1)}>
                下一步
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon="check" onClick={() => void finish()}>
                完成
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function Title({ text, desc }: { text: string; desc: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold tracking-tight">{text}</h2>
      <p className="mt-1 text-xs leading-5 text-fg-muted">{desc}</p>
    </div>
  );
}

function Radio({
  checked,
  onChange,
  title,
  desc,
  tone
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  desc: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const titleColor =
    tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-fg' : 'text-fg';
  return (
    <button
      onClick={onChange}
      className={[
        'flex w-full items-start gap-3 rounded-card border p-3 text-left transition-colors duration-150 ease-out',
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
        <span className={['block text-sm font-medium', titleColor].join(' ')}>{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-muted">{desc}</span>
      </span>
    </button>
  );
}

function Foot({ text }: { text: string }) {
  return <p className="text-xs font-medium text-brand">{text}</p>;
}
