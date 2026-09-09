/**
 * text 引擎 — 纯文本族（MD/TXT/CSV/JSON/XML/HTML/LOG）的零依赖提取。
 *
 * 手法照搬 Opptrix doc-library text-l0：
 * - BOM 识别（UTF-16 LE/BE、UTF-8）；无 BOM 时启发式 UTF-8 vs GB18030/GBK 解码
 *   （逐候选打分：替换符重罚、CJK/可打印 ASCII 加分，UTF-8 接近时优先防误伤纯 ASCII）；
 * - 换行归一（\r\n|\r → \n）+ trim；
 * - CSV 额外转 Markdown 表格（简版：引号感知分列 → | a | b | 管道表，行数封顶防炸）。
 */
import type { ExtractChunk } from '../types.js';

/** 引擎内部统一产物（service 负责包装成 ExtractResult） */
export interface EngineOutput {
  pages: number;
  text: string;
  chunks: ExtractChunk[];
  warnings: string[];
}

/** 文本族支持的扩展名（小写含点） */
export const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.log',
]);

// ---------------------------------------------------------------------------
// 解码（照搬 Opptrix text-l0 的启发式）
// ---------------------------------------------------------------------------

const CJK_START = 0x4e00;
const CJK_END = 0x9fff;
const REPLACEMENT = 0xfffd;
/** UTF-8 与最佳候选分差在此以内时优先 UTF-8，避免误伤纯 ASCII */
const UTF8_PREFER_MARGIN = 8;

function scoreDecodedText(text: string): number {
  let score = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp === REPLACEMENT) {
      score -= 50;
      continue;
    }
    if (cp >= CJK_START && cp <= CJK_END) {
      score += 3;
      continue;
    }
    // 可打印 ASCII + 常见空白
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0x7e)) {
      score += 1;
      continue;
    }
    // 其他常见可打印 Unicode（拉丁扩展等）
    if (cp >= 0xa0 && cp < 0xd800) {
      score += 1;
    }
  }
  return score;
}

function tryDecodeLabel(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 无 BOM：启发式 UTF-8 vs GB18030/GBK */
function decodeTextBufferHeuristic(blob: Buffer): string {
  const bytes = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  const candidates: Array<{ label: string; text: string; score: number }> = [];

  for (const label of ['utf-8', 'gb18030', 'gbk'] as const) {
    // gb18030 已成功时跳过 gbk（超集）
    if (label === 'gbk' && candidates.some((c) => c.label === 'gb18030')) continue;
    const text = tryDecodeLabel(bytes, label);
    if (text == null) continue;
    candidates.push({ label, text, score: scoreDecodedText(text) });
  }

  if (candidates.length === 0) {
    return blob.toString('utf8');
  }

  const utf8 = candidates.find((c) => c.label === 'utf-8');
  let best = candidates[0] as { label: string; text: string; score: number };
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i] as { label: string; text: string; score: number };
    if (c.score > best.score) best = c;
  }

  // UTF-8 分数接近或更好时优先（避免误伤纯 ASCII）
  if (utf8 && utf8.score + UTF8_PREFER_MARGIN >= best.score) {
    return utf8.text;
  }
  return best.text;
}

/** 解码纯文本 buffer（UTF-16 BOM / UTF-8 BOM；无 BOM 时启发式 UTF-8 vs GB18030/GBK） */
export function decodeTextBuffer(blob: Buffer): string {
  if (blob.length >= 2) {
    if (blob[0] === 0xff && blob[1] === 0xfe) {
      return blob.subarray(2).toString('utf16le');
    }
    if (blob[0] === 0xfe && blob[1] === 0xff) {
      const swapped = Buffer.alloc(blob.length - 2);
      for (let i = 2; i + 1 < blob.length; i += 2) {
        swapped[i - 2] = blob[i + 1] ?? 0;
        swapped[i - 1] = blob[i] ?? 0;
      }
      return swapped.toString('utf16le');
    }
  }
  if (blob.length >= 3 && blob[0] === 0xef && blob[1] === 0xbb && blob[2] === 0xbf) {
    return blob.subarray(3).toString('utf8');
  }
  return decodeTextBufferHeuristic(blob);
}

// ---------------------------------------------------------------------------
// CSV → Markdown 表格（简版）
// ---------------------------------------------------------------------------

/** CSV 行数封顶：超出部分丢弃并告警（防万级行拖垮 LLM 上下文） */
export const CSV_MAX_ROWS = 5000;

/** 引号感知的单行分列：双引号包裹的单元格可含逗号/换行转义（"" → "） */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** 探测分隔符：取前几行中 出现次数最多且≥1 的候选（, ; \t） */
function detectDelimiter(text: string): string {
  const sample = text.split('\n').slice(0, 5).join('\n');
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = sample.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** 简易 Markdown 管道表（首行为表头 + 分隔行；单元格竖线转义） */
function rowsToMarkdownTable(rows: string[][]): string | null {
  if (rows.length === 0) return null;
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount < 1) return null;
  const pad = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < colCount) out.push('');
    return out.map((c) => c.replace(/\|/g, '\\|'));
  };
  const [head, ...body] = rows.map(pad);
  return [
    `| ${(head ?? []).join(' | ')} |`,
    `| ${Array(colCount).fill('---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/**
 * CSV 文本 → Markdown 管道表（简版）。
 * 行数超 CSV_MAX_ROWS 截断（告警由调用方根据返回的第二元组判断）。
 */
export function csvToMarkdownTable(text: string): { table: string; truncated: boolean } {
  const delimiter = detectDelimiter(text);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  const truncated = lines.length > CSV_MAX_ROWS;
  const kept = truncated ? lines.slice(0, CSV_MAX_ROWS) : lines;
  const rows = kept.map((line) => splitCsvLine(line, delimiter));
  const table = rowsToMarkdownTable(rows) ?? '';
  return { table, truncated };
}

// ---------------------------------------------------------------------------
// 引擎入口
// ---------------------------------------------------------------------------

/** 纯文本长页软切阈值（与全库 chunk 粒度一致） */
const CHUNK_TARGET = 2800;

function softSplit(text: string): ExtractChunk[] {
  const chunks: ExtractChunk[] = [];
  if (!text) return chunks;
  if (text.length <= CHUNK_TARGET) {
    chunks.push({ text });
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
    if (slice) chunks.push({ text: slice });
    start = end;
  }
  return chunks;
}

/** 是否纯文本族扩展名 */
export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * 文本族提取：解码 → 归一 →（CSV 转 Markdown 表）→ 单页产物。
 * 空内容不抛错：返回空文本 + 告警。
 */
export function extractTextEngine(buffer: Buffer, fileExt: string): EngineOutput {
  const warnings: string[] = [];
  const raw = decodeTextBuffer(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let text = raw.trim();
  if (!text) {
    return { pages: 0, text: '', chunks: [], warnings: ['no readable text found in file'] };
  }

  if (fileExt.toLowerCase() === '.csv') {
    const { table, truncated } = csvToMarkdownTable(raw);
    if (table) {
      text = table;
      if (truncated) warnings.push(`csv rows exceeded ${CSV_MAX_ROWS}; output truncated`);
    }
  }

  return { pages: 1, text, chunks: softSplit(text), warnings };
}
