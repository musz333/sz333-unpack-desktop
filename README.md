# sz333 解压工具（桌面版）

Windows 桌面解压工具：分卷合并 · 多层嵌套 · 加密包 · **密码锚点工作流** · 任务队列 · 历史记录。
**Electron + React + Vite + Tailwind CSS**，产物为 `.exe`（NSIS 安装包 + 便携版）。

![tech](https://img.shields.io/badge/Electron-31-2b2b2b) ![tech](https://img.shields.io/badge/React-18-2b2b2b) ![tech](https://img.shields.io/badge/Vite-5-2b2b2b) ![tech](https://img.shields.io/badge/Tailwind-3-2b2b2b)

---

## 快速开始

```bash
# 1) 安装依赖（会下载 Electron 二进制，约 100MB，需要网络）
npm install

# 2) 开发调试（热更新）
npm run dev

# 3) 构建产物（out/）
npm run build

# 4) 打包 Windows exe → release/
npm run dist              # NSIS 安装包 + portable 便携版
npm run dist:portable     # 只出便携版（体积更小、不写注册表）
```

打包完成后在 `release/` 目录得到：

| 文件 | 说明 |
| --- | --- |
| `sz333 解压工具-1.0.0-x64-nsis.exe` | NSIS 安装包（可选安装目录、创建快捷方式） |
| `sz333 解压工具-1.0.0-便携版.exe` | 免安装便携版，双击即用 |

> 如需真正的双击即用构建脚本，直接运行 `scripts/build.bat`（内含 Node 检查、依赖安装、构建、打包四步）。

---

## 项目结构

```
sz333-unpack-desktop/
├─ src/
│  ├─ main/                      # 主进程：文件系统 / 解压 / 压缩（Node 侧）
│  │  ├─ index.ts                # 窗口、菜单、IPC 注册、设置与历史持久化
│  │  ├─ engine.ts               # 7-Zip 封装：定位引擎、魔数识别、分卷归组、列表解析、进度解析、错误归类
│  │  ├─ tasks.ts                # 任务队列：并发闸门、暂停/恢复/取消/重试、实时进度、**工作流匹配与命中统计**
│  │  ├─ workflows.ts            # **工作流引擎**：锚点匹配评分 / 指纹 / 自愈 / 持久化（移植自 v1.9）
│  │  └─ workflowPack.ts         # **卡片包**：批量导出 / 导入预览 / 冲突策略
│  ├─ preload/index.ts           # 安全桥（contextBridge）：只暴露白名单方法
│  ├─ renderer/                  # 渲染进程：纯 UI
│  │  ├─ index.html              # 含 CSP，禁止远程脚本
│  │  └─ src/
│  │     ├─ App.tsx              # 布局装配（顶栏 / 侧栏 / 主区 / 详情 / 浮层）
│  │     ├─ store.ts             # zustand 状态（视图、资源包、任务、设置、Toast）
│  │     ├─ components/          # 组件
│  │     │  ├─ Icon.tsx          # 唯一图标源（Lucide，stroke 1.5）
│  │     │  ├─ ui.tsx            # Button / IconButton / Switch / Chip / Progress / EmptyState
│  │     │  ├─ TopBar.tsx        # 产品名 + 导航 + 主题 + 窗口按钮
│  │     │  ├─ Sidebar.tsx       # 任务队列 + 压缩参数
│  │     │  ├─ Workspace.tsx     # 拖拽区 ↔ 资源列表（原位切换）
│  │     │  ├─ ArchiveDetail.tsx # 压缩包元数据 + 文件预览 + 筛选
│  │     │  ├─ QueuePanel.tsx    # 任务卡（进度 / 暂停 / 取消 / 重试）
│  │     │  ├─ CompressView.tsx  # 压缩：选内容 → 参数 → 入队
│  │     │  ├─ HistoryView.tsx   # 历史记录 + 搜索 + 一键清空
│  │     │  └─ Dialogs.tsx       # 设置 / 密码输入 / Toast
│  │     ├─ lib/format.ts        # 体积、时间、路径、压缩率格式化
│  │     └─ styles/global.css    # 设计令牌（CSS 变量）+ Tailwind 层
│  └─ shared/types.ts            # 三端共享类型与 IPC 频道常量
├─ resources/7z.exe, 7z.dll      # 内嵌 7-Zip 引擎（x64）
├─ build/icon.ico                # 应用图标
├─ scripts/build.bat             # 一键打包脚本
├─ electron.vite.config.ts       # 主/预加载/渲染三端构建配置
├─ electron-builder.config.js    # 打包配置（NSIS + portable）
├─ tailwind.config.js            # 设计令牌映射（8pt 网格、字号、圆角、阴影）
└─ tsconfig*.json
```

---

## 架构与安全

- **主进程**负责一切系统能力：文件读写、调用 `7z.exe`、托盘通知、回收站删除、设置与历史落盘。
- **渲染进程**只做 UI，通过 `window.api.*` 调用；不含 Node 能力。
- **preload** 用 `contextBridge` 暴露**白名单方法**，不透传 `ipcRenderer`。
- 窗口强制 `contextIsolation: true`、`nodeIntegration: false`；`index.html` 带 CSP，禁止外部脚本。
- 拖拽取路径使用 `webUtils.getPathForFile()`（Electron 高版本已移除 `File.path`）。

### 7-Zip 引擎

`resources/7z.exe` 经 `extraResources` 放在 **asar 之外**，因此可被 `spawn` 直接调用（asar 内的可执行文件无法运行）。
定位顺序：`process.resourcesPath/7z.exe` → 项目 `resources/` → 系统安装的 7-Zip。

支持格式：**zip / 7z / rar / tar / gz / bz2 / xz 解压**；**zip / 7z / tar 压缩**（7-Zip 不提供 RAR 压缩，界面已注明）。

---

## 功能清单

> 说明：本工具**只做解压**，不含压缩打包功能（按需求确认移除）。

| 能力 | 说明 |
| --- | --- |
| 拖拽添加 | 拖到窗口任意位置即可；分卷（`.part1` / `.001` / `.z01` / `.r00`）自动归为一组 |
| 魔数识别 | 不信任扩展名，按文件头判断真实格式（伪装成 `.JPG` 的包也能识别） |
| 压缩包详情 | 格式、文件数、解压后大小、压缩率、是否加密、分卷数 |
| 文件预览 | 解析 `7z l -slt` 输出，支持关键字筛选、仅文件/含目录切换 |
| 任务队列 | 多任务、并发 1/2/4、实时进度（解析 `7z -bsp1` 输出）、当前处理文件 |
| 暂停 / 取消 / 重试 | 取消立即终止 7z 进程并清理未完成输出；暂停后可恢复（Windows 无法挂起外部进程，恢复会重新开始，UI 已注明） |
| 加密包 | 自动探测加密 → 弹出密码输入 → 用新密码重试；可记住常用密码自动尝试 |
| 覆盖策略 | 自动改名（默认）/ 覆盖 / 跳过，映射为 7-Zip 的 `-aou/-aoa/-aos` |
| 压缩 | 7z / zip / tar，级别 5/7/9，可选密码（7Z 同时加密文件名） |
| **中文路径转英文** | 老资源包（GBK 时代打包、老式编码）解压到中文路径常会乱码/失败。可选「自动 / 始终 / 关闭」：开启时中文目录名与包内中文文件名会被替换为 ASCII 名，并逐条写入任务日志（原名 → 新名）便于对照 |
| **源文件处理** | 两态：保留原始文件 / **彻底删除（默认）**。大体积资源进回收站会白占空间，故不提供回收站方案；处理失败或取消的分组永不删源文件 |
| **首次使用引导** | 首次启动自动弹出 4 步引导（源文件处理 / 中文路径 / 输出目录 / 并发数），每步写明「以后在设置哪一项改」；设置页底部有【重新查看首次运行引导】常驻入口 |
| **工作流卡片** |  **以「该来源第一层命中的解压密码」为锚点记住整条解压链路**；同源包直接按链路解压，跳过探测与密码试错。卡片显示状态 / 锚点密码 / 链路 / 指纹 / 战绩（命中·连续失败·最近使用），支持卡片与列表视图切换 |
| **批量导出 / 导入** | 卡片可批量导出为 JSON 卡片包，导入时先出预览清单（新增 / 同锚点冲突 / 低置信 / 无锚点跳过）并逐条勾选；冲突默认保留本地，可选"用导入覆盖"（只换链路、保留本地战绩）。支持 v1.9（WinForms 版）导出的卡片包 |
| 历史记录 | 落盘保存，可搜索、一键清空、直接打开输出位置 |
| 设置 | 默认输出目录、主题（跟随系统/浅色/深色）、并发数、删除源文件（移入回收站）、通知、记住密码 |
| 快捷键 | `Ctrl+O` 添加压缩包；菜单内提供缩放、全屏、开发者工具等标准项 |

---

## 设计规范（实现约定）

- **色彩**：中性灰阶为骨架，**唯一强调色**为品牌青绿（浅色 `#0d9488` / 深色 `#2dd4bf`），语义色仅用于成功 / 警告 / 错误。
- **主题**：全部通过 CSS 变量切换（`src/renderer/src/styles/global.css`），浅色深色零重复样式。
- **网格**：8pt 间距；字号严格 **12 / 14 / 16 / 20 / 28**；圆角卡片 10px、按钮 8px、面板 12px。
- **图标**：**唯一来源 Lucide**，统一 `stroke-width: 1.5`，尺寸 16 / 20 / 24；**全站零 Emoji**。
- **阴影**：仅设置弹窗与 Toast 使用，且极淡（`shadow-pop` / `shadow-toast`）；其余层级全部由 1px 低对比边框建立。
- **状态**：默认 / 悬停 / 按下 / 禁用 / 加载 / 成功 / 失败 均有明确视觉反馈；进度条按语义变色。
- **动效**：150–240ms 缓出，仅用于列表出现、弹窗、Toast、进度；**遵守 `prefers-reduced-motion`**（全局降级为 0.001ms）。
- **响应式**：360px–2560px。≥1180px 三栏（侧栏 + 主区 + 详情）；<1180px 隐藏详情；<900px 收起导航文字与侧栏并改为抽屉，核心解压流程始终可用。
- **可访问性**：语义标签（`header/nav/aside/section/dl`）、`aria-current` / `aria-checked` / `aria-modal` / `aria-live`、全部图标按钮带 `aria-label`、可见焦点环、键盘可达（Tab / Enter / 空格）、对比度满足 WCAG AA。

---

## 常见问题

**打包报错找不到 7z.exe？** 确认 `resources/7z.exe` 存在（仓库已包含）。若缺失，可从 <https://www.7-zip.org/> 下载 7-Zip x64 后提取 `7z.exe`/`7z.dll` 放入该目录。

**首次打包很慢？** `npm install` 需下载 Electron 二进制（约 100MB）；`npm run dist` 还会下载 NSIS 工具链，均只需一次。

**打包卡在 `winCodeSign` 解压失败（无法创建符号链接）？**
electron-builder 的 `winCodeSign` 工具链里含 macOS 用的符号链接（`darwin/*.dylib`），
非管理员账户且未开启开发者模式时无法创建符号链接，导致解压失败。
用仓库自带的免签名配置绕开该步骤：

```bash
npx electron-builder --win nsis portable --config electron-builder.nosign.config.js
```

代价是生成的 exe 使用 Electron 默认图标与版本信息。想要完整图标/版本信息，
请在**开启 Windows 开发者模式**（设置 → 系统 → 开发者选项）或管理员终端中执行 `npm run dist`。

**网络受限（GitHub 下载超时）？**

```powershell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npm run dist
```

**杀毒软件误报？** 未签名的 Electron 打包产物常见误报，属误判；正式分发建议购买代码签名证书。

**只想出便携版？** `npm run dist:portable`。

---

## 开发期验证工具

仓库内附两个探针脚本，用于在无人值守环境下验证 UI 与引擎链路：

```powershell
# 走真实主进程 + 真实 IPC + 真实 7z，截图到 shot-light.png / shot-dark.png
# （--extract 会真实跑一次解压并打印输出文件清单）
$env:SZ333_RESOURCES = (Resolve-Path resources).Path
node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --probe light --extract
node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --probe dark

# 工作流闭环验证：解压两批同源包 → 自动生成卡片 → 第二批命中
node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --wf light
```

> 注意：probe-entry 必须是 Electron 的**入口文件**（Electron 只在加载入口时引导内置模块）。
>
> 另外：若环境变量里存在 `ELECTRON_RUN_AS_NODE=1`（某些 CI/harness 会注入），
> Electron 会退化为纯 Node 运行、`require('electron').app` 为 undefined。运行前请清除：
> `Remove-Item Env:ELECTRON_RUN_AS_NODE`

**运行日志**：程序启动时会把引擎定位结果写入 `%APPDATA%\sz333-unpack-desktop\app.log`，
设置页「关于」区块也提供 **7-Zip 引擎状态 + 重新检测**，方便用户自查。

---

## 许可证

MIT License · 完全免费 · 如通过购买获得请立即退款 · 无需赞赏，愿天下开源

> 请仅用于处理你自己拥有的压缩包，勿用于破解他人付费作品或绕过他人设置的保护。
