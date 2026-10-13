/**
 * 用户级配置目录（避免 Program Files 只读问题）。
 *
 * 单独成文件的原因：`logger` 与 `engine` 都要用它。若把 `userDataDir` 留在
 * `engine.ts`，`logger` 引 `engine`、`engine` 又引 `logger` 会形成循环依赖，
 * 因此抽到本模块，两边都从这里取。
 */
import path from 'node:path';
import os from 'node:os';

export function userDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'sz333-unpack-desktop');
}
