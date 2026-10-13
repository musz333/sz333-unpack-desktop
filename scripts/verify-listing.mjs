#!/usr/bin/env node
/**
 * verify-listing.mjs —— parseListing 解析层回归（修复前基线 / 修复后验收）
 *
 * 为什么这样设计：
 *   本环境禁止 Node 创建子进程（spawnSync 一律 EBUSY），Node 无法调用 7z。
 *   因此 `7z l -slt` 的原始输出由 scripts/make-test-corpus.ps1 预先导出到
 *   test-corpus/<case>/listing.txt；本脚本只做「读文件 → 双实现解析 → 对比期望」。
 *
 * 两个实现：
 *   A. parseCurrent —— 严格复刻 v1.0.6 的 src/main/engine.ts::parseListing（含缺陷）
 *   B. parseFixed   —— 修复目标：按 Path 切块 + 头部状态机（见修复方案 P0-2）
 *
 * 用法：
 *   node scripts/verify-listing.mjs
 *
 * 判读：
 *   修复前：A 列应大量 FAIL（这就是基线红灯），B 列应全 PASS。
 *   修复后：把 B 的逻辑落到 engine.ts，再用真实应用复测；本脚本 B 列即为验收标准。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const CORPUS = path.join(PROJECT, 'test-corpus');

/* ==========================================================================
 * 实现 A：v1.0.6 的 parseListing（复刻，保留缺陷）
 * ========================================================================== */
function parseCurrent(stdout) {
  const lines = stdout.split(/\r?\n/);
  const entries = [];
  let cur = {};
  let archiveType = 'unknown';
  let encrypted = false;

  const flush = () => {
    if (!cur.path) { cur = {}; return; }
    const isDir = (cur.attributes && cur.attributes.includes('D')) || cur.path.endsWith('\\') || cur.path.endsWith('/');
    entries.push({ path: cur.path, size: cur.size ?? 0, isDir: !!isDir, encrypted: !!cur.encrypted });
    cur = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && line.startsWith('Listing archive:')) continue;

    if (line.startsWith('----------')) { flush(); continue; }

    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 3).trim();

    switch (k) {
      case 'Path': cur.path = v; break;
      case 'Type':
        if (!cur.path) {
          if (['7z', 'zip', 'rar', 'tar', 'bzip2', 'xz', 'cab'].includes(v)) archiveType = v;
          else if (v === 'gzip') archiveType = 'gz';
        } else if (v === 'Directory') cur.attributes = 'D';
        break;
      case 'Size': if (cur.path) cur.size = Number(v) || 0; break;
      case 'Packed Size': if (cur.path) cur.packedSize = Number(v) || 0; break;
      case 'Attributes': cur.attributes = v; break;
      case 'Encrypted': if (cur.path) cur.encrypted = v === '+'; else if (v === '+') encrypted = true; break;
      case 'CRC': cur.crc = v; break;
      case 'Modified': cur.modified = v; break;
      case 'Method': if (v && cur.path && v !== 'Store' && /AES/i.test(v)) cur.encrypted = true; break;
      default: break;
    }
  }
  flush();

  if (archiveType === 'unknown' && entries.length) archiveType = 'zip';
  return {
    entries: entries.length,
    files: entries.filter((e) => !e.isDir).length,
    dirs: entries.filter((e) => e.isDir).length,
    format: archiveType,
    list: entries
  };
}

/* ==========================================================================
 * 实现 B：**直接取自 src/main/engine.ts 的真实实现**
 *
 * 为什么不用内联副本：内联副本只能证明"目标逻辑是对的"，不能证明
 * "engine.ts 里落地的就是它"。这里把 engine.ts 的 parseListing 源码抠出来
 * （剥离最小必要的 TS 类型注解）后用 new Function 执行 —— 验证的**就是产品代码**。
 *
 * 若提取失败（源码结构变动等），回退到内联副本并打印告警。
 * ========================================================================== */
function loadEngineParseListing() {
  const srcPath = path.join(PROJECT, 'src/main/engine.ts');
  if (!fs.existsSync(srcPath)) return null;
  const src = fs.readFileSync(srcPath, 'utf8');

  const start = src.indexOf('export function parseListing(');
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;

  // 括号配平（跳过字符串 / 模板串 / 行注释 / 块注释）
  let depth = 0;
  let i = braceStart;
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i += 1; } continue; }
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i += 1; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }

  let body = src.slice(start, i + 1);
  body = body
    .replace(/export function parseListing\(([^)]*)\)(\s*:\s*[\w.<>[\]\s]+)?/, 'function parseListing(stdout)')
    .replace(/:\s*ArchiveEntry\[\]/g, '')
    .replace(/:\s*PendingEntry/g, '')
    .replace(/:\s*ArchiveFormat/g, '')
    .replace(/\s+as\s+ArchiveFormat/g, '');

  try {
    // eslint-disable-next-line no-new-func
    return new Function(`${body}\nreturn parseListing;`)();
  } catch (e) {
    console.warn(`[warn] 从 engine.ts 提取 parseListing 失败，回退到内联副本：${e.message}`);
    return null;
  }
}

/**
 * 把 engine.ts 的 ParsedListing 结果适配成本脚本统一的比较结构。
 *   engine 返回 { archiveType, entries: ArchiveEntry[], ... }
 *   内联副本返回 { format, entries: number, list[] }
 */
function adaptEngineImpl(fn) {
  return (stdout) => {
    const r = fn(stdout) || {};
    const list = Array.isArray(r.entries) ? r.entries : [];
    return {
      entries: list.length,
      files: list.filter((e) => !e.isDir).length,
      dirs: list.filter((e) => e.isDir).length,
      format: r.archiveType ?? 'unknown',
      list
    };
  };
}

/* 内联副本（仅当上面的提取失败时作为回退，逻辑与修复方案一致） */
function parseFixedInline(stdout) {
  const lines = stdout.split(/\r?\n/);
  const entries = [];
  let cur = {};
  let archiveType = 'unknown';
  let encrypted = false;
  let inHeader = true;

  const flush = () => {
    if (cur.path === undefined) { cur = {}; return; }
    if (!inHeader) {
      const p = cur.path;
      const isDir = (cur.attributes && cur.attributes.includes('D')) || p.endsWith('\\') || p.endsWith('/');
      entries.push({ path: p, size: cur.size ?? 0, isDir: !!isDir, encrypted: !!cur.encrypted });
    }
    cur = {};
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Listing archive:')) continue;

    if (/^-{2,}$/.test(line)) {
      flush();
      if (line.length >= 10) inHeader = false;
      continue;
    }

    const eq = line.indexOf(' = ');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 3).trim();

    if (k === 'Path') {
      if (cur.path !== undefined) flush();
      cur.path = v;
      continue;
    }

    switch (k) {
      case 'Type':
        if (inHeader) {
          if (['7z', 'zip', 'rar', 'tar', 'bzip2', 'xz', 'cab'].includes(v)) archiveType = v;
          else if (v === 'gzip') archiveType = 'gz';
        } else if (v === 'Directory') cur.attributes = 'D';
        break;
      case 'Size': cur.size = Number(v) || 0; break;
      case 'Packed Size': cur.packedSize = Number(v) || 0; break;
      case 'Attributes': cur.attributes = v; break;
      case 'Encrypted': if (v === '+') cur.encrypted = true; break;
      case 'CRC': cur.crc = v; break;
      case 'Modified': cur.modified = v; break;
      case 'Method': if (v && v !== 'Store' && /AES/i.test(v)) cur.encrypted = true; break;
      default: break;
    }
  }
  flush();

  if (archiveType === 'unknown' && entries.length) archiveType = 'zip';
  return {
    entries: entries.length,
    files: entries.filter((e) => !e.isDir).length,
    dirs: entries.filter((e) => e.isDir).length,
    format: archiveType,
    list: entries
  };
}

/* ==========================================================================
 * 对比
 * ========================================================================== */
function eq(a, b) { return a === b; }

function judge(actual, expect, isCorrupt) {
  if (isCorrupt) {
    // 损坏包：只要求不崩、且不虚构条目
    return { pass: actual.entries === 0, note: '损坏包：应解析出 0 条目' };
  }
  const fails = [];
  if (!eq(actual.entries, expect.entries)) fails.push(`条目 ${actual.entries}≠${expect.entries}`);
  if (!eq(actual.files, expect.files)) fails.push(`文件 ${actual.files}≠${expect.files}`);
  if (!eq(actual.dirs, expect.dirs)) fails.push(`目录 ${actual.dirs}≠${expect.dirs}`);
  if (!eq(actual.format, expect.format)) fails.push(`格式 ${actual.format}≠${expect.format}`);
  return { pass: fails.length === 0, note: fails.join('; ') };
}

function main() {
  if (!fs.existsSync(CORPUS)) {
    console.error(`找不到语料目录：${CORPUS}\n请先运行 scripts/make-test-corpus.ps1 生成语料。`);
    process.exit(1);
  }

  const manifestPath = path.join(CORPUS, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`找不到 manifest.json：${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 优先用 engine.ts 的真实实现；提取失败才回退内联副本
  const engineImpl = loadEngineParseListing();
  const parseB = engineImpl ? adaptEngineImpl(engineImpl) : parseFixedInline;
  const implSource = engineImpl ? 'src/main/engine.ts（真实实现）' : '内联副本（提取失败）';

  const rows = [];
  let curPass = 0;
  let fixPass = 0;
  let total = 0;

  for (const c of manifest.cases) {
    const listingPath = path.join(c.dir, 'listing.txt');
    if (!fs.existsSync(listingPath)) {
      rows.push({ id: c.id, title: c.title, skipped: true, reason: '缺少 listing.txt' });
      continue;
    }
    const stdout = fs.readFileSync(listingPath, 'utf8');
    const expect = c.actual ?? { entries: 0, files: 0, dirs: 0, format: 'unknown' };
    const isCorrupt = !!c.corrupt;

    const A = parseCurrent(stdout);
    const B = parseB(stdout);
    const jA = judge(A, expect, isCorrupt);
    const jB = judge(B, expect, isCorrupt);

    total += 1;
    if (jA.pass) curPass += 1;
    if (jB.pass) fixPass += 1;

    rows.push({
      id: c.id,
      title: c.title,
      expect: `${expect.entries}(${expect.files}f/${expect.dirs}d) ${expect.format}`,
      current: `${A.entries}(${A.files}f/${A.dirs}d) ${A.format}`,
      fixed: `${B.entries}(${B.files}f/${B.dirs}d) ${B.format}`,
      passA: jA.pass,
      passB: jB.pass,
      noteA: jA.note,
      noteB: jB.note,
      sample: c.id.startsWith('C01') || c.id.startsWith('C02')
        ? { A: A.list.map((e) => e.path), B: B.list.map((e) => e.path) }
        : undefined
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);

  console.log('');
  console.log('===== parseListing 解析层回归 =====');
  console.log('  实现 A = v1.0.6 旧逻辑（基线对照，应当大面积失败）');
  console.log(`  实现 B = ${implSource}`);
  console.log('');
  console.log(pad('用例', 24) + pad('期望', 22) + pad('当前实现', 22) + pad('修复实现', 22) + '判定');
  console.log('-'.repeat(112));
  for (const r of rows) {
    if (r.skipped) {
      console.log(pad(r.id, 24) + `跳过：${r.reason}`);
      continue;
    }
    const verdict = `${r.passA ? 'A:OK' : 'A:FAIL'} / ${r.passB ? 'B:OK' : 'B:FAIL'}`;
    console.log(pad(r.id, 24) + pad(r.expect, 22) + pad(r.current, 22) + pad(r.fixed, 22) + verdict);
  }
  console.log('-'.repeat(112));
  console.log(`当前实现通过：${curPass}/${total}    修复实现通过：${fixPass}/${total}`);
  console.log('');

  // 差异明细
  const bad = rows.filter((r) => !r.skipped && !r.passA);
  if (bad.length) {
    console.log('===== 当前实现的失败明细 =====');
    for (const r of bad) {
      console.log(`\n[${r.id}] ${r.title}`);
      console.log(`  期望 ${r.expect} / 实得 ${r.current}`);
      console.log(`  差异：${r.noteA}`);
      if (r.sample) {
        console.log(`  当前解析出的条目：${JSON.stringify(r.sample.A)}`);
        console.log(`  修复后应为：      ${JSON.stringify(r.sample.B)}`);
      }
    }
    console.log('');
  }

  const stillBad = rows.filter((r) => !r.skipped && !r.passB);
  if (stillBad.length) {
    console.log('===== 修复实现仍未通过的用例（需检查语料或实现） =====');
    for (const r of stillBad) console.log(`  [${r.id}] ${r.noteB}`);
    console.log('');
  }

  console.log(`结论：当前实现 ${curPass}/${total} 通过（基线红灯 ${total - curPass} 项），修复实现 ${fixPass}/${total} 通过。`);
  console.log('');

  process.exitCode = fixPass === total ? 0 : 1;
}

main();
