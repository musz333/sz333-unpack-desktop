import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'default' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary: 'bg-brand text-white border-brand hover:bg-brand-hover hover:border-brand-hover',
  default: 'bg-ink-0 text-fg border-line hover:bg-ink-1 hover:border-line-strong',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-ink-1 hover:text-fg',
  danger: 'bg-ink-0 text-bad border-bad/40 hover:bg-bad-soft'
};

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2'
};

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  loading,
  block,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 16 : 16;
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={[
        'inline-flex select-none items-center justify-center rounded-btn border font-medium',
        'transition-colors duration-150 ease-out active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0',
        VARIANT[variant],
        SIZE[size],
        block ? 'w-full' : '',
        className
      ].join(' ')}
    >
      {loading ? (
        <Icon name="loader" size={iconSize} className="animate-spin" />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children ? <span className="truncate">{children}</span> : null}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  active?: boolean;
  size?: 16 | 20;
}

export function IconButton({ icon, label, active, size = 16, className = '', ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={[
        'grid h-8 w-8 place-items-center rounded-btn border transition-colors duration-150 ease-out',
        active ? 'border-brand-line bg-brand-soft text-brand' : 'border-transparent text-fg-muted hover:bg-ink-1 hover:text-fg',
        className
      ].join(' ')}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-180 ease-out',
        checked ? 'border-brand bg-brand' : 'border-line-strong bg-ink-1',
        disabled ? 'cursor-not-allowed opacity-45' : ''
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-[2px] left-[2px] h-4 w-4 rounded-full shadow-sm transition-transform duration-180 ease-out',
          checked ? 'translate-x-4 bg-white' : 'translate-x-0 bg-ink-0'
        ].join(' ')}
      />
    </button>
  );
}

export function Chip({
  children,
  tone = 'default',
  icon
}: {
  children: ReactNode;
  tone?: 'default' | 'accent' | 'ok' | 'warn' | 'bad';
  icon?: IconName;
}) {
  const toneCls =
    tone === 'accent'
      ? 'chip-accent'
      : tone === 'ok'
        ? 'chip-ok'
        : tone === 'warn'
          ? 'chip-warn'
          : tone === 'bad'
            ? 'chip-bad'
            : '';
  return (
    <span className={['chip', toneCls].join(' ')}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </span>
  );
}

export function Progress({
  value,
  tone = 'brand',
  indeterminate
}: {
  value: number | null;
  tone?: 'brand' | 'ok' | 'bad';
  indeterminate?: boolean;
}) {
  const color = tone === 'ok' ? 'bg-ok' : tone === 'bad' ? 'bg-bad' : 'bg-brand';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full border border-line bg-ink-1">
      {indeterminate ? (
        <div className={['h-full w-1/3 rounded-full', color, 'animate-[fade-in_0.6s_ease-out]'].join(' ')} style={{ animation: 'pulse 1.4s ease-in-out infinite' }} />
      ) : (
        <div
          className={['h-full rounded-full transition-[width] duration-200 ease-out', color].join(' ')}
          style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
        />
      )}
    </div>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  desc,
  action
}: {
  icon?: IconName;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line-strong bg-ink-0 px-4 py-6 text-center">
      <span className="grid h-9 w-9 place-items-center rounded-card border border-line bg-ink-1 text-fg-muted">
        <Icon name={icon} size={20} />
      </span>
      <p className="text-xs font-medium text-fg-muted">{title}</p>
      {desc ? <p className="max-w-[36ch] text-xs leading-5 text-fg-faint">{desc}</p> : null}
      {action}
    </div>
  );
}
