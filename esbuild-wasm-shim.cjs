/**
 * esbuild-wasm-shim.cjs —— 把 `require('esbuild')` 重定向到 esbuild-wasm
 *
 * 沙箱无法运行 esbuild 原生二进制（winmm.dll not found），本 shim 用
 * esbuild-wasm 的浏览器版实现提供等价 API，供 Vite 调用。
 * 由 build-with-wasm.mjs 通过 Module._resolveFilename 劫持注入。
 */
const fs = require('node:fs');
const path = require('node:path');

globalThis.self = globalThis;
const wasm = require('esbuild-wasm/esm/browser.js');

const wasmPath = path.join(__dirname, 'node_modules/esbuild-wasm/esbuild.wasm');
let ready = null;
function ensure() {
  if (!ready) {
    ready = wasm.initialize({
      wasmModule: new WebAssembly.Module(fs.readFileSync(wasmPath)),
      worker: false
    });
  }
  return ready;
}

/** Vite 会同步调用 transform；wasm 版只能异步，故用 Atomics.wait 做同步等待 */
function syncify(promise) {
  let done = false, result, error;
  promise.then(
    (r) => { result = r; done = true; },
    (e) => { error = e; done = true; }
  );
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (!done) Atomics.wait(sab, 0, 0, 5);
  if (error) throw error;
  return result;
}

const api = {
  version: wasm.version,
  transform: (input, options) => ensure().then(() => wasm.transform(input, options)),
  transformSync: (input, options) => syncify(api.transform(input, options)),
  build: (options) => ensure().then(() => wasm.build(options)),
  buildSync: (options) => syncify(api.build(options)),
  formatMessages: (msgs, options) => ensure().then(() => wasm.formatMessages(msgs, options)),
  formatMessagesSync: (msgs, options) => syncify(api.formatMessages(msgs, options)),
  initialize: (o) => wasm.initialize(o),
  stop: () => wasm.stop(),
  context: (o) => ensure().then(() => wasm.context(o)),
  analyzeMetafile: () => { throw new Error('analyzeMetafile 未在 wasm shim 中实现'); },
  analyzeMetafileSync: () => { throw new Error('analyzeMetafileSync 未在 wasm shim 中实现'); }
};

module.exports = api;
module.exports.default = api;
