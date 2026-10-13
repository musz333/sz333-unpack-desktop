/**
 * Electron 入口：真实主进程 + UI 验证探针（开发期用）
 *
 * 为什么要拆成两个文件：
 *   Electron 只在加载【入口文件】时引导内置模块（app 等）。如果入口文件在顶层
 *   就 require('electron') 并用不到 app，会得到 undefined。所以入口必须先加载
 *   真实主进程，再按需挂载探针。
 *
 * ⚠️ 审计里"最危险"的一条：以前这里**写死**加载 `../out/main/index.js`（开发构建），
 *    失效模式是"所有套件全绿，但用户跑的是旧版/别的产物"。现在改为按优先级解析：
 *      ① process.resourcesPath/app.asar/out/main/index.js  → 真·打包态（用户跑的字节）
 *      ② process.resourcesPath/app/out/main/index.js       → 解包台架
 *      ③ __dirname/../out/main/index.js                    → 开发构建（打印醒目警告）
 *    并**打印实际加载的路径**，让"跑的是哪份产物"永远可见。
 *
 * 用法： node_modules\electron\dist\electron.exe scripts/probe-entry.cjs [light|dark|--scan|--cjk|...]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/** 把"实际加载了哪份产物"同时写到 stdout 与文件（GUI 程序 stdout 常捕获不到） */
function announce(lines) {
  const text = lines.join('\n') + '\n';
  try {
    process.stdout.write(text);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'sz333-probe-entry.txt'), text);
  } catch {
    /* ignore */
  }
}

/** 按优先级选出要加载的主进程入口文件 */
function resolveMainEntry() {
  const res = process.resourcesPath || '';
  const candidates = [
    { p: res && path.join(res, 'app.asar', 'out', 'main', 'index.js'), kind: '打包态 (app.asar，用户实际产物)' },
    { p: res && path.join(res, 'app', 'out', 'main', 'index.js'), kind: '解包台架 (resources/app)' },
    { p: path.join(__dirname, '..', 'out', 'main', 'index.js'), kind: '开发构建 (dev out/)' }
  ];
  for (const c of candidates) {
    try {
      if (c.p && fs.existsSync(c.p)) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[candidates.length - 1];
}

const chosen = resolveMainEntry();

/* 说明：探针入口本身不应显式 require('electron') 之外的 Electron 模块，
 * 这里只负责加载真实主进程与套件；app 的引导由被加载的真实主进程完成。 */
/*
 * 例外：本机/CI 无 GPU 时 Chromium 会 FATAL。若已通过 cli 传了 --disable-gpu 等开关
 * 则无需在此处理；如需在此处兜底，可在最前面 require('electron').app.disableHardwareAcceleration()。
 * 这里保持最小干预：仅打印，不改产品行为。
 */

announce([
  '============================================================',
  '[probe-entry] 实际加载主进程：' + chosen.p,
  '[probe-entry] 来源类型：' + chosen.kind,
  '[probe-entry] resourcesPath=' + (process.resourcesPath || '(空)')
]);
if (chosen.kind.startsWith('开发构建')) {
  announce([
    '*** 警告：正在加载【开发构建 out/】，不是用户实际运行的打包产物 app.asar！***',
    '*** 本套件结果不能代表交付产物；请在有 app.asar 的打包态运行。***'
  ]);
}
announce(['============================================================']);

// 1) 真实主进程（注册 whenReady / IPC / 创建窗口）
require(chosen.p);

// 2) 探针：仅在传入参数时启用
const argv = process.argv.slice(1);
const has = (f) => argv.includes(f);

if (has('--scan')) {
  require('./verify-scan-dedup.cjs');
}

if (has('--wizard')) {
  require('./verify-wizard.cjs');
}

if (has('--cjk')) {
  require('./verify-cjk.cjs');
}

if (has('--wf')) {
  require('./verify-workflow.cjs');
}

if (has('--layers')) {
  require('./verify-layers.cjs');
}

if (has('--probe')) {
  require('./verify-ui.cjs');
}
