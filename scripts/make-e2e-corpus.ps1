# 生成分层（套娃）解压 + APK 过滤验证语料
#
# 产物落在 %TEMP%\sz333-e2e，供 scripts\verify-layers.cjs 使用：
#   case1-nested\outer.7z.001..003   三卷 7z，内层是**伪装成 .jpg 的 zip**
#   case2-disguise\container.7z      内层 伪装图.jpg（实为 zip）
#   case3-apk-low\low.zip            app.apk 约占 20%（低于 70% 阈值，只应剔 apk）
#   case4-apk-high\high.zip          big.apk 约占 99%（高于 70% 阈值，应删整份产物）
#   （两个 apk 都用随机字节：魔数 unknown → 不会被套娃循环解开，
#     从而确保是 **APK 过滤器**在处理它们，而不是递归清理）
#
# 为什么必须自造：现有语料里没有 .apk 样本，且「伪装扩展名」这条路径
# 需要真实改名文件才能验证魔数嗅探。
#
# 用法：pwsh -File scripts\make-e2e-corpus.ps1
#       （从仓库根目录跑；会先清空 %TEMP%\sz333-e2e）

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$SZ = Join-Path $root 'resources\7z.exe'
if (-not (Test-Path $SZ)) { throw "找不到 7z: $SZ" }

$T = Join-Path $env:TEMP 'sz333-e2e'
if (Test-Path $T) { Remove-Item $T -Recurse -Force }
New-Item -ItemType Directory -Path $T -Force | Out-Null
Write-Host "语料根: $T"

# ---------- 语料 1：三卷套娃 + 伪装扩展名 ----------
# 外层三卷 7z → 封面.jpg（真身是 zip）→ 内容.txt / 随机.bin
$c1 = Join-Path $T 'case1-nested'
$w1 = Join-Path $T '_work1'
New-Item -ItemType Directory -Path $c1, $w1 -Force | Out-Null

New-Item -ItemType Directory -Path "$w1\payload" -Force | Out-Null
Set-Content -Path "$w1\payload\内容.txt" -Value ("分层验收内容 " * 100) -Encoding UTF8
# 随机数据让 zip 无法压缩，从而外层 7z 分卷时确实切成多卷（-v2k → 约 3 卷）
$f = [System.IO.File]::Create("$w1\payload\随机.bin"); $f.SetLength(6KB); $f.Close()
$rnd = New-Object byte[] 6144
(New-Object Random).NextBytes($rnd)
[System.IO.File]::WriteAllBytes("$w1\payload\随机.bin", $rnd)

# 内层 zip，随后改名成 .jpg 伪装
& $SZ a -tzip "$w1\real.zip" "$w1\payload\*" -mx1 | Out-Null
Copy-Item "$w1\real.zip" "$w1\封面.jpg" -Force
# 外层 7z，分卷（-v2k 保证切成 3 卷）
& $SZ a -t7z "$w1\outer.7z" "$w1\封面.jpg" -mx0 -v2k | Out-Null
Copy-Item "$w1\outer.7z.00*" $c1 -Force

# ---------- 语料 2：独立伪装用例 ----------
$c2 = Join-Path $T 'case2-disguise'
$w2 = Join-Path $T '_work2'
New-Item -ItemType Directory -Path $c2, $w2 -Force | Out-Null
Set-Content -Path "$w2\inner-content.txt" -Value "伪装层最内部内容 OK" -Encoding UTF8
& $SZ a -tzip "$w2\_inner.zip" "$w2\inner-content.txt" -mx1 | Out-Null
Copy-Item "$w2\_inner.zip" "$w2\伪装图.jpg" -Force
& $SZ a -t7z "$c2\container.7z" "$w2\伪装图.jpg" -mx1 | Out-Null

# ---------- 语料 3：apk 占比低（~20%）----------
# 关键：为了让 **APK 过滤器**真正被验证，apk 必须是 canExtract 不认识的格式。
#   · 若 apk 是合法 zip（真实 apk 就是这样），套娃循环会在第 2 层把它解开，
#     随后作为"已消费的中间压缩包"被 removeIntermediates 删掉 ——
#     于是 apk 消失是**递归清理**干的，根本没测到过滤器。
#   · 所以这里用随机字节：魔数嗅探为 unknown → pickNextLayer 跳过 → apk 留在产物里
#     等过滤器处理。这样过滤器的两条规则才真正被测到。
#     （真实场景里两种都存在：能解开的 apk 由递归清理带走，解不开的由过滤器带走。）

function New-OpaqueApk([string]$path, [int]$sizeBytes) {
  if (Test-Path $path) { Remove-Item $path -Force }
  $bytes = New-Object byte[] $sizeBytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [System.IO.File]::WriteAllBytes($path, $bytes)
}

$c3 = Join-Path $T 'case3-apk-low'
$w3 = Join-Path $T '_work3'
New-Item -ItemType Directory -Path $c3, $w3 -Force | Out-Null
New-OpaqueApk "$w3\app.apk" (2MB)
Set-Content -Path "$w3\说明.txt" -Value ("x" * 200000) -Encoding UTF8
$f = [System.IO.File]::Create("$w3\data.bin"); $f.SetLength(8MB); $f.Close()
Push-Location $w3
& $SZ a -tzip "$c3\low.zip" '.\*' -mx1 | Out-Null
Pop-Location

# ---------- 语料 4：apk 占比高（~99%）----------
$c4 = Join-Path $T 'case4-apk-high'
$w4 = Join-Path $T '_work4'
New-Item -ItemType Directory -Path $c4, $w4 -Force | Out-Null
New-OpaqueApk "$w4\big.apk" (20MB)
Set-Content -Path "$w4\tiny.txt" -Value "小文件" -Encoding UTF8
Push-Location $w4
& $SZ a -tzip "$c4\high.zip" '.\*' -mx0 | Out-Null
Pop-Location

Write-Host ''
Write-Host '=== 语料总览 ==='
Get-ChildItem $T -Recurse -File |
  Where-Object { $_.FullName -notlike '*_work*' } |
  Select-Object @{ n = 'Rel'; e = { $_.FullName.Substring($T.Length + 1) } }, Length |
  Format-Table -AutoSize
Write-Host '完成。接着跑：node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --layers'
