/**
 * 格式化工具（统一口径，避免各处各写一套）
 */
export function fmtSize(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function fmtCount(n?: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('zh-CN');
}

export function fmtTime(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(from?: number | null, to?: number | null): string {
  if (!from) return '—';
  const ms = (to ?? Date.now()) - from;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m} 分 ${rest} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

export function ratio(a: number, b: number): string {
  if (!b) return '—';
  return `${Math.round((a / b) * 100)}%`;
}

/** 路径变短：只保留最后两段，前面用省略号 */
export function shortPath(p: string, keep = 2): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  if (parts.length <= keep) return p;
  return `…\\${parts.slice(-keep).join('\\')}`;
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
