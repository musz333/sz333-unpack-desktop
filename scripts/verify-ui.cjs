/**
 * UI 验证探针（开发期用，CommonJS：与主进程 CJS 产物保持一致）
 *
 * 由 scripts/probe-entry.cjs 作为 Electron 入口加载（入口必须先加载真实主进程）。
 * 作用：注入真实压缩包 → 走完整 IPC 链路（scanPacks / listArchive）→ 截图存档。
 *
 * 用法：
 *   node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --probe [light|dark]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const theme = process.argv.includes('dark') ? 'dark' : 'light';
const outFile = path.join(root, `shot-${theme}.png`);
const FX = path.join(os.tmpdir(), 'sz333probe');

app.whenReady().then(async () => {
  // ---- 覆盖为可控的测试数据（真实的 7z 列表解析仍走主进程实现） ----
  ipcMain.removeHandler('settings:get');
  ipcMain.handle('settings:get', () => ({
    theme,
    language: 'zh-CN',
    defaultOutDir: path.join(os.homedir(), 'Downloads', '解压输出'),
    extractToSubfolder: true,
    overwrite: 'rename',
    level: 7,
    keepDirStructure: true,
    deleteSourceAfterExtract: false,
    maxConcurrent: 1,
    notifyOnFinish: true,
    autoOpenOutDir: false,
    rememberPasswords: true,
    passwords: ['Secret2026']
  }));

  ipcMain.removeHandler('history:list');
  ipcMain.handle('history:list', () => [
    {
      id: 'h1',
      op: 'extract',
      label: 'RX-4114',
      source: 'C:\\Downloads\\RX-4114.part1.rar',
      output: 'C:\\Downloads\\RX-4114',
      size: 3241000000,
      fileCount: 1284,
      status: 'done',
      at: Date.now() - 3600000
    },
    {
      id: 'h2',
      op: 'compress',
      label: '素材归档_2026Q1',
      source: 'C:\\Pictures\\Q1',
      output: 'C:\\Downloads\\素材归档_2026Q1.7z',
      size: 812000000,
      status: 'done',
      at: Date.now() - 86400000
    },
    {
      id: 'h3',
      op: 'extract',
      label: '坏包测试',
      source: 'C:\\Downloads\\bad.zip',
      output: '',
      size: 0,
      status: 'failed',
      at: Date.now() - 172800000
    }
  ]);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('[verify-ui] 未找到窗口');
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

  // ---- 注入真实文件（临时素材不存在时回退为占位路径） ----
  const real = ['设计稿.zip', '素材归档_2026Q1.7z', 'RX-4114.part1.7z.001', 'RX-4114.part2.7z.002']
    .map((f) => path.join(FX, f))
    .filter((p) => fs.existsSync(p));

  const paths = real.length ? real : ['C:\\Users\\zk\\Downloads\\示例.zip'];

  const injected = await win.webContents
    .executeJavaScript(
      `
    (async () => {
      const paths = ${JSON.stringify(paths)};
      try {
        if (window.__store) {
          const n = await window.__store.getState().addPaths(paths);
          return 'store:' + n;
        }
        return 'no-store';
      } catch (e) { return 'ERR:' + e.message; }
    })();
  `
    )
    .catch((e) => 'EVAL_ERR:' + e.message);

  console.log('[verify-ui] 注入结果：' + injected);
  console.log('[verify-ui] 使用文件：' + paths.join(' | '));

  // 等详情面板异步读取压缩包目录
  await new Promise((r) => setTimeout(r, 2500));

  // 打印详情面板关键文本，确认 7z 列表解析真的通了
  const probeText = await win.webContents
    .executeJavaScript(
      `(() => { const dl = document.querySelector('dl'); return dl ? dl.innerText.replace(/\\n/g, ' | ') : 'NO_DL'; })()`
    )
    .catch(() => 'ERR');
  console.log('[verify-ui] 详情面板：' + probeText);

  const preview = await win.webContents
    .executeJavaScript(
      `(() => { const rows = document.querySelectorAll('ul li'); return '列表条目 ' + rows.length; })()`
    )
    .catch(() => 'ERR');
  console.log('[verify-ui] ' + preview);

  // ---- 若带 --extract：真实跑一次解压，验证 解压→输出 全链路 ----
  if (process.argv.includes('--extract') && real.length) {
    const outDir = path.join(os.tmpdir(), 'sz333probe-out');
    fs.rmSync(outDir, { recursive: true, force: true });

    const started = await win.webContents.executeJavaScript(`
      (async () => {
        const t = await window.api.startExtract({ paths: [${JSON.stringify(path.join(FX, '设计稿.zip'))}], outDir: ${JSON.stringify(outDir)}, label: '设计稿.zip' });
        return t.id;
      })();
    `);
    console.log('[verify-ui] 已入队解压任务：' + started);

    const done = await win.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const t = window.__store.getState().tasks.find(x => x.id === ${JSON.stringify(started)});
          if (t && (t.status === 'done' || t.status === 'failed')) return JSON.stringify({ status: t.status, progress: t.progress, output: t.outputPath, files: t.fileCount, error: t.error && t.error.message });
          await new Promise(r => setTimeout(r, 200));
        }
        return 'TIMEOUT';
      })();
    `);
    console.log('[verify-ui] 解压任务结果：' + done);

    if (fs.existsSync(outDir)) {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(outDir, path.join(d, e.name))]));
      const files = walk(outDir);
      console.log('[verify-ui] 输出目录文件（' + files.length + '）：' + files.join(', '));
    } else {
      console.log('[verify-ui] 输出目录未生成');
    }
  }

  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  fs.writeFileSync(outFile, png);
  console.log(`[verify-ui] 截图已保存：${outFile}（${Math.round(png.length / 1024)} KB）`);

  app.exit(0);
});
