/**
 * _syntax-check.mts —— 对**所有被修改的文件**做静态体检
 *
 * 本机没有 node_modules（跑不了 tsc），所以：
 *   · .ts/.tsx：做"括号配平"（跳过字符串/模板串/注释/正则），发现明显语法断裂；
 *   · .mjs    ：用 `node --check` 做真正的语法解析。
 * 另外，能安全加载的 .ts 模块（无 electron/react 依赖）已在 _verify-fixes.mts 中
 * 被真实 import 过 —— 那本身就是一次语法与链接验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 项目根（本脚本位于 <项目>/scripts/ 下，取上一级） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REGEX_PREV = '(,=:[!&|?{};+-*%^~<>';
/**
 * 判断 `/` 是否为正则字面量的开始。
 *
 * @param jsx tsx 模式下要额外排除两种 **JSX 语法**，否则会被误判：
 *   · `/>`（自闭合标签，如 `<Icon size={16} />`）—— `/` 前一个是 `}`，
 *     而 `}` 在 REGEX_PREV 里，会被当成"正则开始"；
 *   · `</`（闭合标签，如 `</p>`）—— `/` 前一个是 `<`，同样在 REGEX_PREV 里。
 *   这两种误判会让检查器把后面大段代码当正则/注释跳过，产生**假失败**。
 */
const isRegexStart = (src: string, i: number, jsx: boolean): boolean => {
  if (jsx) {
    if (src[i + 1] === '>') return false; // JSX 自闭合 />
    let k = i - 1;
    while (k >= 0 && /\s/.test(src[k])) k -= 1;
    if (k >= 0 && src[k] === '<') return false; // JSX 闭合 </
  }
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  return REGEX_PREV.includes(src[j]);
};

/**
 * @param jsx 是否按 JSX 语法放宽正则判定（.tsx 传 true，.ts 传 false）
 */
function balanceCheck(abs: string, jsx: boolean): { ok: boolean; msg?: string } {
  const src = fs.readFileSync(abs, 'utf8');
  const stack: { c: string; line: number }[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let inStr: string | null = null;
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
    if (c === '/' && isRegexStart(src, i, jsx)) {
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
        return { ok: false, msg: `第 ${line} 行 "${c}" 不匹配（栈顶 ${top ? top.c + '@' + top.line : '空'}）` };
      }
    }
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    return { ok: false, msg: `第 ${t.line} 行的 "${t.c}" 未闭合` };
  }
  return { ok: true };
}

const changed = [
  'src/shared/volumeKey.ts',
  'src/main/engine.ts',
  'src/main/tasks.ts',
  'src/main/recursive.ts',
  'src/main/asciiPath.ts',
  'src/main/dedup.ts',
  'src/main/index.ts',
  'src/renderer/src/store.ts',
  'src/renderer/src/components/Dialogs.tsx',
  'src/renderer/src/components/WorkflowsView.tsx'
];

let pass = 0;
let fail = 0;

console.log('--- ① 括号配平（.tsx 按 JSX 规则放宽正则判定）---');
for (const rel of changed) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`  [FAIL] ${rel}（文件不存在）`);
    fail += 1;
    continue;
  }
  const r = balanceCheck(abs, rel.endsWith('.tsx'));
  if (r.ok) {
    console.log(`  [OK]   ${rel}`);
    pass += 1;
  } else {
    console.log(`  [FAIL] ${rel} —— ${r.msg}`);
    fail += 1;
  }
}

/* 用 `node --check` 做真正的语法解析（不链接、不执行）。
 * 旧实现用 `new vm.SourceTextModule(...)`，但它需要 `--experimental-vm-modules`，
 * 未带该 flag 时会抛 "vm.SourceTextModule is not a constructor" → 该段**恒 FAIL**。
 * `node --check` 是 Node 自带的语法检查，会按扩展名（.mjs）正确按 ESM 解析，无需任何 flag。
 * 注：本机沙箱下 spawnSync 会 EBUSY，故与 verify-pwd-e2e.mts 一致，改用异步 spawn。 */
const runNodeCheck = (abs: string): Promise<{ ok: boolean; msg: string }> =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, ['--check', abs], { windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => resolve({ ok: false, msg: String(e) }));
    c.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, msg: '' });
        return;
      }
      const raw = err.trim();
      resolve({
        ok: false,
        msg: raw ? raw.split('\n').slice(-3).join(' ') : `node --check 退出码 ${code}`
      });
    });
  });

console.log('\n--- ② ESM 语法解析（node --check，不执行）---');
for (const rel of ['scripts/ci-assert-release-assets.mjs', 'scripts/sync-release-checksums.mjs']) {
  const abs = path.join(ROOT, rel);
  const r = await runNodeCheck(abs);
  if (r.ok) {
    console.log(`  [OK]   ${rel}`);
    pass += 1;
  } else {
    console.log(`  [FAIL] ${rel} —— ${r.msg}`);
    fail += 1;
  }
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(64));
process.exitCode = fail === 0 ? 0 : 1;
