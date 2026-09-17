@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0.."

echo ============================================================
echo   sz333 解压工具 - 一键打包 Windows exe
echo ============================================================
echo.

rem ---------- 1) 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo         请先安装 Node.js LTS：https://nodejs.org/
  echo         或在 PowerShell 中执行： winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/4] Node.js 已就绪：!NODEVER!

rem ---------- 2) 检查引擎 ----------
if not exist "resources\7z.exe" (
  echo [错误] 缺少 resources\7z.exe（7-Zip 引擎）。
  echo         请从 https://www.7-zip.org/ 下载 x64 版并提取 7z.exe / 7z.dll 到 resources\ 目录。
  pause
  exit /b 1
)
if not exist "build\icon.ico" (
  echo [提示] 未找到 build\icon.ico，将使用 Electron 默认图标。
)
echo [2/4] 7-Zip 引擎已就绪。

rem ---------- 3) 安装依赖 ----------
if not exist "node_modules" (
  echo [3/4] 正在安装依赖（首次约需数分钟，会下载 Electron 二进制）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败。若网络受限，可先执行：
    echo         npm config set registry https://registry.npmmirror.com
    echo         set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    pause
    exit /b 1
  )
) else (
  echo [3/4] 依赖已存在，跳过安装。
)

rem ---------- 4) 构建 + 打包 ----------
echo [4/4] 正在构建并打包（NSIS 安装包 + 便携版）...
call npm run dist
if errorlevel 1 (
  echo [错误] 打包失败，请查看上方日志。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   打包完成！产物位于 release\ 目录：
echo ============================================================
dir /b "release\*.exe" 2>nul
echo.
echo   安装包：直接双击安装
echo   便携版：双击即用，不写注册表
echo.
pause
