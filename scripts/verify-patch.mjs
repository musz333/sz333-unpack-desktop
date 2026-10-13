#!/usr/bin/env node
/**
 * verify-patch.mjs —— 无 tsc 环境下的补丁自检
 *
 * 背景：本机没有 node_modules（无法运行 `npm run typecheck`）。这里做两项替代性检查：
 *   ① 对改动过的 TS 文件做**括号配平**（跳过字符串 / 模板串 / 注释 / **正则字面量**），
 *      发现明显的语法断裂；
 *   ② 断言每个修复点的**关键代码特征**存在 / 旧缺陷特征已消失，防止"改漏"。
 *
 * 注意：括号配平是启发式的 —— 它只用于发现"括号明显不配对"这类低级错误，
 *       不能替代真正的类型检查。修复后仍应在有 node_modules 的环境跑一次 `npm run typecheck`。
 *
 * 用法：node scripts/verify-patch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

/** 这些字符之后出现的 `/` 更可能是正则字面量的开始（而非除号） */
const REGEX_PREV = '(,=:[!&|?{};+-*%^~<>';

function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  return REGEX_PREV.includes(src[j]);
}

/* ---------------------------- ① 括号配平 ---------------------------- */
function balanceCheck(abs) {
  const src = fs.readFileSync(abs, 'utf8');
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  let line = 1;

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];

    if (c === '\n') {
      line += 1;
      if (inLine) inLine = false;
      continue;
    }
    if (inLine) continue;
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }

    if (c === '/' && n === '/') { inLine = true; i += 1; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 1; continue; }

    // 正则字面量：整体跳过（含字符类里的引号与斜杠）
    if (c === '/' && isRegexStart(src, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < src.length; j += 1) {
        const ch = src[j];
        if (ch === '\\') { j += 1; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      i = j;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }

    if (c === '(' || c === '[' || c === '{') stack.push({ c, line });
    else if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) {
        return {
          ok: false,
          line,
          msg: `第 ${line} 行出现不匹配的 "${c}"（栈顶：${top ? top.c + ' @' + top.line : '空'}）`
        };
      }
    }
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    return { ok: false, line: t.line, msg: `第 ${t.line} 行的 "${t.c}" 未闭合` };
  }
  return { ok: true };
}

/* ---------------------------- ② 关键改动断言 ---------------------------- */
const CHECKS = [
  {
    file: 'src/main/tasks.ts',
    name: 'P0-1 cleanupPartial 只清理自建目录',
    must: [/private cleanupPartial\(outDir: string, auto: boolean\): boolean/, /cleanupPartial\(outDir, outDirAuto\)/],
    mustNot: [/cleanupPartial\(outDir, src\)/]
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P0-6 取消信号总线（abort 真正被触发）',
    must: [/t\.abort\?\.abort\(\)/],
    mustNot: []
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P0-3 锁释放改用闭包对象',
    must: [/const release = t\.releaseOutLock;/],
    mustNot: [/const cur = this\.tasks\.get\(id\);/]
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P0-4 暂停/取消分流',
    must: [/private pauseFlags = new Set<string>\(\)/, /private settleAborted\(/, /this\.pauseFlags\.delete\(t\.id\)/],
    mustNot: []
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P0-5 APK 过滤用 finalOutDir + P1-6 用户目录保护',
    must: [/filterApks\(finalOutDir, settings\.apkDropThreshold, \{ allowDropWholeDir: outDirAuto \}\)/],
    mustNot: [/filterApks\(outDir, settings\.apkDropThreshold\)/]
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P1-2/P1-3 密码记忆走统一回调',
    must: [/this\.deps\.rememberPassword\(password\)/],
    mustNot: [/this\.deps\.emit\(\{ \.\.\.this\.publicTask\(t\) \}\)/]
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P1-4 硬链接优先',
    must: [/fs\.linkSync\(from, to\)/],
    mustNot: []
  },
  {
    file: 'src/main/tasks.ts',
    name: 'P1-5 dirStats 异步化',
    must: [
      /async function dirStats\(dir: string\): Promise<\{ files: number; size: number \}>/,
      /await dirStats\(/
    ],
    mustNot: []
  },
  {
    file: 'src/main/engine.ts',
    name: 'P0-2 parseListing 按 Path 切块 + 头部状态机',
    must: [/let inHeader = true/, /if \(k === 'Path'\)/, /if \(line\.length >= 10\) inHeader = false/],
    mustNot: [/line\.startsWith\('----------'\)/]
  },
  {
    file: 'src/main/apkFilter.ts',
    name: 'P1-6 filterApks 支持 allowDropWholeDir',
    must: [/export interface ApkFilterOptions/, /allowDropWholeDir/],
    mustNot: [/function collectApks\(/, /function totalBytes\(/]
  },
  {
    file: 'src/main/apkFilter.ts',
    name: 'P1-5 单遍遍历',
    must: [/function scanTree\(root: string\): \{ apks: ApkEntry\[\]; total: number \}/],
    mustNot: []
  },
  {
    file: 'src/main/index.ts',
    name: 'P1-1 历史按 id 幂等 upsert',
    must: [/const idx = history\.findIndex\(\(h\) => h\.id === task\.id\)/],
    mustNot: []
  },
  {
    file: 'src/main/index.ts',
    name: 'P1-2/P1-3 rememberPassword 注入',
    must: [
      /rememberPassword: \(pwd: string\) => \{/,
      /settings\.passwords = \[pwd, \.\.\.settings\.passwords\]\.slice\(0, 30\)/
    ],
    mustNot: []
  }
];

/* ---------------------------- 主流程 ---------------------------- */
const files = [...new Set(CHECKS.map((c) => c.file))];
let fail = 0;

console.log('');
console.log('===== 补丁自检（无 tsc 环境的替代体检） =====');
console.log('');
console.log('--- ① 括号配平 ---');
for (const f of files) {
  const abs = path.join(PROJECT, f);
  if (!fs.existsSync(abs)) {
    console.log(`  [FAIL] ${f}（文件缺失）`);
    fail += 1;
    continue;
  }
  const r = balanceCheck(abs);
  if (r.ok) console.log(`  [OK]   ${f}`);
  else {
    console.log(`  [FAIL] ${f} —— ${r.msg}`);
    fail += 1;
  }
}

console.log('');
console.log('--- ② 关键改动断言 ---');
for (const c of CHECKS) {
  const abs = path.join(PROJECT, c.file);
  if (!fs.existsSync(abs)) {
    console.log(`  [FAIL] ${c.name}（文件缺失：${c.file}）`);
    fail += 1;
    continue;
  }
  const src = fs.readFileSync(abs, 'utf8');
  const missing = (c.must || []).filter((re) => !re.test(src));
  const stale = (c.mustNot || []).filter((re) => re.test(src));
  if (!missing.length && !stale.length) {
    console.log(`  [OK]   ${c.name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${c.name}`);
    for (const re of missing) console.log(`         缺少：${re}`);
    for (const re of stale) console.log(`         仍残留旧特征：${re}`);
  }
}

console.log('');
console.log(
  fail === 0
    ? `结论：全部通过（${CHECKS.length} 项断言 + ${files.length} 个文件配平）`
    : `结论：${fail} 项未通过`
);
console.log('');

process.exitCode = fail === 0 ? 0 : 1;
