/**
 * 重复包剔除 验证台
 *
 * 直接调用**真实实现** src/main/dedup.ts（用 esbuild 现场打包，不做任何镜像/复刻），
 * 在临时目录里造真实文件，断言去重行为。
 *
 * 用法： node scripts/verify-dedup.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log('  [PASS] ' + name);
  } else {
    failed += 1;
    console.log('  [FAIL] ' + name + '  → ' + detail);
  }
};

/* ---------- 1) 把真实 TS 打包成 CJS，供 Node 直接调用 ---------- */
const esbuild = require('esbuild');
const outFile = path.join(os.tmpdir(), `dedup-bundle-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/main/dedup.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: outFile,
  logLevel: 'error'
});
const dedup = require(outFile);
execFileSync(process.execPath, ['-e', '0']); // 确保 require 生效顺序

const { findDuplicates, findCrossBatchDuplicates, normalizeCopyName } = dedup;

/* ---------- 2) 临时文件工具 ---------- */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v19dedup-'));
let dirSeq = 0;
const mkdir = () => {
  const d = path.join(base, 'd' + dirSeq++);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const mkfile = (dir, name, size) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(0));
  fs.truncateSync(p, size); // 稀疏创建，不实际占盘
  return p;
};
const sizeOf = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
};

/** 与主进程一致地选主分卷 */
const pack = (id, files) => {
  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'zh'));
  let primary = sorted[0] ?? '';
  for (const f of sorted) {
    const n = path.basename(f).toLowerCase();
    if (n.includes('.part1.') || n.endsWith('.001') || n.endsWith('.z01') || n.endsWith('.r00')) {
      primary = f;
      break;
    }
  }
  return {
    id,
    primary,
    files,
    size: files.reduce((s, f) => s + sizeOf(f), 0),
    name: path.basename(primary)
  };
};

console.log('真实实现：src/main/dedup.ts（esbuild 打包后直接调用）');
console.log('测试根目录：' + base);
console.log();

try {
  /* ================= D1 ================= */
  console.log('=== D1 同名 + 逐分卷大小一致 ===');
  {
    const a = mkdir();
    const b = mkdir();
    const fa = [1, 2, 3].map((i) => mkfile(a, `RX-4114.part${i}.rar`, 1000000));
    const fb = [1, 2, 3].map((i) => mkfile(b, `RX-4114.part${i}.rar`, 1000000));
    const r = findDuplicates([pack('A', fa), pack('B', fb)], sizeOf);
    check('判为重复（1 组）', r.groups.length === 1, 'groups=' + r.groups.length);
    check('只剔除 1 份', r.droppedIds.length === 1, 'dropped=' + r.droppedIds.length);
    check('保留先出现的 A', r.groups[0]?.keep === 'A', r.groups[0]?.keep ?? '-');
    check('依据提到分卷逐一相同', (r.groups[0]?.reason ?? '').includes('分卷'), r.groups[0]?.reason ?? '-');
    check('置信度 exact', r.groups[0]?.confidence === 'exact', r.groups[0]?.confidence ?? '-');
  }

  /* ================= D2 / D3 ================= */
  console.log();
  console.log('=== D2/D3 同名不同大小 / 切法不同 ===');
  {
    const a = mkdir();
    const b = mkdir();
    const c = mkdir();
    const fa = [mkfile(a, 'PKG.part1.rar', 500000), mkfile(a, 'PKG.part2.rar', 500000)];
    const fb = [mkfile(b, 'PKG.part1.rar', 800000), mkfile(b, 'PKG.part2.rar', 200000)];
    const fc = [mkfile(c, 'PKG.part1.rar', 300000), mkfile(c, 'PKG.part2.rar', 700000)];

    const r = findDuplicates([pack('A', fa), pack('B', fb)], sizeOf);
    check('D2 同名但分卷大小不同 → 不算重复', r.groups.length === 0, 'groups=' + r.groups.length);
    check('D2 两份都保留', r.droppedIds.length === 0, 'dropped=' + r.droppedIds.length);
    check('D2 记为冲突', r.conflicts.length === 1, 'conflicts=' + r.conflicts.length);

    const r2 = findDuplicates([pack('B', fb), pack('C', fc)], sizeOf);
    check('D3 总量相同但切法不同 → 不算重复', r2.groups.length === 0, 'groups=' + r2.groups.length);
    check('D3 两份都保留', r2.droppedIds.length === 0, 'dropped=' + r2.droppedIds.length);
  }

  /* ================= D4 ================= */
  console.log();
  console.log('=== D4 复制后缀规范化 ===');
  {
    const cases = [
      ['RX-4114 (1).rar', 'rx-4114'],
      ['RX-4114（2）.rar', 'rx-4114'],
      ['RX-4114_1.rar', 'rx-4114'],
      ['RX-4114 - 副本.rar', 'rx-4114'],
      ['RX-4114 copy.rar', 'rx-4114'],
      ['素材归档 (3).7z', '素材归档'],
      ['A-B (1).part1.7z', 'a-b'],
      ['A-B.part1.7z', 'a-b'],
      ['RX-4114_10.rar', 'rx-4114_10']   // 两位数后缀视为不同包名，不归一
    ];
    for (const [input, expect] of cases) {
      const got = normalizeCopyName(input);
      check(`「${input}」→ ${expect}`, got === expect, '实际得到 ' + got);
    }
  }

  /* ================= D5 ================= */
  console.log();
  console.log('=== D5 跨批次检测 ===');
  {
    const a = mkdir();
    const b = mkdir();
    const ex = [mkfile(a, '已存在.part1.7z', 300000), mkfile(a, '已存在.part2.7z', 300000)];
    const inc = [mkfile(b, '已存在 (1).part1.7z', 300000), mkfile(b, '已存在 (1).part2.7z', 300000)];
    const r = findCrossBatchDuplicates([pack('E', ex)], [pack('N', inc)], sizeOf);
    check('新包与已有包相同 → 判为重复', r.groups.length === 1, 'groups=' + r.groups.length);
    check('剔除的是新来的那一份', r.droppedIds.length === 1 && r.droppedIds[0] === 'N', r.droppedIds.join(','));
    check('保留清单里已有的那一份', r.groups[0]?.keep === 'E', r.groups[0]?.keep ?? '-');
  }

  /* ================= D6 / D7 ================= */
  console.log();
  console.log('=== D6/D7 单文件与三重重复 ===');
  {
    const a = mkdir();
    const b = mkdir();
    const c = mkdir();
    const packs = [
      pack('A', [mkfile(a, '单文件.zip', 4096)]),
      pack('B', [mkfile(b, '单文件 (1).zip', 4096)]),
      pack('C', [mkfile(c, '单文件（2）.zip', 4096)])
    ];
    const r = findDuplicates(packs, sizeOf);
    check('D6 单文件包同名同大小 → 重复', r.groups.length === 1, 'groups=' + r.groups.length);
    check('D7 三份合并为一份（剔除 2）', r.droppedIds.length === 2, 'dropped=' + r.droppedIds.length);
    check('D7 保留第一份 A', r.groups[0]?.keep === 'A', r.groups[0]?.keep ?? '-');
  }

  /* ================= D8 ================= */
  console.log();
  console.log('=== D8 同名不同内容混在一起 ===');
  {
    const a = mkdir();
    const b = mkdir();
    const c = mkdir();
    const fa = [mkfile(a, 'MIX.7z.001', 400000), mkfile(a, 'MIX.7z.002', 400000)];
    const fb = [mkfile(b, 'MIX (1).7z.001', 400000), mkfile(b, 'MIX (1).7z.002', 400000)];
    const fc = [mkfile(c, 'MIX (2).7z.001', 900000)];
    const r = findDuplicates([pack('A', fa), pack('B', fb), pack('C', fc)], sizeOf);
    check('只合并相同的那一对', r.groups.length === 1 && r.droppedIds.length === 1, `groups=${r.groups.length} dropped=${r.droppedIds.length}`);
    check('剔除的是 B', r.droppedIds[0] === 'B', r.droppedIds.join(','));
    check('内容不同的 C 未被剔除', !r.droppedIds.includes('C'), r.droppedIds.join(','));
    check('记为冲突（同名不同大小）', r.conflicts.length === 1, 'conflicts=' + r.conflicts.length);
  }
} finally {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(outFile, { force: true });
  } catch {
    /* ignore */
  }
}

console.log();
console.log('结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
