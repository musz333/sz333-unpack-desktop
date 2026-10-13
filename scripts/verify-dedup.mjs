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

const { findDuplicates, normalizeCopyName } = dedup;

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
      // 修复 ①：单数字后缀**不再**被当成"另存副本"剥离 —— 它更可能是不同的分集/序号
      ['RX-4114_1.rar', 'rx-4114_1'],
      ['RX-4114 - 副本.rar', 'rx-4114'],
      ['RX-4114 copy.rar', 'rx-4114'],
      ['素材归档 (3).7z', '素材归档'],
      ['A-B (1).part1.7z', 'a-b'],
      ['A-B.part1.7z', 'a-b'],
      ['RX-4114_10.rar', 'rx-4114_10'],
      ['video_1.rar', 'video_1'],
      ['video_2.rar', 'video_2'],
      ['episode-1.rar', 'episode-1'],
      ['episode-2.rar', 'episode-2']
    ];
    for (const [input, expect] of cases) {
      const got = normalizeCopyName(input);
      check(`「${input}」→ ${expect}`, got === expect, '实际得到 ' + got);
    }
  }

  /* ================= D5 ================= */
  console.log();
  console.log('=== D5 同名副本标记仍判为重复（原跨批次场景） ===');
  {
    // findCrossBatchDuplicates 已作为死代码删除（无生产调用）；这里用 findDuplicates
    // 覆盖同一套 normalizeCopyName + 逐分卷指纹逻辑：带 (1) 的副本应被归一成同名。
    const a = mkdir();
    const b = mkdir();
    const fa = [mkfile(a, '已存在.part1.7z', 300000), mkfile(a, '已存在.part2.7z', 300000)];
    const fb = [mkfile(b, '已存在 (1).part1.7z', 300000), mkfile(b, '已存在 (1).part2.7z', 300000)];
    const r = findDuplicates([pack('E', fa), pack('N', fb)], sizeOf);
    check('「已存在 (1).part1.7z」与「已存在.part1.7z」判为同一份', r.groups.length === 1, 'groups=' + r.groups.length);
    check('剔除的是带 (1) 的那一份', r.droppedIds.length === 1 && r.droppedIds[0] === 'N', r.droppedIds.join(','));
    check('保留无后缀的那一份', r.groups[0]?.keep === 'E', r.groups[0]?.keep ?? '-');
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

  /* ================= D9 ================= */
  console.log();
  console.log('=== D9 回归：单数字后缀不再被剥离（去重误判修复） ===');
  {
    // 归一化层：单数字后缀不得被吃掉（否则第 1/2/3 集会撞成同一个 key）
    check('「video_1.rar」归一成 video_1', normalizeCopyName('video_1.rar') === 'video_1', normalizeCopyName('video_1.rar'));
    check('「video_2.rar」归一成 video_2', normalizeCopyName('video_2.rar') === 'video_2', normalizeCopyName('video_2.rar'));
    check('「episode-1.rar」归一成 episode-1', normalizeCopyName('episode-1.rar') === 'episode-1', normalizeCopyName('episode-1.rar'));
    check('「episode-2.rar」归一成 episode-2', normalizeCopyName('episode-2.rar') === 'episode-2', normalizeCopyName('episode-2.rar'));

    // 端到端：同名同体积的第 1/2 集**不应**被判为重复（旧实现会静默合并成一份，
    // 第 2 集直接从待处理清单消失 —— 这是本修复要守住的核心不变量）。
    const a = mkdir();
    const b = mkdir();
    const f1 = [mkfile(a, 'video_1.rar', 4096)];
    const f2 = [mkfile(b, 'video_2.rar', 4096)];
    const r = findDuplicates([pack('V1', f1), pack('V2', f2)], sizeOf);
    check('video_1.rar 与 video_2.rar 不判为同一份', r.groups.length === 0, 'groups=' + r.groups.length);
    check('两份都保留（不剔除）', r.droppedIds.length === 0, 'dropped=' + r.droppedIds.length);

    // 对照：真正带 (1) 副本标记的仍应判为重复
    const c = mkdir();
    const d = mkdir();
    const g1 = [mkfile(c, 'video_1.rar', 4096)];
    const g2 = [mkfile(d, 'video_1 (1).rar', 4096)];
    const r2 = findDuplicates([pack('K1', g1), pack('K2', g2)], sizeOf);
    check('「video_1 (1).rar」与「video_1.rar」仍判为同一份', r2.groups.length === 1, 'groups=' + r2.groups.length);
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
