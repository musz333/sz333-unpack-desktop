/**
 * _verify-fixes.mts —— 对修复后的**真实源码**做断言验证
 *
 * 思路：不做"把逻辑抄一遍再测抄的那份"。而是把 `src/**` 原样复制到临时目录、
 * 只做两处机械改写（`@shared/x` → 相对路径、相对导入补 `.ts` 扩展名），
 * 然后用 Node 的 --experimental-strip-types 直接加载**真实模块**并调用其导出函数。
 * 这样断言的是交付源码本身，不是复述。
 *
 * 运行：
 *   node --experimental-strip-types _verify-fixes.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** 项目根（本脚本位于 <项目>/scripts/ 下，取上一级） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/* ------------------------------ 断言框架 ------------------------------ */
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  \u001b[32m[OK]\u001b[0m   ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  \u001b[31m[FAIL]\u001b[0m ${name}${detail ? `\n         ${detail}` : ''}`);
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
const section = (t: string) => console.log(`\n${t}`);

/* ------------------------------ 1. 物化源码 ------------------------------ */
/* 把 src 复制到临时目录，做两处机械改写：
 *   ① `@shared/xxx` → `./xxx`（Node 不认识 vite 别名）
 *   ② `from './xxx'` → `from './xxx.ts'`（Node ESM 要求显式扩展名）
 * 除此之外**一个字符都不改**，保证断言对象就是交付源码。 */
const work = path.join(os.tmpdir(), 'sz333-verify-src');
fs.rmSync(work, { recursive: true, force: true });

function materialize(rel: string, toDir: string): void {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) return;
  if (fs.statSync(from).isDirectory()) {
    for (const e of fs.readdirSync(from)) materialize(path.join(rel, e), toDir);
    return;
  }
  if (!rel.endsWith('.ts')) return;
  let code = fs.readFileSync(from, 'utf8');
  code = code.replace(/from '@shared\/([A-Za-z0-9_]+)'/g, "from './$1.ts'");
  code = code.replace(/from '\.\/([A-Za-z0-9_]+)'/g, "from './$1.ts'");
  /* engine.ts 的 child_process 换成"记账 shim"：这样调用真实 run7z 时
   * 能捕获它**实际构造的 argv 与 stdin**，用来证明密码不在命令行里。 */
  if (rel.split(path.sep).join('/').endsWith('main/engine.ts')) {
    code = code.replace(/from 'node:child_process'/g, "from './cp-shim.ts'");
  }
  const out = path.join(toDir, path.basename(rel));
  fs.writeFileSync(out, code, 'utf8');
}

const flat = path.join(work, 'flat');
fs.mkdirSync(flat, { recursive: true });
materialize('shared', flat);
materialize('main', flat);

/* 记账用的 child_process 替身：记录 spawn 的 bin/args/stdin，并立即"成功退出" */
fs.writeFileSync(
  path.join(flat, 'cp-shim.ts'),
  `import { EventEmitter } from 'node:events';
export interface SpawnCall { bin: string; args: string[]; opts: unknown; stdin: string; stdinEnded: boolean; }
export const spawnCalls: SpawnCall[] = [];
export function spawn(bin: string, args: string[], opts: unknown): any {
  const call: SpawnCall = { bin, args: args.slice(), opts, stdin: '', stdinEnded: false };
  spawnCalls.push(call);
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {};
  c.stderr = new EventEmitter(); c.stderr.setEncoding = () => {};
  c.stdin = {
    write: (s: string) => { call.stdin += s; return true; },
    end: () => { call.stdinEnded = true; },
    on: () => {}
  };
  c.kill = () => {};
  setTimeout(() => c.emit('close', 0), 0);
  return c;
}
`,
  'utf8'
);

const load = async (name: string) => import(pathToFileURL(path.join(flat, `${name}.ts`)).href);

/* tasks.ts 的 collectSourceFiles 是模块私有函数；为可断言，仅把它的声明补上 export。
 * （这是唯一一处为测试而做的改动，已在报告里说明。） */
{
  const p = path.join(flat, 'tasks.ts');
  if (fs.existsSync(p)) {
    let s = fs.readFileSync(p, 'utf8');
    s = s.replace('function collectSourceFiles(', 'export function collectSourceFiles(');
    fs.writeFileSync(p, s, 'utf8');
  }
}

const vk = await load('volumeKey');
const engine = await load('engine');
const recursive = await load('recursive');
const asciiPath = await load('asciiPath');
const tasks = await load('tasks');

const readSrc = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 只保留"代码行"，剔除注释行 —— 避免注释里提到旧写法时被断言误判 */
const codeLines = (s: string) =>
  s
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/* ================================================================== *
 * A. P0-2 —— 分卷识别与"同名非分卷文件"误删
 * ================================================================== */
section('A. P0-2 分卷识别（真实调用 shared/volumeKey.ts）');

eq('volumeKey(75.part1.rar) = 75', vk.volumeKey('75.part1.rar'), '75');
eq('volumeKey(a.7z.001) = a.7z', vk.volumeKey('a.7z.001'), 'a.7z');
eq('volumeKey(x.r00) = x', vk.volumeKey('x.r00'), 'x');
eq('volumeKey(movie.7z) = movie', vk.volumeKey('movie.7z'), 'movie');
// 缺陷根源：同名不同类文件的 key 相同
eq('volumeKey(movie.nfo) 同样 = movie（缺陷根源）', vk.volumeKey('movie.nfo'), 'movie');
// 护栏：isVolumeMember 能区分
ok('isVolumeMember(movie.nfo) = false', vk.isVolumeMember('movie.nfo') === false);
ok('isVolumeMember(movie.sfv) = false', vk.isVolumeMember('movie.sfv') === false);
ok('isVolumeMember(movie.txt) = false', vk.isVolumeMember('movie.txt') === false);
ok('isVolumeMember(movie.part1.rar) = true', vk.isVolumeMember('movie.part1.rar') === true);
ok('isVolumeMember(a.7z.002) = true', vk.isVolumeMember('a.7z.002') === true);
ok('isVolumeMember(x.r01) = true', vk.isVolumeMember('x.r01') === true);

section('A2. P0-2 端到端：真实调用 scanPaths / siblingsOfVolume');

{
  const dir = path.join(os.tmpdir(), 'sz333-p02');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // 造一个 7z 魔数文件（scanPaths 会按魔数识别）
  const sz333Magic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
  const mk = (n: string, buf: Buffer) => fs.writeFileSync(path.join(dir, n), buf);

  // 场景一：movie.7z 与同名的 movie.nfo / movie.sfv 在同一目录
  mk('movie.7z', sz333Magic);
  mk('movie.nfo', Buffer.from('release notes'));
  mk('movie.sfv', Buffer.from('checksums'));

  // scanPaths 已改为异步（读文件头/stat 走异步 IO）→ 必须 await
  const packs = await engine.scanPaths([dir]);
  const movie7z = packs.find((p) => p.primary.toLowerCase().endsWith('movie.7z'));
  ok('movie.7z 能成组', !!movie7z);
  if (movie7z) {
    eq('  movie.7z 组只含 1 个文件（不再把 .nfo/.sfv 当分卷）', movie7z.files.length, 1);
    eq('  该组不含 movie.nfo', movie7z.files.some((f) => f.toLowerCase().endsWith('movie.nfo')), false);
    eq('  该组不含 movie.sfv', movie7z.files.some((f) => f.toLowerCase().endsWith('movie.sfv')), false);
  }
  ok('movie.nfo 未被吞并（仍是独立条目）', packs.some((p) => p.primary.toLowerCase().endsWith('movie.nfo')));
  ok('movie.sfv 未被吞并（仍是独立条目）', packs.some((p) => p.primary.toLowerCase().endsWith('movie.sfv')));

  // 场景二：真正的分卷仍要被正确归并
  const dir2 = path.join(os.tmpdir(), 'sz333-p02b');
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.mkdirSync(dir2, { recursive: true });
  const rarMagic = Buffer.concat([Buffer.from('Rar!\u001a\u0007\u0000', 'latin1'), Buffer.alloc(8)]);
  fs.writeFileSync(path.join(dir2, 'RX.part1.rar'), rarMagic);
  fs.writeFileSync(path.join(dir2, 'RX.part2.rar'), rarMagic);
  fs.writeFileSync(path.join(dir2, 'RX.part3.rar'), rarMagic);
  fs.writeFileSync(path.join(dir2, 'RX.nfo'), Buffer.from('info'));

  const packs2 = await engine.scanPaths([dir2]);
  const rx = packs2.find((p) => p.primary.toLowerCase().endsWith('rx.part1.rar'));
  ok('真分卷 RX.part1/2/3.rar 被归为一组', !!rx);
  if (rx) {
    eq('  该组恰好 3 个分卷（不含 RX.nfo）', rx.files.length, 3);
    eq('  该组不含 RX.nfo', rx.files.some((f) => f.toLowerCase().endsWith('rx.nfo')), false);
  }

  // siblingsOfVolume：真实调用
  const sib = recursive.siblingsOfVolume(path.join(dir, 'movie.7z'));
  eq('siblingsOfVolume(movie.7z) 只含自己，不含 movie.nfo/.sfv', sib.length, 1);
  const sib2 = recursive.siblingsOfVolume(path.join(dir2, 'RX.part1.rar'));
  eq('siblingsOfVolume(RX.part1.rar) 收齐 3 个分卷', sib2.length, 3);
  eq('  且不含 RX.nfo', sib2.some((f) => f.toLowerCase().endsWith('rx.nfo')), false);

  // collectSourceFiles（同一谓词，模块私有函数已为断言补 export）
  const csf = tasks.collectSourceFiles([path.join(dir2, 'RX.part1.rar')], path.join(dir2, 'RX.part1.rar'));
  eq('collectSourceFiles 只收 3 个分卷（不会删掉 RX.nfo）', csf.length, 3);
  eq('  且不含 RX.nfo', csf.some((f) => f.toLowerCase().endsWith('rx.nfo')), false);
}

/* ================================================================== *
 * B. P0-3 —— 中文路径转换不再搬走用户目录
 * ================================================================== */
section('B. P0-3 路径 ASCII 化（真实调用 asciiPath.ts）');

{
  const r1 = asciiPath.ensureAsciiOutDir('D:\\我的下载\\资源包', 'resource');
  ok('父目录段「我的下载」原样保留', r1.dir.startsWith('D:\\我的下载\\'), `实际=${r1.dir}`);
  ok('叶子目录被 ASCII 化（changed=true）', r1.changed === true);
  ok('结果不含镜像父目录 u6211u7684…', !r1.dir.includes('u6211u7684'));

  const r2 = asciiPath.ensureAsciiOutDir('D:\\我的下载\\res', 'res');
  eq('父目录含中文但叶子已是 ASCII → 不做任何改名', r2.changed, false);
  eq('  返回原路径', r2.dir, 'D:\\我的下载\\res');

  const r3 = asciiPath.ensureAsciiOutDir('D:\\ascii\\res', 'res');
  eq('全 ASCII 短路径 → 不改名', r3.changed, false);

  // 用户指定目录：allowRenameDir=false 时绝不改目录名
  // applyAsciiPolicy 已改为异步（renameSync 等走异步 IO）→ 必须 await
  const r4 = await asciiPath.applyAsciiPolicy('D:\\我的下载\\我的资源', 'resource', { allowRenameDir: false });
  eq('用户指定目录：dirChanged=false（不再搬移）', r4.dirChanged, false);
  eq('  目录路径保持不变', r4.outDir, 'D:\\我的下载\\我的资源');
}

/* ================================================================== *
 * C. P0-4 —— APK 整包删除后不再自动删源
 * ================================================================== */
section('C. P0-4 APK 套壳删包后跳过删源');

{
  const t = readSrc('src/main/tasks.ts');
  ok(
    '存在「整包被删 → 跳过删源」的显式分支',
    /apkDroppedWholePackage\)\s*\{\s*\n\s*layersLog\.push/.test(t) || /settings\.sourcePolicy === 'delete' && apkDroppedWholePackage/.test(t)
  );
  ok(
    '删源分支叠加了 !apkDroppedWholePackage 条件',
    /settings\.sourcePolicy === 'delete' && !apkDroppedWholePackage/.test(t)
  );
  ok('有「已跳过删除源文件」的用户提示', /已跳过删除源文件/.test(t));
}

/* ================================================================== *
 * D. P1-1 —— 密码不再进命令行
 * ================================================================== */
section('D. P1-1 解压密码改走 stdin');

{
  const e = readSrc('src/main/engine.ts');
  const t = readSrc('src/main/tasks.ts');

  ok('run7z 提供 password 选项', /password\?:\s*string;/.test(e));
  ok('run7z 用 stdin 管道（stdio[0]=pipe）', /stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\]/.test(e));
  ok('run7z 把密码写入 stdin', /child\.stdin\.write\(opts\.password/.test(e));
  ok('run7z 总是 end() stdin（避免挂起）', /child\.stdin\.end\(\)/.test(e));

  ok('engine.ts 代码中不再出现 -p${password', !/-p\$\{password/.test(codeLines(e)));
  ok('tasks.ts 代码中不再出现 -p${layerPassword', !/-p\$\{layerPassword/.test(codeLines(t)));
  // 空密码探测（判断外层是否加密）现位于 tasks.ts 第 0 层；engine.ts 的 needsPassword 已作为死代码移除
  ok('探测加密仍用空密码 -p（不含真实密码，属预期）', /'l', '-slt', '-p', '--'/.test(t));
  ok('listArchive 通过 password 选项传密码', /run7z\(\{\s*args,\s*password:\s*password \|\| undefined\s*\}\)/.test(e));
  ok('解压调用点通过 password 选项传密码', /password:\s*layerPassword \|\| undefined/.test(t));
}

/* ================================================================== *
 * D2. P1-1 —— 拦截真实 run7z 的 spawn，检查它实际构造的 argv / stdin
 * ================================================================== */
section('D2. P1-1 真实调用 run7z：捕获实际 argv 与 stdin');

{
  const shim = await load('cp-shim');
  const SECRET = 'TOP_SECRET_PWD_123';

  // ① 解压场景（对应 tasks.ts 的 x 命令）
  await engine.run7z({ args: ['x', '-y', '-oOUT', '--', 'enc.7z'], password: SECRET }).promise;
  const c1 = shim.spawnCalls[shim.spawnCalls.length - 1];
  const argv1 = c1.args.join(' ');
  ok('解压：argv 中**不含**密码', !argv1.includes(SECRET), `argv=${argv1}`);
  ok('解压：argv 中不含 -p 参数', !/(^|\s)-p/.test(argv1), `argv=${argv1}`);
  ok('解压：密码确实写进了 stdin', c1.stdin.includes(SECRET));
  ok('解压：stdin 已关闭（避免挂起）', c1.stdinEnded === true);

  // ② 列表场景（对应 engine.ts 的 l -slt 命令）
  await engine.listArchive('C:\\fake\\enc.7z', SECRET);
  const c2 = shim.spawnCalls[shim.spawnCalls.length - 1];
  const argv2 = c2.args.join(' ');
  ok('列表：argv 中**不含**密码', !argv2.includes(SECRET), `argv=${argv2}`);
  ok('列表：密码写进了 stdin', c2.stdin.includes(SECRET));

  // ③ 无密码场景：stdin 立即 EOF
  await engine.run7z({ args: ['x', '--', 'plain.7z'] }).promise;
  const c3 = shim.spawnCalls[shim.spawnCalls.length - 1];
  eq('无密码：stdin 为空', c3.stdin, '');
  ok('无密码：stdin 仍被关闭', c3.stdinEnded === true);
}

/* ================================================================== *
 * E. P1-2 / P1-3 / P1-4 —— 锁 key 与状态残留
 * ================================================================== */
section('E. P1-2/3/4 锁 key 与状态残留');

{
  const t = readSrc('src/main/tasks.ts');
  const idx = readSrc('src/main/index.ts');

  ok('锁 key 使用 plannedOutDir（与最终写入路径对齐）', /path\.resolve\(plannedOutDir\)\.toLowerCase\(\)/.test(t));
  ok('  取锁前预先计算 plannedOutDir', /let plannedOutDir = outDir;/.test(t));
  ok('  ASCII 化时的 preferBase 与预计算一致（resourceStem）', /applyAsciiPolicy\(outDir, resourceStem,/.test(t));

  ok('pauseFlags 在 execute 入口清理', /this\.pauseFlags\.delete\(id\);/.test(t));

  const previewIdx = idx.indexOf("'workflow:importPreview'");
  const clearIdx = idx.indexOf('importCache.clear()');
  ok('importPreview 中清空上一批缓存', previewIdx >= 0 && clearIdx > previewIdx);
}

/* ================================================================== *
 * F. P2 —— 重复实现收敛 / 死代码 / 版本门禁
 * ================================================================== */
section('F. P2 收敛、死代码与版本门禁');

{
  const store = readSrc('src/renderer/src/store.ts');
  const dedup = readSrc('src/main/dedup.ts');
  const e = readSrc('src/main/engine.ts');
  const dialogs = readSrc('src/renderer/src/components/Dialogs.tsx');
  const wfView = readSrc('src/renderer/src/components/WorkflowsView.tsx');

  ok('renderer/store.ts 从 @shared/volumeKey 导入 normalizeCopyName', /from '@shared\/volumeKey'/.test(store));
  ok('  且不再本地手抄实现', !/function normalizeCopyName/.test(store));
  ok('main/dedup.ts 复用 shared 实现', /from '@shared\/volumeKey'/.test(dedup));
  ok('  且不再本地定义 volumeBase（死代码已删）', !/function volumeBase/.test(dedup));

  ok('engine.ts 死代码 execFileAsync 已移除', !/execFileAsync/.test(e));
  ok('  engine.ts 不再导入 execFile/promisify', !/import \{ execFile/.test(e));
  ok('Dialogs.tsx 死代码 PanelEmptyWrapper 已移除', !/PanelEmptyWrapper/.test(dialogs));
  ok('WorkflowsView.tsx 冗余再导出已移除', !/export \{ ratio \}/.test(wfView));

  ok('volumeKey 已抽到 shared/volumeKey.ts', fs.existsSync(path.join(ROOT, 'src/shared/volumeKey.ts')));

  const ci = readSrc('scripts/ci-assert-release-assets.mjs');
  ok('CI 断言包含版本一致性检查', /pkg\.version !== manifest\.version/.test(ci));
  ok('  且校验资产文件名含当前版本', /a\.file\.includes\(pkg\.version\)/.test(ci));
  ok('提供留底刷新脚本 sync-release-checksums.mjs', fs.existsSync(path.join(ROOT, 'scripts/sync-release-checksums.mjs')));
}

/* ------------------------------ 结论 ------------------------------ */
console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(64));
process.exitCode = fail === 0 ? 0 : 1;
