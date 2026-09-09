/**
 * office 引擎 — Word / PowerPoint / Excel 的零转换提取（手法照搬 Opptrix office-l0）。
 *
 * - .docx → mammoth extractRawText（单页）
 * - .doc  → word-extractor（正文 + 页眉脚 + 脚注尾注 + 文本框；单页）
 * - .pptx → jszip 解 slides XML `<a:t>` 按幻灯片分页
 * - .ppt  → ppt-to-text（readBuffer + utils.to_text；按幻灯片分页）
 * - .xlsx → SheetJS 逐 sheet 转 Markdown 管道表（按 sheet 分页；新能力）
 *
 * 路由兜底：扩展名缺失/误标时按魔数（PK ZIP / OLE D0CF11E0）+ 包内路径探测。
 * 内容问题一律不抛错：空文本 + 告警。
 */
import { createRequire } from 'node:module';

import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

import type { ExtractChunk } from '../types.js';
import type { EngineOutput } from './text.js';

const require = createRequire(import.meta.url);
const pptToText = require('ppt-to-text') as import('ppt-to-text').PptToTextModule;
const WordExtractor = require('word-extractor') as new () => import('word-extractor').default;

const A_T_RE = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;

/** Office 族扩展名 → kind */
export type OfficeKind = 'docx' | 'doc' | 'pptx' | 'ppt' | 'xlsx' | 'xls';

const OFFICE_EXTENSION_KINDS: Record<string, OfficeKind> = {
  '.docx': 'docx',
  '.doc': 'doc',
  '.pptx': 'pptx',
  '.ppt': 'ppt',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
};

export function officeKindFromExtension(ext: string): OfficeKind | null {
  return OFFICE_EXTENSION_KINDS[ext.toLowerCase()] ?? null;
}

/** mime → office kind（扩展名缺失时的二级依据） */
export function officeKindFromMime(mime: string): OfficeKind | null {
  const m = mime.toLowerCase();
  if (m.includes('wordprocessingml')) return 'docx';
  if (m === 'application/msword' || m.includes('msword')) return 'doc';
  if (m.includes('presentationml')) return 'pptx';
  if (m.includes('ms-powerpoint') || m.includes('mspowerpoint')) return 'ppt';
  if (m.includes('spreadsheetml') || m.includes('ms-excel') || m.includes('excel')) {
    return m.includes('sheet') || m.includes('excel') ? 'xlsx' : 'xls';
  }
  return null;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizeText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function pageTextToChunks(pages: Array<{ page: number; text: string }>, target = 2800): ExtractChunk[] {
  const chunks: ExtractChunk[] = [];
  for (const p of pages) {
    const text = p.text;
    if (!text) continue;
    if (text.length <= target) {
      chunks.push({ page: p.page, text });
      continue;
    }
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + target, text.length);
      if (end < text.length) {
        const soft = text.lastIndexOf('\n\n', end);
        if (soft > start + target / 2) end = soft;
      }
      const slice = text.slice(start, end).trim();
      if (slice) chunks.push({ page: p.page, text: slice });
      start = end;
    }
  }
  return chunks;
}

function outputFromPages(
  pages: Array<{ page: number; text: string }>,
  warnings: string[] = [],
): EngineOutput {
  const text = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
  return { pages: pages.length, text, chunks: pageTextToChunks(pages), warnings };
}

function failed(message: string): EngineOutput {
  return { pages: 0, text: '', chunks: [], warnings: [message] };
}

function slideIndex(name: string): number | null {
  const m = /ppt\/slides\/slide(\d+)\.xml$/i.exec(name.replace(/\\/g, '/'));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// docx / doc
// ---------------------------------------------------------------------------

async function extractDocx(buffer: Buffer): Promise<EngineOutput> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = normalizeText(result.value ?? '');
    if (!text) return failed('docx contains no readable text');
    return outputFromPages([{ page: 1, text }]);
  } catch (e) {
    return failed(`docx extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function extractDoc(buffer: Buffer): Promise<EngineOutput> {
  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    const parts = [
      doc.getBody(),
      doc.getHeaders(),
      doc.getFooters(),
      doc.getFootnotes(),
      doc.getEndnotes(),
      doc.getTextboxes(),
    ]
      .map((s) => normalizeText(s ?? ''))
      .filter(Boolean);
    const text = parts.join('\n\n').trim();
    if (!text) return failed('doc contains no readable text');
    return outputFromPages([{ page: 1, text }]);
  } catch (e) {
    return failed(`doc extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// pptx / ppt
// ---------------------------------------------------------------------------

function extractSlideText(xml: string): string {
  const parts: string[] = [];
  A_T_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = A_T_RE.exec(xml)) !== null) {
    const t = decodeXmlEntities(match[1] ?? '').trim();
    if (t) parts.push(t);
  }
  return parts.join('\n').trim();
}

async function extractPptx(buffer: Buffer): Promise<EngineOutput> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entries = Object.keys(zip.files)
      .map((name) => ({ name, idx: slideIndex(name) }))
      .filter((e): e is { name: string; idx: number } => e.idx !== null)
      .sort((a, b) => a.idx - b.idx);
    if (entries.length === 0) return failed('pptx has no slide xml entries');

    const pages: Array<{ page: number; text: string }> = [];
    for (const entry of entries) {
      const file = zip.file(entry.name);
      if (!file) continue;
      const xml = await file.async('string');
      pages.push({ page: entry.idx, text: extractSlideText(xml) });
    }
    const text = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
    if (!text) return failed('pptx slides contain no readable text');
    return outputFromPages(pages);
  } catch (e) {
    return failed(`pptx extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function extractPpt(buffer: Buffer): Promise<EngineOutput> {
  try {
    const pres = pptToText.readBuffer(buffer);
    const slideTexts = pptToText.utils.to_text(pres);
    if (slideTexts.length > 0) {
      const pages = slideTexts.map((text, i) => ({ page: i + 1, text: normalizeText(String(text ?? '')) }));
      const text = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
      if (!text) return failed('ppt slides contain no readable text');
      return outputFromPages(pages);
    }
    const flat = normalizeText(pptToText.extractText(buffer, { separator: '\n\n' }));
    if (!flat) return failed('ppt contains no readable text');
    return outputFromPages([{ page: 1, text: flat }]);
  } catch (e) {
    return failed(`ppt extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// xlsx（SheetJS 逐 sheet → Markdown 管道表）
// ---------------------------------------------------------------------------

/** xlsx 行数封顶（每 sheet）；超出截断 + 告警 */
export const XLSX_MAX_ROWS_PER_SHEET = 5000;

function sheetToMarkdown(rows: Array<Array<string | number | boolean | null>>): string | null {
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount < 1) return null;
  const pad = (cells: Array<string | number | boolean | null>): string[] => {
    const out = [...cells];
    while (out.length < colCount) out.push('');
    return out.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '));
  };
  const [head, ...body] = rows.map(pad);
  return [
    `| ${(head ?? []).join(' | ')} |`,
    `| ${Array(colCount).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

async function extractXlsx(buffer: Buffer): Promise<EngineOutput> {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    if (wb.SheetNames.length === 0) return failed('workbook has no sheets');
    const warnings: string[] = [];
    const pages: Array<{ page: number; text: string }> = [];
    for (let i = 0; i < wb.SheetNames.length; i++) {
      const name = wb.SheetNames[i] as string;
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as Array<
        Array<string | number | boolean | null>
      >;
      while (rows.length > 0 && rows[rows.length - 1]?.every((c) => String(c ?? '').trim() === '')) rows.pop();
      const truncated = rows.length > XLSX_MAX_ROWS_PER_SHEET;
      if (truncated) {
        rows.length = XLSX_MAX_ROWS_PER_SHEET;
        warnings.push(`sheet "${name}" rows exceeded ${XLSX_MAX_ROWS_PER_SHEET}; output truncated`);
      }
      const table = sheetToMarkdown(rows) ?? '';
      pages.push({ page: i + 1, text: table ? `## ${name}\n\n${table}` : '' });
    }
    const text = pages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
    if (!text) return failed('workbook sheets contain no readable cells');
    return outputFromPages(pages, warnings);
  } catch (e) {
    return failed(`xlsx extraction failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// 路由入口
// ---------------------------------------------------------------------------

async function zipPeek(buffer: Buffer): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    return Object.keys(zip.files);
  } catch {
    return [];
  }
}

/** 是否 OLE 复合文档魔数（D0 CF 11 E0） */
export function isOleCompound(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0
  );
}

/**
 * Office 族提取入口：按 kind 分派；kind 缺失时按魔数 + 包内路径探测
 * （PK→docx/pptx/xlsx、OLE→doc→ppt）。扩展名优先于魔数（调用方 service 已做文本族硬闸）。
 */
export async function extractOfficeEngine(
  buffer: Buffer,
  opts: { ext?: string; mime?: string } = {},
): Promise<EngineOutput> {
  const kind =
    officeKindFromExtension(opts.ext ?? '') ?? officeKindFromMime(opts.mime ?? '');
  if (kind === 'docx') return extractDocx(buffer);
  if (kind === 'doc') return extractDoc(buffer);
  if (kind === 'pptx') return extractPptx(buffer);
  if (kind === 'ppt') return extractPpt(buffer);
  if (kind === 'xlsx' || kind === 'xls') return extractXlsx(buffer);

  // 魔数兜底：OOXML ZIP
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const names = await zipPeek(buffer);
    if (names.some((n) => /word\/document\.xml$/i.test(n))) return extractDocx(buffer);
    if (names.some((n) => /ppt\/slides\/slide\d+\.xml$/i.test(n))) return extractPptx(buffer);
    if (names.some((n) => /^xl\/workbook\.xml$/i.test(n))) return extractXlsx(buffer);
    // 魔数是 ZIP 但不是可识别的 OOXML：如实告知（避免把 zip 当文本灌给调用方）
    return failed('zip container is not a recognizable docx/pptx/xlsx package');
  }

  // OLE 复合文档：优先 .doc，再 .ppt（doc 失败时 ppt 兜底，与 Opptrix 一致）
  if (isOleCompound(buffer)) {
    const asDoc = await extractDoc(buffer);
    if (!asDoc.warnings.length && asDoc.text) return asDoc;
    const asPpt = await extractPpt(buffer);
    if (!asPpt.warnings.length && asPpt.text) return asPpt;
    return {
      ...asDoc,
      warnings: [
        ...asDoc.warnings,
        ...asPpt.warnings,
        'OLE compound document could not be read as doc or ppt',
      ],
    };
  }

  return failed('unable to recognize office document format');
}
