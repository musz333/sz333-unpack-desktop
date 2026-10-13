/**
 * CI 断言 ②：**已发布资产留底校验**（防「交付物落后于源码」/ 被掉包）。
 *
 * 这是与断言 ① 不同的第二条：① 防"打包拿错产物"；② 防"交付物落后于源码"。
 * （上一轮返工的真实原因就是：只做了 ① 而没做 ②，于是 1.0.4 的 exe 是旧代码。）
 *
 * 校验内容：
 *   1) 仓库根必须存在 `release-checksums.json`，且其中 `assets` 非空；
 *   2) 若 `release/<file>` 实际存在，其 SHA-256 必须与留底一致（不一致 = 被掉包/被改写）；
 *   3) 若 `release/win-unpacked/resources/app.asar` 存在，其 `out/**` 必须与当前
 *      `out/**` 逐文件一致（= 交付的 bundle 与当前源码同源）；
 *      不存在则**明确 SKIP**（CI 默认 checkout 不带 release/ 目录）。
 *
 * 用法： node scripts/ci-assert-release-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const manifestPath = path.join(root, 'release-checksums.json');
const releaseDir = path.join(root, 'release');

if (!fs.existsSync(manifestPath)) {
  console.error('[assert-release] FAIL —— 缺少 release-checksums.json（已发布资产哈希留底）');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  console.error('[assert-release] FAIL —— release-checksums.json 的 assets 为空（未填写已发布资产哈希）');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 断言 ⓪：**版本一致性**（新增）
 *
 * 为什么必须放在最前面：留底哈希只能证明"exe 没被掉包"，**证明不了
 * "exe 是当前版本构建的"**。真实事故：交付目录叫 release-1.0.7、源码是
 * 1.0.7，但 release-checksums.json 仍是 1.0.6、bin/ 下也是 1.0.6 的 exe ——
 * 哈希校验照样通过（因为留底记的就是那个旧 exe）。
 * 所以先卡版本：package.json 的 version、留底里的 version 必须一致；
 * 且**带版本号的发布产物**（NSIS/portable）文件名必须含当前版本。
 * （`win-unpacked/` 主程序按 `${productName}.exe` 命名、不含版本号，豁免文件名检查。）
 * ------------------------------------------------------------------ */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let versionFailed = false;

if (pkg.version !== manifest.version) {
  console.error(
    `[assert-release] FAIL —— 版本不一致：package.json=${pkg.version}，release-checksums.json=${manifest.version}\n` +
      `    说明：交付留底停留在旧版本（exe 很可能是旧代码构建的）。\n` +
      `    处理：重新执行 npm run dist，再跑 node scripts/sync-release-checksums.mjs 刷新留底。`
  );
  versionFailed = true;
}

for (const a of manifest.assets) {
  /* 以下两类条目天然不含版本号，跳过「文件名含版本」检查：
   *   - `win-unpacked/`：electron-builder 标准布局，主程序按 `${productName}.exe` 命名；
   *   - `bin/`：本项目的「绿色版目录」交付布局，主程序同样按 `${productName}.exe` 命名
   *     （本次交付即为此形态，若只豁免 win-unpacked/ 会误报 FAIL）。
   * 它们的「防掉包」由下方的 SHA-256 比对负责；「是否同版本」由
   * package.json / 留底的 version 一致性卡住。
   * 只对**带版本号的发布产物**（NSIS 安装包 / portable 便携版）校验文件名含版本。 */
  const relPath = a.file.replace(/\\/g, '/');
  if (relPath.startsWith('win-unpacked/') || relPath.startsWith('bin/')) continue;
  if (!a.file.includes(pkg.version)) {
    console.error(
      `[assert-release] FAIL —— 资产文件名不含当前版本 ${pkg.version}：${a.file}\n` +
        `    说明：该产物疑似由其它版本构建（或命名模板未带版本号）。`
    );
    versionFailed = true;
  }
}
if (versionFailed) process.exit(1);
console.log(`[assert-release] OK    版本一致（package.json / 留底 / 资产名均为 ${pkg.version}）`);

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let failed = false;
let checked = 0;

for (const a of manifest.assets) {
  const p = path.join(releaseDir, a.file.split('/').join(path.sep));
  if (!fs.existsSync(p)) {
    console.log(`[assert-release] SKIP  ${a.file}（release/ 下不存在）`);
    continue;
  }
  const h = sha256File(p);
  checked += 1;
  if (h !== a.sha256) {
    console.error(`[assert-release] FAIL  ${a.file}\n    期望 ${a.sha256}\n    实际 ${h}`);
    failed = true;
  } else {
    console.log(`[assert-release] OK    ${a.file}`);
  }
}

/* 内嵌 7-Zip 引擎完整性：manifest.resources[]（7z.exe / 7z.dll）的 SHA-256 比对。
 * 这两个二进制随源码入库于 <项目根>/resources/（不是 release/ 产物），故先相对**项目根**解析；
 * 打包时 extraResources 会把它复制到 release/win-unpacked/resources/，该副本一并纳入比对。
 * 两处都找不到则 SKIP（与 assets[] 的 SKIP 语义一致）。 */
const resourceCandidates = (rel) => [
  path.join(root, rel.split('/').join(path.sep)),
  path.join(releaseDir, 'win-unpacked', rel.split('/').join(path.sep))
];
for (const r of manifest.resources ?? []) {
  const cands = resourceCandidates(r.file);
  const p = cands.find((x) => fs.existsSync(x));
  if (!p) {
    console.log(`[assert-release] SKIP  ${r.file}（未找到：${cands.join(' / ')}）`);
    continue;
  }
  const h = sha256File(p);
  checked += 1;
  if (h !== r.sha256) {
    console.error(`[assert-release] FAIL  ${r.file}\n    期望 ${r.sha256}\n    实际 ${h}\n    位置 ${p}`);
    failed = true;
  } else {
    console.log(`[assert-release] OK    ${r.file}（${p}）`);
  }
}

/* 交付物 vs 源码：release bundle 的 out/** 是否与当前 out/** 同源 */
if (manifest.bundle?.asar) {
  const asarPath = path.join(releaseDir, manifest.bundle.asar.split('/').join(path.sep));
  const projOut = path.join(root, 'out');
  if (!fs.existsSync(asarPath)) {
    console.log('[assert-release] SKIP  交付 bundle 未打包（无 release/win-unpacked/resources/app.asar）');
  } else if (!fs.existsSync(projOut)) {
    console.log('[assert-release] SKIP  工程 out/ 不存在，无法比对交付 bundle（请先 npm run build）');
  } else {
    const asar = require('@electron/asar');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-rel-'));
    asar.extractAll(asarPath, tmp);
    const tree = (dir) => {
      const m = new Map();
      if (!fs.existsSync(dir)) return m;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else m.set(path.relative(dir, p).split(path.sep).join('/'), sha256File(p));
        }
      };
      walk(dir);
      return m;
    };
    const a = tree(path.join(tmp, 'out'));
    const b = tree(projOut);
    const diffs = [];
    for (const [rel, h] of b) {
      if (!a.has(rel)) diffs.push('bundle 缺少：' + rel);
      else if (a.get(rel) !== h) diffs.push('内容不一致：' + rel);
    }
    for (const rel of a.keys()) if (!b.has(rel)) diffs.push('bundle 多出：' + rel);
    if (diffs.length) {
      console.error('[assert-release] FAIL —— 已交付 bundle 与当前源码 out/** 不一致（交付物落后于源码）：');
      for (const d of diffs) console.error('  - ' + d);
      failed = true;
    } else {
      console.log('[assert-release] OK    交付 bundle 的 out/** 与当前源码一致');
    }
  }
}

if (failed) process.exit(1);
console.log(`[assert-release] PASS —— 留底校验通过（实际比对 ${checked} 个资产；其余为 SKIP）`);
