/**
 * fileextract 引擎与服务单测（≥18 用例）。
 *
 * 覆盖：text 引擎（UTF-8/GBK/UTF-16 BOM 解码、CSV→Markdown 表、空文件）、
 * pdf 引擎（多页、表格启发式、损坏容错、弱文本 needsOcr）、office 引擎（docx/pptx/
 * xlsx 真实最小文件 + 魔数兜底 + OLE 优雅失败）、detectExtractKind 路由矩阵、
 * FileExtractService（任务池派发/回退、大文件警告、file_extracts 持久化覆盖、
 * fileId 提取、OCR 未就绪 needsOcr 不抛）、model-downloader（镜像链回退、HTML 投毒、
 * env 覆盖、状态机）、OCR 单例/空闲卸载、真机 OCR（无模型 skipIf）与扩展桥。
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Knex } from 'knex';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import sharp from 'sharp';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';
import { createLocalDriver } from '../src/kernel/files/drivers/local.js';
import { FileService } from '../src/kernel/files/service.js';
import { HookManager } from '../src/kernel/hooks/manager.js';
import {
  closeOcrEngine,
  createFileExtractBridge,
  detectExtractKind,
  ensureOcrModelsDownloaded,
  EXTRACT_TASK_NAME,
  FileExtractService,
  getOcrDownloadState,
  getOcrLastUsedAtForTests,
  hasOcrSingletonForTests,
  missingOcrModelFiles,
  ocrModelDir,
  releaseOcrInstance,
  resetOcrDownloadStateForTests,
  resolveOcrIdleMs,
  runExtraction,
  setOcrFactoryForTests,
  sourcesForRemote,
  DEFAULT_OCR_IDLE_MS,
} from '../src/kernel/fileextract/index.js';
import type { ExtractResult, ExtractTaskArgs } from '../src/kernel/fileextract/index.js';
import { csvToMarkdownTable, decodeTextBuffer, extractTextEngine } from '../src/kernel/fileextract/engines/text.js';
import { ocrImageBuffer } from '../src/kernel/fileextract/engines/ocr.js';
import { extractPdfEngine, extractTablesFromPageText, isWeakPdfText } from '../src/kernel/fileextract/engines/pdf.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-fileextract-'));
  db = await openSqlite(join(dir, 'kernel.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
});

/** file_extracts 为惰性建表：首建前清理需探测（不存在则跳过） */
async function clearFileExtracts(): Promise<void> {
  if (await db.schema.hasTable('file_extracts')) {
    await db('file_extracts').del();
  }
}

afterAll(async () => {
  await closeOcrEngine();
  await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

/** 主线程直提运行时（无模型、不自动下载） */
function runtime(overrides: { dataDir?: string; autoDownload?: boolean } = {}) {
  return {
    dataDir: overrides.dataDir ?? join(dir, `rt-${Math.random().toString(36).slice(2)}`),
    autoDownload: overrides.autoDownload ?? false,
    logger,
  };
}

// ---------------------------------------------------------------------------
// fixtures（jszip 造最小 OOXML / 手造 PDF / SheetJS 写 xlsx / sharp 造图）
// ---------------------------------------------------------------------------

async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildPptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  for (let i = 0; i < slides.length; i++) {
    const texts = (slides[i] ?? []).map((t) => `<a:t>${t}</a:t>`).join('');
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a">${texts}</p:sld>`);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

function buildXlsx(sheets: Array<{ name: string; rows: unknown[][] }>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** 手造最小 PDF（xref 正确；每页一行 Helvetica 文本） */
function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;
  pages.forEach((text, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objects[pageNum] = `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 100 0 R >> >> >>\nendobj\n`;
    objects[contentNum] = `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });
  objects[100] = '100 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  for (let i = 1; i < objects.length; i++) {
    if (objects[i] === undefined) continue;
    offsets[i] = body.length;
    body += objects[i];
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  body += xref + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function buildTextPng(text: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="120">`
    + `<rect width="100%" height="100%" fill="white"/>`
    + `<text x="20" y="70" font-size="34" font-family="sans-serif" fill="black">${text}</text></svg>`;
  return sharp({ create: { width: 420, height: 120, channels: 3, background: 'white' } })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// text 引擎
// ---------------------------------------------------------------------------

describe('text 引擎', () => {
  it('1. UTF-8 纯文本：单页提取 + chunks + 元数据', () => {
    const out = extractTextEngine(Buffer.from('# Title\n\nhello world', 'utf8'), '.md');
    expect(out.pages).toBe(1);
    expect(out.text).toContain('# Title');
    expect(out.chunks).toHaveLength(1);
    expect(out.warnings).toHaveLength(0);
  });

  it('2. UTF-16 LE BOM 解码', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('bom 文本', 'utf16le')]);
    expect(decodeTextBuffer(buf)).toBe('bom 文本');
  });

  it('3. 无 BOM GBK 启发式解码（中文 → 不乱码）', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // '中文' 的 GBK 编码
    expect(decodeTextBuffer(gbk)).toBe('中文');
  });

  it('4. UTF-8 BOM 剥离', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok', 'utf8')]);
    expect(decodeTextBuffer(buf)).toBe('ok');
  });

  it('5. CSV → Markdown 管道表（表头 + 分隔行 + 行）', () => {
    const { table } = csvToMarkdownTable('Name,Score\nAlice,90\nBob,85\n');
    expect(table.split('\n')[0]).toBe('| Name | Score |');
    expect(table.split('\n')[1]).toBe('| --- | --- |');
    expect(table).toContain('| Alice | 90 |');
    expect(table).toContain('| Bob | 85 |');
  });

  it('6. CSV 引号单元格（含逗号/转义引号）', () => {
    const { table } = csvToMarkdownTable('"a,b","c""d"\nx,y');
    expect(table).toContain('| a,b | c"d |');
    expect(table).toContain('| x | y |');
  });

  it('7. 空文件：空文本 + 告警（不抛错）', () => {
    const out = extractTextEngine(Buffer.alloc(0), '.txt');
    expect(out.text).toBe('');
    expect(out.pages).toBe(0);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('8. runExtraction text 路由：json/log/html 等全走 text 引擎且 fileExt 正确', async () => {
    const json = await runExtraction(
      { data: Buffer.from('{"a":1}', 'utf8'), name: 'data.json' },
      {},
      runtime(),
    );
    expect(json.engine).toBe('text');
    expect(json.fileExt).toBe('.json');
    expect(json.text).toBe('{"a":1}');
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// pdf 引擎
// ---------------------------------------------------------------------------

describe('pdf 引擎', () => {
  it('9. 两页 PDF：页数权威 + 按页文本 + chunks 分页', async () => {
    const out = await extractPdfEngine(buildPdf(['Hello PDF page one', 'Second page content here']));
    expect(out.pages).toBe(2);
    expect(out.text).toContain('Hello PDF page one');
    expect(out.text).toContain('Second page content here');
    expect(out.chunks.map((c) => c.page)).toEqual([1, 2]);
    expect(out.warnings).toHaveLength(0);
  });

  it('10. 表格启发式：多空格对齐行块 → Markdown 表', () => {
    const { prose, tablesMd } = extractTablesFromPageText('前言段落\n名称  数量  单价\n苹果  3  5.0\n结尾');
    expect(tablesMd).toHaveLength(1);
    expect(tablesMd[0]).toContain('| 名称 | 数量 | 单价 |');
    expect(prose).toContain('前言段落');
    expect(prose).toContain('结尾');
  });

  it('11. 损坏 PDF：优雅失败（空文本 + 告警，不抛）', async () => {
    const out = await extractPdfEngine(Buffer.from('%PDF-1.4 garbage not a pdf', 'latin1'));
    expect(out.text).toBe('');
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('12. 弱文本判定阈值：chars/page < 40 或总量 < 80 → weak', () => {
    expect(isWeakPdfText(10, 1)).toBe(true);
    expect(isWeakPdfText(100, 1)).toBe(false);
    expect(isWeakPdfText(200, 10)).toBe(true); // 20 chars/page
    expect(isWeakPdfText(0, 0)).toBe(true);
  });

  it('13. 弱文本 PDF + autoDownload=false：needsOcr 标记 + 告警（不抛）', async () => {
    const result = await runExtraction(
      { data: buildPdf(['hi']), name: 'scan.pdf' },
      {},
      runtime(),
    );
    expect(result.engine).toBe('pdf');
    expect(result.needsOcr).toBe(true);
    expect(result.warnings.some((w) => w.includes('ocr models not installed'))).toBe(true);
    expect(result.ocrUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// office 引擎
// ---------------------------------------------------------------------------

describe('office 引擎', () => {
  it('14. docx（jszip 最小 OOXML）：mammoth 提取正文', async () => {
    const buf = await buildDocx(['Hello Doc', 'Second line']);
    const result = await runExtraction({ data: buf, name: 'hello.docx' }, {}, runtime());
    expect(result.engine).toBe('office');
    expect(result.fileExt).toBe('.docx');
    expect(result.text).toContain('Hello Doc');
    expect(result.text).toContain('Second line');
    expect(result.pages).toBe(1);
  });

  it('15. pptx（jszip slides `<a:t>`）：按幻灯片分页', async () => {
    const buf = await buildPptx([
      ['Slide One Title', 'Slide One Body'],
      ['Slide Two Title'],
    ]);
    const result = await runExtraction({ data: buf, name: 'deck.pptx' }, {}, runtime());
    expect(result.engine).toBe('office');
    expect(result.pages).toBe(2);
    expect(result.text).toContain('Slide One Title');
    expect(result.text).toContain('Slide Two Title');
    expect(result.chunks?.map((c) => c.page)).toEqual([1, 2]);
  });

  it('16. xlsx（SheetJS 真实文件）：逐 sheet 转 Markdown 表并分页', async () => {
    const buf = buildXlsx([
      { name: 'Scores', rows: [['Name', 'Score'], ['Alice', '90']] },
      { name: 'Cities', rows: [['City', 'Pop'], ['SH', '24000000']] },
    ]);
    const result = await runExtraction({ data: buf, name: 'book.xlsx' }, {}, runtime());
    expect(result.engine).toBe('office');
    expect(result.pages).toBe(2);
    expect(result.text).toContain('## Scores');
    expect(result.text).toContain('| Name | Score |');
    expect(result.text).toContain('| Alice | 90 |');
    expect(result.text).toContain('| City | Pop |');
  });

  it('17. 魔数兜底：无扩展名的 docx 内容仍走 office 引擎（ZIP 包内路径探测）', async () => {
    const buf = await buildDocx(['Magic Bytes Doc']);
    const result = await runExtraction({ data: buf }, {}, runtime());
    expect(result.engine).toBe('office');
    expect(result.text).toContain('Magic Bytes Doc');
    expect(result.fileExt).toBe('');
  });

  it('18. OLE 魔数（伪造 .doc）：优雅失败不抛', async () => {
    const buf = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 7)]);
    const result = await runExtraction({ data: buf, name: 'legacy.doc' }, {}, runtime());
    expect(result.engine).toBe('office');
    expect(result.text).toBe('');
    expect(result.needsOcr).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// detectExtractKind 路由矩阵
// ---------------------------------------------------------------------------

describe('detectExtractKind 路由', () => {
  it('19. 文本族硬闸：.txt 扩展名 + %PDF 内容 → text（绝不落 PDF）', () => {
    expect(detectExtractKind(Buffer.from('%PDF-1.4 fake', 'latin1'), { name: 'a.txt' })).toBe('text');
  });

  it('20. 魔数兜底：%PDF → pdf、PNG 魔数 → image、OLE → office、未知 → text', () => {
    expect(detectExtractKind(Buffer.from('%PDF-1.4', 'latin1'), {})).toBe('pdf');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    expect(detectExtractKind(png, {})).toBe('image');
    expect(detectExtractKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), {})).toBe('office');
    expect(detectExtractKind(Buffer.from([0x50, 0x4b, 0x03, 0x04]), {})).toBe('office');
    expect(detectExtractKind(Buffer.from([0x00, 0x01, 0x02, 0x03]), {})).toBe('text');
    expect(detectExtractKind(Buffer.from('x'), { mime: 'application/pdf' })).toBe('pdf');
    expect(detectExtractKind(Buffer.from('x'), { name: 'pic.webp', mime: 'text/plain' })).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// FileExtractService：任务池 / 大文件警告 / 持久化
// ---------------------------------------------------------------------------

function makePoolStub(result: Partial<ExtractResult>) {
  const calls: Array<{ jobId: string; args: ExtractTaskArgs }> = [];
  return {
    calls,
    pool: {
      run: async (jobId: string, args: ExtractTaskArgs): Promise<ExtractResult> => {
        calls.push({ jobId, args });
        return {
          fileExt: '.stub',
          engine: 'text',
          text: 'pooled',
          charCount: 6,
          chunks: [],
          ocrUsed: false,
          warnings: [],
          durationMs: 1,
          ...result,
        };
      },
    },
  };
}

describe('FileExtractService', () => {
  it('21. 注入 taskPool：派发任务池执行（args 含 base64/name/ocr）且结果来自池', async () => {
    const { calls, pool } = makePoolStub({ text: 'pooled text', engine: 'text' });
    const service = new FileExtractService({ ...runtime(), taskPool: pool });
    const result = await service.extract({ data: Buffer.from('abc'), name: 'a.txt' }, { ocr: 'never' });
    expect(result.text).toBe('pooled text');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.dataBase64).toBe(Buffer.from('abc').toString('base64'));
    expect(calls[0]?.args.name).toBe('a.txt');
    expect(calls[0]?.args.ocr).toBe('never');
    expect(EXTRACT_TASK_NAME).toBe('file-extract');
  });

  it('22. taskPool 派发失败：回退主线程 + 附加警告', async () => {
    const service = new FileExtractService({
      ...runtime(),
      taskPool: {
        run: async () => {
          throw new Error('pool is full');
        },
      },
    });
    const result = await service.extract({ data: Buffer.from('fallback text', 'utf8'), name: 'b.txt' });
    expect(result.text).toBe('fallback text');
    expect(result.warnings.some((w) => w.includes('task pool dispatch failed') && w.includes('pool is full'))).toBe(true);
  });

  it('23. 无 taskPool + 大文件：主线程执行 + 大文件警告', async () => {
    const service = new FileExtractService({ ...runtime(), mainThreadWarnBytes: 1024 });
    const result = await service.extract({ data: Buffer.alloc(4096, 97), name: 'big.txt' });
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('main thread'))).toBe(true);
  });

  it('24. extractFile：提取 + file_extracts 惰性建表落库 + 重复提取覆盖', async () => {
    await clearFileExtracts();
    await db('files').del();
    const files = new FileService({
      driver: createLocalDriver(join(dir, 'files-root-1')),
      db,
      hooks: new HookManager(),
      emit: () => undefined,
      logger,
      maxUploadBytes: 1024 * 1024,
    });
    const service = new FileExtractService({ ...runtime(), files, db });
    const rec = await files.store({ data: Buffer.from('stored body', 'utf8'), origName: 'note.txt' });

    const first = await service.extractFile(rec.id);
    expect(first.fileId).toBe(rec.id);
    expect(first.engine).toBe('text');
    expect(first.text).toBe('stored body');

    const stored = await service.getStored(rec.id);
    expect(stored?.text).toBe('stored body');
    expect(stored?.engine).toBe('text');

    // 重复提取：覆盖（仍单行）
    await service.extractFile(rec.id);
    const rows = await db('file_extracts').where({ file_id: rec.id });
    expect(rows).toHaveLength(1);
  });

  it('25. extract({fileId})：读取记录名路由（xlsx 内容按 .xlsx 提取）', async () => {
    await db('files').del();
    const files = new FileService({
      driver: createLocalDriver(join(dir, 'files-root-2')),
      db,
      hooks: new HookManager(),
      emit: () => undefined,
      logger,
      maxUploadBytes: 1024 * 1024,
    });
    const service = new FileExtractService({ ...runtime(), files, db });
    const buf = buildXlsx([{ name: 'S1', rows: [['K', 'V'], ['alpha', '1']] }]);
    const rec = await files.store({ data: buf, origName: 'table.xlsx' });
    const result = await service.extract({ fileId: rec.id });
    expect(result.engine).toBe('office');
    expect(result.fileExt).toBe('.xlsx');
    expect(result.text).toContain('| K | V |');
  });

  it('26. fileId 提取但未装配 files 依赖 → NOT_IMPLEMENTED（不静默）', async () => {
    const service = new FileExtractService(runtime());
    await expect(service.extract({ fileId: 'x' })).rejects.toMatchObject({ code: 'HARNESS-9004' });
  });

  it('27. OCR 未就绪的图片：needsOcr 结果 + 告警（不抛）', async () => {
    const png = await buildTextPng('plain');
    const result = await runExtraction({ data: png, name: 'pic.png' }, {}, runtime());
    expect(result.engine).toBe('ocr');
    expect(result.fileExt).toBe('.png');
    expect(result.needsOcr).toBe(true);
    expect(result.warnings.some((w) => w.includes('ocr models not installed'))).toBe(true);
  });

  it('28. ocr=never 显式禁用：needsOcr + 禁用告警', async () => {
    const png = await buildTextPng('plain');
    const result = await runExtraction({ data: png, name: 'pic.png' }, { ocr: 'never' }, runtime());
    expect(result.warnings.some((w) => w.includes('ocr disabled by request'))).toBe(true);
    expect(result.needsOcr).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// model-downloader：镜像链 / HTML 投毒 / env 覆盖 / 状态机
// ---------------------------------------------------------------------------

describe('model-downloader', () => {
  /** 本地 HTTP 源：{ urlPath → 响应 }；非 200 或 html:true 模拟镜像异常 */
  async function withLocalSource(
    handler: (path: string) => { status: number; body: Buffer; html?: boolean } | undefined,
  ): Promise<{ base: string; close: () => void }> {
    const server: Server = createServer((req, res) => {
      const hit = handler(req.url ?? '/');
      if (hit === undefined) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(hit.status, { 'content-type': hit.html ? 'text/html' : 'application/octet-stream' });
      res.end(hit.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  beforeEach(() => {
    resetOcrDownloadStateForTests();
    delete process.env.HARNESS_OCR_MODEL_DIR;
  });

  afterEach(() => {
    delete process.env.HARNESS_MODELSCOPE_BASE;
    delete process.env.HARNESS_HF_MIRROR;
  });

  it('29. sourcesForRemote：三源镜像链 + HARNESS_* env 覆盖', () => {
    process.env.HARNESS_MODELSCOPE_BASE = 'https://ms.example.com/';
    process.env.HARNESS_HF_MIRROR = 'https://mirror.example.com';
    process.env.HARNESS_OCR_MODELSCOPE_REPO = 'Org/Repo';
    process.env.HARNESS_OCR_HF_REPO = 'Org/Repo';
    process.env.HARNESS_OCR_MODELSCOPE_TAG = 'v9.9';
    const sources = sourcesForRemote('onnx/x.onnx');
    expect(sources.map((s) => s.label)).toEqual(['modelscope', 'hf-mirror', 'huggingface']);
    expect(sources[0]?.url).toBe('https://ms.example.com/models/Org/Repo/resolve/v9.9/onnx/x.onnx');
    expect(sources[1]?.url).toContain('https://mirror.example.com/Org/Repo/resolve/main/onnx/x.onnx');
    expect(sources[2]?.url).toContain('https://huggingface.co/Org/Repo/resolve/main/onnx/x.onnx');
  });

  it('30. 镜像链回退：首源 404 → 次源成功；状态机 downloaded', async () => {
    const modelDir = join(dir, 'dl-models-1');
    const { base, close } = await withLocalSource((p) => {
      if (p.includes('/models/ms/repo/')) return undefined; // modelscope 404
      return { status: 200, body: Buffer.from('model-bytes') };
    });
    process.env.HARNESS_MODELSCOPE_BASE = `${base}/models/ms/repo/resolve/v1`;
    process.env.HARNESS_HF_MIRROR = base;
    process.env.HARNESS_OCR_HF_REPO = 'any';
    try {
      const result = await ensureOcrModelsDownloaded(modelDir);
      expect(result.ok).toBe(true);
      expect(missingOcrModelFiles(modelDir)).toHaveLength(0);
      expect(getOcrDownloadState().state).toBe('downloaded');
    } finally {
      close();
    }
  }, 30_000);

  it('31. HTML 投毒检测：三源都回 HTML → 失败 + error 状态 + 半截文件不落正式名', async () => {
    const modelDir = join(dir, 'dl-models-2');
    const { base, close } = await withLocalSource(() => ({ status: 200, body: Buffer.from('<!doctype html><html>login</html>'), html: true }));
    process.env.HARNESS_MODELSCOPE_BASE = `${base}/ms`;
    process.env.HARNESS_HF_MIRROR = base;
    process.env.HARNESS_OCR_HF_REPO = 'any';
    try {
      const result = await ensureOcrModelsDownloaded(modelDir);
      expect(result.ok).toBe(false);
      expect(result.missingFiles.length).toBeGreaterThan(0);
      expect(getOcrDownloadState().state).toBe('error');
      expect(existsSync(join(modelDir, 'ch_PP-OCRv4_det_mobile.onnx'))).toBe(false);
    } finally {
      close();
    }
  }, 30_000);

  it('32. ocrModelDir：<dataDir>/models/ocr 缺省与 HARNESS_OCR_MODEL_DIR 覆盖；idle env 解析', () => {
    expect(ocrModelDir('/data')).toBe(join('/data', 'models', 'ocr'));
    process.env.HARNESS_OCR_MODEL_DIR = '/custom/models';
    expect(ocrModelDir('/data')).toBe('/custom/models');
    delete process.env.HARNESS_OCR_MODEL_DIR;
    expect(resolveOcrIdleMs({})).toBe(DEFAULT_OCR_IDLE_MS);
    expect(resolveOcrIdleMs({ HARNESS_OCR_IDLE_MS: '0' })).toBe(0);
    expect(resolveOcrIdleMs({ HARNESS_OCR_IDLE_MS: 'bogus' })).toBe(DEFAULT_OCR_IDLE_MS);
  });
});

// ---------------------------------------------------------------------------
// OCR 单例 / 真机 OCR（无模型 skipIf）
// ---------------------------------------------------------------------------

/** 真机模型目录：CI 可用 HARNESS_TEST_OCR_MODEL_DIR 注入；开发机复用 ~/.opptrix 缓存 */
const OCR_TEST_MODEL_DIR
  = process.env.HARNESS_TEST_OCR_MODEL_DIR
  ?? join(homedir(), '.opptrix', 'models', 'llms', 'rapidocr-ppocrv4-mobile');
const OCR_READY = existsSync(join(OCR_TEST_MODEL_DIR, 'ch_PP-OCRv4_det_mobile.onnx'));

describe('ocr 引擎单例', () => {
  afterEach(async () => {
    setOcrFactoryForTests(null);
    await releaseOcrInstance();
    delete process.env.HARNESS_OCR_MODEL_DIR;
  });

  it('33. 单例创建/复用/释放（工厂注入，不加载真实 ONNX）', async () => {
    const modelDir = join(dir, 'fake-models');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(modelDir, { recursive: true });
    for (const f of ['ch_PP-OCRv4_det_mobile.onnx', 'ch_PP-OCRv4_rec_mobile.onnx', 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'ppocr_keys_v1.txt']) {
      writeFileSync(join(modelDir, f), 'stub');
    }
    process.env.HARNESS_OCR_MODEL_DIR = modelDir;
    let created = 0;
    setOcrFactoryForTests(async () => {
      created += 1;
      return { detect: async () => [{ text: 'fake' }] };
    });
    expect(hasOcrSingletonForTests()).toBe(false);
    // 假模型目录 + 假工厂：ocrImageBuffer 走完整单例链路
    const rt = runtime({ dataDir: dir });
    const text1 = await ocrImageBuffer(rt.dataDir, Buffer.from('img'));
    expect(text1).toBe('fake');
    expect(created).toBe(1);
    expect(hasOcrSingletonForTests()).toBe(true);
    await ocrImageBuffer(rt.dataDir, Buffer.from('img'));
    expect(created).toBe(1); // 复用
    expect(getOcrLastUsedAtForTests()).toBeGreaterThan(0);
    await releaseOcrInstance();
    expect(hasOcrSingletonForTests()).toBe(false);
  });
});

describe.skipIf(!OCR_READY)('真机 OCR（PP-OCRv4 模型已就绪）', () => {
  beforeEach(() => {
    process.env.HARNESS_OCR_MODEL_DIR = OCR_TEST_MODEL_DIR;
  });

  afterEach(() => {
    delete process.env.HARNESS_OCR_MODEL_DIR;
  });

  it('34. 图片 OCR：文本非空且 ocrUsed=true（断言放宽：引擎可用时非空）', async () => {
    const png = await buildTextPng('Hello OCR 2026');
    const result = await runExtraction({ data: png, name: 'shot.png' }, {}, runtime({ dataDir: dir }));
    expect(result.engine).toBe('ocr');
    expect(result.ocrUsed).toBe(true);
    expect(result.charCount).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain('hello');
  }, 120_000);

  it('35. 弱文本 PDF → OCR 升级：engine=ocr 且文本来自栅格化页面', async () => {
    const pdf = buildPdf(['Hello PDF page one']);
    const result = await runExtraction({ data: pdf, name: 'scan.pdf' }, {}, runtime({ dataDir: dir }));
    expect(result.ocrUsed).toBe(true);
    expect(result.engine).toBe('ocr');
    expect(result.text).toContain('Hello');
    expect(result.pages).toBe(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 扩展桥
// ---------------------------------------------------------------------------

describe('createFileExtractBridge', () => {
  function bridgeRig(opts: { text?: string; permissionsOk?: boolean } = {}) {
    const permitted: Array<{ extId: string; topic: string; permission: string }> = [];
    const service = {
      extractFile: vi.fn(async (fileId: string) => ({
        fileId,
        engine: 'text',
        ocrUsed: false,
        pages: 1,
        charCount: (opts.text ?? 'short body').length,
        text: opts.text ?? 'short body',
        warnings: [],
        needsOcr: false,
        durationMs: 3,
      })),
      status: vi.fn(() => ({
        state: 'downloaded' as const,
        modelDir: '/models/ocr',
        missingFiles: [],
        autoDownload: false,
      })),
    };
    const bridge = createFileExtractBridge({
      service,
      requirePermission: (extId, topic, permission) => {
        permitted.push({ extId, topic, permission });
        if (opts.permissionsOk === false) {
          throw err('FORBIDDEN', { message: 'missing permission' });
        }
      },
    });
    return { bridge, service, permitted };
  }

  it('36. extract.file：提取并按 32KB 截断标记；权限闸收口 files:read', async () => {
    const { bridge, service, permitted } = bridgeRig();
    const payload = await bridge[KERNEL_TOPICS.extractFile]({ fileId: 'f-1' }, 'ext:doc-demo');
    expect(payload).toMatchObject({ fileId: 'f-1', engine: 'text', charCount: 'short body'.length, truncated: false });
    expect((payload as { text: string }).text).toBe('short body');
    expect(service.extractFile).toHaveBeenCalledWith('f-1', {});
    expect(permitted[0]).toEqual({ extId: 'doc-demo', topic: KERNEL_TOPICS.extractFile, permission: 'files:read' });
  });

  it('37. extract.file：>32KB 文本截断（truncated:true）；opts ocr/deep 透传', async () => {
    const big = 'x'.repeat(40 * 1024);
    const { bridge, service } = bridgeRig({ text: big });
    const payload = (await bridge[KERNEL_TOPICS.extractFile]({ fileId: 'f-2', ocr: 'always', deep: true }, 'ext:demo')) as {
      truncated: boolean;
      text: string;
    };
    expect(payload.truncated).toBe(true);
    expect(payload.text.length).toBeLessThanOrEqual(32 * 1024);
    expect(service.extractFile).toHaveBeenCalledWith('f-2', { ocr: 'always', deep: true });
  });

  it('38. 非扩展端点 / 缺权限 / 非法负载：fail-closed 抛错', async () => {
    const { bridge } = bridgeRig();
    await expect(bridge[KERNEL_TOPICS.extractFile]({ fileId: 'f' }, 'kernel')).rejects.toMatchObject({
      code: 'HARNESS-2003',
    });
    const rig = bridgeRig({ permissionsOk: false });
    await expect(rig.bridge[KERNEL_TOPICS.extractFile]({ fileId: 'f' }, 'ext:demo')).rejects.toMatchObject({
      code: 'HARNESS-1007',
    });
    await expect(bridgeRig().bridge[KERNEL_TOPICS.extractFile]({}, 'ext:demo')).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
  });

  it('39. extract.status：透传 OCR 模型状态（同样过权限闸）', async () => {
    const { bridge, service } = bridgeRig();
    const status = await bridge[KERNEL_TOPICS.extractStatus]({}, 'ext:demo');
    expect(status).toMatchObject({ state: 'downloaded', modelDir: '/models/ocr' });
    expect(service.status).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// system-tools：files_extract 工具（直接注入模式）
// ---------------------------------------------------------------------------

describe('system-tools files_extract', () => {
  it('40. 注入 service：files_extract 提取 + 32KB 截断；未注入 → HARNESS-9001 不抛', async () => {
    const { createExtractTools, createSystemTools } = await import('../src/kernel/mcp/system-tools.js');
    let service: { extractFile: (id: string) => Promise<Record<string, unknown>> } | undefined = {
      extractFile: async (fileId) => ({
        fileId,
        engine: 'pdf',
        ocrUsed: true,
        pages: 3,
        charCount: 100,
        text: 'extracted text',
        warnings: [],
        needsOcr: false,
        durationMs: 5,
      }),
    };
    const tools = createSystemTools(
      createExtractTools(() => ({ service: service as never })),
    );
    const tool = tools.find((t) => t.name === 'files_extract');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ fileId: 'f-9' }, {} as never);
    expect(result).toMatchObject({
      ok: true,
      fileId: 'f-9',
      engine: 'pdf',
      ocrUsed: true,
      pages: 3,
      truncated: false,
      text: 'extracted text',
    });

    service = undefined;
    const miss = await tool!.execute({ fileId: 'f-9' }, {} as never);
    expect(miss).toMatchObject({ ok: false, error: { code: 'HARNESS-9001' } });
  });
});
