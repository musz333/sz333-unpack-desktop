# ============================================================================
# 把本项目源码上传到 GitHub（无需安装 git，全部走 GitHub REST API）
#
# 用法（PowerShell）：
#   $env:GH_TOKEN="ghp_你的token"      # 需要 repo 权限（classic 勾 repo，或 fine-grained 勾 Contents: Read and write）
#   pwsh -File scripts/upload-github.ps1
#
# 可选：
#   $env:GH_REPO="sz333-unpack-desktop"    # 仓库名（默认 sz333-unpack-desktop）
#   $env:GH_PROXY="http://127.0.0.1:7897"  # 需要代理时才设置
#   $env:GH_PRIVATE="1"                    # 建私有仓库（默认公开）
#
# 说明：逐文件通过 Contents API 提交，每个文件一次 commit。
#       大文件（>40MB）与构建产物会被自动跳过。
# ============================================================================
$ErrorActionPreference = 'Stop'

$token = $env:GH_TOKEN
if ([string]::IsNullOrEmpty($token)) {
  Write-Host '[错误] 未设置 GH_TOKEN。' -ForegroundColor Red
  Write-Host '       生成地址：https://github.com/settings/tokens' -ForegroundColor Yellow
  Write-Host '       PowerShell 里执行： $env:GH_TOKEN="ghp_xxx"' -ForegroundColor Yellow
  exit 1
}

$repoName = if ($env:GH_REPO) { $env:GH_REPO } else { 'sz333-unpack-desktop' }
$private = $env:GH_PRIVATE -eq '1'
$api = 'https://api.github.com'
$proxy = $env:GH_PROXY

$headers = @{
  'User-Agent'    = 'sz333-unpack-desktop'
  'Authorization' = "Bearer $token"
  'Accept'        = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$base = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $base
Write-Host "项目根目录：$base" -ForegroundColor Cyan

function Invoke-GH {
  param([string]$Method, [string]$Uri, $Body)
  $params = @{
    Uri = $Uri; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 120
  }
  if ($Body) { $params.Body = $Body; $params.ContentType = 'application/json' }
  if ($proxy) { $params.Proxy = $proxy }
  try {
    return Invoke-WebRequest @params
  } catch {
    # PS7 用 ErrorDetails.Message；PS5 用响应流，两种都兼容
    $msg = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $msg = $_.ErrorDetails.Message
    } elseif ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $msg = $stream
      } catch {
        try {
          $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
          $msg = $sr.ReadToEnd()
        } catch { $msg = $_.Exception.Message }
      }
    } else {
      $msg = $_.Exception.Message
    }
    Write-Host "  [失败] $Method $Uri" -ForegroundColor Red
    Write-Host "         $msg" -ForegroundColor DarkRed
    return $null
  }
}

# ---------- 1) 取当前用户 ----------
$me = Invoke-GH 'Get' "$api/user"
if (-not $me) { Write-Host '[错误] token 无效或网络不通。' -ForegroundColor Red; exit 1 }
$owner = ($me.Content | ConvertFrom-Json).login
Write-Host "已认证用户：$owner" -ForegroundColor Green

# ---------- 2) 确定或创建仓库 ----------
$repoUri = "$api/repos/$owner/$repoName"
$exists = Invoke-GH 'Get' $repoUri
if ($exists) {
  Write-Host "仓库已存在：$owner/$repoName" -ForegroundColor Green
} else {
  Write-Host "创建仓库：$owner/$repoName（私有=$private）..." -ForegroundColor Cyan
  $body = @{
    name        = $repoName
    description = 'Windows 桌面解压工具：分卷合并 / 多层嵌套 / 加密包 / 密码锚点工作流（Electron + React + Vite + Tailwind）'
    private     = $private
    has_issues  = $true
    auto_init   = $false
  } | ConvertTo-Json -Compress
  $created = Invoke-GH 'Post' "$api/user/repos" $body
  if (-not $created) { exit 1 }
  Write-Host "已创建：$owner/$repoName" -ForegroundColor Green
  Start-Sleep -Seconds 2
}

# ---------- 3) 待上传文件清单 ----------
$include = @(
  'package.json', 'package-lock.json', 'README.md', '.gitignore',
  'electron.vite.config.ts', 'electron-builder.config.js', 'electron-builder.nosign.config.js',
  'tailwind.config.js', 'postcss.config.js',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json',
  'resources/7z.exe',
  'build/icon.ico',
  'scripts/build.bat', 'scripts/make-icon.mjs', 'scripts/upload-github.ps1', 'scripts/publish-release.ps1',
  'scripts/probe-entry.cjs', 'scripts/verify-ui.cjs', 'scripts/verify-workflow.cjs',
  'scripts/verify-cjk.cjs', 'scripts/verify-wizard.cjs',
  'shot-light.png', 'shot-dark.png', 'shot-workflows-light.png', 'shot-wizard.png'
)
$srcFiles = Get-ChildItem (Join-Path $base 'src') -Recurse -File | ForEach-Object {
  $full = $_.FullName
  $rel = $full.Substring($base.Length).TrimStart('\', '/')
  $rel.Replace('\', '/')
}
$all = @($include) + @($srcFiles)

$maxBytes = 40MB
$uploaded = 0; $skipped = 0; $failed = 0

Write-Host ''
Write-Host '开始上传...' -ForegroundColor Cyan

foreach ($rel in $all) {
  $local = Join-Path $base ($rel.Replace('/', '\'))
  if (-not (Test-Path $local)) { Write-Host "  跳过（不存在）：$rel" -ForegroundColor DarkGray; $skipped++; continue }

  $fi = Get-Item $local
  if ($fi.Length -gt $maxBytes) {
    Write-Host ("  跳过（>{0}MB）：{1}" -f [int]($maxBytes/1MB), $rel) -ForegroundColor Yellow
    $skipped++
    continue
  }

  $bytes = [System.IO.File]::ReadAllBytes($local)
  $content = [Convert]::ToBase64String($bytes)
  $uri = "$api/repos/$owner/$repoName/contents/$rel"

  # 已存在则需带 sha 才能真正覆盖（GET 失败多为瞬时网络问题，重试两次）
  $sha = $null
  for ($i = 1; $i -le 2; $i++) {
    $head = Invoke-GH 'Get' $uri
    if ($head) { $sha = ($head.Content | ConvertFrom-Json).sha; break }
    Start-Sleep -Seconds 2
  }

  $body = @{ message = "Add $rel"; content = $content }
  if ($sha) { $body.sha = $sha }
  $json = $body | ConvertTo-Json -Compress

  # PUT 也重试，避免一次网络抖动就要人工重跑
  $r = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $r = Invoke-GH 'Put' $uri $json
    if ($r) { break }
    if ($attempt -lt 3) {
      Write-Host "        第 $attempt 次失败，2 秒后重试…" -ForegroundColor DarkYellow
      Start-Sleep -Seconds 2
    }
  }
  if ($r) {
    Write-Host ("  [OK] {0}  ({1:N1} KB)" -f $rel, ($fi.Length / 1KB)) -ForegroundColor Green
    $uploaded++
  } else {
    Write-Host "  [×]  $rel 上传失败（已重试 3 次）" -ForegroundColor Red
    $failed++
  }
}

Write-Host ''
Write-Host '======================================================' -ForegroundColor Cyan
Write-Host ("  上传完成：成功 {0} · 跳过 {1} · 失败 {2}" -f $uploaded, $skipped, $failed)
Write-Host ("  仓库地址：https://github.com/{0}/{1}" -f $owner, $repoName) -ForegroundColor Yellow
Write-Host '======================================================' -ForegroundColor Cyan
