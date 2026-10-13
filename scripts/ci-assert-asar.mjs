/**
 * CI 断言 ①：打包产物 asar 里的 `out/**` 必须与工程 `out/**` **逐文件 SHA-256 一致**。
 *
 * 目的：防「打包拿错产物」（build wiring 错误 —— 例如某版本的 exe 里其实是旧代码）。
 * 只有在**同一个 commit** 上先 `npm run build` 再 `electron-builder` 打包时，两者才应当一致。
 *
 * 用法： node scripts/ci-assert-asar.mjs <asarPath>
 *        例：   node scripts/ci-assert-asar.mjs release/win-unpacked/resources/app.asar
 *
 * 依赖：@electron/asar（electron-builder 的传递依赖，npm ci 后会存在于 node_modules）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asarPath = process.argv[2];
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('[assert-asar] 找不到 asar：' + (asarPath || '(未提供)'));
  process.exit(2);
}

const projOut = path.resolve('out');
if (!fs.existsSync(projOut)) {
  console.error('[assert-asar] 工程 out/ 不存在，请先 npm run build');
  process.exit(2);
}

const asar = require('@electron/asar');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-asar-'));
asar.extractAll(asarPath, tmp);
const asarOut = path.join(tmp, 'out');

/** 收集目录下所有文件的相对路径（POSIX 分隔）→ sha256 */
function tree(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const rel = path.relative(root, p).split(path.sep).join('/');
        map.set(rel, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
      }
    }
  };
  walk(root);
  return map;
}

const a = tree(asarOut);
const b = tree(projOut);
const problems = [];
for (const [rel, hash] of b) {
  if (!a.has(rel)) problems.push('asar 缺少：' + rel);
  else if (a.get(rel) !== hash) problems.push('内容不一致：' + rel);
}
for (const rel of a.keys()) {
  if (!b.has(rel)) problems.push('asar 多出：' + rel);
}

console.log(`[assert-asar] asar out/** = ${a.size} 文件，工程 out/** = ${b.size} 文件`);
if (problems.length) {
  console.error('[assert-asar] FAIL —— asar 与工程 out/** 不一致（打包拿错产物）：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('[assert-asar] PASS —— asar out/** 与工程 out/** 逐文件 SHA-256 一致');
