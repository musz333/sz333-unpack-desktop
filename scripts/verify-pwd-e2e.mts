/**
 * _verify-pwd-e2e.mts —— 用**真实 7z.exe** 验证「stdin 传密码」这条修复路径功能正常
 *
 * 说明：本环境沙箱禁止从 Node 启动系统程序（powershell/wmic 返回 EBUSY），
 * 因此"解压时去抓 7z 进程命令行"这一步无法在此执行 —— 那部分改由
 * `_verify-fixes.mts` 的 D2 组完成（直接拦截 run7z 实际构造的 argv，证据更直接）。
 *
 * 本脚本负责证明另一件事：**改成 stdin 传密码后，功能没有回归** ——
 *   · 加密包（含 -mhe=on 头部加密）能用 stdin 密码正常解压；
 *   · 加密包 `l -slt` 列表能用 stdin 密码正常列出；
 *   · 无密码包 + stdin 立即 EOF → 正常解压；
 *   · 密码错误 / 未提供 → 快速失败，**不会挂起**。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  [OK]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail ? `\n         ${detail}` : ''}`);
  }
};

const SRC = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'resources');
const binDir = path.join(os.tmpdir(), 'sz333-e2e-bin');
const work = path.join(os.tmpdir(), 'sz333-e2e-work');
fs.rmSync(binDir, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.copyFileSync(path.join(SRC, '7z.exe'), path.join(binDir, '7z.exe'));
fs.copyFileSync(path.join(SRC, '7z.dll'), path.join(binDir, '7z.dll'));
const bin = path.join(binDir, '7z.exe');

/** 模拟 run7z：密码走 stdin；返回 { code, out, timedOut } */
function run(args: string[], password?: string, timeoutMs = 15000): Promise<{ code: number | string; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    if (c.stdin) {
      if (password) c.stdin.write(password + '\n');
      c.stdin.end();
    }
    const t = setTimeout(() => {
      try { c.kill(); } catch { /* ignore */ }
      resolve({ code: 'TIMEOUT', out, timedOut: true });
    }, timeoutMs);
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out, timedOut: false });
    });
    c.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: String(e), timedOut: false });
    });
  });
}

const PWD = 'P@ssw0rd-E2E-2026';
fs.mkdirSync(path.join(work, 'payload'), { recursive: true });
for (let i = 0; i < 20; i += 1) {
  fs.writeFileSync(path.join(work, 'payload', `f${i}.txt`), `content ${i}\n`.repeat(20));
}
fs.writeFileSync(path.join(work, 'plain.txt'), 'no password\n');

await run(['a', '-t7z', `-p${PWD}`, '-mhe=on', 'enc.7z', 'payload']);
await run(['a', '-t7z', 'plain.7z', 'plain.txt']);
ok('准备：加密包 + 无密码包已生成', fs.existsSync(path.join(work, 'enc.7z')) && fs.existsSync(path.join(work, 'plain.7z')));

console.log('\n1) 加密包：stdin 传正确密码解压');
{
  const r = await run(['x', '-y', '-oout_ok', 'enc.7z'], PWD);
  ok('  退出码 0', r.code === 0, `code=${r.code}`);
  ok('  产物落地', fs.existsSync(path.join(work, 'out_ok', 'payload', 'f0.txt')));
}

console.log('\n2) 加密包：stdin 传密码列目录（-mhe=on 头部加密）');
{
  const r = await run(['l', '-slt', '-sccUTF-8', '--', 'enc.7z'], PWD);
  ok('  退出码 0', r.code === 0, `code=${r.code}`);
  ok('  能列出内部文件', /f0\.txt/.test(r.out));
  ok('  未出现 Wrong password', !/Wrong password/i.test(r.out));
}

console.log('\n3) 加密包：密码错误 → 快速失败且不挂起');
{
  const r = await run(['x', '-y', '-oout_bad', 'enc.7z'], 'WRONG-PWD');
  ok('  未挂起', r.timedOut === false);
  ok('  退出码非 0', r.code !== 0 && r.code !== 'TIMEOUT', `code=${r.code}`);
  ok('  未产出文件', !fs.existsSync(path.join(work, 'out_bad', 'payload', 'f0.txt')));
}

console.log('\n4) 加密包：不提供密码（stdin EOF）→ 快速失败且不挂起');
{
  const r = await run(['x', '-y', '-oout_none', 'enc.7z']);
  ok('  未挂起', r.timedOut === false);
  ok('  退出码非 0', r.code !== 0 && r.code !== 'TIMEOUT', `code=${r.code}`);
  ok('  提示需要密码', /Enter password|Wrong password|Cannot open encrypted/i.test(r.out));
}

console.log('\n5) 无密码包：stdin 立即 EOF → 正常解压（不因 stdin 改动而回归）');
{
  const r = await run(['x', '-y', '-oout_plain', 'plain.7z']);
  ok('  退出码 0', r.code === 0, `code=${r.code}`);
  ok('  产物落地', fs.existsSync(path.join(work, 'out_plain', 'plain.txt')));
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(64));
process.exitCode = fail === 0 ? 0 : 1;
