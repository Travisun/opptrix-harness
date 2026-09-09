/**
 * pdf 引擎 — pdf-parse 文本层提取（照搬 Opptrix agent/pdf-extract.ts 精简版）。
 *
 * 要点：
 * - 走 `pdf-parse/lib/pdf-parse.js` 子路径（主入口 import 时会读测试文件）；
 * - Buffer 触发 bad XRef 的坑位：入参一律 `new Uint8Array(data)`；
 * - 优先 pagerender 按真实页收集正文（按 Y 坐标拼行），numpages 为页数权威；
 * - 表格启发式：多空格对齐的连续行块 → Markdown 管道表；
 * - 弱文本判定：charCount < 80 或 chars/page < 40 → needsOcr（service 据此升级 OCR）。
 */
import type { ExtractChunk } from '../types.js';
import type { EngineOutput } from './text.js';

/** 弱文本绝对字数阈值（低于视为几乎无文本层） */
export const WEAK_ABS_CHAR_COUNT = 80;
/** 弱文本每页平均字数阈值 */
export const WEAK_CHARS_PER_PAGE = 40;

const CHUNK_TARGET = 2800;

// ---------------------------------------------------------------------------
// 表格启发式（照搬 Opptrix linesToMarkdownTable / extractTablesFromPageText）
// ---------------------------------------------------------------------------

/** 将多空格对齐的行块转为 Markdown 表；失败则返回 null。 */
export function linesToMarkdownTable(lines: string[]): string | null {
  if (lines.length < 2) return null;
  const rows = lines
    .map((line) =>
      line
        .trim()
        .split(/\s{2,}/)
        .map((c) => c.trim())
        .filter(Boolean),
    )
    .filter((r) => r.length > 0);
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount < 2) return null;
  const meaningful = rows.filter((r) => r.length >= 2);
  if (meaningful.length < 2) return null;
  const pad = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < colCount) out.push('');
    return out.map((c) => c.replace(/\|/g, '\\|'));
  };
  const header = pad(meaningful[0] as string[]);
  const body = meaningful.slice(1).map(pad);
  const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
  return [
    `| ${header.join(' | ')} |`,
    sep,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** 从页面纯文本中挑出疑似表格块并转 Markdown。 */
export function extractTablesFromPageText(pageText: string): { prose: string; tablesMd: string[] } {
  const lines = pageText.split('\n');
  const proseParts: string[] = [];
  const tablesMd: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const looksTable = /\S\s{2,}\S/.test(line);
    if (!looksTable) {
      proseParts.push(line);
      i += 1;
      continue;
    }
    const block: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (!/\S\s{2,}\S/.test(cur) && cur.trim() !== '') break;
      if (cur.trim() === '' && block.length > 0) {
        i += 1;
        break;
      }
      if (/\S\s{2,}\S/.test(cur)) block.push(cur);
      else if (cur.trim() === '') {
        i += 1;
        break;
      } else break;
      i += 1;
    }
    const md = linesToMarkdownTable(block);
    if (md) tablesMd.push(md);
    else proseParts.push(...block);
  }
  return { prose: proseParts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tablesMd };
}

// ---------------------------------------------------------------------------
// 页收集与拼装
// ---------------------------------------------------------------------------

/** 与 pdf-parse 默认 pagerender 等价：按 Y 坐标拼行。 */
async function renderPdfPageText(pageData: {
  getTextContent: (opts: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }) => Promise<{ items: Array<{ str?: string; transform?: number[] }> }>;
}): Promise<string> {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY: number | undefined;
  let text = '';
  for (const item of textContent.items) {
    const str = typeof item.str === 'string' ? item.str : '';
    const y = Array.isArray(item.transform) ? item.transform[5] : undefined;
    if (lastY === y || lastY === undefined) {
      text += str;
    } else {
      text += `\n${str}`;
    }
    lastY = y;
  }
  return text;
}

function splitPages(rawText: string): string[] {
  const normalized = rawText.replace(/\r\n/g, '\n');
  if (normalized.includes('\f')) {
    return normalized.split('\f').map((p) => p.trim()).filter(Boolean);
  }
  // pdf-parse 有时用多重换行近似分页（仅作 pagerender 失败时的回退）
  const soft = normalized.split(/\n{4,}/).map((p) => p.trim()).filter(Boolean);
  if (soft.length > 1) return soft;
  return normalized.trim() ? [normalized.trim()] : [];
}

/** Node 24 + pdf-parse 1.1.x：Buffer 会触发 bad XRef；纯 Uint8Array 正常。 */
function toPdfParseInput(data: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(data);
}

function softSplitPage(page: number, text: string): ExtractChunk[] {
  const chunks: ExtractChunk[] = [];
  if (!text) return chunks;
  if (text.length <= CHUNK_TARGET) {
    chunks.push({ page, text });
    return chunks;
  }
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_TARGET, text.length);
    if (end < text.length) {
      const soft = text.lastIndexOf('\n\n', end);
      if (soft > start + CHUNK_TARGET / 2) end = soft;
    }
    const slice = text.slice(start, end).trim();
    if (slice) chunks.push({ page, text: slice });
    start = end;
  }
  return chunks;
}

/**
 * 弱文本判定：字数过低或 chars/page 低于阈值 → 建议升级 OCR。
 */
export function isWeakPdfText(charCount: number, pageCount: number): boolean {
  if (pageCount <= 0) return true;
  if (charCount < WEAK_ABS_CHAR_COUNT) return true;
  return charCount / pageCount < WEAK_CHARS_PER_PAGE;
}

/**
 * PDF 文本层提取。内容问题（加密 / 损坏 / 无文本层）不抛错：返回空文本 + 告警。
 */
export async function extractPdfEngine(buffer: Buffer): Promise<EngineOutput> {
  const warnings: string[] = [];
  let pageTexts: string[] = [];
  let pageCount = 0;

  try {
    // pdf-parse 子路径无官方类型（vendor.d.ts 声明）；动态 import 避免非 PDF 场景白加载
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = mod.default;
    const collected: string[] = [];
    const result = await pdfParse(toPdfParseInput(buffer), {
      pagerender: async (pageData) => {
        const pageText = await renderPdfPageText(pageData);
        collected.push(pageText);
        return pageText;
      },
    });
    const numpages = Number(result.numpages);
    // pageCount 以 pdf-parse numpages 为准；禁止用「仅成功拆出的页数」覆盖真实页数
    pageCount =
      Number.isFinite(numpages) && numpages > 0 ? Math.floor(numpages) : Math.max(collected.length, 1);

    if (collected.length > 0) {
      pageTexts = [...collected];
      while (pageTexts.length < pageCount) pageTexts.push('');
    } else {
      const raw = String(result.text ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      pageTexts = splitPages(raw);
      if (pageTexts.length === 0 && pageCount > 0) pageTexts = [''];
    }
  } catch (e) {
    warnings.push(`pdf text layer extraction failed: ${e instanceof Error ? e.message : String(e)}`);
    return { pages: 0, text: '', chunks: [], warnings };
  }

  const pageTextsNormalized = pageTexts.map((t) =>
    t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
  );
  const proseParts: string[] = [];
  const chunks: ExtractChunk[] = [];
  for (let i = 0; i < pageTextsNormalized.length; i++) {
    const page = i + 1;
    const normalized = pageTextsNormalized[i] ?? '';
    const { prose, tablesMd } = extractTablesFromPageText(normalized);
    const pageText = [prose || normalized, ...tablesMd].filter(Boolean).join('\n\n').trim();
    proseParts.push(pageText);
    chunks.push(...softSplitPage(page, pageText));
  }

  const text = proseParts.filter(Boolean).join('\n\n').trim();
  if (!text) {
    warnings.push('pdf has no extractable text layer (likely scanned); OCR recommended');
  }
  return { pages: pageCount, text, chunks, warnings };
}
