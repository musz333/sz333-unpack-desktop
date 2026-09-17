/**
 * 工作流卡片包：批量导出 / 导入（从 v1.9 的 WorkflowPack.cs 移植）
 *
 * 设计要点（与 v1.9 一致）：
 *  · 导出内容包含**锚点密码明文** —— 锚点密码就是卡片的身份，脱敏等于作废；
 *    因此导出前界面必须提示"内含解压密码，分享前请确认对象"。
 *  · 导入先解析成预览清单（新增 / 同锚点冲突 / 低置信 / 无锚点跳过 / 损坏），
 *    由用户勾选后再写入；冲突策略默认"保留本地"。
 *  · 去重键 = 锚点密码，与内部"一个锚点只保留一条生效记录"的规则一致。
 *  · 覆盖时只替换链路与指纹，**保留本地战绩**（命中次数是本地历史，不该被顶掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeWorkflow,
  buildLabel,
  chainText,
  WORKFLOW_PACK_SCHEMA,
  type Workflow,
  type WorkflowStep
} from './workflows';

export interface WorkflowCardDto {
  name: string;
  anchorPassword: string;
  fingerprint: string;
  primVolSize: number;
  volCount: number;
  nameHint: string;
  layerCount: number;
  note: string;
  enabled: boolean;
  hitCount: number;
  missCount: number;
  lastUsed: string;
  created: string;
  steps: WorkflowStep[];
}

export interface WorkflowPackFile {
  schemaVersion: number;
  exportedAt: string;
  tool: string;
  cards: WorkflowCardDto[];
}

export interface ImportPreviewItem {
  card: WorkflowCardDto;
  /** 新增 / 冲突 / 低置信 / 无锚点跳过 */
  kind: 'new' | 'conflict' | 'low-confidence' | 'skipped';
  /** 与本地冲突时，本地那条的摘要 */
  localSummary: string;
  /** 默认是否勾选 */
  selected: boolean;
}

export interface ImportPreview {
  sourceFile: string;
  error?: string;
  items: ImportPreviewItem[];
  newCount: number;
  conflictCount: number;
  lowConfidenceCount: number;
  skippedCount: number;
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseTime(s: string): number {
  if (!s) return 0;
  const t = Date.parse(s.replace(/-/g, '/'));
  return Number.isFinite(t) ? t : 0;
}

export function toDto(w: Workflow): WorkflowCardDto {
  return {
    name: w.name,
    anchorPassword: w.anchorPassword,
    fingerprint: w.fingerprint,
    primVolSize: w.primVolSize,
    volCount: w.volCount,
    nameHint: w.nameHint,
    layerCount: w.layerCount,
    note: w.note,
    enabled: w.enabled && !w.autoDisabled,
    hitCount: w.hitCount,
    missCount: w.missCount,
    lastUsed: fmtTime(w.lastUsedAt),
    created: fmtTime(w.createdAt),
    steps: w.steps
  };
}

export function fromDto(d: WorkflowCardDto): Workflow | null {
  if (!d) return null;
  const raw = {
    name: d.name,
    anchorPassword: d.anchorPassword,
    fingerprint: d.fingerprint,
    primVolSize: d.primVolSize,
    volCount: d.volCount,
    nameHint: d.nameHint,
    layerCount: d.layerCount,
    note: d.note,
    enabled: d.enabled,
    hitCount: d.hitCount,
    missCount: d.missCount,
    lastUsedAt: parseTime(d.lastUsed),
    createdAt: parseTime(d.created) || Date.now(),
    steps: d.steps
  };
  return normalizeWorkflow(raw as unknown as Partial<Workflow> & Record<string, unknown>);
}

/** 卡片摘要（列表 / 预览共用） */
export function describeCard(d: WorkflowCardDto): string {
  const anchor = d.anchorPassword || '（无锚点）';
  const layers = d.steps?.length ?? d.layerCount;
  return `锚点 ${anchor} · ${layers} 层 · 命中 ${d.hitCount} 次`;
}

export function describeWorkflow(w: Workflow): string {
  return `${w.anchorPassword || '（无锚点）'} · ${w.steps.length} 层 · 命中 ${w.hitCount} 次`;
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

export function exportPack(filePath: string, flows: Workflow[]): number {
  if (!flows?.length) throw new Error('没有可导出的工作流');
  const pack: WorkflowPackFile = {
    schemaVersion: WORKFLOW_PACK_SCHEMA,
    exportedAt: fmtTime(Date.now()),
    tool: 'sz333 解压工具 v1.0 (Electron)',
    cards: flows.map(toDto)
  };
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(pack, null, 2), 'utf8');
  return pack.cards.length;
}

export function suggestFileName(count: number): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `工作流卡片_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${count}张.json`;
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

export function previewPack(filePath: string, localFlows: Workflow[]): ImportPreview {
  const preview: ImportPreview = {
    sourceFile: filePath,
    items: [],
    newCount: 0,
    conflictCount: 0,
    lowConfidenceCount: 0,
    skippedCount: 0
  };

  let pack: WorkflowPackFile | null = null;
  try {
    pack = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    preview.error = `文件无法解析（不是本工具导出的工作流卡片包？）：${e instanceof Error ? e.message : String(e)}`;
    return preview;
  }

  if (!pack?.cards?.length) {
    preview.error = '文件里没有工作流卡片。';
    return preview;
  }
  if (pack.schemaVersion > WORKFLOW_PACK_SCHEMA) {
    preview.error = `文件由更新版本的工具导出（schema ${pack.schemaVersion}），当前版本无法识别。`;
    return preview;
  }

  // 本地按锚点密码索引，用于判定冲突
  const localByAnchor = new Map<string, Workflow>();
  for (const w of localFlows ?? []) {
    if (w?.anchorPassword && !localByAnchor.has(w.anchorPassword)) localByAnchor.set(w.anchorPassword, w);
  }

  for (const card of pack.cards) {
    const item: ImportPreviewItem = {
      card,
      kind: 'new',
      localSummary: '',
      selected: true
    };

    if (!card.anchorPassword) {
      item.kind = 'skipped';
      item.selected = false;
      preview.skippedCount += 1;
    } else {
      const local = localByAnchor.get(card.anchorPassword);
      if (local) {
        item.kind = 'conflict';
        item.localSummary = describeWorkflow(local);
        item.selected = false; // 冲突项默认不勾选（保守）
        preview.conflictCount += 1;
      } else if (!card.fingerprint) {
        item.kind = 'low-confidence';
        item.selected = true;
        preview.lowConfidenceCount += 1;
      } else {
        item.kind = 'new';
        item.selected = true;
        preview.newCount += 1;
      }
    }
    preview.items.push(item);
  }
  return preview;
}

/**
 * 应用导入
 * @param overwriteExisting true → 同锚点用导入的覆盖本地；false → 保留本地
 */
export function applyImport(
  preview: ImportPreview,
  localFlows: Workflow[],
  overwriteExisting: boolean
): { added: number; overwritten: number; skipped: number } {
  let added = 0;
  let overwritten = 0;
  let skipped = 0;

  for (const item of preview.items ?? []) {
    if (!item.selected) continue;
    const incoming = fromDto(item.card);
    if (!incoming || !incoming.anchorPassword) {
      skipped += 1;
      continue;
    }

    const exist = localFlows.find((w) => w.anchorPassword === incoming.anchorPassword);

    if (!exist) {
      localFlows.push(incoming);
      added += 1;
    } else if (overwriteExisting) {
      // 覆盖链路与指纹，但保留本地统计（导入包里的统计是导出方的历史）
      exist.steps = incoming.steps;
      exist.fingerprint = incoming.fingerprint;
      exist.primVolSize = incoming.primVolSize;
      exist.volCount = incoming.volCount;
      exist.nameHint = incoming.nameHint;
      exist.layerCount = incoming.layerCount;
      exist.name = incoming.name || exist.name;
      exist.note = incoming.note;
      exist.enabled = true;
      exist.autoDisabled = false;
      exist.missCount = 0;
      exist.name = exist.name || buildLabel(exist);
      overwritten += 1;
    } else {
      skipped += 1;
    }
  }
  return { added, overwritten, skipped };
}

export { chainText };
