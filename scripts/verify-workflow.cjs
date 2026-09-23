/**
 * 工作流闭环验证探针（开发期用）
 *
 * 验证链路：
 *   1) 解压第 1 批加密包 → 自动生成工作流卡片（锚点密码 = 解压密码）
 *   2) 再解压第 2 批同源包 → 命中卡片，跳过密码试错
 *   3) 切到工作流页截图
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --wf [light|dark]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const theme = process.argv.includes('dark') ? 'dark' : 'light';
const FX = path.join(os.tmpdir(), 'sz333wf');
const outFile = path.join(root, `shot-workflows-${theme}.png`);

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('[wf] 未找到窗口');
    app.exit(2);
    return;
  }

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer] ' + message);
  });

  win.show();
  win.setSize(1240, 800);

  await new Promise((r) => {
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', () => r());
  });

  // 等 store 初始化
  await new Promise((r) => setTimeout(r, 800));

  const p1 = path.join(FX, 'batch1', 'RX-4114.part1.7z.001');
  const p2 = path.join(FX, 'batch2', 'RX-4114.part1.7z.001');
  const out1 = path.join(FX, 'out1');
  const out2 = path.join(FX, 'out2');
  for (const d of [out1, out2]) fs.rmSync(d, { recursive: true, force: true });

  if (!fs.existsSync(p1) || !fs.existsSync(p2)) {
    console.error('[wf] 缺少测试包：' + p1 + ' / ' + p2);
    app.exit(3);
    return;
  }

  // 预置密码（模拟用户已把该上传者的密码存进设置，这是真实使用流程）
  await win.webContents.executeJavaScript(`
    window.api.setSettings({ passwords: ['Secret2026'], rememberPasswords: true })
  `);
  console.log('[wf] 已预置密码 Secret2026');

  // 清空已有工作流，保证是干净起点
  const existing = await win.webContents.executeJavaScript('window.api.workflowList()');
  for (const c of existing) {
    await win.webContents.executeJavaScript(`window.api.workflowRemove(${JSON.stringify(c.id)})`);
  }
  console.log('[wf] 起点：已有卡片 ' + existing.length + ' 张（已清空）');

  const runExtract = async (src, outDir, tag) => {
    const res = await win.webContents.executeJavaScript(`
      (async () => {
        const t = await window.api.startExtract({ paths: [${JSON.stringify(src)}], outDir: ${JSON.stringify(outDir)}, label: 'RX-4114' });
        const deadline = Date.now() + 40000;
        while (Date.now() < deadline) {
          const cur = window.__store.getState().tasks.find(x => x.id === t.id);
          if (cur && ['done','failed','needs-password','cancelled'].includes(cur.status)) {
            return JSON.stringify({ status: cur.status, files: cur.fileCount, output: cur.outputPath, err: cur.error && cur.error.message });
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return 'TIMEOUT';
      })();
    `);
    console.log(`[wf] ${tag} 解压结果：${res}`);
    return res;
  };

  // ---- 第 1 次：应生成卡片 ----
  await runExtract(p1, out1, '第1批');
  const after1 = await win.webContents.executeJavaScript('window.api.workflowList()');
  // 诊断：直接看主进程算出的指纹与源文件集合
  const diag = await win.webContents.executeJavaScript(`
    (async () => {
      const list = await window.api.workflowList();
      return JSON.stringify(list.map(c => ({ anchor: c.anchorPassword, fp: c.fingerprint, prim: c.primVolSize, vol: c.volCount, chain: c.chain })));
    })();
  `);
  console.log('[wf][诊断] 卡片指纹: ' + diag);
  const filesDiag = await win.webContents.executeJavaScript(`
    (async () => {
      const p = ${JSON.stringify(p1)};
      return JSON.stringify({ p1: p, exists: true });
    })();
  `);
  void filesDiag;
  console.log('[wf][诊断] 源包所在目录内容: ' + JSON.stringify(fs.readdirSync(path.dirname(p1))));
  console.log('[wf] 第1批后卡片数：' + after1.length);
  if (after1.length) {
    const c = after1[0];
    console.log(
      `[wf] 卡片内容：锚点=${c.anchorPassword} | 层数=${c.layerCount} | 分卷=${c.volCount} | 基准体积=${c.primVolSize} | 链路=${c.chain} | 命中=${c.hitCount}`
    );
  }

  // ---- 第 2 次：同源包，应命中 ----
  const matched = await win.webContents.executeJavaScript(`
    (async () => {
      window.__wfLog = [];
      const un = window.api.onWorkflowProgress((e) => window.__wfLog.push(e.kind + ': ' + e.text));
      await new Promise(r => setTimeout(r, 50));
      return 'ready';
    })();
  `);
  void matched;
  await runExtract(p2, out2, '第2批');
  const log = await win.webContents.executeJavaScript('JSON.stringify(window.__wfLog || [])');
  console.log('[wf] 第2批匹配事件：' + log);

  const after2 = await win.webContents.executeJavaScript('window.api.workflowList()');
  console.log('[wf] 第2批后卡片数：' + after2.length + '（命中则不应新增，命中次数 +1）');
  if (after2.length) {
    console.log(`[wf] 命中次数：${after2[0].hitCount} | 最近使用：${new Date(after2[0].lastUsedAt).toLocaleTimeString()}`);
  }

  // ---- 输出文件核对 ----
  const walk = (d) =>
    fs.existsSync(d)
      ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]))
      : [];
  console.log('[wf] out1 文件：' + walk(out1).join(', '));
  console.log('[wf] out2 文件：' + walk(out2).join(', '));

  // ---- 切到工作流页截图 ----
  await win.webContents.executeJavaScript(`
    (() => { window.__store.getState().setView('workflows'); return true; })();
  `);
  await new Promise((r) => setTimeout(r, 1200));

  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(outFile, png);
  console.log(`[wf] 工作流页截图：${outFile}（${Math.round(png.length / 1024)} KB）`);

  app.exit(0);
});
