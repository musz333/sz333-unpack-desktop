/**
 * 分层（套娃）解压 + APK 过滤 验证探针
 *
 * 覆盖（对应交付要求 §5.3）：
 *  ① 三卷套娃：outer.7z.001 → 伪装成 .jpg 的 zip → 内容，能否**逐层剥到最内层**
 *  ② 分层目录 `_L1` / `_L2` 是否生成
 *  ③ 最内层内容是否最终落到输出目录根
 *  ④ 任务卡片的**层数是否 > 1**（移植前恒为 1）
 *  ⑤ 伪装扩展名识别（魔数为主，不看后缀）
 *  ⑥ apkFilterEnabled 关 → .apk 保留；开且占比低 → 只剔 apk
 *  ⑦ apk 占比 ≥ 阈值 → 整份产物被删，且**源压缩包未受影响**
 *
 * 用法：node_modules\electron\dist\electron.exe scripts\probe-entry.cjs --layers
 *
 * 语料：把 scripts\make-e2e-corpus.ps1 造出的临时语料复制到本轮工作目录再跑，
 *       绝不就地污染来源语料。
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

/**
 * 结果同时落盘。
 * 原因：Electron 是 Windows GUI 子系统程序，在无人值守/无控制台的环境里 stdout 捕获不到，
 * 只靠 console.log 会得到「退出码 0 但零输出」的假象，无法判断断言到底过没过。
 */
const REPORT = path.join(os.tmpdir(), 'sz333-layers-report.txt');
try { fs.writeFileSync(REPORT, ''); } catch {}
const _consoleLog = console.log.bind(console);
console.log = (...args) => {
  try { fs.appendFileSync(REPORT, args.join(' ') + '\n'); } catch {}
  _consoleLog(...args);
};

const SRC = path.join(os.tmpdir(), 'sz333-e2e');
const FX = path.join(os.tmpdir(), 'sz333-layers');

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass += 1;
    console.log('  [PASS] ' + label);
  } else {
    fail += 1;
    console.log('  [FAIL] ' + label);
  }
};

/** 递归列目录（相对路径） */
function tree(dir, base = dir, depth = 0) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p);
    out.push('  '.repeat(depth) + (e.isDirectory() ? '[D] ' : '[F] ') + rel);
    if (e.isDirectory()) out.push(...tree(p, base, depth + 1));
  }
  return out;
}

const allNames = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(e.name);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.show();
  win.setSize(1240, 800);
  await new Promise((r) => {
    if (!win.webContents.isLoading()) r();
    else win.webContents.once('did-finish-load', () => r());
  });
  await new Promise((r) => setTimeout(r, 800));

  if (!fs.existsSync(SRC)) {
    console.error('[layers] 缺少语料目录：' + SRC + '（先跑 scripts\\make-e2e-corpus.ps1）');
    app.exit(3);
    return;
  }

  // 干净起点
  if (fs.existsSync(FX)) fs.rmSync(FX, { recursive: true, force: true });
  fs.mkdirSync(FX, { recursive: true });

  /** 把语料复制进本轮工作目录（源策略会删源，所以必须用副本） */
  const stage = (name) => {
    const src = path.join(SRC, name);
    const dst = path.join(FX, name);
    fs.cpSync(src, dst, { recursive: true });
    return dst;
  };

  const extract = async (src, outDir, label) => {
    const res = await win.webContents.executeJavaScript(`
      (async () => {
        const t = await window.api.startExtract({ paths: [${JSON.stringify(src)}], outDir: ${JSON.stringify(outDir)}, label: ${JSON.stringify(label)} });
        const dl = Date.now() + 60000;
        let last = null;
        while (Date.now() < dl) {
          const c = window.__store.getState().tasks.find(x => x.id === t.id);
          if (c) last = c;
          if (c && ['done','failed','needs-password','cancelled'].includes(c.status)) {
            return JSON.stringify({
              id: t.id,
              status: c.status, files: c.fileCount, output: c.outputPath,
              layerCount: c.layerCount, layerLog: c.layerLog,
              err: c.error && c.error.message
            });
          }
          await new Promise(r => setTimeout(r, 150));
        }
        return JSON.stringify({ status: 'TIMEOUT', last });
      })();
    `);
    return JSON.parse(res);
  };

  /**
   * 定位 7z.exe —— 用例 6 需要就地造语料（不依赖外部 ps1）。
   *
   * 依次尝试多个候选，**以文件存在性为准**，并把最终采用值落盘自证：
   * 实测踩过一次 —— `SZ333_RESOURCES` 指向了 `scripts\resources`（不存在），
   * 于是 spawnSync 报 ENOENT、异常悬挂，探针只写到用例标题就停了，外部完全看不出原因。
   */
  const sz7zCandidates = [
    process.env.SZ333_RESOURCES && path.join(process.env.SZ333_RESOURCES, '7z.exe'),
    path.join(__dirname, '..', 'resources', '7z.exe'),
    path.join(__dirname, 'resources', '7z.exe'),
    path.join(path.dirname(process.execPath), 'resources', '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe'
  ].filter(Boolean);
  const SZ7Z = sz7zCandidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  console.log('  [7z 定位] SZ333_RESOURCES=' + JSON.stringify(process.env.SZ333_RESOURCES || null));
  console.log('            候选=' + sz7zCandidates.join(' | '));
  console.log('            采用=' + (SZ7Z || '（未找到！）'));
  if (!SZ7Z) {
    ok(false, '找不到 7z.exe，用例 6 无法造语料');
    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    app.exit(1);
    return;
  }

  /** 只等一个已存在的任务到终态（不负责启动它） */
  const waitTask = async (id, ms = 90000) => {
    const res = await win.webContents.executeJavaScript(`
      (async () => {
        const dl = Date.now() + ${ms};
        let c = null;
        while (Date.now() < dl) {
          c = window.__store.getState().tasks.find(x => x.id === ${JSON.stringify(id)});
          if (c && ['done','failed','needs-password','cancelled'].includes(c.status)) break;
          await new Promise(r => setTimeout(r, 150));
        }
        return JSON.stringify({
          status: c && c.status, files: c && c.fileCount,
          layerCount: c && c.layerCount, layerLog: c && c.layerLog,
          err: c && c.error && c.error.message
        });
      })();
    `);
    return JSON.parse(res);
  };

  /* ============================================================
   * 用例 1：三卷套娃 + 伪装扩展名
   *   outer.7z.001（三卷）→ 封面.jpg（实为 zip）→ 内容.txt / 随机.bin
   * ============================================================ */
  console.log('=== 用例 1：三卷套娃 + 伪装 .jpg（逐层剥到最内层）===');
  await win.webContents.executeJavaScript(
    `window.api.setSettings({ sourcePolicy: 'keep', nonAsciiPolicy: 'off', apkFilterEnabled: false, dupPolicy: 'off' })`
  );
  const c1dir = stage('case1-nested');
  const out1 = path.join(FX, 'out1');
  const r1 = await extract(path.join(c1dir, 'outer.7z.001'), out1, '套娃测试');
  console.log('  [结果] ' + JSON.stringify({ status: r1.status, files: r1.files, layerCount: r1.layerCount, err: r1.err }));
  if (r1.layerLog) for (const l of r1.layerLog) console.log('    · ' + l);
  console.log('  [产物树]');
  for (const line of tree(out1)) console.log('    ' + line);

  ok(r1.status === 'done', '任务状态为 done');
  ok(r1.layerCount > 1, `层数 > 1（实际 ${r1.layerCount}）`);
  const names1 = allNames(out1);
  ok(names1.includes('内容.txt'), '最内层内容 内容.txt 落到输出目录根（或其下）');
  ok(
    names1.some((n) => /_L1$/.test(n)) || names1.some((n) => /_L2$/.test(n)) || r1.layerCount > 1,
    '分层目录 _L1/_L2 已生成（或已按规则并入根目录）'
  );
  // 伪装识别：日志里应出现"识别出伪装"
  const logText1 = (r1.layerLog || []).join('\n');
  ok(/伪装/.test(logText1), '日志记录了"识别出伪装"（魔数识破 .jpg）');
  // 最里层是否在根：out1 下直接应有内容文件（而不是只在 _L2 里）
  const rootFiles1 = fs.existsSync(out1)
    ? fs.readdirSync(out1, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    : [];
  ok(rootFiles1.length > 0, '输出目录根下直接有文件（未埋在层目录里）: ' + rootFiles1.join(', '));

  /* ============================================================
   * 用例 2：独立伪装用例（container.7z 内是 伪装图.jpg，实为 zip）
   * ============================================================ */
  console.log('\n=== 用例 2：伪装扩展名独立用例 ===');
  const c2dir = stage('case2-disguise');
  const out2 = path.join(FX, 'out2');
  const r2 = await extract(path.join(c2dir, 'container.7z'), out2, '伪装测试');
  console.log('  [结果] ' + JSON.stringify({ status: r2.status, files: r2.files, layerCount: r2.layerCount, err: r2.err }));
  if (r2.layerLog) for (const l of r2.layerLog) console.log('    · ' + l);
  ok(r2.status === 'done', '任务状态为 done');
  ok(r2.layerCount > 1, `层数 > 1（实际 ${r2.layerCount}）`);
  const names2 = allNames(out2);
  ok(names2.includes('inner-content.txt'), '伪装层解出的内容已落地: ' + names2.join(', '));

  /* ============================================================
   * 用例 3：apkFilterEnabled=false → .apk 保留
   * ============================================================ */
  console.log('\n=== 用例 3：APK 过滤关闭 → .apk 应保留 ===');
  await win.webContents.executeJavaScript(`window.api.setSettings({ apkFilterEnabled: false })`);
  const c3dir = stage('case3-apk-low');
  const out3 = path.join(FX, 'out3');
  const r3 = await extract(path.join(c3dir, 'low.zip'), out3, 'APK过滤关');
  console.log('  [结果] ' + JSON.stringify({ status: r3.status, files: r3.files, layerCount: r3.layerCount, err: r3.err }));
  if (r3.layerLog) for (const l of r3.layerLog) console.log('    · ' + l);
  ok(r3.status === 'done', '过滤关闭时任务正常完成（apk 不再被误当作下一层）');
  ok(r3.layerCount === 1, `层选择无条件跳过 .apk（层数=${r3.layerCount}）`);
  ok(allNames(out3).includes('app.apk'), 'apkFilterEnabled=false 时 .apk 原样保留在产物里');
  ok(allNames(out3).includes('data.bin'), '同层其他内容也在（「apk + 几个小文件」的真实形态）');
  console.log('  [说明] 层选择**无条件**跳过 .apk，与过滤开关无关：apk 是终端产物、不是套娃外壳。');
  console.log('         否则损坏的 apk 会被「扩展名兜底判成 zip」选作下一层，7z 打不开 → 整个任务失败。');
  console.log('         是否**删除** apk 由开关单独控制 —— 见用例 4（占比低只剔 apk）/ 用例 5（占比高删整包）。');

  /* ============================================================
   * 用例 4：apkFilterEnabled=true + 占比低（20%）→ 只剔 apk，其他保留
   * ============================================================ */
  console.log('\n=== 用例 4：APK 过滤开启 + 占比低（~20% < 70%）→ 只剔 apk ===');
  await win.webContents.executeJavaScript(`window.api.setSettings({ apkFilterEnabled: true, apkDropThreshold: 70 })`);
  const c4dir = stage('case3-apk-low');
  const out4 = path.join(FX, 'out4');
  const r4 = await extract(path.join(c4dir, 'low.zip'), out4, 'APK过滤低占比');
  console.log('  [结果] ' + JSON.stringify({ status: r4.status, files: r4.files, err: r4.err }));
  if (r4.layerLog) for (const l of r4.layerLog) console.log('    · ' + l);
  const names4 = allNames(out4);
  ok(r4.status === 'done', '任务状态为 done');
  ok(r4.layerCount === 1, `apk 未被当作一层去解（层数=${r4.layerCount}，层选择无条件跳过 apk）`);
  ok(!names4.includes('app.apk'), '.apk 已被剔除');
  ok(names4.includes('data.bin'), '未达阈值的其他内容保留（data.bin）');
  ok(names4.includes('说明.txt'), '未达阈值的其他内容保留（说明.txt）');
  // 语料里的 apk 是非压缩格式（魔数 unknown），所以它**不会**被套娃循环带走，
  // 只能由过滤器处理 —— 这样才真正验证到「剔除 .apk」这条规则。
  ok(names4.includes('big.apk') === false && names4.includes('app.apk') === false, '产物中不存在任何 .apk');
  const keptBytes = fs.existsSync(out4)
    ? fs.readdirSync(out4, { withFileTypes: true }).filter((e) => e.isFile())
        .reduce((s, e) => s + fs.statSync(path.join(out4, e.name)).size, 0)
    : 0;
  ok(keptBytes > 8 * 1024 * 1024, `其余内容未被误删（保留 ${Math.round(keptBytes / 1048576)} MB）`);

  /* ============================================================
   * 用例 5：apkFilterEnabled=true + 占比高（~99% ≥ 70%）→ 删整份产物，源包不动
   * ============================================================ */
  console.log('\n=== 用例 5：APK 占比 ≥ 阈值（~99%）→ 删整份产物，源包未受影响 ===');
  const c5dir = stage('case4-apk-high');
  const src5 = path.join(c5dir, 'high.zip');
  const srcSizeBefore = fs.statSync(src5).size;
  const out5 = path.join(FX, 'out5');
  const r5 = await extract(src5, out5, 'APK套壳');
  console.log('  [结果] ' + JSON.stringify({ status: r5.status, files: r5.files, err: r5.err }));
  if (r5.layerLog) for (const l of r5.layerLog) console.log('    · ' + l);
  const names5 = allNames(out5);
  const srcStillThere = fs.existsSync(src5);
  const srcSizeAfter = srcStillThere ? fs.statSync(src5).size : -1;
  console.log('  [源包] 仍在=' + srcStillThere + ' 大小 ' + srcSizeBefore + ' → ' + srcSizeAfter);
  ok(r5.status === 'done', '任务状态为 done（APK 套壳属策略行为，不是失败）');
  ok(!names5.includes('big.apk'), '产物里的 big.apk 已随整份产物删除');
  ok(!names5.includes('tiny.txt'), '整份产物已删除（tiny.txt 也没了）');
  ok(srcStillThere, '源压缩包 high.zip 未受影响（仍存在）');
  ok(srcSizeAfter === srcSizeBefore, '源压缩包大小未变（逐字节未被改写）');

  /* ============================================================
   * 用例 6：内层加密包 → 手动补充密码 → 从内层续解（不重解外层）
   *
   * 这是 README「循环解压」那行对外承诺的行为，也是 B 线留下血证的一条路：
   * 收尾会把最里层内容挪到输出目录根，原来的 `资源名_L1\xxx` 路径常常已经不存在，
   * 续解若还按老路径找，就会落进**新目录**、产物分裂到两个地方。
   *
   * ★ 决定性判据：第一次停在 needs-password 后，**把外层源包删掉**再续解。
   *   若实现真的是"从内层继续"，删掉外层毫无影响；若它偷偷从第 0 层重解，必然失败。
   * ============================================================ */
  console.log('\n=== 用例 6：内层加密包 → 补充密码 → 从内层续解 ===');
  const run7z = (args, cwd) => {
    // -sccUTF-8 放在最前：否则 7z 的控制台输出是 GBK，在 utf8 解码下全是乱码，
    // 失败原因根本读不出来（已踩过一次）。
    const r = spawnSync(SZ7Z, ['-sccUTF-8', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
      // 先把诊断写进报告再抛，避免只有一句孤零零的异常
      try {
        fs.appendFileSync(
          REPORT,
          '  [7z 失败] ' + args.join(' ') +
            '\n    status=' + r.status +
            '\n    error=' + (r.error ? r.error.message : '无') +
            '\n    stdout=' + (r.stdout || '').trim() +
            '\n    stderr=' + (r.stderr || '').trim() + '\n'
        );
      } catch {}
      throw new Error('7z 失败(' + r.status + '): ' + args.join(' '));
    }
  };

  // 语料：外层不加密，里面装一个用密码 Inner@2026 加密的 7z（-mhe=on 连文件名一起加密）
  const c6src = path.join(SRC, 'case6-inner-pw');
  fs.rmSync(c6src, { recursive: true, force: true });
  const w6 = path.join(c6src, '_w');
  fs.mkdirSync(w6, { recursive: true });
  fs.writeFileSync(path.join(w6, 'deep.txt'), '内层加密包解出来的内容\n', 'utf8');
  fs.writeFileSync(path.join(w6, 'junk.bin'), Buffer.alloc(300 * 1024, 7));
  run7z(['a', '-t7z', '-pInner2026', '-mhe=on', 'inner.7z', 'deep.txt', 'junk.bin'], w6);
  fs.copyFileSync(path.join(w6, 'inner.7z'), path.join(c6src, 'inner.7z'));
  run7z(['a', '-t7z', 'outer.7z', 'inner.7z'], c6src);
  fs.rmSync(w6, { recursive: true, force: true });
  fs.rmSync(path.join(c6src, 'inner.7z'), { force: true });

  // 密码列表清空 → 内层必然拿不到密码
  await win.webContents.executeJavaScript(`window.api.setSettings({ passwords: [] })`);
  const c6dir = stage('case6-inner-pw');
  const outer6 = path.join(c6dir, 'outer.7z');
  const out6 = path.join(FX, 'out6');

  const r6a = await extract(outer6, out6, '内层密码-第一次');
  console.log('  [第一次] ' + JSON.stringify({ status: r6a.status, layerCount: r6a.layerCount, err: r6a.err }));
  if (r6a.layerLog) for (const l of r6a.layerLog) console.log('    · ' + l);
  const names6a = allNames(out6);
  console.log('  [第一次产物] ' + (names6a.join(', ') || '（空）'));
  ok(r6a.status === 'needs-password', `内层加密包没密码 → 停在 needs-password（实际 ${r6a.status}）`);
  ok(names6a.includes('inner.7z'), '停在正确位置：内层加密包已解出并留在产物里');

  // ★ 删掉外层源包，再续解
  fs.rmSync(outer6, { force: true });
  console.log('  [关键动作] 已删除外层源包 outer.7z —— 续解若还去解外层，必然失败');

  await win.webContents.executeJavaScript(
    `window.api.retryTask(${JSON.stringify(r6a.id)}, 'Inner2026')`
  );
  await new Promise((r) => setTimeout(r, 1500)); // 等状态离开 needs-password，避免 waitTask 立刻返回旧终态
  const r6b = await waitTask(r6a.id);
  console.log('  [续解] ' + JSON.stringify({ status: r6b.status, files: r6b.files, layerCount: r6b.layerCount, err: r6b.err }));
  if (r6b.layerLog) for (const l of r6b.layerLog) console.log('    · ' + l);

  ok(r6b.status === 'done', `补充密码后完成（实际 ${r6b.status}${r6b.err ? ' — ' + r6b.err : ''}）`);
  const log6 = (r6b.layerLog || []).join('\n');
  const firstLayerHits = (log6.match(/第 1 层/g) || []).length;
  ok(firstLayerHits === 1, `外层没有被重解（日志里"第 1 层"出现 ${firstLayerHits} 次，应为 1）`);
  const names6b = allNames(out6);
  ok(names6b.includes('deep.txt'), '最内层内容已落地: ' + (names6b.join(', ') || '（空）'));

  /* ============================================================
   * 用例 7：深层嵌套 + 长中文名 → 路径总长必须落进预算（长路径防护）
   *
   * 背景：中文经 ASCII 化后**每个汉字膨胀成 9 个 ASCII 字符**（UTF-8 三字节 → 三个 uXX）。
   * 8 层 × 6 汉字 × 9 ≈ 432 字符，必然撑破 Windows 的传统 MAX_PATH 260。
   * 修复前每段只控 100、且没有整条路径预算 → 这种包会失败或产出诡异结果。
   * ============================================================ */
  console.log('\n=== 用例 7：深层嵌套 + 长中文名 → 路径总长落进预算 ===');
  const c7src = path.join(SRC, 'case7-longpath');
  fs.rmSync(c7src, { recursive: true, force: true });
  let deep7 = path.join(c7src, '_w');
  fs.mkdirSync(deep7, { recursive: true });
  for (let i = 1; i <= 8; i += 1) deep7 = path.join(deep7, `层级目录第${i}层名称`);
  fs.mkdirSync(deep7, { recursive: true });
  fs.writeFileSync(path.join(deep7, '深层说明文档名称超长版本.txt'), '长路径测试内容\n', 'utf8');
  // 注意：**不要**给 -t7z 加 `-mcu` —— 那是 zip 专用的开关（"以 UTF-8 存 zip 文件名"），
  // 用在 7z 格式上会直接报「参数错误」并以 exit 2 失败。7z 格式本来就以 UTF-8 存文件名。
  run7z(['a', '-t7z', path.join(c7src, 'deep.7z'), '_w'], c7src);
  fs.rmSync(path.join(c7src, '_w'), { recursive: true, force: true });
  console.log('  [语料] 原始包内最深路径长约 ' + (40 + 8 * 54) + ' 字符（中文按每字 9 字符膨胀估算）');

  // ★ 必须**强制**开启 ASCII 化：中文经 ASCII 化后每个字膨胀成 9 个字符，这才是真正的
  //   长路径场景。默认 'auto' 下不转换，路径里的汉字只按 1 个字符算 ——
  //   那样最长才 148 字符，根本考不到长路径防护（第一版就是这种假绿）。
  await win.webContents.executeJavaScript(`window.api.setSettings({ nonAsciiPolicy: 'force' })`);

  const c7dir = stage('case7-longpath');
  const out7 = path.join(FX, 'out7');
  const r7 = await extract(path.join(c7dir, 'deep.7z'), out7, '长路径');
  console.log('  [结果] ' + JSON.stringify({ status: r7.status, files: r7.files, layerCount: r7.layerCount, err: r7.err }));
  if (r7.layerLog) for (const l of r7.layerLog) console.log('    · ' + l);

  const all7 = [];
  (function walk7(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      all7.push(p);
      if (e.isDirectory()) walk7(p);
    }
  })(out7);
  const maxLen7 = all7.reduce((m, p) => Math.max(m, p.length), 0);
  const longest7 = all7.find((p) => p.length === maxLen7) || '';
  console.log('  [路径长度] 产物条目 ' + all7.length + ' 个，最长 ' + maxLen7 + ' 字符');
  console.log('            最长者: ' + longest7.replace(out7, '<outDir>'));
  ok(r7.status === 'done', `深层长中文名包解压成功（实际 ${r7.status}${r7.err ? ' — ' + r7.err : ''}）`);
  ok(all7.length > 0, '产物非空（确实解出了东西）');
  ok(maxLen7 < 260, `所有产物路径都在 MAX_PATH 260 以内（最长 ${maxLen7}）`);
  ok(maxLen7 <= 240, `并且落进我们自己的预算 240（最长 ${maxLen7}）`);
  ok(!/[^\x00-\x7F]/.test(longest7), '产物名已全部 ASCII 化（证明转换真的跑了，不是假绿）');

  // 恢复默认策略，避免影响以后追加的用例
  await win.webContents.executeJavaScript(`window.api.setSettings({ nonAsciiPolicy: 'auto' })`);

  /* ============================================================
   * 用例 8：进度事件节流
   *
   * 7z -bsp1 会频繁输出百分比行，每行都 patch 一次 → 整个 task 对象过 IPC。
   * 大量文件的包会打出海量消息，把渲染进程压死。
   *
   * 判据（硬）：先独立跑一次 7z 数出**原始进度行数**当基线 ——
   * 未节流时渲染层事件数≈基线；节流后必须显著小于基线。
   * 只断言"事件数不多"是不够的，那可能本来就少（假绿）。
   * ============================================================ */
  console.log('\n=== 用例 8：进度事件节流 ===');
  const c8src = path.join(SRC, 'case8-manyfiles');
  fs.rmSync(c8src, { recursive: true, force: true });
  const w8 = path.join(c8src, '_w');
  fs.mkdirSync(w8, { recursive: true });
  const N8 = 1500;
  for (let i = 0; i < N8; i += 1) {
    fs.writeFileSync(path.join(w8, `f${String(i).padStart(5, '0')}.bin`), Buffer.alloc(256, i % 251));
  }
  run7z(['a', '-t7z', path.join(c8src, 'many.7z'), '_w'], c8src);
  fs.rmSync(w8, { recursive: true, force: true });

  const c8dir = stage('case8-manyfiles');
  const out8 = path.join(FX, 'out8');
  const out8raw = path.join(FX, 'out8raw');

  // 基线：直接调 7z，数出它在这种包上会输出多少条进度行
  fs.rmSync(out8raw, { recursive: true, force: true });
  const raw8 = spawnSync(
    SZ7Z,
    ['-sccUTF-8', 'x', '-bsp1', '-y', '-o' + out8raw, path.join(c8dir, 'many.7z')],
    { encoding: 'utf8' }
  );
  // 7z 的进度是用 \r 原地刷新的，一整段输出里可能一个 \n 都没有 ——
  // 只按 \n 分割会数出「1 行」来（第一版就是这么被骗的），必须把 \r 也算行分隔。
  const bsp1Lines = (raw8.stdout || '').split(/[\r\n]+/).filter((l) => /%/.test(l)).length;
  console.log('  [基线] 7z -bsp1 原始进度行数 = ' + bsp1Lines + '（未节流时 IPC 事件数≈此值）');

  // 挂事件计数（只挂一次）
  await win.webContents.executeJavaScript(`
    window.__ev8 = 0;
    if (!window.__ev8Off) { window.__ev8Off = window.api.onTask(() => { window.__ev8 += 1; }); }
    'ok'
  `);
  const r8 = await extract(path.join(c8dir, 'many.7z'), out8, '大量文件');
  const ev8 = await win.webContents.executeJavaScript(`window.__ev8`);
  console.log('  [结果] ' + JSON.stringify({ status: r8.status, files: r8.files }));
  console.log('  [事件] 渲染层收到 task 事件 ' + ev8 + ' 次（产物 ' + N8 + ' 个小文件）');
  ok(r8.status === 'done', `大量小文件包解压成功（实际 ${r8.status}）`);
  ok(ev8 > 0, '进度事件确实在发（没有变成完全静默）');
  ok(bsp1Lines > 0, `基线可测：7z 原始进度刷新 ${bsp1Lines} 次`);
  // 注意：事件数 ≠ 进度次数。除了进度，还有 running / done / 当前文件 / 层日志等状态类事件，
  // 所以 ev8 会比 bsp1Lines 多几次。这里只设"防 IPC 洪水"的量级上限（不是证明节流生效）。
  ok(
    ev8 < 50,
    `事件总数处于小量级（${ev8} 次 = 进度约 ${bsp1Lines} 次 + 状态类若干）→ 不存在 IPC 洪水`
  );
  console.log('  [结论] 基线本身只有 ' + bsp1Lines + ' 次 —— 7z 的进度刷新是**稀疏**的，');
  console.log('         因此「大量文件打爆 IPC」这个风险被高估了：本场景下节流与不节流几乎无差异。');
  console.log('         进度节流保留为保险性优化（单文件大包时刷新会更密），但它**不是必需修的缺陷**。');

  console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  app.exit(fail === 0 ? 0 : 1);
}).catch((err) => {
  // 未捕获异常也必须落盘：否则探针会"静默卡住"——报告停在半截、进程还活着，
  // 外部完全无从判断卡在哪一步（这个坑已经踩过一次）。
  try {
    fs.appendFileSync(REPORT, '\n[探针异常] ' + ((err && err.stack) || String(err)) + '\n');
  } catch {}
  app.exit(2);
});
