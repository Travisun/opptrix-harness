/**
 * ocr 引擎 — Node 内 ONNX OCR（@gutenye/ocr-node + PP-OCRv4 mobile 模型）。
 * 手法照搬 Opptrix doc-library ocr-l2：
 * - 图片（png/jpg/webp/bmp）直接 OCR（经临时文件喂 detect）；
 * - 弱文本 PDF → @hyzyla/pdfium 栅格化（scale 2，sharp raw→png）→ 逐页 OCR；
 * - 单例引擎 + 空闲 12 分钟卸载（HARNESS_OCR_IDLE_MS 覆盖，0 = 关闭）；
 * - 整次 OCR 300s 超时；批量并发 3；
 * - 模型/运行时未就绪或失败一律返回空结果（不抛），由 service 转为 needsOcr。
 *
 * 注意：单例状态是 **线程私有** 的——提取任务跑在任务线程池 worker 内时，
 * OCR 引擎在 worker 首次调用时才创建（与主进程互不影响）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { missingOcrModelFiles, ocrModelDir } from '../model-downloader.js';
import type { OcrModelStatus } from '../types.js';
import { getOcrDownloadState } from '../model-downloader.js';

/** 单次 OCR 整体超时（毫秒） */
export const OCR_TIMEOUT_MS = 300_000;
/** 批量 OCR 默认并发 */
export const OCR_CONCURRENCY = 3;
/** 默认空闲 12 分钟卸载 */
export const DEFAULT_OCR_IDLE_MS = 12 * 60 * 1000;

/** 支持直接 OCR 的图片扩展名 */
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// 可用性
// ---------------------------------------------------------------------------

let onnxProbe: Promise<boolean> | null = null;

async function probeOnnxRuntime(): Promise<boolean> {
  try {
    await import('@gutenye/ocr-node');
    return true;
  } catch {
    try {
      await import('onnxruntime-node');
      return true;
    } catch {
      return false;
    }
  }
}

function onnxReadyCached(): Promise<boolean> {
  if (!onnxProbe) onnxProbe = probeOnnxRuntime();
  return onnxProbe;
}

/** 模型四件套是否齐备（不探测 onnx 运行时） */
export function isOcrModelReady(dataDir: string): boolean {
  const dir = ocrModelDir(dataDir);
  return missingOcrModelFiles(dir).length === 0;
}

/** OCR 状态视图（REST / 桥共用）：内存下载状态机 + 磁盘模型文件复合 */
export function getOcrModelStatus(dataDir: string, autoDownload: boolean): OcrModelStatus {
  const dir = ocrModelDir(dataDir);
  const missing = missingOcrModelFiles(dir);
  const dl = getOcrDownloadState();
  if (missing.length === 0) {
    return { state: 'downloaded', modelDir: dir, missingFiles: [], autoDownload };
  }
  if (dl.state === 'downloading') {
    return {
      state: 'downloading',
      percent: dl.percent ?? 0,
      modelDir: dir,
      missingFiles: missing,
      autoDownload,
    };
  }
  if (dl.state === 'error') {
    return {
      state: 'error',
      modelDir: dir,
      missingFiles: missing,
      error: dl.error ?? 'ocr model download failed',
      autoDownload,
    };
  }
  return { state: 'not-downloaded', modelDir: dir, missingFiles: missing, autoDownload };
}

/** OCR 引擎当前是否真正可跑（模型齐备 + onnx 运行时可加载） */
export async function isOcrAvailable(dataDir: string): Promise<boolean> {
  if (!isOcrModelReady(dataDir)) return false;
  return onnxReadyCached();
}

// ---------------------------------------------------------------------------
// 单例 + 空闲卸载
// ---------------------------------------------------------------------------

type OcrLine = { text?: string };
type OcrInstance = {
  detect: (input: string | Buffer) => Promise<OcrLine[]>;
  dispose?: () => void | Promise<void>;
  close?: () => void | Promise<void>;
};

export function resolveOcrIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.HARNESS_OCR_IDLE_MS;
  if (raw == null || raw === '') return DEFAULT_OCR_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_OCR_IDLE_MS;
  return n;
}

type OcrFactory = (modelDir: string) => Promise<OcrInstance>;

let ocrSingleton: Promise<OcrInstance> | null = null;
let ocrIdleTimer: ReturnType<typeof setTimeout> | null = null;
let ocrIdleUnloadPromise: Promise<void> | null = null;
let ocrLastUsedAt = 0;
/** 测试可注入，避免真实 Ocr.create */
let ocrFactoryForTests: OcrFactory | null = null;

function clearOcrIdleTimer(): void {
  if (ocrIdleTimer) {
    clearTimeout(ocrIdleTimer);
    ocrIdleTimer = null;
  }
}

function scheduleOcrIdleUnload(): void {
  clearOcrIdleTimer();
  const idleMs = resolveOcrIdleMs();
  if (idleMs <= 0) return;
  ocrIdleTimer = setTimeout(() => {
    ocrIdleTimer = null;
    void runOcrIdleUnload();
  }, idleMs);
  if (typeof ocrIdleTimer === 'object' && ocrIdleTimer && 'unref' in ocrIdleTimer) {
    (ocrIdleTimer as { unref(): void }).unref();
  }
}

function touchOcrLastUsed(): void {
  ocrLastUsedAt = Date.now();
  scheduleOcrIdleUnload();
}

async function disposeOcrInstance(instance: OcrInstance): Promise<void> {
  const disposer =
    typeof instance.dispose === 'function'
      ? instance.dispose.bind(instance)
      : typeof instance.close === 'function'
        ? instance.close.bind(instance)
        : null;
  if (!disposer) {
    // @gutenye/ocr-node 当前无公开 dispose/close；置空 singleton 依赖 GC 回收 ONNX 会话
    return;
  }
  try {
    await disposer();
  } catch {
    /* ignore teardown races */
  }
}

/** 释放 OCR singleton；失败不抛，下次调用可再创建。 */
export async function releaseOcrInstance(): Promise<void> {
  clearOcrIdleTimer();
  const pending = ocrSingleton;
  ocrSingleton = null;
  if (!pending) return;
  let instance: OcrInstance;
  try {
    instance = await pending;
  } catch {
    return;
  }
  await disposeOcrInstance(instance);
}

async function runOcrIdleUnload(): Promise<void> {
  if (ocrIdleUnloadPromise) {
    await ocrIdleUnloadPromise;
    return;
  }
  ocrIdleUnloadPromise = releaseOcrInstance().finally(() => {
    ocrIdleUnloadPromise = null;
  });
  await ocrIdleUnloadPromise;
}

/** 关闭 OCR 单例（含进行中的空闲卸载）；service.close 使用 */
export async function closeOcrEngine(): Promise<void> {
  clearOcrIdleTimer();
  const pendingUnload = ocrIdleUnloadPromise;
  ocrIdleUnloadPromise = null;
  if (pendingUnload) {
    try {
      await pendingUnload;
    } catch {
      /* ignore */
    }
  }
  await releaseOcrInstance();
}

/** @internal 测试：注入/清空 OCR 工厂 */
export function setOcrFactoryForTests(factory: OcrFactory | null): void {
  ocrFactoryForTests = factory;
}

/** @internal 测试：当前是否持有 singleton（含创建中 Promise） */
export function hasOcrSingletonForTests(): boolean {
  return ocrSingleton != null;
}

/** @internal 测试：最近一次成功使用时间戳 */
export function getOcrLastUsedAtForTests(): number {
  return ocrLastUsedAt;
}

async function getOcrInstance(modelDir: string): Promise<OcrInstance> {
  if (!ocrSingleton) {
    const creating = (async () => {
      if (ocrFactoryForTests) {
        return ocrFactoryForTests(modelDir);
      }
      const mod = await import('@gutenye/ocr-node');
      const Ocr = mod.default;
      return Ocr.create({
        models: {
          detectionPath: path.join(modelDir, 'ch_PP-OCRv4_det_mobile.onnx'),
          recognitionPath: path.join(modelDir, 'ch_PP-OCRv4_rec_mobile.onnx'),
          dictionaryPath: path.join(modelDir, 'ppocr_keys_v1.txt'),
        },
      }) as Promise<OcrInstance>;
    })();
    ocrSingleton = creating;
    creating.catch(() => {
      if (ocrSingleton === creating) ocrSingleton = null;
    });
  }
  return ocrSingleton;
}

// ---------------------------------------------------------------------------
// OCR 执行
// ---------------------------------------------------------------------------

function linesToText(lines: OcrLine[]): string {
  return lines
    .map((l) => (typeof l.text === 'string' ? l.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
}

async function detectImageWithOcr(ocr: OcrInstance, image: Buffer): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harness-ocr-'));
  const imgPath = path.join(tmpDir, 'page.png');
  try {
    await fs.promises.writeFile(imgPath, image);
    const lines = await ocr.detect(imgPath);
    return linesToText(lines);
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 300s 超时包装：超时返回空串（不抛） */
async function withTimeout(work: Promise<string>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(''), OCR_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 对单张图片做 OCR。模型/运行时未就绪或失败/超时返回空串（不抛）。
 * 模型未就绪时直接短路返回（不触发下载——下载由 service 层决策）。
 */
export async function ocrImageBuffer(dataDir: string, image: Buffer): Promise<string> {
  try {
    if (!isOcrModelReady(dataDir)) return '';
    const ocr = await getOcrInstance(ocrModelDir(dataDir));
    const text = (await withTimeout(detectImageWithOcr(ocr, image))).trim();
    touchOcrLastUsed();
    return text;
  } catch {
    return '';
  }
}

/**
 * PDF（弱文本）→ pdfium 栅格化（scale 2）→ 逐页 OCR。
 * 未就绪返回 []（不抛）；单页失败按空串处理。
 */
export async function ocrPdfBuffer(
  dataDir: string,
  buffer: Buffer,
  opts: { concurrency?: number } = {},
): Promise<Array<{ page: number; text: string }>> {
  if (!isOcrModelReady(dataDir)) return [];
  let images: Buffer[];
  try {
    images = await rasterizePdfPages(buffer);
  } catch {
    return [];
  }
  if (images.length === 0) return [];
  const texts = await ocrImageBuffers(
    dataDir,
    images,
    { concurrency: opts.concurrency ?? OCR_CONCURRENCY },
  );
  return texts.map((text, i) => ({ page: i + 1, text }));
}

/** 批量 OCR：并发限流（默认 3），单项失败记空串。 */
export async function ocrImageBuffers(
  dataDir: string,
  images: Buffer[],
  opts: { concurrency?: number } = {},
): Promise<string[]> {
  if (!images.length) return [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? OCR_CONCURRENCY, 4));
  const out: string[] = new Array(images.length).fill('');
  let next = 0;

  async function worker(): Promise<void> {
    while (next < images.length) {
      const i = next;
      next += 1;
      const img = images[i];
      if (!img) continue;
      out[i] = await ocrImageBuffer(dataDir, img);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, images.length) }, () => worker()));
  return out;
}

/** PDF → 每页 PNG Buffer（pdfium + sharp，scale 2）。失败上抛由调用方兜底。 */
export async function rasterizePdfPages(buffer: Buffer): Promise<Buffer[]> {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const sharpMod = await import('sharp');
  const sharp = sharpMod.default;
  const library = await PDFiumLibrary.init();
  try {
    const document = await library.loadDocument(new Uint8Array(buffer));
    try {
      const pages: Buffer[] = [];
      const pageCount = document.getPageCount();
      for (let i = 0; i < pageCount; i++) {
        const page = document.getPage(i);
        const rendered = await page.render({
          scale: 2,
          render: async (options) => {
            return sharp(options.data, {
              raw: {
                width: options.width,
                height: options.height,
                channels: 4,
              },
            })
              .png()
              .toBuffer();
          },
        });
        pages.push(Buffer.from(rendered.data));
      }
      return pages;
    } finally {
      document.destroy();
    }
  } finally {
    library.destroy();
  }
}
