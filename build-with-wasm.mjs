/**
 * build-with-wasm.mjs —— 沙箱环境下的等价构建脚本（v2）
 *
 * 背景：本机沙箱无法运行任何 Go 原生二进制（esbuild.exe 报 winmm.dll not found），
 * 因此 `npm run build`（electron-vite → esbuild 原生）必然失败。
 * 本脚本用 **esbuild-wasm** 替换原生 esbuild，产出与标准构建等价的 out/ 三端产物。
 *
 * ── v2 修复（2026-10-09）────────────────────────────────────────────────────
 * v1 存在两个致命缺陷，导致打包后**白屏**（窗口能开、内容全白）：
 *   ① 渲染进程把裸包名（react / react-dom / zustand / lucide-react）一律标记为
 *      external，产出 index.js 里保留 `import ... from "react"` 等**裸模块导入**；
 *   ② index.html 用 `<script type="module">` 加载 index.js。
 * 在 `file://` 协议下，<script type="module"> 会被 Chromium 的 CORS 直接拦截
 * （"Cross origin requests are only supported for protocol schemes: ..."），
 * 即便能加载，浏览器也无 node_modules 解析能力，裸导入必然失败 → 入口脚本整体
 * 不执行 → React 从不挂载 → 白屏。
 *
 * v2 对策：
 *   ① 改用 esbuild-wasm 的 **Node 入口**（lib/main.js，可访问 fs，能自动解析
 *      node_modules），渲染进程**不再 external 任何依赖**，全部 bundle 进单文件；
 *   ② 渲染进程输出 **iife** 格式，index.html 改用**普通 <script>** 加载
 *      —— 经典脚本在 file:// 下不受 module 的 CORS 限制；
 *   ③ define 掉 `import.meta.env`（iife 里 `import.meta` 是语法错误，
 *      且 zustand 等库内部会读取它）。
 * 注意：Node 版 esbuild-wasm 会 spawn 一个 `node` 子进程承载服务，故需保证 PATH
 * 中存在 node（脚本第 0 步已自动注入当前 node 所在目录）。
 *
 * 产出：
 *   out/main/index.js       主进程（CJS，外部化 node 内置与 electron）
 *   out/preload/index.js    preload（CJS）
 *   out/renderer/index.html + index.js + index.css   渲染进程（React，单文件自包含）
 *
 * 用法：node build-with-wasm.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const outDir = path.join(root, 'out');

/* ---------- 0) 保证 spawn('node') 可用 ---------- */
process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');

/* ---------- 1) 初始化 esbuild-wasm 的 Node 入口 ---------- */
const esbuild = require('esbuild-wasm');
await esbuild.initialize({});
console.log('[build] esbuild-wasm(Node) v' + esbuild.version + ' 已就绪');

const toPosix = (p) => p.replace(/\\/g, '/');

const NODE_BUILTINS = [
  'node:events', 'node:fs', 'node:path', 'node:os', 'node:url',
  'node:child_process', 'node:crypto', 'node:stream', 'node:util',
  'node:buffer', 'node:process', 'node:worker_threads', 'node:net',
  'node:http', 'node:https', 'node:zlib', 'node:readline', 'node:timers',
  'electron'
];

const ALIAS = {
  '@shared': toPosix(path.join(root, 'src/shared')),
  '@': toPosix(path.join(root, 'src/renderer/src'))
};

function assertOk(r) {
  if (r.errors && r.errors.length) {
    throw new Error(r.errors.map((e) => e.text || JSON.stringify(e)).join('\n'));
  }
  return r;
}

/* ---------- 2) 主进程 / preload：CJS + 外部化 node 内置与 electron ---------- */
async function bundleNode(entry, outfile) {
  const r = assertOk(await esbuild.build({
    absWorkingDir: root,
    entryPoints: [toPosix(path.join(root, entry))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    external: NODE_BUILTINS,
    alias: ALIAS,
    logLevel: 'warning'
  }));
  const dest = path.join(outDir, outfile);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.outputFiles[0].text);
}

/* ---------- 3) 渲染进程：依赖全量 bundle + iife 输出 ---------- */
const cssEmptyPlugin = {
  name: 'css-empty',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: 'empty-css' }));
    b.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'js' }));
  }
};

async function bundleRenderer() {
  const rendererOut = path.join(outDir, 'renderer');

  // 3.1 JS：React + zustand + lucide-react 全部打进单文件，iife 格式
  const js = assertOk(await esbuild.build({
    absWorkingDir: root,
    entryPoints: [toPosix(path.join(root, 'src/renderer/src/main.tsx'))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    write: false,
    jsx: 'automatic',
    minify: true,
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': '"production"',
      'import.meta.env.BASE_URL': '"./"',
      'import.meta.env': '{"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"./"}'
    },
    loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl' },
    alias: ALIAS,
    plugins: [cssEmptyPlugin],
    logLevel: 'warning'
  }));
  fs.writeFileSync(path.join(rendererOut, 'index.js'), js.outputFiles[0].text);

  // 3.2 CSS：Tailwind + 自研 global.css（PostCSS 走 Node 版）
  const tailwind = require('tailwindcss');
  const autoprefixer = require('autoprefixer');
  const postcss = require('postcss');
  const inputCss = path.join(root, 'src/renderer/src/styles/global.css');
  const raw = fs.readFileSync(inputCss, 'utf8');
  const processed = await postcss([
    tailwind({ config: path.join(root, 'tailwind.config.js') }),
    autoprefixer()
  ]).process(raw, { from: inputCss, to: path.join(rendererOut, 'index.css') });
  fs.writeFileSync(path.join(rendererOut, 'index.css'), processed.css);

  // 3.3 index.html：移除 Vite 占位脚本，注入静态 css/js（普通脚本，非 module）
  const htmlTemplate = path.join(root, 'src/renderer/index.html');
  let html = fs.readFileSync(htmlTemplate, 'utf8');
  html = html
    .replace(/<script type="module"[^>]*src="[^"]*main\.tsx"[^>]*><\/script>/g, '')
    .replace(/<script[^>]*src="\.\/src\/main\.tsx"[^>]*><\/script>/g, '');
  if (!/index\.css/.test(html)) {
    html = html.replace('</head>', '  <link rel="stylesheet" href="./index.css">\n  </head>');
  }
  if (!/index\.js/.test(html)) {
    // 关键：普通脚本（非 module）—— file:// 下不会被 CORS 拦截
    html = html.replace('</body>', '  <script src="./index.js"></script>\n  </body>');
  }
  fs.writeFileSync(path.join(rendererOut, 'index.html'), html);
}

/* ---------- 4) 组装 ---------- */
try {
  fs.rmSync(outDir, { recursive: true, force: true });
} catch (e) {
  console.warn('[build] 清理 out/ 失败（沙箱句柄占用），继续：', e.message);
}
fs.mkdirSync(path.join(outDir, 'main'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'preload'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'renderer'), { recursive: true });

console.log('[build] 打包主进程 → out/main/index.js');
await bundleNode('src/main/index.ts', 'main/index.js');
console.log('[build] 打包 preload → out/preload/index.js');
await bundleNode('src/preload/index.ts', 'preload/index.js');
console.log('[build] 打包渲染进程 → out/renderer/');
await bundleRenderer();

console.log('\n[build] 完成。产物：');
for (const f of ['main/index.js', 'preload/index.js', 'renderer/index.html', 'renderer/index.js', 'renderer/index.css']) {
  const p = path.join(outDir, f);
  console.log('  ' + f.padEnd(24) + (fs.existsSync(p) ? fs.statSync(p).size + ' B' : '(缺失)'));
}
