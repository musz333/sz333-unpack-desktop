/**
 * 中文路径 + 源文件策略 验证探针（**带硬断言**）
 *
 * 覆盖：
 *  ① nonAsciiPolicy=auto：中文输出目录 + 中文包名 → 输出路径**整条**转全 ASCII
 *  ② sourcePolicy='delete' → 解压成功后源包**不存在**（不可恢复）
 *  ③ sourcePolicy='keep'   → 源包**存在且字节哈希不变**
 *
 * 说明：
 *  · `SourcePolicy` 现在只有 keep | delete 两态（回收站方案已取消），
 *    因此本脚本**不再**测试 recycle。
 *  · 语料由本脚本用内嵌 7z **自造**（不依赖外部预置文件），否则套件会因缺语料而"静默通过"。
 *  · 断言仿 verify-layers.cjs 的 ok() 模式；结果同时落盘（Windows GUI 无 stdout 捕获）。
 *
 * 用法（打包态台架）： <台架>\sz333 解压工具.exe --cjk
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPORT = path.join(os.tmpdir(), 'sz333-cjk-report.txt');
try { fs.writeFileSync(REPORT, ''); } catch {}
const _log = console.log.bind(console);
console.log = (...args) => {
  try {
    fs.appendFileSync(REPORT, args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  } catch {}
  _log(...args);
};

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log('  [PASS] ' + label);
  } else {
    fail += 1;
    console.log('  [FAIL] ' + label);
  }
};

const BASE = path.join(os.tmpdir(), 'sz333中文测试');
const asciiOnly = (s) => !/[^\x00-\x7F]/.test(s);

/** 递归检查整条路径（含父级）是否纯 ASCII，返回第一处非 ASCII 段 */
function firstNonAsciiSegment(p) {
  const segs = p.split(/[\\/]/).filter(Boolean);
  for (const s of segs) if (!asciiOnly(s)) return s;
  return null;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 按优先级定位内嵌 7z（台架 resources → 系统安装） */
function resolve7z() {
  const cands = [
    path.join(process.resourcesPath, '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return '7z.exe';
}

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => {
    if (!win) return r();
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', r);
  });
  await new Promise((r) => setTimeout(r, 700));

  const setS = (patch) => win.webContents.executeJavaScript(`window.api.setSettings(${JSON.stringify(patch)})`);
  const extract = async (src, outDir, tag) => {
    const res = await win.webContents.executeJavaScript(`
      (async () => {
        const t = await window.api.startExtract({ paths: [${JSON.stringify(src)}], outDir: ${JSON.stringify(outDir)}, label: '中文测试' });
        const dl = Date.now() + 60000;
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

  /* ---------- 自造语料（中文目录树 + 中文名） ---------- */
  const SZ = resolve7z();
  console.log('[cjk] 7z = ' + SZ + ' 存在=' + fs.existsSync(SZ));
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  const work = path.join(BASE, '_work');
  const deep = path.join(work, '中文目录', '子目录');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, '说明文档.txt'), '中文内容-说明', 'utf8');
  fs.writeFileSync(path.join(deep, '图片素材-01.txt'), '中文内容-图片', 'utf8');
  fs.writeFileSync(path.join(deep, '数据文件.bin'), Buffer.alloc(64, 7));
  const srcZip = path.join(BASE, '中文压缩包(含空格).zip');
  const src7z = path.join(BASE, '资源包-甲.7z');
  const rz = spawnSync(SZ, ['a', '-tzip', srcZip, path.join(work, '中文目录')], { cwd: work, encoding: 'utf8' });
  const r7 = spawnSync(SZ, ['a', '-t7z', src7z, path.join(work, '中文目录')], { cwd: work, encoding: 'utf8' });
  console.log(`[cjk] 语料 zip exit=${rz.status} 存在=${fs.existsSync(srcZip)} | 7z exit=${r7.status} 存在=${fs.existsSync(src7z)}`);

  /* ================= ① auto：整条输出路径转全 ASCII ================= */
  console.log('\n=== ① nonAsciiPolicy=auto：中文输出目录 + 中文包名 ===');
  await setS({ passwords: [], nonAsciiPolicy: 'auto', sourcePolicy: 'keep', extractToSubfolder: false, overwrite: 'rename' });
  const zhOut = path.join(BASE, '中文输出目录');
  const r1 = await extract(src7z, zhOut, '中文包名 + auto');
  ok(r1.status === 'done', `中文路径包解压成功（实际 ${r1.status}${r1.err ? ' — ' + r1.err : ''}）`);
  const badSeg = r1.output ? firstNonAsciiSegment(r1.output) : '(无输出路径)';
  ok(!!r1.output && badSeg === null, `① 输出路径整条为纯 ASCII（首个非 ASCII 段=${badSeg ?? '无'}）实际=${r1.output}`);
  if (r1.output) {
    const names = fs.existsSync(r1.output) ? fs.readdirSync(r1.output) : [];
    ok(names.length > 0 && names.every(asciiOnly), `① 产物文件名全部纯 ASCII（${names.join(', ')}）`);
  } else {
    ok(false, '① 产物文件名全部纯 ASCII（无输出目录）');
  }

  /* ================= ② delete：源包必须消失 ================= */
  console.log('\n=== ② sourcePolicy=delete：源包应被删除（不可恢复） ===');
  await setS({ sourcePolicy: 'delete', nonAsciiPolicy: 'off' });
  const dDel = path.join(BASE, '三态-delete');
  fs.rmSync(dDel, { recursive: true, force: true });
  fs.mkdirSync(dDel, { recursive: true });
  const srcDel = path.join(dDel, '资源包-甲.7z');
  fs.copyFileSync(src7z, srcDel);
  const r2 = await extract(srcDel, path.join(dDel, 'out'), 'sourcePolicy=delete');
  ok(r2.status === 'done', `② delete 用例解压成功（实际 ${r2.status}）`);
  ok(!fs.existsSync(srcDel), `② sourcePolicy='delete'：源包已被删除（原路径不存在）`);

  /* ================= ③ keep：源包必须存在且字节不变 ================= */
  console.log('\n=== ③ sourcePolicy=keep：源包应保留且哈希不变 ===');
  await setS({ sourcePolicy: 'keep', nonAsciiPolicy: 'off' });
  const dKeep = path.join(BASE, '三态-keep');
  fs.rmSync(dKeep, { recursive: true, force: true });
  fs.mkdirSync(dKeep, { recursive: true });
  const srcKeep = path.join(dKeep, '资源包-甲.7z');
  fs.copyFileSync(src7z, srcKeep);
  const h0 = sha(srcKeep);
  const r3 = await extract(srcKeep, path.join(dKeep, 'out'), 'sourcePolicy=keep');
  ok(r3.status === 'done', `③ keep 用例解压成功（实际 ${r3.status}）`);
  ok(fs.existsSync(srcKeep), `③ sourcePolicy='keep'：源包仍然存在`);
  ok(fs.existsSync(srcKeep) && sha(srcKeep) === h0, `③ sourcePolicy='keep'：源包字节哈希不变（sha=${h0.slice(0, 12)}…）`);

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  try {
    fs.appendFileSync(REPORT, '\n[探针异常] ' + ((err && err.stack) || String(err)) + '\n');
  } catch {}
  app.exit(2);
});
