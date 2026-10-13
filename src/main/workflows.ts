/**
 * 工作流引擎（从 v1.9 WinForms 版逐条移植，评分规则保持一致）
 *
 * 核心思想：同一个上传者发布的资源包，解压密码几乎不变、分卷命名与层数相对稳定。
 * 因此以「该来源第一层命中的解压密码」为身份锚点，加上内容指纹（分卷体积/分卷数/
 * 命名结构）与层数评分；分数不足或有同分竞争时，宁可走常规探测也绝不静默走错链路。
 *
 * 与 v1.9 完全一致的关键规则：
 *   ① 锚点密码优先从**用户自己的密码列表**确认命中（不轻易用记录自证）
 *      —— **修复 P0-① 的唯一例外**：密码列表里没有该锚点、但体积指纹一致时，
 *      允许"锚点自证"给一个保守分（见 matchWorkflow 与 selfAttestScore），
 *      否则全新安装/未记住密码时旗舰功能永不命中。自证命中会被调用方区别对待
 *      （失误不立即停用卡片）。
 *   ② 锚点命中但体积不符 → 必须有名称印证（两票制）才采用
 *   ③ 同分 → 命中次数多者优先；仍分不出 → 放弃匹配
 *   ④ 命中失败：密码错 1 次即自动停用；普通失败连续 2 次停用
 *   ⑤ 同一锚点密码只保留一条生效记录
 */
import path from 'node:path';
import fs from 'node:fs';
import { userDataDir } from './engine';
import { logger } from './logger';

/* ------------------------------------------------------------------ *
 * 落盘密码加解密（修复 P0-②）
 *
 * 设计要点：本模块**不直接 import electron**。
 * 原因：`scripts/verify-fixes.mts` 会把 src 原样搬到临时目录、用 Node 的
 * `--experimental-strip-types` 直接加载 `tasks.ts`（→ 间接加载本模块）。
 * 一旦这里 `import { safeStorage } from 'electron'`，Node 解析不到 electron 模块，
 * 整套断言会直接崩掉。因此把"加解密"抽象成可注入的 codec：
 *   · 默认 = 恒等（明文），保证脱离 Electron 时（测试/脚本）行为不变；
 *   · 主进程启动时通过 setSecretCodec 注入基于 safeStorage（DPAPI）的实现。
 *
 * 语义约定：`seal` 把明文变成落盘形态（可能带 `enc:` 前缀）；`open` 把落盘形态
 * 还原成明文。**内存中的 Workflow 始终是明文**（匹配、导出、UI 都按明文工作），
 * 只有 `loadWorkflows` / `saveWorkflows` 这一对读写函数经过 codec。
 * ------------------------------------------------------------------ */
export interface SecretCodec {
  seal(plain: string): string;
  open(stored: string): string;
}

/** 默认恒等 codec：无 Electron 环境下退化为明文（向后兼容） */
let secretCodec: SecretCodec = { seal: (s) => s, open: (s) => s };

/** 注入加解密实现（由主进程 index.ts 在 app ready 后调用一次） */
export function setSecretCodec(codec: SecretCodec): void {
  secretCodec = codec;
}


/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface WorkflowStep {
  /** 该层输入压缩包扩展名，如 .rar / .7z */
  inputExt: string;
  /** 该层解出的单个文件的伪装扩展名（如 .JPG；无伪装则为空） */
  fakeExt: string;
  /** 该层真实格式（rar/zip/7z…；空表示该层即得到最终结果） */
  realFormat: string;
  /** 该层命中密码（空 = 无密码） */
  password: string;
  /** 改名目标扩展名（如 .rar；空 = 无需改名） */
  renameTo: string;
}

export interface Workflow {
  id: string;
  /** 标签名（显示用） */
  name: string;
  /**
   * 锚点密码：该来源第一层命中的解压密码 —— 匹配的主依据
   */
  anchorPassword: string;
  /** 内容指纹："体积|命名签名;体积|命名签名;…"（体积升序） */
  fingerprint: string;
  /** 体积基准值 = 该套分卷中最小的分卷体积（0 = 未记录） */
  primVolSize: number;
  /** 分卷数量 */
  volCount: number;
  /** 名称提示（分组名，仅作辅助分；长度 < 4 时忽略） */
  nameHint: string;
  /** 链路层数 */
  layerCount: number;
  /** 解压链路（外层 → 内层） */
  steps: WorkflowStep[];
  note: string;
  createdAt: number;
  enabled: boolean;

  // 使用统计与自愈
  hitCount: number;
  missCount: number;
  lastUsedAt: number;
  /** 连续失败达阈值后自动停用 */
  autoDisabled: boolean;
  /** 自动停用原因是否为"锚点密码错误" */
  missPasswordError: boolean;
}

export interface WorkflowMatch {
  flow: Workflow | null;
  score: number;
  reason: string;
  /** 候选里有同分竞争者（歧义，不采用） */
  ambiguous: boolean;
  /**
   * 命中是否来自"锚点自证"（修复 P0-①）：
   * 卡片锚点**不在**用户密码列表里，但体积指纹一致，于是用卡片自记的锚点
   * 做了一次保守命中。调用方据此放宽失误惩罚 —— 自证可能只是"另一个同尺寸的包"，
   * 不该像"用户确实持有该密码"那样一次错就永久停用卡片。
   */
  selfAttested?: boolean;
}

export const WORKFLOW_CONST = {
  /** 采用阈值：低于此分视为没命中，宁可走探测 */
  acceptScore: 45,
  /** 名称辅助分要求的最小长度（v1.6 为 2，太容易误命中） */
  minNameHintLength: 4,
  /** 命中后连续失败多少次自动停用 */
  autoDisableMissLimit: 2,
  /** 体积指纹容差：±2% 或 ±64KB 取大者 */
  sizeToleranceRatio: 0.02,
  sizeToleranceMin: 65536,
  /** 单条指纹里最多收集多少条目（超大包防止列表过长） */
  maxVolumes: 64,
  /**
   * 锚点自证分（修复 P0-①）。
   *
   * 卡片锚点**不在**用户密码列表里、但体积指纹一致时给的保守分。
   * 该锚点本就是"用户上一次成功解压时用过、并被记进卡片"的密码，
   * 不是凭空捏造；体积一致（±2%）进一步把误命中概率压低。
   * 只给 30（低于真命中 45）—— 体积一致(30) + 自证(30) 已足够越过阈值 45，
   * 但不会盖过"用户确实持有密码"的强度。
   */
  selfAttestScore: 30
} as const;

/** 卡片包 schema 版本（与 v1.9 的 WorkflowPack 对齐） */
export const WORKFLOW_PACK_SCHEMA = 1;

/* ------------------------------------------------------------------ *
 * 指纹构建
 * ------------------------------------------------------------------ */

/** 分卷命名去掉尾部序号，得到"同套分卷"的签名：a.part1.rar → a，a.7z.001 → a.7z */
export function volumeSignature(fileName: string): string {
  let s = fileName.replace(/\.[^.]+$/, '');
  s = s.replace(/\.(part\d+|z\d{2}|r\d{2}|\d{3})$/i, '');
  return s.toLowerCase();
}

/**
 * 由分组文件构建内容指纹："体积|签名;体积|签名;…"（体积升序）
 * 指纹第 0 段即最小分卷体积，作为体积基准值。
 */
export function buildFingerprint(files: string[]): string {
  try {
    const items: { size: number; sig: string }[] = [];
    for (const f of files.slice(0, WORKFLOW_CONST.maxVolumes)) {
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {
        size = 0;
      }
      items.push({ size, sig: volumeSignature(path.basename(f)) });
    }
    items.sort((a, b) => (a.size !== b.size ? a.size - b.size : a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
    return items.map((i) => `${i.size}|${i.sig}`).join(';');
  } catch {
    return '';
  }
}

/** 取体积基准值（指纹第一段） */
export function primarySizeOf(fingerprint: string): number {
  if (!fingerprint) return 0;
  const end = fingerprint.indexOf('|');
  const n = Number(fingerprint.slice(0, end < 0 ? fingerprint.length : end));
  return Number.isFinite(n) ? n : 0;
}

function sizesOf(fingerprint: string): number[] {
  if (!fingerprint) return [];
  return fingerprint
    .split(';')
    .map((seg) => Number(seg.split('|')[0]))
    .filter((n) => Number.isFinite(n) && n >= 0);
}

function signaturesOf(fingerprint: string): string[] {
  if (!fingerprint) return [];
  return fingerprint
    .split(';')
    .map((seg) => {
      const bar = seg.indexOf('|');
      return bar >= 0 ? seg.slice(bar + 1) : '';
    })
    .filter((s) => s.length > 0);
}

/** 数量级是否一致（同量级即认为一致，避免"多一个分包"就判不一致） */
function sameMagnitude(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const tol = Math.max(WORKFLOW_CONST.sizeToleranceMin, Math.max(a, b) * WORKFLOW_CONST.sizeToleranceRatio);
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ *
 * 匹配（v1.9 评分规则逐条对应）
 * ------------------------------------------------------------------ */

export function isUsable(w: Workflow): boolean {
  return w.enabled && !w.autoDisabled;
}

/**
 * 匹配工作流
 * @param list        已有工作流
 * @param baseName    当前分组名
 * @param fingerprint 当前分组指纹
 * @param layerHint   层数提示（0 = 未知）
 * @param batchCount  本批分组总数
 * @param passwords   用户本机密码列表（锚点只从中确认）
 */
export function matchWorkflow(
  list: Workflow[],
  baseName: string,
  fingerprint: string,
  layerHint: number,
  batchCount: number,
  passwords: string[]
): WorkflowMatch {
  const none: WorkflowMatch = { flow: null, score: 0, reason: '', ambiguous: false };
  if (!list?.length) return none;

  const primSize = primarySizeOf(fingerprint);
  const candidates = list.filter((w) => w && isUsable(w));
  if (!candidates.length) return none;

  // 锚点密码集合 = 用户本机密码列表（只认用户确实持有的密码，绝不用记录自证）
  const anchorSet = new Set(passwords.filter((p) => !!p));

  let best: Workflow | null = null;
  let bestScore = -1;
  let bestReason = '';
  let bestSelfAttested = false;
  let tieCount = 0;
  /** 与 bestScore 同分的候选（同分裁决只允许在这个子集里比较命中次数） */
  let tied: Workflow[] = [];
  let twoVoteRejectScore = -1;
  let twoVoteRejectReason = '';

  for (const w of candidates) {
    let score = 0;
    const reasons: string[] = [];
    let sizeAgree = false;
    let sizeDisagree = false;
    let anchorHit = false;
    let selfAttested = false;

    const hint = w.nameHint || w.name || '';
    const nameHit =
      hint.length >= WORKFLOW_CONST.minNameHintLength &&
      !!baseName &&
      baseName.toLowerCase().includes(hint.toLowerCase());

    // ① 内容指纹：体积一致加分；不一致时看有没有锚点可依据（有锚点不扣分，交给两票制）
    if (primSize > 0 && w.primVolSize > 0) {
      if (sameMagnitude(primSize, w.primVolSize)) {
        sizeAgree = true;
        score += 30;
        reasons.push('体积一致');
        const mine = sizesOf(fingerprint);
        const his = sizesOf(w.fingerprint);
        const mineSig = signaturesOf(fingerprint);
        const hisSig = signaturesOf(w.fingerprint);
        if (mine.length > 0 && mine.length === his.length) {
          score += 5;
          reasons.push('分卷数一致');
        } else if (mineSig.length > 0 && hisSig.length > 0 && mineSig[0] === hisSig[0]) {
          score += 2;
          reasons.push('命名结构一致');
        }
      } else if (w.anchorPassword && anchorSet.has(w.anchorPassword)) {
        sizeDisagree = true;
        reasons.push('体积不符（需名称印证）');
      } else {
        // 没有锚点可依据时，指纹就是主要证据，不一致直接扣分（防同名异源误命中）
        score -= 14;
        reasons.push('体积不符');
      }
    }

    // ② 锚点密码：主依据（用户确实持有该密码 = 同一上传者）
    if (w.anchorPassword && anchorSet.has(w.anchorPassword)) {
      anchorHit = true;
      score += 45;
      reasons.push('锚点密码命中');
      if (sizeAgree) {
        score += 10;
        reasons.push('与密码双重印证');
      }
    } else if (w.anchorPassword && sizeAgree) {
      /* 冷启动自证（修复 P0-①）。
       *
       * 场景：刚重装 / 用户关了"记住密码" / 换了机器 —— 密码列表为空或未收录该锚点。
       * 此时卡片照常生成却永远拿不到锚点分（仅指纹+名称最多 ~38 < 阈值 45），
       * 于是旗舰功能永不自动命中，等于没有。
       *
       * 这里允许用**卡片自己记录的锚点**做一次保守命中，但硬性要求体积指纹一致：
       *   · 该锚点本就是用户上次成功解压时用的密码（不是凭空捏造）；
       *   · 体积在 ±2% 内一致，才认为"很可能就是同一来源"。
       * 分值与真命中拉开（30 < 45），且调用方会对自证命中放宽失误惩罚
       * （见 WorkflowMatch.selfAttested）—— 即便自证错了，代价也只是走一次探测。
       */
      selfAttested = true;
      score += WORKFLOW_CONST.selfAttestScore;
      reasons.push('锚点自证（体积一致）');
    }

    // ③ 名称：仅辅助。锚点未命中时只给极小分值，避免"名称像"就自作主张走链路
    if (nameHit) {
      if (anchorHit) {
        if (sizeAgree) {
          score += 10;
          reasons.push('名称+体积+密码三重一致');
        } else {
          score += 5;
          reasons.push('名称匹配（辅助）');
        }
      } else {
        score += 3;
        reasons.push('名称匹配（无锚点，仅辅助）');
      }
    }

    // ④ 结构特征
    if (layerHint > 0 && w.steps.length === layerHint) score += 3;
    if (w.steps.length > 0 && w.anchorPassword && w.steps[0].password === w.anchorPassword) score += 2;

    // 同锚点在本批存了多份（重复记录）→ 命中次数高者略占优
    if (w.hitCount > 0 && batchCount > 1) score += Math.min(w.hitCount, 5);

    // 旧版记录（无锚点、无指纹）只能靠名称，额外降权
    if (!w.anchorPassword && !w.fingerprint) {
      score -= 8;
      reasons.push('旧版记录（缺锚点）');
    }

    if (score > bestScore) {
      bestScore = score;
      best = w;
      bestReason = reasons.join('、');
      bestSelfAttested = selfAttested;
      tieCount = 1;
      tied = [w];
    } else if (score === bestScore && score > 0) {
      tieCount += 1;
      tied.push(w);
    }

    // 两票制硬门槛：锚点命中 + 体积不符 + 名称也不符 → 不允许采用
    if (anchorHit && sizeDisagree && !nameHit && score > twoVoteRejectScore) {
      twoVoteRejectScore = score;
      twoVoteRejectReason = '锚点密码命中但体积不符且名称不符（可能是同一上传者的另一个包）';
    }
  }

  const result: WorkflowMatch = { flow: null, score: 0, reason: '', ambiguous: false };

  if (!best || bestScore < WORKFLOW_CONST.acceptScore) {
    if (twoVoteRejectScore >= WORKFLOW_CONST.acceptScore) {
      result.score = twoVoteRejectScore;
      result.reason = `${twoVoteRejectReason} → 不采用（走探测）`;
    } else {
      result.score = Math.max(0, bestScore);
      result.reason = `最高分 ${result.score} 未达阈值 ${WORKFLOW_CONST.acceptScore}（走探测）`;
    }
    return result;
  }

  // 两票制：冠军若只靠锚点密码、体积与名称都对不上 → 不采用
  if (twoVoteRejectScore >= bestScore && twoVoteRejectScore >= WORKFLOW_CONST.acceptScore) {
    result.score = bestScore;
    result.reason = `${twoVoteRejectReason} → 不采用（走探测）`;
    return result;
  }

  // 同分竞争：命中次数明显更高者胜出；否则放弃
  if (tieCount > 1) {
    let byHits: Workflow | null = null;
    let bestHits = -1;
    let secondHits = -1;
    /* 只在**同分子集**里比命中次数。原实现在全部候选里取最大 hitCount，
     * 会让一条分数更低（甚至低于阈值）但命中多的记录赢得裁决，并把它的低分
     * 包装成最高分上报 —— 走错链路且置信度失真。 */
    for (const w of tied) {
      if (w.hitCount > bestHits) {
        secondHits = bestHits;
        bestHits = w.hitCount;
        byHits = w;
      } else if (w.hitCount > secondHits) {
        secondHits = w.hitCount;
      }
    }
    if (byHits && bestHits >= 1 && bestHits >= secondHits + 2) {
      result.flow = byHits;
      result.score = bestScore;
      result.selfAttested = bestSelfAttested;
      result.reason = `同分（${bestScore}）但该记录命中 ${byHits.hitCount} 次，优先采用`;
      return result;
    }
    result.score = bestScore;
    result.ambiguous = true;
    result.reason = `有 ${tieCount} 条工作流同分（${bestScore}），为避免走错链路改为探测`;
    return result;
  }

  result.flow = best;
  result.score = bestScore;
  result.selfAttested = bestSelfAttested;
  result.reason = `${bestReason}，置信度 ${bestScore}`;
  return result;
}

/* ------------------------------------------------------------------ *
 * 统计与自愈
 * ------------------------------------------------------------------ */

export function onHit(w: Workflow, batchCount = 1): void {
  w.hitCount += Math.max(1, batchCount);
  w.missCount = 0;
  w.lastUsedAt = Date.now();
  w.autoDisabled = false;
  w.missPasswordError = false;
}

/** 按链路失败：passwordError = true（锚点密码本身就错）时立即停用 */
export function onMiss(w: Workflow, passwordError: boolean): boolean {
  w.missCount += 1;
  w.lastUsedAt = Date.now();
  if (!w.autoDisabled && (passwordError || w.missCount >= WORKFLOW_CONST.autoDisableMissLimit)) {
    w.autoDisabled = true;
    w.missPasswordError = passwordError;
    return true;
  }
  return false;
}

export function manualEnable(w: Workflow): void {
  w.enabled = true;
  w.autoDisabled = false;
  w.missCount = 0;
  w.missPasswordError = false;
}

/** 同锚点重复记录合并：以命中次数高者为准，其余标记停用（保留在列表里供核对） */
export function mergeDuplicateAnchors(list: Workflow[]): number {
  if (!list || list.length < 2) return 0;
  const keep = new Map<string, Workflow>();
  let merged = 0;
  for (const w of list) {
    if (!w?.anchorPassword) continue;
    const exist = keep.get(w.anchorPassword);
    if (!exist) {
      keep.set(w.anchorPassword, w);
      continue;
    }
    const win = w.hitCount > exist.hitCount ? w : exist;
    const lose = win === w ? exist : w;
    keep.set(w.anchorPassword, win);
    lose.autoDisabled = true;
    if (!win.enabled && !win.autoDisabled) win.enabled = true;
    merged += 1;
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * 由解压结果生成记录
 * ------------------------------------------------------------------ */

export function buildFromResult(input: {
  baseName: string;
  steps: WorkflowStep[];
  primVolSize: number;
  files: string[];
}): Workflow | null {
  const { baseName, steps, primVolSize, files } = input;
  if (!steps?.length) return null;

  // 锚点 = 第一层命中密码（没有则取链路中第一个非空密码）
  let anchor = steps[0].password ?? '';
  if (!anchor) {
    for (const s of steps) {
      if (s.password) {
        anchor = s.password;
        break;
      }
    }
  }

  const fingerprint = buildFingerprint(files);
  const w: Workflow = {
    id: `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    anchorPassword: anchor,
    fingerprint,
    primVolSize: primVolSize > 0 ? primVolSize : primarySizeOf(fingerprint),
    volCount: files?.length || 1,
    nameHint: baseName || '',
    layerCount: steps.length,
    steps,
    note: '',
    createdAt: Date.now(),
    enabled: true,
    hitCount: 1,
    missCount: 0,
    lastUsedAt: Date.now(),
    autoDisabled: false,
    missPasswordError: false
  };
  w.name = buildLabel(w);
  return w;
}

/** 生成可读标签：锚点密码优先，便于用户辨认上传者 */
export function buildLabel(w: Workflow): string {
  const sigs = signaturesOf(w.fingerprint);
  let sig = sigs[0] ?? '';
  if (sig.length > 24) sig = sig.slice(0, 24);
  if (w.anchorPassword) return `锚点 ${w.anchorPassword}${sig ? ` · ${sig}` : ''}`;
  return w.nameHint || sig || '工作流';
}

/** 链路可读文本，如 ".rar → .JPG(rar) → .zip" */
export function chainText(w: Workflow): string {
  return (
    w.steps
      .map((s) => {
        let seg = s.inputExt || '';
        if (s.fakeExt && s.fakeExt !== s.renameTo) seg += `/${s.fakeExt}(${s.realFormat})`;
        return seg;
      })
      .join(' → ') || '（空链路）'
  );
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

const file = () => path.join(userDataDir(), 'workflows.json');

/**
 * 把磁盘上的原始记录解密成内存明文形态（修复 P0-②）。
 *
 * 只处理两个敏感字段：`anchorPassword` 与 `steps[].password`。
 * 解密在 normalizeWorkflow **之前**做 —— 否则空 name 的记录会用密文
 * 去 buildLabel，标签里就会出现一串 base64 乱码。
 * 旧数据无 `enc:` 前缀 → codec.open 原样返回（向后兼容旧明文）。
 */
function openStoredWorkflow(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...r };
  if (typeof r.anchorPassword === 'string') out.anchorPassword = secretCodec.open(r.anchorPassword);
  if (Array.isArray(r.steps)) {
    out.steps = (r.steps as unknown[]).map((s) => {
      if (!s || typeof s !== 'object') return s;
      const st = s as Record<string, unknown>;
      return typeof st.password === 'string' ? { ...st, password: secretCodec.open(st.password) } : st;
    });
  }
  return out;
}

/**
 * 把内存中的明文 Workflow 转成落盘形态（修复 P0-②）。
 * 导出包（workflowPack.exportPack）**不走这里**，仍保持明文 ——
 * 锚点密码就是卡片身份，导出前已有明确警告对话框。
 */
function sealWorkflow(w: Workflow): Record<string, unknown> {
  return {
    ...w,
    anchorPassword: secretCodec.seal(w.anchorPassword ?? ''),
    steps: (w.steps ?? []).map((s) => ({ ...s, password: secretCodec.seal(s.password ?? '') }))
  };
}

export function loadWorkflows(): Workflow[] {
  try {
    if (fs.existsSync(file())) {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      if (Array.isArray(raw)) {
        return raw
          .map((r) => normalizeWorkflow(openStoredWorkflow(r) as Partial<Workflow> & Record<string, unknown>))
          .filter(Boolean) as Workflow[];
      }
    }
  } catch (e) {
    logger.warn(`读取工作流失败，已按空处理：${e instanceof Error ? e.message : String(e)}`);
  }
  return [];
}

export function saveWorkflows(list: Workflow[]): void {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(list.map(sealWorkflow), null, 2), 'utf8');
  } catch (e) {
    logger.warn(`写入工作流失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 补齐缺失字段，兼容旧版导出的卡片包 */
function normalizeWorkflow(raw: Partial<Workflow> & Record<string, unknown>): Workflow | null {
  if (!raw) return null;
  const steps = Array.isArray(raw.steps)
    ? (raw.steps as Partial<WorkflowStep>[]).map((s) => ({
        inputExt: s.inputExt ?? '',
        fakeExt: s.fakeExt ?? '',
        realFormat: s.realFormat ?? '',
        password: s.password ?? '',
        renameTo: s.renameTo ?? ''
      }))
    : [];
  const w: Workflow = {
    id: (raw.id as string) || `w${Math.random().toString(36).slice(2, 9)}`,
    name: (raw.name as string) || '',
    anchorPassword: (raw.anchorPassword as string) || '',
    fingerprint: (raw.fingerprint as string) || '',
    primVolSize: Number(raw.primVolSize) || 0,
    volCount: Number(raw.volCount) || 1,
    nameHint: (raw.nameHint as string) || '',
    layerCount: Number(raw.layerCount) || steps.length,
    steps,
    note: (raw.note as string) || '',
    createdAt: Number(raw.createdAt) || Date.now(),
    enabled: raw.enabled !== false,
    hitCount: Number(raw.hitCount) || 0,
    missCount: Number(raw.missCount) || 0,
    lastUsedAt: Number(raw.lastUsedAt) || 0,
    autoDisabled: raw.autoDisabled === true,
    missPasswordError: raw.missPasswordError === true
  };
  if (!w.name) w.name = buildLabel(w);
  return w;
}

export { normalizeWorkflow };
