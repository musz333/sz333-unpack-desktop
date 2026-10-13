#!/usr/bin/env node
/**
 * sync-release-checksums.mjs —— 构建完成后刷新「已发布资产留底」
 *
 * 背景：`release-checksums.json` 是 `ci-assert-release-assets.mjs` 的比对基准，
 * 用来防「交付物被掉包」与「交付物落后于源码」。但它**不会自己更新** ——
 * 真实事故：交付目录叫 1.0.7、源码也是 1.0.7，留底却停留在 1.0.6，
 * 于是校验一路通过，而 bin/ 里装的其实是 1.0.6 的旧 exe。
 *
 * 用法（在 `npm run dist` 之后执行）：
 *   node scripts/sync-release-checksums.mjs                # 扫描 <项目>/release
 *   node scripts/sync-release-checksums.mjs <产物目录>      # 指定目录（如交付包的 bin/）
 *
 * 它会：
 *   1) 用 `package.json` 的 version 写入留底的 version（保证与源码同版本）；
 *   2) 扫描目录下**顶层 .exe** 与 `win-unpacked/` 主程序，记录 SHA-256 与体积；
 *   3) 记录 `win-unpacked/resources/app.asar` 的哈希与 out/** 树哈希。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release');

if (!fs.existsSync(releaseDir)) {
  console.error(`[sync-checksums] 目录不存在：${releaseDir}\n  先执行 npm run dist 产出安装包。`);
  process.exit(1);
}

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const statSize = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

const assets = [];

// ① 顶层 .exe（NSIS 安装包 / 便携版）
for (const e of fs.readdirSync(releaseDir, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.toLowerCase().endsWith('.exe')) continue;
  const p = path.join(releaseDir, e.name);
  assets.push({ file: e.name, sha256: sha256File(p), size: statSize(p) });
}

// ② win-unpacked 下的主程序（未压缩目录，调试/留档用）
const unpacked = path.join(releaseDir, 'win-unpacked');
if (fs.existsSync(unpacked)) {
  for (const e of fs.readdirSync(unpacked, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.exe')) continue;
    const p = path.join(unpacked, e.name);
    assets.push({ file: `win-unpacked/${e.name}`, sha256: sha256File(p), size: statSize(p) });
  }
}

if (!assets.length) {
  console.error(`[sync-checksums] 在 ${releaseDir} 下没找到任何 .exe —— 请确认已执行 npm run dist。`);
  process.exit(1);
}

// ③ 交付 bundle（asar + out/** 树哈希）
let bundle = null;
const asarRel = 'win-unpacked/resources/app.asar';
const asarPath = path.join(releaseDir, asarRel.split('/').join(path.sep));
if (fs.existsSync(asarPath)) {
  let outFileCount = 0;
  let outTreeSha256 = '';
  try {
    const asar = (await import('@electron/asar')).default ?? (await import('@electron/asar'));
    const tmp = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'sync-rel-'));
    asar.extractAll(asarPath, tmp);
    const outDir = path.join(tmp, 'out');
    const rels = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else rels.push(path.relative(outDir, p).split(path.sep).join('/'));
      }
    };
    walk(outDir);
    rels.sort();
    const h = crypto.createHash('sha256');
    for (const rel of rels) {
      h.update(rel);
      h.update(fs.readFileSync(path.join(outDir, rel.split('/').join(path.sep))));
    }
    outFileCount = rels.length;
    outTreeSha256 = h.digest('hex');
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[sync-checksums] 警告：无法解析 app.asar（${e.message}），bundle 段将只记 asar 哈希`);
  }
  bundle = {
    asar: asarRel,
    sha256: sha256File(asarPath),
    outFileCount,
    outTreeSha256
  };
}

const out = {
  $comment:
    '已发布资产的 SHA-256 留底（防「交付物落后于源码」/ 被掉包）。CI 断言见 scripts/ci-assert-release-assets.mjs。',
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  assets,
  ...(bundle ? { bundle } : {})
};

const target = path.join(root, 'release-checksums.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');

console.log(`[sync-checksums] 已写入 ${target}`);
console.log(`  version   = ${pkg.version}`);
console.log(`  assets    = ${assets.length} 个`);
for (const a of assets) console.log(`    · ${a.file}  (${a.size} B)`);
if (bundle) console.log(`  bundle    = ${bundle.asar}  outFiles=${bundle.outFileCount}`);
