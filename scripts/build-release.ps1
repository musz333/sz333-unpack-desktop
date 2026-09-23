# 打包 Windows 产物（NSIS 安装包 + 便携版）→ release\
#
# 为什么要单独写这个脚本，而不直接用 `npm run dist`：
#   electron-builder.config.js 里
#     win.artifactName = '${productName}-${version}-${arch}-${env.BUILD_KIND}.exe'
#   引用了环境变量 BUILD_KIND。**不定义它就整个打包中断**：
#     ⨯ cannot expand pattern "...": env BUILD_KIND is not defined
#   而 `npm run dist` / scripts\build.bat 都没有设置它。
#
# 取值说明：
#   · 安装包走向 win.artifactName → BUILD_KIND=setup
#     模板是 '${productName}-${version}-${arch}-${env.BUILD_KIND}.exe'，
#     而 ${arch} 本身就会展开成 'x64'，所以这里只能填 'setup'，
#     填 'x64-setup' 会得到 `...-x64-x64-setup.exe`（重复的 x64）。
#     最终名：`sz333 解压工具-1.0.5-x64-setup.exe`
#   · 便携版有自己的 portable.artifactName（`...-便携版.exe`）覆盖它，不受影响
#   · 但 electron-builder 仍会对 win 目标求值该模板，所以必须定义
#   · 发布时 publish-release.ps1 会把两者重命名为 ASCII：
#     `sz333-unpack-1.0.5-setup-x64.exe` / `sz333-unpack-1.0.5-portable-x64.exe`
#     （它靠 *setup.exe / *便携版*.exe 通配找本地文件）
#
# 用法：pwsh -File scripts\build-release.ps1
#       （从仓库根目录跑；会自动杀占用进程并清空 release\）

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1) 必须先杀掉占用 release\ 里文件的进程，否则报 ffmpeg.dll: Access is denied
Get-Process |
  Where-Object { $_.Path -like "*sz333-unpack-desktop*" } |
  ForEach-Object { try { $_.Kill() } catch {} }
Start-Sleep -Seconds 2

Remove-Item 'release' -Recurse -Force -ErrorAction SilentlyContinue

# 2) 国内镜像：避免下载 Electron / electron-builder 工具链超时
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'

# 3) 不设它打包会直接失败（见文件头说明）
$env:BUILD_KIND = 'setup'

Write-Host '=== 构建 out/ ==='
npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }

Write-Host ''
Write-Host '=== 打包 nsis + portable ==='
npx electron-builder --win nsis portable --config electron-builder.nosign.config.js
if ($LASTEXITCODE -ne 0) { throw '打包失败' }

Write-Host ''
Write-Host '=== release\ 产物 ==='
Get-ChildItem 'release\*.exe' | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize

Write-Host '=== SHA-256 ==='
Get-ChildItem 'release\*.exe' | ForEach-Object {
  $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
  Write-Host ("  {0}`n    {1}" -f $_.Name, $h)
}
