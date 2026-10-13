# 依赖清单（v2.0.1）

> 本文件随源码包提供，内容与 `package.json` / `package-lock.json` 保持一致。
> 版本号：**2.0.1**

---

## 1. 运行 / 构建环境要求

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10 / 11 **x64**（打包目标仅 x64） |
| Node.js | ≥ 18（开发与构建用；本项目在 Node 20 / 22 上验证） |
| npm | ≥ 9（需支持 lockfileVersion 3） |
| 磁盘 | 首次安装依赖约 **500 MB**（含 Electron 二进制约 100 MB） |
| 网络 | 首次 `npm install` 需访问 npm registry 与 Electron 二进制镜像 |

---

## 2. 运行时依赖（dependencies）

| 包 | 版本约束 | 用途 |
|----|----------|------|
| `react` | ^18.3.1 | 渲染进程 UI 框架 |
| `react-dom` | ^18.3.1 | React DOM 渲染 |
| `zustand` | ^4.5.5 | 渲染进程状态管理 |
| `lucide-react` | ^0.436.0 | 图标库（项目内唯一图标来源） |

---

## 3. 开发依赖（devDependencies）

| 包 | 版本约束 | 用途 |
|----|----------|------|
| `electron` | ^31.4.0 | 桌面运行时 |
| `electron-builder` | ^24.13.3 | 打包 NSIS 安装包 / 便携版 |
| `electron-vite` | ^2.3.0 | 三端（main / preload / renderer）构建 |
| `vite` | ^5.4.2 | 构建内核 |
| `@vitejs/plugin-react` | ^4.3.1 | React 插件 |
| `typescript` | ^5.5.4 | 类型检查 |
| `tailwindcss` | ^3.4.10 | 样式框架 |
| `postcss` | ^8.4.41 | CSS 处理 |
| `autoprefixer` | ^10.4.20 | CSS 前缀补全 |
| `@types/node` | ^20.16.1 | Node 类型声明 |
| `@types/react` | ^18.3.4 | React 类型声明 |
| `@types/react-dom` | ^18.3.0 | ReactDOM 类型声明 |

---

## 4. 内嵌二进制（**不经 npm 管理**）

| 文件 | 版本 | 用途 | 分发方式 |
|------|------|------|----------|
| `resources/7z.exe` | **7-Zip 26.02 (x64)** | 解压引擎（以外部进程方式调用） | `extraResources` → 打包后位于 asar **之外** |
| `resources/7z.dll` | **7-Zip 26.02 (x64)** | 引擎动态库 | 同上 |

> ⚠️ **关键约束**：`7z.exe` 必须放在 asar **之外**（打包后位于安装目录的 `resources/`），
> 否则无法被 `spawn` 调用。见 `electron-builder.config.js` 的 `extraResources`。
>
> ⚠️ **调用约束**：`7z.exe` 与 `7z.dll` 必须**同目录**。若从受限目录运行导致
> `Codec Load Error`，需把两者一起复制到可访问目录再调用（本项目的验证脚本即如此处理）。

---

## 5. 依赖完整性

- `package-lock.json` 锁定全部传递依赖（lockfileVersion 3）。
- 严格还原请用 `npm ci`（按锁文件安装，不修改锁文件）。

---

## 6. 设计说明：不引入 Node 侧解压库

本项目**刻意不使用**任何 Node 侧解压库（如 `node-7z`、`unzipper`、`adm-zip`），
全部解压 / 列表能力都通过调用内嵌 `7z.exe` 完成：

- 支持的格式与 7-Zip 完全一致（zip / 7z / rar / tar / gz / bz2 / xz …）；
- 规避 Node 侧解压库在**中文路径、分卷、伪装扩展名**上的兼容差异；
- 代价：必须随包分发 `7z.exe` + `7z.dll`（约 1.5 MB）。

---

## 7. 版本对应关系

| 项 | 版本 |
|----|------|
| 源码包版本 | **2.0.1** |
| `package.json` → `version` | **2.0.1** |
| `package-lock.json` 根 version | **1.0.7** |
| `src/renderer/src/lib/appInfo.ts` → `APP_VERSION` | **2.0.1** |
| 交付包版本 | **2.0.1** |
