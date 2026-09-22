# ============================================================================
# 发布 Release 并上传可执行文件（走 GitHub REST API，无需 git）
#
# 用法：
#   $env:GH_TOKEN="ghp_xxx"
#   pwsh -File scripts/publish-release.ps1
#
# 可选：
#   $env:GH_TAG="v1.0.2"        # 默认取 package.json 的 version
#   $env:GH_PRIVATE="1"         # 建为草稿（不公开）
#
# 说明：资产名使用 ASCII（中文名在部分下载器/命令行下会出问题），
#       中文说明写在 Release 正文里。
# ============================================================================
$ErrorActionPreference = 'Stop'

$token = $env:GH_TOKEN
if ([string]::IsNullOrEmpty($token)) {
  Write-Host '[错误] 未设置 GH_TOKEN' -ForegroundColor Red
  exit 1
}

$owner = 'musz333'
$repo = 'sz333-unpack-desktop'
$api = 'https://api.github.com'
$uploadApi = 'https://uploads.github.com'

$headers = @{
  'User-Agent' = 'sz333-release'
  'Authorization' = "Bearer $token"
  'Accept' = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $base

$pkg = Get-Content (Join-Path $base 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$tag = if ($env:GH_TAG) { $env:GH_TAG } else { "v$version" }
$draft = $env:GH_PRIVATE -eq '1'

Write-Host "发布目标：$owner/$repo  标签：$tag" -ForegroundColor Cyan

# ---------- 1) 定位产物 ----------
$portable = Get-ChildItem (Join-Path $base 'release') -Filter '*便携版*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$setup = Get-ChildItem (Join-Path $base 'release') -Filter '*setup.exe' -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $portable -and -not $setup) {
  Write-Host '[错误] release 目录里没有找到 exe，请先执行打包：' -ForegroundColor Red
  Write-Host '       npx electron-builder --win nsis portable --config electron-builder.nosign.config.js' -ForegroundColor Yellow
  exit 1
}

# ---------- 2) 创建或复用 Release ----------
$releaseUri = "$api/repos/$owner/$repo/releases/tags/$tag"
$release = $null
try {
  $release = Invoke-RestMethod -Uri $releaseUri -Headers $headers -TimeoutSec 40
  Write-Host "Release 已存在，复用：$tag" -ForegroundColor Green
} catch {
  $body = @{
    tag_name = $tag
    target_commitish = 'main'
    name = "sz333 解压工具 $version"
    draft = $draft
    prerelease = $false
    body = @"
## sz333 解压工具 $version（Windows 桌面版）

分卷合并 · 多层嵌套 · 加密包 · **密码锚点工作流** · 任务队列 · 历史记录

### 下载哪个？

| 文件 | 说明 |
| --- | --- |
| ``sz333-unpack-$version-portable-x64.exe`` | **便携版（推荐）**：免安装，双击即用，不写注册表 |
| ``sz333-unpack-$version-setup-x64.exe`` | 安装版：可选安装目录、创建快捷方式、可卸载 |

### 首次使用

1. 下载后双击运行（若 Windows 提示"已保护你的电脑"，点【更多信息】→【仍要运行】；未签名个人软件属常见提示）
2. 首次启动会弹出 **4 步引导**：源文件处理 / 中文路径 / 输出目录 / 并发数
3. 把压缩包（含分卷）拖进窗口 → 点【解压】

### 主要能力

- **分卷自动归组**：``.part1`` / ``.001`` / ``.z01`` / ``.r00`` 自动识别为一组
- **魔数识别**：不看扩展名，按文件头判断真实格式（伪装成 ``.JPG`` 的包也能认）
- **密码锚点工作流**：同一个上传者的密码稳定 → 记住链路，下次同源一键解压，跳过探测与试错
- **中文路径转英文**：老资源包对中文路径不友好时，自动把目录名与包内文件名换成 ASCII，并逐条记录对照表
- **并发处理**：可同时处理 1 / 2 / 4 个压缩包（默认 1）
- **源文件处理**：默认解压成功后彻底删除原包（可选保留），失败或取消永不删源文件

### 环境

- Windows 10 / 11 x64，**免装运行时**（单文件自包含）
- 内嵌 7-Zip 引擎（LGPL），无需单独安装 7-Zip

### 源码

https://github.com/$owner/$repo

---
完全免费 · 如通过购买获得请立即退款 · 无需赞赏，愿天下开源
"@
  } | ConvertTo-Json -Compress

  $release = Invoke-RestMethod -Uri "$api/repos/$owner/$repo/releases" -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 60
  Write-Host "已创建 Release：$tag" -ForegroundColor Green
}

# ---------- 3) 上传资产 ----------
function Publish-Asset {
  param([string]$FilePath, [string]$AssetName)

  if (-not $FilePath) { return }
  $sizeMb = [math]::Round((Get-Item $FilePath).Length / 1MB, 1)
  Write-Host "上传 $AssetName（$sizeMb MB）..." -ForegroundColor Cyan

  # 已存在同名资产则先删除（便于重复发布）
  $listUri = "$api/repos/$owner/$repo/releases/$($release.id)/assets"
  $assets = Invoke-RestMethod -Uri $listUri -Headers $headers -TimeoutSec 40
  foreach ($a in $assets) {
    if ($a.name -eq $AssetName) {
      Invoke-RestMethod -Uri "$api/repos/$owner/$repo/releases/assets/$($a.id)" -Method Delete -Headers $headers -TimeoutSec 40 | Out-Null
      Write-Host "  已删除旧资产 $AssetName" -ForegroundColor DarkGray
    }
  }

  $uri = "$uploadApi/repos/$owner/$repo/releases/$($release.id)/assets?name=$AssetName"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $resp = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $FilePath -TimeoutSec 1800
  $sw.Stop()
  Write-Host ("  ✔ 完成：{0}（{1:N1} MB，用时 {2:N0}s）" -f $resp.name, ($resp.size / 1MB), $sw.Elapsed.TotalSeconds) -ForegroundColor Green
  Write-Host "    下载地址：$($resp.browser_download_url)" -ForegroundColor Yellow
}

Publish-Asset -FilePath $portable.FullName -AssetName "sz333-unpack-$version-portable-x64.exe"
Publish-Asset -FilePath $setup.FullName -AssetName "sz333-unpack-$version-setup-x64.exe"

Write-Host ''
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host "  Release 页面：https://github.com/$owner/$repo/releases/tag/$tag" -ForegroundColor Yellow
Write-Host '======================================================' -ForegroundColor Cyan
