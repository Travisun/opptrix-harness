/**
 * FileExtractService — 文件内容提取内核服务（级联分派 + OCR 升级 + 惰性持久化）。
 *
 * 级联路由（扩展名 → MIME → 魔数兜底；文本族硬闸最优先，绝不误入 PDF/OCR 路径）：
 * - 纯文本族（MD/TXT/CSV/JSON/XML/HTML/LOG）→ text 引擎（BOM/GBK 启发式解码，CSV 转表）
 * - %PDF → pdf 引擎（文本层 + 表格启发式）；弱文本层（chars/page 阈值）→ needsOcr
 * - PK ZIP → docx/pptx/xlsx（包内路径探测）；OLE D0CF11E0 → doc → ppt
 * - 图片魔数/扩展名 → OCR 引擎
 * - 其余 → text 引擎兜底
 *
 * OCR 升级策略（opts.ocr = 'auto'（缺省）| 'never' | 'always'；opts.deep 等价 'always'）：
 * - 弱文本 PDF / 图片：模型未就绪时按 deps.autoDownload 决定是否自动下载（三源镜像链）；
 *   未就绪且不下载 → 返回 needsOcr 结果（**不抛错**），warnings 说明原因；
 * - OCR 成功且字数超过文本层时采用 OCR 结果（engine='ocr', ocrUsed=true）。
 *
 * 执行位置：deps.taskPool 注入时优先派发任务线程池（CPU 密集：PDF 解析 / OCR / 解包）；
 * 未注入（JSDoc 警告：生产装配必须注入，主线程执行会阻塞事件循环）或派发失败时回退
 * 主线程执行，大文件（> mainThreadWarnBytes，缺省 4MB）附加警告。同步执行整体 300s 超时。
 *
 * 持久化：`extractFile(fileId)` 提取并把结果写入 `file_extracts`（惰性建表；file_id 主键，
 * 重复提取覆盖），供 LLM files_read 关联读取已提取文本。
 */
import { randomUUID } from 'node:crypto';

import type { Knex } from 'knex';

import { err } from '../errors/index.js';
import type { FileRecord, FileService } from '../files/index.js';
import { ensureOcrModelsDownloaded, ocrModelDir } from './model-downloader.js';
import { extractOfficeEngine } from './engines/office.js';
import { extractPdfEngine, isWeakPdfText } from './engines/pdf.js';
import {
  closeOcrEngine,
  getOcrModelStatus,
  isImageExtension,
  isOcrModelReady,
  ocrImageBuffer,
  ocrPdfBuffer,
} from './engines/ocr.js';
import { extractTextEngine, isTextExtension } from './engines/text.js';
import type {
  ExtractChunk,
  ExtractEngineId,
  ExtractFileInput,
  ExtractInput,
  ExtractOptions,
  ExtractOcrMode,
  ExtractResult,
  ExtractTaskArgs,
  ExtractTaskPool,
  OcrModelStatus,
} from './types.js';
import { EXTRACT_TASK_NAME } from './types.js';

/** 同步执行整体超时（毫秒） */
export const EXTRACT_SYNC_TIMEOUT_MS = 300_000;
/** 主线程执行的大文件警告阈值（字节），缺省 4MB */
export const DEFAULT_MAIN_THREAD_WARN_BYTES = 4 * 1024 * 1024;

type Logger = import('pino').Logger;

/** 提取运行时上下文（service 与任务线程池 handler 共用的最小依赖） */
export interface ExtractRuntime {
  /** 数据目录（OCR 模型根 <dataDir>/models/ocr） */
  dataDir: string;
  /** 模型未就绪时是否允许自动下载（HARNESS_OCR_AUTO_DOWNLOAD） */
  autoDownload: boolean;
  /** 内核 logger */
  logger: Logger;
}

/** FileExtractService 依赖集合 */
export interface FileExtractServiceDeps extends ExtractRuntime {
  /** 文件服务（fileId 提取 / 持久化需要；缺省时 fileId 入参抛 NOT_IMPLEMENTED） */
  files?: FileService;
  /** 内核 knex（file_extracts 惰性建表；与 files 同缺省约束） */
  db?: Knex;
  /**
   * 任务线程池窄接口（生产装配必须提供；未注入时主线程执行 + 大文件警告，
   * 长任务会阻塞事件循环——见模块头注释）。
   */
  taskPool?: ExtractTaskPool;
  /** 主线程执行的大文件警告阈值（字节），缺省 4MB */
  mainThreadWarnBytes?: number;
}

/** file_extracts 行（snake_case） */
interface FileExtractRow {
  file_id: string;
  engine: string;
  text: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// 路由探测（纯函数）
// ---------------------------------------------------------------------------

/** 提取分派目标 */
export type ExtractKind =
  | 'text'
  | 'pdf'
  | 'image'
  | 'docx'
  | 'doc'
  | 'pptx'
  | 'ppt'
  | 'xlsx'
  | 'xls'
  | 'office';

function extOfName(name?: string): string {
  if (!name) return '';
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx).toLowerCase();
}

function isPdfMagic(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

function isZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isOleMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

function isImageMagic(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  // PNG \x89PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true;
  // JPEG FFD8FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  // WEBP RIFF....WEBP
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return true;
  }
  // BMP 'BM'
  return buffer[0] === 0x42 && buffer[1] === 0x4d;
}

/**
 * 级联分派探测：文本族扩展名/文本 MIME 硬闸 → 明确扩展名 → MIME → 魔数 → text 兜底。
 */
export function detectExtractKind(buffer: Buffer, input: { name?: string; mime?: string }): ExtractKind {
  const ext = extOfName(input.name);
  const mime = (input.mime ?? '').toLowerCase();

  // 1) 硬闸：文本族绝不落 PDF/OCR（误标扩展名的纯文本安全直达）
  if (isTextExtension(ext) || mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return 'text';
  }

  // 2) 明确扩展名
  if (ext === '.pdf') return 'pdf';
  if (isImageExtension(ext)) return 'image';
  const officeExt = officeKindOfExt(ext);
  if (officeExt) return officeExt;

  // 3) MIME 二级
  if (mime.includes('pdf')) return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  const officeMime = officeKindOfMime(mime);
  if (officeMime) return officeMime;

  // 4) 魔数兜底
  if (isPdfMagic(buffer)) return 'pdf';
  if (isImageMagic(buffer)) return 'image';
  if (isZipMagic(buffer) || isOleMagic(buffer)) return 'office';

  // 5) 其余 → text 兜底
  return 'text';
}

function officeKindOfExt(ext: string): ExtractKind | null {
  if (ext === '.docx') return 'docx';
  if (ext === '.doc') return 'doc';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.ppt') return 'ppt';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.xls') return 'xls';
  return null;
}

function officeKindOfMime(mime: string): ExtractKind | null {
  if (mime.includes('wordprocessingml')) return 'docx';
  if (mime === 'application/msword' || mime.includes('msword')) return 'doc';
  if (mime.includes('presentationml')) return 'pptx';
  if (mime.includes('ms-powerpoint') || mime.includes('mspowerpoint')) return 'ppt';
  if (mime.includes('spreadsheetml') || mime.includes('ms-excel') || mime.includes('excel')) return 'xlsx';
  return null;
}

// ---------------------------------------------------------------------------
// 提取管线（service 与 worker 任务 handler 共用）
// ---------------------------------------------------------------------------

function baseResult(fileExt: string, now0: number): ExtractResult {
  return {
    fileExt,
    engine: 'text',
    text: '',
    charCount: 0,
    chunks: [],
    ocrUsed: false,
    warnings: [],
    durationMs: 0,
  };
}

function finalize(
  result: ExtractResult,
  engineOut: { pages?: number; text: string; chunks?: ExtractChunk[]; warnings: string[] },
  engine: ExtractEngineId,
  now0: number,
): ExtractResult {
  result.engine = engine;
  result.text = engineOut.text;
  result.charCount = engineOut.text.length;
  result.chunks = engineOut.chunks ?? [];
  result.warnings.push(...engineOut.warnings);
  if (engineOut.pages !== undefined) result.pages = engineOut.pages;
  result.durationMs = Date.now() - now0;
  return result;
}

/** 确保模型就绪：允许自动下载时尝试镜像链下载；返回是否就绪（附状态便于告警） */
async function ensureModelsReady(
  rt: ExtractRuntime,
): Promise<{ ready: boolean; downloaded: boolean; error?: string }> {
  if (isOcrModelReady(rt.dataDir)) return { ready: true, downloaded: false };
  if (!rt.autoDownload) {
    return { ready: false, downloaded: false };
  }
  const dir = ocrModelDir(rt.dataDir);
  rt.logger.info({ dir }, '[fileextract] downloading OCR models');
  const downloaded = await ensureOcrModelsDownloaded(dir);
  if (!downloaded.ok) {
    return { ready: false, downloaded: false, error: 'ocr model download failed' };
  }
  return { ready: true, downloaded: true };
}

/**
 * 核心提取管线：探测 → 引擎 → OCR 升级 → ExtractResult。
 * 内容问题不抛错（warnings + needsOcr）；只有 OCR 自动下载路径的意外异常会被兜底成告警。
 */
export async function runExtraction(
  input: { data: Buffer; name?: string; mime?: string },
  opts: ExtractOptions,
  rt: ExtractRuntime,
): Promise<ExtractResult> {
  const now0 = Date.now();
  const fileExt = extOfName(input.name);
  const mode: ExtractOcrMode = opts.ocr ?? (opts.deep === true ? 'always' : 'auto');
  const kind = detectExtractKind(input.data, { name: input.name, mime: input.mime });

  // ---- 纯文本族 ----
  if (kind === 'text') {
    const out = extractTextEngine(input.data, fileExt);
    const result = finalize(baseResult(fileExt, now0), out, 'text', now0);
    result.needsOcr = result.charCount === 0;
    return result;
  }

  // ---- Office 族 ----
  if (kind !== 'pdf' && kind !== 'image') {
    const out = await extractOfficeEngine(input.data, {
      ...(kind !== 'office' ? { ext: fileExt } : {}),
      ...(input.mime !== undefined ? { mime: input.mime } : {}),
    });
    const result = finalize(baseResult(fileExt, now0), out, 'office', now0);
    result.needsOcr = result.charCount === 0;
    return result;
  }

  // ---- 图片：直接 OCR ----
  if (kind === 'image') {
    const result = baseResult(fileExt, now0);
    result.engine = 'ocr';
    result.pages = 1;
    if (mode === 'never') {
      result.warnings.push('ocr disabled by request (ocr=never)');
      result.needsOcr = true;
      result.durationMs = Date.now() - now0;
      return result;
    }
    const models = await ensureModelsReady(rt);
    if (!models.ready) {
      result.warnings.push(
        models.error !== undefined
          ? 'ocr model download failed; image not recognized'
          : `ocr models not installed (set HARNESS_OCR_AUTO_DOWNLOAD=1 or download to ${ocrModelDir(rt.dataDir)})`,
      );
      result.needsOcr = true;
      result.durationMs = Date.now() - now0;
      return result;
    }
    const text = await ocrImageBuffer(rt.dataDir, input.data);
    result.ocrUsed = true;
    result.text = text;
    result.charCount = text.length;
    result.chunks = text ? [{ page: 1, text }] : [];
    if (!text) result.warnings.push('ocr produced no text for this image');
    result.needsOcr = text.length === 0;
    result.durationMs = Date.now() - now0;
    return result;
  }

  // ---- PDF：文本层 + 弱文本 OCR 升级 ----
  const out = await extractPdfEngine(input.data);
  const result = finalize(baseResult(fileExt, now0), out, 'pdf', now0);
  const weak = isWeakPdfText(result.charCount, result.pages ?? 0);
  const wantOcr = mode === 'always' || (mode === 'auto' && weak);
  if (!wantOcr) {
    if (weak) result.needsOcr = true;
    return result;
  }

  result.needsOcr = true;
  const models = await ensureModelsReady(rt);
  if (!models.ready) {
    result.warnings.push(
      models.error !== undefined
        ? 'ocr model download failed; kept pdf text layer'
        : `ocr models not installed (set HARNESS_OCR_AUTO_DOWNLOAD=1 or download to ${ocrModelDir(rt.dataDir)}); pdf text layer is weak`,
    );
    return result;
  }

  const ocrPages = await ocrPdfBuffer(rt.dataDir, input.data);
  const ocrText = ocrPages.map((p) => p.text).filter(Boolean).join('\n\n').trim();
  result.ocrUsed = ocrText.length > 0;
  // 采纳判据（空白不敏感：OCR 输出常丢空格，不能按原始长度比较）
  const ocrScore = ocrText.replace(/\s+/g, '').length;
  const layerScore = result.text.replace(/\s+/g, '').length;
  if (ocrText.length > 0 && ocrScore >= layerScore) {
    result.engine = 'ocr';
    result.text = ocrText;
    result.charCount = ocrText.length;
    result.chunks = ocrPages
      .filter((p) => p.text)
      .flatMap((p) => splitPageChunks(p.page, p.text));
    result.warnings.push(`ocr upgraded weak pdf text layer (${result.charCount} chars from OCR)`);
    result.needsOcr = isWeakPdfText(result.charCount, result.pages ?? 0);
  } else {
    result.warnings.push('ocr attempted but produced no better text than the pdf text layer');
  }
  result.durationMs = Date.now() - now0;
  return result;
}

function splitPageChunks(page: number, text: string, target = 2800): Array<{ page: number; text: string }> {
  if (!text) return [];
  if (text.length <= target) return [{ page, text }];
  const chunks: Array<{ page: number; text: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + target, text.length);
    if (end < text.length) {
      const soft = text.lastIndexOf('\n\n', end);
      if (soft > start + target / 2) end = soft;
    }
    const slice = text.slice(start, end).trim();
    if (slice) chunks.push({ page, text: slice });
    start = end;
  }
  return chunks;
}

/** 同步执行整体 300s 超时：超时转失败结果（不抛） */
async function withExtractTimeout(work: Promise<ExtractResult>): Promise<ExtractResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<ExtractResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              fileExt: '',
              engine: 'text',
              text: '',
              charCount: 0,
              chunks: [],
              ocrUsed: false,
              warnings: [`extraction timed out after ${EXTRACT_SYNC_TIMEOUT_MS}ms`],
              durationMs: EXTRACT_SYNC_TIMEOUT_MS,
              needsOcr: false,
            }),
          EXTRACT_SYNC_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class FileExtractService {
  readonly #deps: FileExtractServiceDeps;
  #extractTableReady: Promise<void> | null = null;

  constructor(deps: FileExtractServiceDeps) {
    this.#deps = deps;
  }

  /** OCR 模型状态（GET /api/v1/extract/status 与桥共用） */
  status(): OcrModelStatus {
    return getOcrModelStatus(this.#deps.dataDir, this.#deps.autoDownload);
  }

  /**
   * 触发 OCR 模型下载（幂等；已齐备时直接返回 downloaded）。
   * 供集成方预热；提取路径的自动下载另受 deps.autoDownload 控制。
   */
  async downloadModels(): Promise<OcrModelStatus> {
    await ensureOcrModelsDownloaded(ocrModelDir(this.#deps.dataDir));
    return this.status();
  }

  /**
   * 提取文件内容。
   *
   * @param input 直接内容（data 必填）或 { fileId }（需 deps.files，admin 语义可读 private）
   * @param opts ocr / deep
   * @throws HarnessError 仅入参/资源问题（fileId 不存在、无 files/db 依赖）；内容问题一律结果化
   */
  async extract(input: ExtractInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
    if ('fileId' in input && typeof (input as { fileId?: unknown }).fileId === 'string') {
      const { record, data } = await this.#readFile(input.fileId);
      return this.#extractBuffer({ data, name: record.origName, mime: record.mime }, opts);
    }
    const fileInput = input as ExtractFileInput;
    if (!Buffer.isBuffer(fileInput.data)) {
      throw err('VALIDATION_FAILED', { message: 'extract(): data must be a Buffer' });
    }
    return this.#extractBuffer({ data: fileInput.data, name: fileInput.name, mime: fileInput.mime }, opts);
  }

  /**
   * 按 fileId 提取并持久化到 file_extracts（重复提取覆盖，全文落库）。
   * REST POST /api/v1/extract/file/:id、桥 extractFile、MCP files_extract 共用；
   * 各调用面按自身上限对返回 text 再截断（REST 8MB / 桥与工具 32KB）。
   */
  async extractFile(fileId: string, opts: ExtractOptions = {}): Promise<ExtractResult & { fileId: string }> {
    const { record, data } = await this.#readFile(fileId);
    const result = await this.#extractBuffer({ data, name: record.origName, mime: record.mime }, opts);
    await this.#persist(fileId, result);
    return { ...result, fileId };
  }

  /** 读取已持久化的提取结果（files_read 关联面）；无记录返回 null。 */
  async getStored(fileId: string): Promise<{ engine: string; text: string; createdAt: number } | null> {
    const db = this.#requireDb();
    await this.#ensureExtractTable();
    const row = (await db('file_extracts').where({ file_id: fileId }).first()) as FileExtractRow | undefined;
    if (row === undefined) return null;
    return { engine: row.engine, text: row.text, createdAt: Number(row.created_at) };
  }

  /** 释放 OCR 单例（内核停机时调用）；幂等不抛。 */
  async close(): Promise<void> {
    await closeOcrEngine();
  }

  // ---- 内部 ----

  #requireDb(): Knex {
    if (this.#deps.db === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'FileExtractService was assembled without a db dependency; file-backed extract is unavailable',
      });
    }
    return this.#deps.db;
  }

  async #readFile(fileId: string): Promise<{ record: FileRecord; data: Buffer }> {
    if (this.#deps.files === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'FileExtractService was assembled without a files dependency; fileId extract is unavailable',
      });
    }
    // 提取面属内核/管理员语义：private 文件放行（REST 层已做角色门禁；扩展走桥的 files:read 权限闸）
    return this.#deps.files.read(fileId, { allowPrivate: true });
  }

  async #extractBuffer(input: { data: Buffer; name?: string; mime?: string }, opts: ExtractOptions): Promise<ExtractResult> {
    const pool = this.#deps.taskPool;
    if (pool !== undefined) {
      try {
        const args: ExtractTaskArgs = {
          dataBase64: input.data.toString('base64'),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.mime !== undefined ? { mime: input.mime } : {}),
          ...(opts.ocr !== undefined ? { ocr: opts.ocr } : {}),
          ...(opts.deep !== undefined ? { deep: opts.deep } : {}),
        };
        return await pool.run(randomUUID(), args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const result = await this.#extractOnMainThread(input, opts);
        result.warnings.push(`task pool dispatch failed; ran on main thread: ${message}`);
        return result;
      }
    }
    return this.#extractOnMainThread(input, opts);
  }

  async #extractOnMainThread(
    input: { data: Buffer; name?: string; mime?: string },
    opts: ExtractOptions,
  ): Promise<ExtractResult> {
    const result = await withExtractTimeout(runExtraction(input, opts, this.#deps));
    const warnBytes = this.#deps.mainThreadWarnBytes ?? DEFAULT_MAIN_THREAD_WARN_BYTES;
    if (input.data.byteLength > warnBytes) {
      result.warnings.push(
        `large file (${input.data.byteLength} bytes) was extracted on the main thread; configure a task pool for CPU isolation`,
      );
    }
    return result;
  }

  async #ensureExtractTable(): Promise<void> {
    if (this.#extractTableReady === null) {
      this.#extractTableReady = (async () => {
        const db = this.#requireDb();
        const has = await db.schema.hasTable('file_extracts');
        if (!has) {
          await db.schema.createTable('file_extracts', (t) => {
            t.text('file_id').primary();
            t.text('engine').notNullable();
            t.text('text').notNullable().defaultTo('');
            t.integer('created_at').notNullable();
          });
        }
      })();
      this.#extractTableReady.catch(() => {
        this.#extractTableReady = null; // 失败允许重试
      });
    }
    await this.#extractTableReady;
  }

  async #persist(fileId: string, result: ExtractResult): Promise<void> {
    const db = this.#requireDb();
    await this.#ensureExtractTable();
    await db('file_extracts')
      .insert({
        file_id: fileId,
        engine: result.engine,
        text: result.text,
        created_at: Date.now(),
      } satisfies FileExtractRow)
      .onConflict('file_id')
      .merge({ engine: result.engine, text: result.text, created_at: Date.now() });
  }
}

// ---------------------------------------------------------------------------
// 任务线程池 handler（worker 侧注册）
// ---------------------------------------------------------------------------

/** createExtractTaskHandler 依赖（worker 内只缺这些；OCR 单例在 worker 首调用时创建） */
export interface ExtractTaskHandlerDeps {
  dataDir: string;
  logger: Logger;
  autoDownload?: boolean;
}

/**
 * 产出任务池 worker 侧的提取执行器（任务名 {@link EXTRACT_TASK_NAME}，集成方注册进
 * worker 的 fn 分发表）。入参为 {@link ExtractTaskArgs}（JSON 序列化安全），返回
 * {@link ExtractResult}。OCR 引擎单例在本 worker 首次调用时惰性创建（线程私有）。
 */
export function createExtractTaskHandler(
  deps: ExtractTaskHandlerDeps,
): (args: ExtractTaskArgs) => Promise<ExtractResult> {
  const rt: ExtractRuntime = {
    dataDir: deps.dataDir,
    autoDownload: deps.autoDownload ?? false,
    logger: deps.logger,
  };
  return async (args: ExtractTaskArgs) => {
    const data = Buffer.from(args.dataBase64, 'base64');
    return runExtraction(
      { data, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.mime !== undefined ? { mime: args.mime } : {}) },
      { ...(args.ocr !== undefined ? { ocr: args.ocr } : {}), ...(args.deep !== undefined ? { deep: args.deep } : {}) },
      rt,
    );
  };
}

// 便利再导出（集成方装配用）
export { EXTRACT_TASK_NAME };
