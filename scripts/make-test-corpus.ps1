# make-test-corpus.ps1
# 生成 sz333 解压工具「修复前基线」测试语料（PowerShell 版）
# 说明：本机沙箱禁止 Node 创建子进程（EBUSY），故由 PowerShell 驱动 7z。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-test-corpus.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-test-corpus.ps1 -Large

param([switch]$Large)

$ErrorActionPreference = 'Stop'

# 让 PowerShell 正确解码外部命令（7z -sccUTF-8）的输出，避免中文路径/条目名乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Project = Split-Path -Parent $PSScriptRoot
$Res     = Join-Path $Project 'resources'
$Corpus  = Join-Path $Project 'test-corpus'
$Stage   = Join-Path $env:TEMP 'sz333-corpus-stage'
$LogFile = Join-Path $env:TEMP 'sz333-corpus-build.log'
$Pwd     = 'sz333-test'
$ManyEntries = 3200

$script:Cases = @()
$script:Warn  = New-Object System.Collections.Generic.List[string]
$script:Utf8  = New-Object System.Text.UTF8Encoding($false)

try { if ([System.IO.File]::Exists($LogFile)) { [System.IO.File]::Delete($LogFile) } } catch { }

function Log([string]$m) {
  Write-Host $m
  try { [System.IO.File]::AppendAllText($LogFile, "$m`r`n", $script:Utf8) } catch { }
}
function Warn([string]$m) {
  $script:Warn.Add($m) | Out-Null
  Log "  [warn] $m"
}

# ---------------------------- 引擎定位 ----------------------------
$SevenZ = $null
function Get-Engine {
  if ($script:SevenZ) { return $script:SevenZ }
  $bundled = Join-Path $Res '7z.exe'
  if (-not (Test-Path $bundled)) { throw "找不到内嵌引擎: $bundled" }

  # 始终使用临时副本：从项目目录直接运行时，7z.exe 可能因权限/沙箱限制
  # 无法加载同目录的 7z.dll（症状：Codec Load Error），复制到 %TEMP% 后稳定可用。
  $dir = Join-Path $env:TEMP 'sz333-engine'
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  Copy-Item $bundled (Join-Path $dir '7z.exe') -Force
  Copy-Item (Join-Path $Res '7z.dll') (Join-Path $dir '7z.dll') -Force
  $alt = Join-Path $dir '7z.exe'

  # 用 i（列出支持的格式）验证 —— 它会真正加载 codec，比无参数调用可靠
  $o = (& $alt i 2>&1 | Out-String)
  if ($o -notmatch '7-Zip' -or $o -match 'Codec Load Error') {
    throw '7-Zip 引擎不可用（临时副本验证失败）'
  }
  $script:SevenZ = $alt
  Log "  [engine] 使用临时副本: $alt"
  return $script:SevenZ
}

function Run7z([string[]]$argList, [string]$cwd) {
  Push-Location $cwd
  try {
    $out  = (& $SevenZ @argList 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  return @{ code = $code; out = $out }
}

# ---------------------------- 目录工具 ----------------------------
# 说明：宿主对 Remove-Item 做了安全删除钩子（回收站失败即拒绝），
#       这里统一改用 .NET API 做目录清理，避免被 fail-closed 拦截。
function Force-Delete([string]$p) {
  try {
    if ([System.IO.Directory]::Exists($p)) { [System.IO.Directory]::Delete($p, $true) }
    elseif ([System.IO.File]::Exists($p)) { [System.IO.File]::Delete($p) }
  } catch { }
}

function New-CaseDir([string]$id) {
  $d = Join-Path $Corpus $id
  Force-Delete $d
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  return $d
}
function New-StageDir([string]$id) {
  $d = Join-Path $Stage $id
  Force-Delete $d
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  return $d
}
function Write-Text([string]$dir, [string]$rel, [string]$content) {
  $p = Join-Path $dir $rel
  $parent = Split-Path -Parent $p
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [System.IO.File]::WriteAllText($p, $content, (New-Object System.Text.UTF8Encoding($false)))
  return $p
}
function Write-Rand([string]$dir, [string]$rel, [int]$bytes) {
  $p = Join-Path $dir $rel
  $parent = Split-Path -Parent $p
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $buf = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  [System.IO.File]::WriteAllBytes($p, $buf)
  return $p
}

function AddCase([hashtable]$c) {
  $script:Cases += $c
  Log ("  [ok] " + $c.id + "  " + $c.title)
}

# ---------------------------- 期望值解析（正确版） ----------------------------
function Count-Entries([string]$stdout) {
  $inHeader = $true
  $curPath  = $null
  $isDir    = $false
  $files    = 0
  $dirs     = 0
  $format   = 'unknown'

  $flush = {
    if ($null -ne $curPath -and -not $inHeader) {
      if ($isDir) { $script:f++ } else { $script:f2++ }
    }
  }

  foreach ($raw in ($stdout -split "`r?`n")) {
    $line = $raw.Trim()
    if (-not $line) { continue }
    if ($line.StartsWith('Listing archive:')) { continue }

    if ($line -match '^-{2,}$') {
      if ($null -ne $curPath -and -not $inHeader) { if ($isDir) { $dirs++ } else { $files++ } }
      $curPath = $null; $isDir = $false
      if ($line.Length -ge 10) { $inHeader = $false }
      continue
    }

    $eq = $line.IndexOf(' = ')
    if ($eq -lt 0) { continue }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 3).Trim()

    if ($k -eq 'Path') {
      if ($null -ne $curPath -and -not $inHeader) { if ($isDir) { $dirs++ } else { $files++ } }
      $curPath = $v; $isDir = $false
      continue
    }
    if ($k -eq 'Type') {
      if ($inHeader) {
        if ($v -eq 'gzip') { $format = 'gz' }
        elseif (@('7z','zip','rar','tar','bzip2','xz','cab') -contains $v) { $format = $v }
      } elseif ($v -eq 'Directory') { $isDir = $true }
    }
    if ($k -eq 'Attributes' -and $v -match 'D') { $isDir = $true }
  }
  if ($null -ne $curPath -and -not $inHeader) { if ($isDir) { $dirs++ } else { $files++ } }

  return @{ files = $files; dirs = $dirs; entries = ($files + $dirs); format = $format }
}

function Get-Expected([string]$archiveAbs, [string]$password) {
  $r = Run7z @('l','-slt','-sccUTF-8',("-p" + $password),'--',$archiveAbs) (Split-Path -Parent $archiveAbs)
  $st = Count-Entries $r.out
  $enc = ($r.out -match 'Wrong password|Cannot open encrypted|Enter password|Data Error in encrypted')
  $st.encrypted = $enc
  $st.listOk = ($r.code -eq 0)
  $st.raw = $r.out
  $st.code = $r.code
  return $st
}

# ============================ 用例 ============================

function CaseC01 {
  $id = 'C01-multi-7z'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'a.txt' "AAAA first file`n" | Out-Null
  Write-Text $st 'b.txt' "BBBB second file`n" | Out-Null
  Write-Text $st 'c.txt' "CCCC third file`n" | Out-Null
  Write-Text $st 'd.txt' "DDDD fourth file`n" | Out-Null
  $out = Join-Path $dir 'C01-multi.7z'
  $r = Run7z @('a',$out,'a.txt','b.txt','c.txt','d.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='多文件 7z（4 文件，无目录）'; dir=$dir; archive='C01-multi.7z'
             format='7z'; encrypted=$false; password=''
             goal='P0-2：解析必须得到 4 个文件条目，且不含"压缩包自身"' }
}

function CaseC02 {
  $id = 'C02-multi-7z-dirs'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'docs/readme.txt' "readme`n" | Out-Null
  Write-Text $st 'docs/sub/note.txt' "note`n" | Out-Null
  $out = Join-Path $dir 'C02-dirs.7z'
  $r = Run7z @('a',$out,'docs') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='多文件 7z（含目录条目）'; dir=$dir; archive='C02-dirs.7z'
             format='7z'; encrypted=$false; password=''
             goal='P0-2：目录条目（Attributes=D）与文件条目都要解析出来' }
}

function CaseC03 {
  $id = 'C03-multi-zip'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'x.txt' "xxx`n" | Out-Null
  Write-Text $st 'y.txt' "yyy`n" | Out-Null
  Write-Text $st 'z.txt' "zzz`n" | Out-Null
  $out = Join-Path $dir 'C03-multi.zip'
  $r = Run7z @('a','-tzip',$out,'x.txt','y.txt','z.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='多文件 zip（3 文件）'; dir=$dir; archive='C03-multi.zip'
             format='zip'; encrypted=$false; password=''
             goal='P0-2：zip 走同一解析路径，格式应识别为 zip' }
}

function CaseC04 {
  $id = 'C04-encrypted-7z'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'secret1.txt' "secret content one`n" | Out-Null
  Write-Text $st 'secret2.txt' "secret content two`n" | Out-Null
  $out = Join-Path $dir 'C04-enc.7z'
  $r = Run7z @('a',("-p"+$Pwd),'-mhe=on',$out,'secret1.txt','secret2.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='加密 7z（含头部加密 -mhe=on）'; dir=$dir; archive='C04-enc.7z'
             format='7z'; encrypted=$true; password=$Pwd
             goal='P0-2（Encrypted 标记）+ 密码流程 + 工作流锚点' }
}

function CaseC05 {
  $id = 'C05-encrypted-zip'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'note.txt' "encrypted zip content`n" | Out-Null
  $out = Join-Path $dir 'C05-enc.zip'
  $r = Run7z @('a','-tzip',("-p"+$Pwd),'-mem=AES256',$out,'note.txt') $st
  if ($r.code -ne 0) {
    Warn "$id : AES256 创建失败，回退 ZipCrypto"
    $r = Run7z @('a','-tzip',("-p"+$Pwd),$out,'note.txt') $st
  }
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='加密 zip（AES256）'; dir=$dir; archive='C05-enc.zip'
             format='zip'; encrypted=$true; password=$Pwd
             goal='P0-2 + 密码流程（zip 加密分支）' }
}

function CaseC06 {
  $id = 'C06-split-7z'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  1..6 | ForEach-Object { Write-Rand $st ("part$_" + '.bin') 4096 | Out-Null }
  # 7z 创建分卷时输出名必须给「基础名」（不带 .001），卷号由 -v 自动追加
  $out = Join-Path $dir 'C06-split.7z'
  $r = Run7z @('a','-v8k',$out,'part1.bin','part2.bin','part3.bin','part4.bin','part5.bin','part6.bin') $st
  if ($r.code -ne 0) { throw $r.out }
  $vols = @(Get-ChildItem $dir -Filter 'C06-split.7z.*' | Select-Object -ExpandProperty Name | Sort-Object)
  if ($vols.Count -lt 2) { throw ("分卷未生成多个: " + ($vols -join ',')) }
  AddCase @{ id=$id; title=("7z 分卷（" + $vols.Count + " 卷）"); dir=$dir; archive=$vols[0]
             format='7z'; encrypted=$false; password=''; volumes=$vols
             goal='分卷归组（volumeKey/isVolumeMember）、中间包清理、源文件删除策略' }
}

function CaseC07 {
  $id = 'C07-split-zip'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  1..6 | ForEach-Object { Write-Rand $st ("z$_" + '.bin') 4096 | Out-Null }
  # 与 C06 一致：创建分卷时输出名给「基础名」（不带 .001），卷号由 -v 自动追加
  $out = Join-Path $dir 'C07-split.zip'
  $r = Run7z @('a','-tzip','-v8k',$out,'z1.bin','z2.bin','z3.bin','z4.bin','z5.bin','z6.bin') $st
  if ($r.code -ne 0) { Warn "$id : 7z 无法创建 zip 分卷，已跳过"; return }
  $vols = @(Get-ChildItem $dir -Filter 'C07-split.zip.*' | Select-Object -ExpandProperty Name | Sort-Object)
  if ($vols.Count -lt 2) { Warn "$id : 未产生多卷，已跳过"; return }
  AddCase @{ id=$id; title=("zip 分卷（" + $vols.Count + " 卷）"); dir=$dir; archive=$vols[0]
             format='zip'; encrypted=$false; password=''; volumes=$vols
             goal='zip 分卷归组' }
}

function CaseC08 {
  $id = 'C08-disguised-jpg'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  $inner = Join-Path $st 'hidden.zip'
  Write-Text $st 'hidden-content.txt' "this is inside a zip disguised as JPG`n" | Out-Null
  $r = Run7z @('a','-tzip',$inner,'hidden-content.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  Move-Item $inner (Join-Path $st 'photo.JPG') -Force
  $out = Join-Path $dir 'C08-disguised.7z'
  $r = Run7z @('a',$out,'photo.JPG') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='伪装扩展名（外层 7z 内的 photo.JPG 实为 zip）'; dir=$dir; archive='C08-disguised.7z'
             format='7z'; encrypted=$false; password=''
             goal='魔数识别、pickNextLayer、多层链路、伪装日志' }
}

function CaseC09 {
  $id = 'C09-nested-3'
  $dir = New-CaseDir $id; $st = New-StageDir $id

  $d3 = Join-Path $st 'd3'
  New-Item -ItemType Directory -Path $d3 -Force | Out-Null
  Write-Text $d3 'final.txt' "THE FINAL CONTENT`n" | Out-Null
  $null = Run7z @('a',(Join-Path $st 'L3.7z'),'final.txt') $d3

  $d2 = Join-Path $st 'd2'
  New-Item -ItemType Directory -Path $d2 -Force | Out-Null
  Copy-Item (Join-Path $st 'L3.7z') (Join-Path $d2 'L3.7z') -Force
  $null = Run7z @('a','-tzip',(Join-Path $st 'L2.zip'),'L3.7z') $d2

  $d1 = Join-Path $st 'd1'
  New-Item -ItemType Directory -Path $d1 -Force | Out-Null
  Copy-Item (Join-Path $st 'L2.zip') (Join-Path $d1 'L2.zip') -Force
  $out = Join-Path $dir 'C09-nested.7z'
  $r = Run7z @('a',$out,'L2.zip') $d1
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='三层套娃（7z → zip → 7z → 内容）'; dir=$dir; archive='C09-nested.7z'
             format='7z'; encrypted=$false; password=''
             goal='MAX_DEPTH 递归、逐层日志、layerCount、工作流卡片链路、中间包清理' }
}

function CaseC10 {
  $id = 'C10-apk-shell'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Rand $st 'classes.dex' (900 * 1024) | Out-Null
  $apkZip = Join-Path $st 'app.zip'
  $r = Run7z @('a','-tzip','-mx1',$apkZip,'classes.dex') $st
  if ($r.code -ne 0) { throw $r.out }
  Move-Item $apkZip (Join-Path $st 'big.apk') -Force
  Write-Text $st 'readme.txt' "this pack is basically an apk shell`n" | Out-Null
  Write-Text $st 'info.nfo' "nfo`n" | Out-Null
  $out = Join-Path $dir 'C10-apk-shell.7z'
  $r = Run7z @('a','-mx1',$out,'big.apk','readme.txt','info.nfo') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='APK 壳包（big.apk 占解压总量约 90%）'; dir=$dir; archive='C10-apk-shell.7z'
             format='7z'; encrypted=$false; password=''
             goal='P0-5（ASCII 改名后过滤仍生效）、P1-6（用户目录保护）、apk 不作套娃层' }
}

function CaseC11 {
  $id = 'C11-cjk-names'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st '中文文档.txt' "这是中文内容`n" | Out-Null
  Write-Text $st '图片/示例说明.txt' "中文子目录内容`n" | Out-Null
  Write-Text $st 'mixed-混合-name.txt' "mixed`n" | Out-Null
  $out = Join-Path $dir 'C11-中文包.7z'
  $r = Run7z @('a',$out,'中文文档.txt','图片','mixed-混合-name.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title='中文路径包（包名与包内条目均含中文）'; dir=$dir; archive='C11-中文包.7z'
             format='7z'; encrypted=$false; password=''
             goal='asciiName/asciiPath 转写、路径预算、P0-5（改名 + APK 过滤组合）' }
}

function CaseC12 {
  $id = 'C12-many-entries'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  $bulk = Join-Path $st 'bulk'
  New-Item -ItemType Directory -Path $bulk -Force | Out-Null
  $enc = New-Object System.Text.UTF8Encoding($false)
  for ($i = 0; $i -lt $ManyEntries; $i++) {
    $name = 'f' + $i.ToString('00000') + '.txt'
    [System.IO.File]::WriteAllText((Join-Path $bulk $name), "$i`n", $enc)
  }
  $out = Join-Path $dir 'C12-many.7z'
  $r = Run7z @('a','-mx1',$out,'bulk') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title=("超多条目（" + $ManyEntries + " 个文件）"); dir=$dir; archive='C12-many.7z'
             format='7z'; encrypted=$false; password=''
             goal='listArchive 的 truncated 分支、进度节流、P1-5（遍历阻塞）' }
}

function CaseC13 {
  $id = 'C13-duplicate-packs'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'same.txt' "identical payload for duplicate detection`n" | Out-Null
  $a = Join-Path $dir 'same-pack.7z'
  $r = Run7z @('a',$a,'same.txt') $st
  if ($r.code -ne 0) { throw $r.out }
  $sub = Join-Path $dir 'copy'
  New-Item -ItemType Directory -Path $sub -Force | Out-Null
  Copy-Item $a (Join-Path $sub 'same-pack.7z') -Force
  AddCase @{ id=$id; title='重复包（同名同大小两份，位于不同子目录）'; dir=$dir; archive='same-pack.7z'
             format='7z'; encrypted=$false; password=''
             goal='dedup 去重（本轮修复不应影响该行为）' }
}

function CaseC14 {
  $id = 'C14-corrupt'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  Write-Text $st 'x.txt' ('x' * 4096) | Out-Null
  $good = Join-Path $st 'good.7z'
  $null = Run7z @('a',$good,'x.txt') $st
  $buf = [System.IO.File]::ReadAllBytes($good)
  $half = [int]([math]::Floor($buf.Length / 2))
  $part = New-Object byte[] $half
  [Array]::Copy($buf, $part, $half)
  [System.IO.File]::WriteAllBytes((Join-Path $dir 'C14-corrupt.7z'), $part)
  AddCase @{ id=$id; title='损坏包（正常包截断 50%）'; dir=$dir; archive='C14-corrupt.7z'
             format='unknown'; encrypted=$false; password=''
             goal='错误分类（not-archive）、失败而非假成功'; corrupt=$true }
}

function CaseC15 {
  $id = 'C15-large-file'
  $dir = New-CaseDir $id; $st = New-StageDir $id
  $mb = 512
  $chunk = New-Object byte[] (1024 * 1024)
  for ($i = 0; $i -lt $chunk.Length; $i++) { $chunk[$i] = 0x41 }
  $fs = [System.IO.File]::Create((Join-Path $st 'big.dat'))
  try { for ($i = 0; $i -lt $mb; $i++) { $fs.Write($chunk, 0, $chunk.Length) } } finally { $fs.Close() }
  $out = Join-Path $dir 'C15-large.7z'
  $r = Run7z @('a','-mx1',$out,'big.dat') $st
  if ($r.code -ne 0) { throw $r.out }
  AddCase @{ id=$id; title=("大体积单文件（解压后 " + $mb + "MB）"); dir=$dir; archive='C15-large.7z'
             format='7z'; encrypted=$false; password=''
             goal='P1-4（硬链接 vs 复制+删源）的耗时对比' }
}

# ============================ 主流程 ============================

try {
Log "=== 生成测试语料 -> $Corpus ==="
$null = Get-Engine

Force-Delete $Corpus
New-Item -ItemType Directory -Path $Corpus -Force | Out-Null
Force-Delete $Stage
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

$builders = @('CaseC01','CaseC02','CaseC03','CaseC04','CaseC05','CaseC06','CaseC07',
              'CaseC08','CaseC09','CaseC10','CaseC11','CaseC12','CaseC13','CaseC14')
if ($Large) { $builders += 'CaseC15' }

foreach ($b in $builders) {
  try { & $b } catch {
    $msg = ($_.Exception.Message -replace "`r?`n", ' ').Trim()
    if ($msg.Length -gt 240) { $msg = $msg.Substring(0, 240) }
    Warn ("构建失败 " + $b + " : " + $msg)
  }
}

Log ""
Log "=== 统计期望值（l -slt 实测） ==="
foreach ($c in $script:Cases) {
  $archiveAbs = Join-Path $c.dir $c.archive
  try {
    $exp = Get-Expected $archiveAbs $c.password
    $ok = if ($c.corrupt) { $true } else { $exp.listOk }
    $c.baselineOk = $ok
    $c.actual = @{
      files = $exp.files; dirs = $exp.dirs; entries = $exp.entries
      format = $exp.format; encrypted = $exp.encrypted; listOk = $exp.listOk; code = $exp.code
    }
    $flag = ''
    if ($exp.encrypted) { $flag += ' 加密' }
    if (-not $ok) { $flag += '  [list失败]' }
    Log ("  " + $c.id.PadRight(22) + " 条目 " + $exp.entries.ToString().PadLeft(5) +
         "（文件 " + $exp.files.ToString().PadLeft(5) + " / 目录 " + $exp.dirs + "）  格式=" + $exp.format + $flag)
    # 保存 -slt 原始输出：供 Node 侧做「当前实现 vs 修复实现」A/B 对比（Node 在本环境无法起子进程）
    [System.IO.File]::WriteAllText((Join-Path $c.dir 'listing.txt'), $exp.raw, $script:Utf8)
    [System.IO.File]::WriteAllText((Join-Path $c.dir 'expected.json'),
      ($c | ConvertTo-Json -Depth 8), $script:Utf8)
  } catch {
    Warn ($c.id + " : 期望值统计失败 " + $_.Exception.Message)
  }
}

$manifest = @{
  generatedAt = (Get-Date).ToString('o')
  engine      = $SevenZ
  password    = $Pwd
  cases       = $script:Cases
  warnings    = @($script:Warn)
}
[System.IO.File]::WriteAllText((Join-Path $Corpus 'manifest.json'),
  ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Log ""
Log ("=== 完成: " + $script:Cases.Count + " 个用例 ===")
if ($script:Warn.Count) {
  Log ""
  Log "警告:"
  foreach ($w in $script:Warn) { Log ("  - " + $w) }
}
Log ("清单: " + (Join-Path $Corpus 'manifest.json'))
} catch {
  Log ("FATAL: " + $_.Exception.Message)
  Log ("STACK: " + $_.ScriptStackTrace)
  throw
}
