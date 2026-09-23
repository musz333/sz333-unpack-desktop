# 生成工作流（密码锚点）验证语料
#
# 产物落在 %TEMP%\sz333wf，供 scripts\verify-workflow.cjs（--wf）使用：
#   batch1\RX-4114.part1.7z.001   外层分卷（不加密）→ inner.7z（加密 Secret2026）→ 内容
#   batch2\RX-4114.part1.7z.001   与 batch1 完全同源，用于验证"第 2 批应命中卡片"
#
# 为什么必须前置生成：verify-workflow 走的是真实解压，而默认 sourcePolicy='delete'
# 会把源包彻底删掉 —— 也就是说**每跑一次 --wf，语料就被消费掉了**，
# 不重新生成的话第二次报「缺少测试包」。
#
# 用法：pwsh -File scripts\make-workflow-corpus.ps1
#       （从仓库根目录跑；会先清空 %TEMP%\sz333wf）

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$SZ = Join-Path $root 'resources\7z.exe'
if (-not (Test-Path $SZ)) { throw "找不到 7z: $SZ" }

$FX = Join-Path $env:TEMP 'sz333wf'
if (Test-Path $FX) { Remove-Item $FX -Recurse -Force }
$w = Join-Path $FX '_build'
New-Item -ItemType Directory -Path $w, "$FX\batch1", "$FX\batch2", "$w\l1" -Force | Out-Null

# 最内层真实内容
Set-Content -Path "$w\内容.txt" -Value "RX-4114 最内层真实内容" -Encoding UTF8
$f = [System.IO.File]::Create("$w\payload.bin"); $f.SetLength(4MB); $f.Close()

# L2：加密 7z（密码 Secret2026，连文件名一起加密 -mhe=on）
& $SZ a -t7z "$w\inner.7z" "$w\内容.txt" "$w\payload.bin" -mx1 -pSecret2026 -mhe=on | Out-Null

# L1：外层不加密 7z，只装 inner.7z，并分卷（-v2m）
Copy-Item "$w\inner.7z" "$w\l1\" -Force
& $SZ a -t7z "$w\RX-4114.part1.7z" "$w\l1\inner.7z" -mx1 -v2m | Out-Null

if (-not (Test-Path "$w\RX-4114.part1.7z.001")) {
  throw "分卷生成失败：$w\RX-4114.part1.7z.001 不存在"
}
Copy-Item "$w\RX-4114.part1.7z.00*" "$FX\batch1\" -Force
Copy-Item "$w\RX-4114.part1.7z.00*" "$FX\batch2\" -Force

Write-Host ''
Write-Host '=== 语料就绪 ==='
Get-ChildItem "$FX\batch1", "$FX\batch2" -File |
  Select-Object @{ n = 'Rel'; e = { $_.FullName.Substring($FX.Length + 1) } }, Length |
  Format-Table -AutoSize
Write-Host '预期：第 1 批生成卡片（层数 2、锚点 Secret2026），第 2 批命中（hitCount=2、卡片数仍为 1）。'
Write-Host '接着跑：node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --wf light'
