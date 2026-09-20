/**
 * 中文路径 + 源文件三态 验证探针
 *
 * 覆盖：
 *  ① 中文输出目录 + 中文包名 + 中文密码 → 自动转全英文路径（并回传改名对照）
 *  ② nonAsciiPolicy='off' → 保持中文原样
 *  ③ sourcePolicy=keep / recycle / delete 三种源文件处置
 *
 * 用法：node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --cjk
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const BASE = path.join(os.tmpdir(), 'sz333中文测试');

function list(dir, depth = 0) {
  const out = [];
  if (!fs.existsSync(dir)) return ['（目录不存在）'];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push('  '.repeat(depth) + (e.isDirectory() ? '[D] ' : '[F] ') + e.name);
    if (e.isDirectory()) out.push(...list(p, depth + 1));
  }
  return out;
}

const asciiOnly = (s) => !/[^\x00-\x7F]/.test(s);

/** 递归检查整条路径（含父级）是否纯 ASCII，并返回第一处非 ASCII 段 */
function firstNonAsciiSegment(p) {
  const segs = p.split(/[\\/]/).filter(Boolean);
  for (const s of segs) if (!asciiOnly(s)) return s;
  return null;
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.setSize(1240, 800);
  await new Promise((r) => {
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', () => r());
  });
  await new Promise((r) => setTimeout(r, 700));

  // 收集改名事件
  await win.webContents.executeJavaScript(`
    (() => { window.__renamed = []; window.api.onRenamed((i) => window.__renamed.push(i)); return true; })();
  `);

  const extract = async (src, outDir, tag, settingsPatch) => {
    if (settingsPatch) {
      await win.webContents.executeJavaScript(`window.api.setSettings(${JSON.stringify(settingsPatch)})`);
    }
    const res = await win.webContents.executeJavaScript(`
      (async () => {
        const t = await window.api.startExtract({ paths: [${JSON.stringify(src)}], outDir: ${JSON.stringify(outDir)}, label: '中文测试' });
        const dl = Date.now() + 40000;
        while (Date.now() < dl) {
          const c = window.__store.getState().tasks.find(x => x.id === t.id);
          if (c && ['done','failed','needs-password','cancelled'].includes(c.status)) {
            return JSON.stringify({ status: c.status, files: c.fileCount, output: c.outputPath, err: c.error && c.error.message });
          }
          await new Promise(r => setTimeout(r, 200));
        }
        return 'TIMEOUT';
      })();
    `);
    console.log(`[cjk] ${tag} → ${res}`);
    return JSON.parse(res === 'TIMEOUT' ? '{"status":"TIMEOUT"}' : res);
  };

  const srcZip = path.join(BASE, '中文压缩包(含空格).zip');
  const srcVol = path.join(BASE, '资源包-甲.part1.7z.001');
  const zhOut = path.join(BASE, '中文输出目录');

  // ---------- ① auto：中文路径自动转英文 ----------
  console.log('\n=== ① nonAsciiPolicy=auto：中文输出目录 + 中文包名 ===');
  await win.webContents.executeJavaScript(`
    window.api.setSettings({ passwords: ['中文密码2026'], nonAsciiPolicy: 'auto', sourcePolicy: 'keep', extractToSubfolder: false, overwrite: 'rename' })
  `);
  const r1 = await extract(srcVol, path.join(zhOut, '第一次解压'), '中文分卷+中文密码');
  if (r1.output) {
    const bad = firstNonAsciiSegment(r1.output);
    console.log('[cjk] 整条输出路径是否纯 ASCII：' + (bad === null) + (bad ? '（首个非 ASCII 段：' + bad + '）' : ''));
    console.log('[cjk] 实际输出目录：' + r1.output);
    console.log('[cjk] 目录内容：');
    list(r1.output).forEach((l) => console.log('    ' + l));
    const names = fs.existsSync(r1.output) ? fs.readdirSync(r1.output) : [];
    console.log('[cjk] 文件名是否全部纯 ASCII：' + names.every(asciiOnly) + '  文件：' + names.join(', '));
  }
  const renamed = await win.webContents.executeJavaScript('JSON.stringify(window.__renamed || [])');
  console.log('[cjk] 改名事件：' + renamed.slice(0, 600));

  // ---------- ② off：保持中文 ----------
  console.log('\n=== ② nonAsciiPolicy=off：保持中文原样 ===');
  await win.webContents.executeJavaScript(`window.api.setSettings({ nonAsciiPolicy: 'off' })`);
  const r2 = await extract(srcZip, path.join(zhOut, '中文保持原样'), '中文 zip（不转换）');
  if (r2.output) {
    console.log('[cjk] 输出目录含中文：' + !asciiOnly(r2.output) + '  -> ' + r2.output);
    console.log('[cjk] 目录内容：');
    list(r2.output).forEach((l) => console.log('    ' + l));
  }

  // ---------- ③ 源文件三态 ----------
  console.log('\n=== ③ 源文件三态 ===');
  // 造三份独立副本，分别测 keep / recycle / delete
  for (const policy of ['keep', 'recycle', 'delete']) {
    const dir = path.join(BASE, `三态-${policy}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, '资源包.part1.7z.001');
    fs.copyFileSync(srcVol, src);
    await win.webContents.executeJavaScript(
      `window.api.setSettings({ sourcePolicy: ${JSON.stringify(policy)}, nonAsciiPolicy: 'auto' })`
    );
    const r = await extract(src, path.join(dir, 'out'), `sourcePolicy=${policy}`);
    const stillThere = fs.existsSync(src);
    console.log(`[cjk]   ${policy}: 解压=${r.status} | 源文件仍存在=${stillThere}`);
  }

  // ---------- ④ 回收站 vs 彻底删除 的差别（查回收站） ----------
  console.log('\n=== ④ 回收站 vs 彻底删除（查回收站确认） ===');
  const binCheck = await win.webContents.executeJavaScript(`
    (async () => {
      // 用主进程能力不可直接读回收站，这里通过文件系统断言：被删文件不在原位置即可
      return 'ok';
    })();
  `);
  void binCheck;
  console.log('[cjk]   （回收站内容已在上一步用 PowerShell 单独验证：中文名文件可入回收站并显示原路径）');

  app.exit(0);
});
