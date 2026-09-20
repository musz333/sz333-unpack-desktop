/**
 * 首次引导验证探针
 *  检查 DOM 里是否出现了引导文案，并截图。
 *  用法：node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --wizard
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.setSize(1240, 800);
  await new Promise((r) => {
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', () => r());
  });
  await new Promise((r) => setTimeout(r, 2000)); // 等 store 初始化 + 引导判定

  const probe = await win.webContents.executeJavaScript(`
    (() => {
      const txt = document.body.innerText || '';
      const hasWizard = txt.includes('首次使用，先做 3 分钟设置');
      const hasNonAsciiStep = txt.includes('全英文') || txt.includes('中文');
      const hasStep = txt.includes('第 1 / 4 步');
      const hasSourceChoice = txt.includes('保留原始文件') && txt.includes('彻底删除');
      const firstRunDone = window.__store ? window.__store.getState().settings.firstRunDone : null;
      const bodySample = txt.split('\\n').filter(l => l.trim()).slice(0, 14).join(' | ');
      return JSON.stringify({ hasWizard, hasStep, hasSourceChoice, hasNonAsciiStep, firstRunDone, bodySample });
    })();
  `);
  console.log('[wizard] DOM 检查：' + probe);

  const shot = path.join(root, 'shot-wizard.png');
  const img = await win.webContents.capturePage();
  fs.writeFileSync(shot, img.toPNG());
  console.log('[wizard] 截图：' + shot + '（' + Math.round(img.toPNG().length / 1024) + ' KB）');

  app.exit(0);
});
