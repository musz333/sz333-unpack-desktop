/**
 * package-green.mjs —— 沙箱环境下的「绿色版目录」打包脚本
 *
 * 与 build-with-wasm.mjs 配套：
 *   1) 先跑 build-with-wasm.mjs 产出 out/ 三端产物；
 *   2) 本脚本把 out/ + package.json 打成 app.asar（@electron/asar）；
 *   3) 把 app.asar + 7z 引擎放进一个绿色版目录（Electron 运行时 + 改名主程序）。
 *
 * 用法：node package-green.mjs <目标目录>
 *   例：node package-green.mjs ../sz333-unpack-2.0.1-dist
 *
 * 说明：本脚本**不生成** Electron 运行时文件（*.dll / *.pak / locales/ 等）；
 * 这些来自已有 dist 的 bin/（同一 Electron 31 运行时）。脚本只负责：
 *   · 重新生成 bin/resources/app.asar（含本版全部修复）
 *   · 拷贝 resources/7z.exe + 7z.dll 到 bin/resources/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(root, '../sz333-unpack-2.0.1-dist');
const binDir = path.join(targetDir, 'bin');
const resDir = path.join(binDir, 'resources');
const outDir = path.join(root, 'out');

/* ---------- 0) 前置校验 ---------- */
for (const f of ['main/index.js', 'preload/index.js', 'renderer/index.html', 'renderer/index.js', 'renderer/index.css']) {
  const p = path.join(outDir, f);
  if (!fs.existsSync(p)) throw new Error(`缺少构建产物 out/${f}，请先运行 node build-with-wasm.mjs`);
}

/* ---------- 1) 组装 app.asar ---------- */
// 注1：沙箱会把 fs.rmSync 劫持到「回收站」，无 GUI 下会失败 → 用时间戳命名暂存目录。
// 注2：沙箱下 fs.cpSync 会硬崩（退出码 127），故自实现递归拷贝。
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dst, e));
  } else {
    fs.copyFileSync(src, dst);
  }
}
const stage = path.join(root, '.build-stage-' + Date.now());
fs.mkdirSync(path.join(stage, 'out'), { recursive: true });
for (const sub of ['main', 'preload', 'renderer']) {
  copyTree(path.join(outDir, sub), path.join(stage, 'out', sub));
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));

const asar = require('@electron/asar');
fs.mkdirSync(resDir, { recursive: true });
const asarOut = path.join(resDir, 'app.asar');
await asar.createPackage(stage, asarOut);
// 校验 asar
const list = asar.listPackage(asarOut);
console.log('[pack] app.asar 已生成：', asarOut);
console.log('[pack]   ' + list.length + ' 个条目，大小 ' + fs.statSync(asarOut).size + ' B');

/* ---------- 2) 拷贝 7z 引擎 ---------- */
for (const f of ['7z.exe', '7z.dll']) {
  const src = path.join(root, 'resources', f);
  const dst = path.join(resDir, f);
  fs.copyFileSync(src, dst);
  console.log('[pack] ' + f + ' → resources/ (' + fs.statSync(dst).size + ' B)');
}

/* ---------- 3) 清理暂存（尽力而为，失败不影响产物） ---------- */
try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* 沙箱下可能失败，忽略 */ }

console.log('\n[pack] 完成。绿色版目标目录：' + targetDir);
console.log('[pack]   运行方式：双击 ' + path.join('bin', 'sz333 解压工具.exe'));
