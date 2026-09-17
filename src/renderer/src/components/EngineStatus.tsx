import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button, Chip } from './ui';
import { shortPath } from '../lib/format';

interface CheckResult {
  ok: boolean;
  path: string;
  version?: string;
  error?: string;
}

/** 引擎状态：把「7z 是否可用」直接暴露在界面上，避免用户遇到问题时无从判断 */
export function EngineStatus() {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [result, setResult] = useState<CheckResult | null>(null);

  const check = async () => {
    setState('loading');
    try {
      const r = await window.api.engineSelfCheck();
      setResult(r);
    } catch (e) {
      setResult({ ok: false, path: '', error: e instanceof Error ? e.message : String(e) });
    }
    setState('done');
  };

  useEffect(() => {
    void check();
  }, []);

  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-ink-1 p-2.5">
      <div className="flex items-center gap-2">
        <Icon name="disk" size={16} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-muted">7-Zip 引擎</span>
        {state === 'loading' ? (
          <Chip>检测中…</Chip>
        ) : result?.ok ? (
          <Chip tone="ok" icon="check">
            可用
          </Chip>
        ) : (
          <Chip tone="bad" icon="error">
            不可用
          </Chip>
        )}
        <Button size="sm" variant="ghost" icon="refresh" className="ml-auto" loading={state === 'loading'} onClick={() => void check()}>
          重新检测
        </Button>
      </div>

      {result ? (
        <p className="mono-num break-all text-xs leading-5 text-fg-faint">
          {result.ok ? `${result.version ?? '7-Zip'} · ${shortPath(result.path, 3)}` : (result.error ?? '未知错误')}
        </p>
      ) : null}
    </div>
  );
}
