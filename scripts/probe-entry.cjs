/**
 * Electron 入口：真实主进程 + UI 验证探针（开发期用）
 *
 * 为什么要拆成两个文件：
 *   Electron 只在加载【入口文件】时引导内置模块（app 等）。如果入口文件在顶层
 *   就 require('electron') 并用不到 app，会得到 undefined。所以入口必须先加载
 *   真实主进程，再按需挂载探针。
 *
 * 用法： node_modules\electron\dist\electron.exe scripts/probe-entry.cjs [light|dark]
 */
const path = require('node:path');

// 1) 真实主进程（注册 whenReady / IPC / 创建窗口）
require(path.join(__dirname, '..', 'out', 'main', 'index.js'));

// 2) 探针：仅在传入 --probe 时启用
if (process.argv.includes('--scan')) {
  require('./verify-scan-dedup.cjs');
}

if (process.argv.includes('--wizard')) {
  require('./verify-wizard.cjs');
}

if (process.argv.includes('--cjk')) {
  require('./verify-cjk.cjs');
}

if (process.argv.includes('--wf')) {
  require('./verify-workflow.cjs');
}

if (process.argv.includes('--probe')) {
  require('./verify-ui.cjs');
}
