# 构建与运行说明（v2.0.1）

> 本文件随源码包提供。环境要求见同目录 `DEPENDENCIES.md`。

---

## 1. 一次性准备

```bash
# 安装依赖（首次约需下载 500 MB，含 Electron 二进制）
npm install

# 严格按锁文件还原（推荐用于复现构建）
npm ci
```

---

## 2. 开发调试（热更新）

```bash
npm run dev
```

启动后主进程 / preload / 渲染进程均支持热更新；修改 `src/main/**` 会自动重启主进程。

---

## 3. 类型检查

```bash
npm run typecheck
# 等价于：tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
```

> 提交前建议必跑 —— 本项目无 ESLint 配置，类型检查是主要的静态防线。

---

## 4. 构建（产出 `out/`）

```bash
npm run build
```

产出三端 bundle：

| 产物 | 路径 | 说明 |
|------|------|------|
| 主进程 | `out/main/index.js` | 入口（`package.json` → `main`） |
| preload | `out/preload/index.js` | contextBridge 白名单桥 |
| 渲染进程 | `out/renderer/index.html` + `assets/` | React 应用 |

---

## 5. 打包 Windows 可执行产物

```bash
npm run dist             # NSIS 安装包 + 便携版
npm run dist:portable    # 仅便携版
```

或使用项目提供的脚本（含 Node 检查、依赖安装、构建、打包四步）：

```bash
scripts\build.bat
# 或
pwsh -File scripts\build-release.ps1
```

### 5.1 无 Go 运行环境时的等价构建（esbuild-wasm 路径）

某些受限环境（如无 GUI 的 Windows 沙箱）**无法运行任何 Go 原生二进制**：
`esbuild.exe` 与 electron-builder 的 `app-builder.exe` 都会报
`winmm.dll not found`，导致 `npm run build` / `npm run dist` 直接失败。

此时可用本仓库内置的**等价构建脚本**（WebAssembly 版 esbuild + `@electron/asar`）：

```bash
# ① 构建 out/ 三端产物（esbuild-wasm 驱动，产出与 npm run build 一致）
node build-with-wasm.mjs

# ② 生成 app.asar + 组装「绿色版目录」
node package-green.mjs <绿色版目标目录>
#   例：node package-green.mjs ../sz333-unpack-2.0.1-dist
```

| 环节 | 标准方式 | 等价方式 |
|------|----------|----------|
| 构建 `out/` | `electron-vite build`（原生 esbuild） | `build-with-wasm.mjs`（**esbuild-wasm**） |
| 打包 `app.asar` | electron-builder（`app-builder.exe`） | `package-green.mjs`（**@electron/asar**） |
| 生成可执行 | NSIS / portable 单 exe | 绿色版目录 + **NSIS 直编便携版**（见 §5.2） |

> 产物运行效果一致：解压后双击 `bin/sz333 解压工具.exe` 即可使用。

> ⚠️ **渲染进程构建的两个关键点（2026-10-09 修复，否则打包后界面白屏）**：
> 1. 渲染进程的依赖（`react` / `react-dom` / `zustand` / `lucide-react`）**必须
>    bundle 进 `index.js`，不能 external** —— 渲染进程运行在 `file://` 下，没有
>    node_modules 解析能力，保留 `import ... from "react"` 之类裸导入会导致入口
>    脚本整体失败。为此 `build-with-wasm.mjs` 使用 **esbuild-wasm 的 Node 入口**
>    （`require('esbuild-wasm')`，可访问 fs、自动解析 node_modules），而非浏览器版。
> 2. 渲染进程输出 **iife** 格式、`index.html` 用**普通 `<script>`** 加载 ——
>    `file://` 下 `<script type="module">` 会被 Chromium 的 CORS 直接拦截
>    （`origin 'null'`），React 无法挂载。同时需 `define` 掉 `import.meta.env`
>    （iife 里 `import.meta` 是语法错误，zustand 等库会读取它）。
>
> 完整根因与验证见交付包 `VERSION-2.0.1.md` §5。

### 5.2 无 Go 环境时的单文件便携版（NSIS 直编路径）

`electron-builder --win portable` 依赖 Go 编写的 `app-builder.exe`，在受限环境同样跑不起来。
但 **NSIS 编译器 `makensis.exe` 是 C++ 程序，可正常运行**，因此可直接编译等价产物。

前提：本机已有 NSIS 工具链 —— electron-builder 首次打包时会把它缓存到
`%LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-3.0.4.1\Bin\makensis.exe`。

构建步骤（脚本位于交付目录 `release-2.0.1/tools/`）：

```bash
# ① 准备精简运行时（过滤式复制，不做删除；locales 仅留 zh-CN/zh-TW/en-US）
python tools/prepare-staging.py

# ② 生成应用图标（多尺寸 .ico：256/128/64/48/32/24/16）
python tools/make-icon.py

# ③ 生成 portable.nsi 并调用 makensis 编译
python tools/make-portable.py
```

产物：`packages/sz333 解压工具-2.0.1-便携版.exe`（约 70.5 MB，LZMA 压缩率约 31%）。

**便携版行为**：双击 → 释放运行时到 `%TEMP%\nsXXXX.tmp` → 启动主程序 →
等待主程序退出 → NSIS 退出并自动清理临时目录。
这与 electron-builder 官方 portable target 行为一致
（Electron 应用的「单文件便携版」本质都是自解压 —— 运行时无法塞进单个 exe）。

> 如需**带安装向导的 NSIS 安装包**，仍需在能运行 Go 二进制的机器上按 `npm run dist` 重建。

### 产物位置与命名

| 产物 | 路径 | 命名规则 |
|------|------|----------|
| NSIS 安装包 | `release/<产品名>-<版本>-x64-setup.exe` | `artifactName: ${productName}-${version}-${arch}-${env.BUILD_KIND}.exe` |
| 便携版 | `release/<产品名>-<版本>-便携版.exe` | `portable.artifactName` |
| 解包目录 | `release/win-unpacked/` | 未压缩的完整目录（调试用） |

> ⚠️ **NSIS / portable 产物非字节可重现**：同一份源码多次构建，体积会在数十字节内浮动。
> 判断"包是否包含某次修复"请用 `out/**` 的逐文件哈希，而不是 exe 的体积或哈希。

---

## 6. 目录结构

```
sz333-unpack-desktop/
├─ src/
│  ├─ main/                    # 主进程（文件系统 / 解压调度 / 持久化）
│  │  ├─ index.ts              # 窗口、菜单、IPC 注册、设置与历史持久化
│  │  ├─ engine.ts             # 7-Zip 封装：定位、魔数识别、分卷归组、列表解析、错误归类
│  │  ├─ tasks.ts              # 任务队列：并发闸门、输出目录锁、递归解压主循环
│  │  ├─ recursive.ts          # 递归层选择（魔数优先 + 工作流链路）、中间包清理
│  │  ├─ workflows.ts          # 密码锚点工作流：指纹 / 评分 / 自愈 / 持久化
│  │  ├─ workflowPack.ts       # 工作流卡片批量导出 / 导入
│  │  ├─ dedup.ts              # 重复包判定（名称归一 + 逐分卷体积指纹，不读内容）
│  │  ├─ asciiName.ts          # 中文名 → ASCII（UTF-8 十六进制转写，可逆）
│  │  ├─ asciiPath.ts          # 路径策略：逐段 ASCII 化 + 长度预算
│  │  └─ apkFilter.ts          # APK 过滤（剔除 / 整包判定）
│  ├─ preload/index.ts         # 安全桥（contextBridge 白名单）
│  ├─ renderer/                # 渲染进程（纯 UI）
│  │  ├─ index.html
│  │  └─ src/{App.tsx,store.ts,components/,lib/,styles/}
│  └─ shared/types.ts          # 三端共享类型 + IPC 频道常量
├─ resources/                  # 内嵌 7z.exe + 7z.dll（必须同目录）
├─ scripts/                    # 构建 / 验证 / 语料生成脚本
├─ test-corpus/                # 测试语料（由 make-test-corpus.ps1 生成）
├─ DEPENDENCIES.md             # 依赖清单
├─ BUILD.md                    # 本文件
├─ README.md                   # 项目说明
├─ electron.vite.config.ts     # 三端构建配置
├─ electron-builder.config.js  # 打包配置
├─ build-with-wasm.mjs         # 无 Go 环境下的等价构建（esbuild-wasm）
├─ package-green.mjs           # 绿色版打包（@electron/asar）
└─ package.json
```

---

## 7. 验证脚本（无需启动 GUI）

```powershell
# 解析层 A/B 回归（直读 src/main/engine.ts 的真实实现）
node scripts\verify-listing.mjs

# 补丁自检（括号配平 + 关键改动断言；无 node_modules 时的替代体检）
node scripts\verify-patch.mjs

# 重新生成测试语料（14 个用例）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-test-corpus.ps1
```

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| `npm install` 卡在 Electron 下载 | 网络受限 | 设置镜像：`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/` |
| 打包后启动报"7-Zip 引擎不可用" | `resources/7z.exe` 未随包分发 | 检查 `electron-builder.config.js` 的 `extraResources` |
| 从项目目录直接运行 `7z.exe` 报 `Codec Load Error` | 无法从该目录加载同目录 `7z.dll` | 把 `7z.exe` + `7z.dll` 一起复制到可访问目录再调用 |
| `npm run typecheck` 报错但应用能跑 | 类型层面问题 | 必须修 —— 无 ESLint，类型检查是主要防线 |
| exe 元数据是原始 Electron | `signAndEditExecutable: false` 的代价 | 已知限制，见发布说明 |

---

## 9. 版本对应

源码包版本 **2.0.1** ↔ 交付包版本 **2.0.1**（详见交付包 `VERSION-2.0.1.md`）。
