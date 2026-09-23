/**
 * 扫描层去重 验证台（真实调用主进程 engine.scanPaths）
 *
 * S1. **分组键 bug 修复验证**：不同目录的同名包不应被合并成一组
 *    （修前会被 pickPrimary 静默吞掉一个，导致"该解的包没解"）
 * S2. 同一目录的分卷正常归为一组
 * S3. 同名 + 逐分卷大小一致 → 扫描时即合并为一份，并记录合并份数
 * S4. 同名不同大小 → 两份都留，并打上冲突标记
 * S5. 复制后缀 " (1)" 的包与原件判为重复
 *
 * 由 scripts/probe-entry.cjs --scan 加载。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  await new Promise((r) => {
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', () => r());
  });
  await new Promise((r) => setTimeout(r, 600));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v19scan-'));
  const mk = (dir, name, size) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(0));
    fs.truncateSync(p, size);
    return p;
  };
  /** 通过 preload 桥调用真实 scanPacks */
  const scan = (paths) =>
    win.webContents.executeJavaScript(`window.api.scanPacks(${JSON.stringify(paths)})`);

  try {
    console.log('=== S1 不同目录的同名包不应被合并（分组键修复验证）===');
    {
      const d1 = path.join(base, '文件夹A');
      const d2 = path.join(base, '文件夹B');
      const f1 = mk(d1, 'RX-4114.rar', 5000000);
      const f2 = mk(d2, 'RX-4114.rar', 3000000); // 同名但大小不同
      const packs = await scan([f1, f2]);
      check('同名不同目录 → 得到 2 个独立分组', packs.length === 2, `实际 ${packs.length} 组`);
      const primaries = packs.map((p) => p.primary).sort();
      check('两个路径都在（没有被静默吞掉）',
        primaries.includes(f1) && primaries.includes(f2),
        primaries.join(' | '));
    }

    console.log();
    console.log('=== S2 同一目录的分卷正常归为一组 ===');
    {
      const d = path.join(base, '分卷包');
      const parts = [1, 2, 3].map((i) => mk(d, `BIG.part${i}.rar`, 1000000));
      const packs = await scan(parts);
      check('3 个分卷 → 1 个分组', packs.length === 1, `实际 ${packs.length} 组`);
      check('分组内包含 3 个分卷', packs[0]?.files.length === 3, `files=${packs[0]?.files.length}`);
      check('主分卷是 part1', path.basename(packs[0]?.primary ?? '').toLowerCase().includes('part1'),
        packs[0]?.primary ?? '-');
    }

    console.log();
    console.log('=== S3 同名 + 逐分卷大小一致 → 扫描时即合并 ===');
    {
      const d1 = path.join(base, '原包');
      const d2 = path.join(base, '下载副本');
      const a = [1, 2].map((i) => mk(d1, `DUP.part${i}.rar`, 2000000));
      const b = [1, 2].map((i) => mk(d2, `DUP.part${i}.rar`, 2000000));
      const packs = await scan([...a, ...b]);
      check('两份相同 → 只保留 1 个分组', packs.length === 1, `实际 ${packs.length} 组`);
      check('记录了合并份数（mergedCount=2）', packs[0]?.mergedCount === 2, `mergedCount=${packs[0]?.mergedCount}`);
      check('给出了去重依据', !!(packs[0]?.dupReason ?? '').length, packs[0]?.dupReason ?? '-');
      check('记下了被剔除的路径', (packs[0]?.dupPaths ?? []).length === 1, `dupPaths=${(packs[0]?.dupPaths ?? []).length}`);
      check('保留的是先选中的那一份', packs[0]?.primary === a[0], `${packs[0]?.primary} vs ${a[0]}`);
    }

    console.log();
    console.log('=== S4 同名不同大小 → 两份都留 + 冲突标记 ===');
    {
      const d1 = path.join(base, '大小A');
      const d2 = path.join(base, '大小B');
      const f1 = mk(d1, 'SAME.rar', 1000000);
      const f2 = mk(d2, 'SAME.rar', 999999);
      const packs = await scan([f1, f2]);
      check('两份都保留（2 组）', packs.length === 2, `实际 ${packs.length} 组`);
      check('两份都带冲突标记', packs.every((p) => !!p.conflictNote), packs.map((p) => p.conflictNote ?? '-').join(' | '));
    }

    console.log();
    console.log('=== S5 复制后缀 (1) 判为重复 ===');
    {
      const d = path.join(base, '后缀');
      const f1 = mk(d, 'SUFFIX.7z', 8000000);
      const f2 = mk(d, 'SUFFIX (1).7z', 8000000);
      const packs = await scan([f1, f2]);
      check('同名同大小（带 (1)）→ 合并为 1 组', packs.length === 1, `实际 ${packs.length} 组`);
      check('mergedCount=2', packs[0]?.mergedCount === 2, `mergedCount=${packs[0]?.mergedCount}`);
    }
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log();
  console.log('结果：通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  app.exit(failed === 0 ? 0 : 1);
});
