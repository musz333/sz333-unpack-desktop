/**
 * 字节体积格式化 —— 主进程统一口径。
 *
 * 原先 index.ts / dedup.ts / apkFilter.ts / tasks.ts 各写了一份，实现几乎相同却分散，
 * 改一处容易漏一处。现收敛为唯一实现，四处一律从这里引用。
 *
 * 说明：渲染层的 `renderer/src/lib/format.ts` 有面向 UI 的 `fmtSize`（阈值与小数位
 * 略有不同），二者**分层保留** —— 渲染层不引用主进程模块。
 */
export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
