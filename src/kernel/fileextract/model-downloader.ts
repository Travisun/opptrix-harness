/**
 * model-downloader — PP-OCRv4 mobile 四文件（det/rec/cls/keys）下载器。
 *
 * 手法照搬 Opptrix doc-library ocr-l2/paths + model-downloader：
 * - 三源镜像链：ModelScope → hf-mirror.com → HuggingFace（env 可覆盖 base/repo/tag，
 *   环境变量前缀统一为 HARNESS_*）；
 * - `.download` 临时文件 + 原子 rename（半截文件永不落正式名）；
 * - HTML 投毒检测：Content-Type 为 text/html/xhtml 或首块像 <!doctype/<html → 视为失败
 *   （镜像 404 落到 HTML 登录页时防把网页当模型写入）；
 * - 状态机（not-downloaded/downloading/downloaded/error）供 GET /api/v1/extract/status。
 * 日志不打印完整 URL（可能含 query token）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** PP-OCRv4 mobile 四件套（det/rec/cls + 字典） */
export const OCR_MODEL_FILES = [
  'ch_PP-OCRv4_det_mobile.onnx',
  'ch_PP-OCRv4_rec_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
  'ppocr_keys_v1.txt',
] as const;

export type OcrModelFile = (typeof OCR_MODEL_FILES)[number];

const REMOTE_MODEL_PATHS: Record<OcrModelFile, string> = {
  'ch_PP-OCRv4_det_mobile.onnx': 'onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx',
  'ch_PP-OCRv4_rec_mobile.onnx': 'onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx': 'onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx',
  'ppocr_keys_v1.txt': 'paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile/ppocr_keys_v1.txt',
};

/** 单文件下载超时（毫秒） */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

const DOWNLOAD_USER_AGENT = 'OpptrixHarness/1.0';

/** 环境覆盖（OPPTRIX_* → HARNESS_*） */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw !== undefined && raw !== '' ? raw : fallback;
}

/** 模型目录：<dataDir>/models/ocr（HARNESS_OCR_MODEL_DIR 可整体覆盖） */
export function ocrModelDir(dataDir: string): string {
  const fromEnv = process.env.HARNESS_OCR_MODEL_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(dataDir, 'models', 'ocr');
}

/** 目录内缺失的模型文件 */
export function missingOcrModelFiles(modelDir: string): string[] {
  const missing: string[] = [];
  for (const file of OCR_MODEL_FILES) {
    if (!fs.existsSync(path.join(modelDir, file))) missing.push(file);
  }
  return missing;
}

/** 三源镜像链（ModelScope → hf-mirror → HuggingFace；env 覆盖 base/repo/tag） */
export function sourcesForRemote(relPath: string): Array<{ label: string; url: string }> {
  const modelscopeBase = envStr('HARNESS_MODELSCOPE_BASE', 'https://modelscope.cn').replace(/\/$/, '');
  const hfMirror = envStr('HARNESS_HF_MIRROR', 'https://hf-mirror.com').replace(/\/$/, '');
  const msRepo = envStr('HARNESS_OCR_MODELSCOPE_REPO', 'RapidAI/RapidOCR').replace(/^\/+|\/+$/g, '');
  const hfRepo = envStr('HARNESS_OCR_HF_REPO', 'RapidAI/RapidOCR').replace(/^\/+|\/+$/g, '');
  const tag = envStr('HARNESS_OCR_MODELSCOPE_TAG', 'v3.9.1').replace(/^\/+|\/+$/g, '');

  return [
    { label: 'modelscope', url: `${modelscopeBase}/models/${msRepo}/resolve/${tag}/${relPath}` },
    { label: 'hf-mirror', url: `${hfMirror}/${hfRepo}/resolve/main/${relPath}?download=true` },
    { label: 'huggingface', url: `https://huggingface.co/${hfRepo}/resolve/main/${relPath}?download=true` },
  ];
}

// ---------------------------------------------------------------------------
// 下载状态（供 /extract/status）
// ---------------------------------------------------------------------------

export interface OcrDownloadState {
  state: 'not-downloaded' | 'downloading' | 'downloaded' | 'error';
  percent: number | null;
  error: string | null;
}

let downloadState: OcrDownloadState = { state: 'not-downloaded', percent: null, error: null };
let downloadSeq = 0;

/** 当前下载状态快照（不触盘，纯内存） */
export function getOcrDownloadState(): OcrDownloadState {
  return { ...downloadState };
}

/** @internal 测试：重置状态机 */
export function resetOcrDownloadStateForTests(): void {
  downloadState = { state: 'not-downloaded', percent: null, error: null };
}

function setState(next: OcrDownloadState): void {
  downloadState = next;
}

// ---------------------------------------------------------------------------
// 下载实现
// ---------------------------------------------------------------------------

function looksLikeHtmlBody(head: Uint8Array): boolean {
  const prefix = Buffer.from(head).toString('utf8', 0, Math.min(head.length, 256)).trimStart().toLowerCase();
  return prefix.startsWith('<!doctype') || prefix.startsWith('<html');
}

async function downloadToFile(
  url: string,
  destPath: string,
  timeoutMs: number,
  onProgress?: (p: { receivedBytes: number; totalBytes: number | null }) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      throw new Error('invalid content type (html)');
    }

    const contentLength = resp.headers.get('content-length');
    const totalBytes =
      contentLength && Number.isFinite(Number(contentLength)) ? Number(contentLength) : null;

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    // 原子写入：先写 .download 临时文件，成功后 rename（半截文件永不落正式名）
    const tempPath = `${destPath}.download`;
    const fileStream = fs.createWriteStream(tempPath, { flags: 'w' });
    const reader = resp.body.getReader();
    let receivedBytes = 0;
    let htmlChecked = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!htmlChecked) {
          if (looksLikeHtmlBody(value)) throw new Error('invalid html body');
          htmlChecked = true;
        }
        receivedBytes += value.byteLength;
        onProgress?.({ receivedBytes, totalBytes });
        await new Promise<void>((resolve, reject) => {
          fileStream.write(Buffer.from(value), (e) => (e ? reject(e) : resolve()));
        });
      }
      await new Promise<void>((resolve, reject) => {
        fileStream.end((e: Error | null | undefined) => (e ? reject(e) : resolve()));
      });
      await fs.promises.rename(tempPath, destPath);
    } catch (e) {
      try {
        fileStream.destroy();
      } catch {
        /* ignore */
      }
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        /* ignore */
      }
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
}

export type OcrDownloadProgress = {
  file: string;
  receivedBytes: number;
  totalBytes: number | null;
  percent: number;
};

/**
 * 确保 OCR 模型四件套就绪：缺失文件按镜像链逐个下载。
 * 返回 ok=false 时不抛错（missingFiles 说明缺口），调用方（service）转为 needsOcr 结果。
 */
export async function ensureOcrModelsDownloaded(
  modelDir: string,
  opts: {
    timeoutMs?: number;
    onProgress?: (p: OcrDownloadProgress) => void;
  } = {},
): Promise<{ ok: boolean; missingFiles: string[] }> {
  const seq = ++downloadSeq;
  const missingBefore = missingOcrModelFiles(modelDir);
  if (missingBefore.length === 0) {
    setState({ state: 'downloaded', percent: 100, error: null });
    return { ok: true, missingFiles: [] };
  }

  setState({ state: 'downloading', percent: 0, error: null });
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  await fs.promises.mkdir(modelDir, { recursive: true });

  const pending = missingOcrModelFiles(modelDir);
  let done = OCR_MODEL_FILES.length - pending.length;
  let failure: string | null = null;

  for (const file of pending as readonly OcrModelFile[]) {
    if (seq !== downloadSeq) return { ok: false, missingFiles: missingOcrModelFiles(modelDir) };
    const dest = path.join(modelDir, file);
    if (fs.existsSync(dest)) {
      done += 1;
      continue;
    }
    const remote = REMOTE_MODEL_PATHS[file];
    let saved = false;
    const errors: string[] = [];
    for (const source of sourcesForRemote(remote)) {
      try {
        await downloadToFile(source.url, dest, timeoutMs, (p) => {
          const fileFraction = p.totalBytes && p.totalBytes > 0 ? p.receivedBytes / p.totalBytes : 0;
          const percent = Math.min(99, Math.round(((done + fileFraction) / OCR_MODEL_FILES.length) * 100));
          setState({ state: 'downloading', percent, error: null });
          opts.onProgress?.({ file, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes, percent });
        });
        saved = true;
        break;
      } catch (e) {
        errors.push(`${source.label}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!saved) {
      failure = `download failed for ${file} (${errors.join('; ')})`;
      break;
    }
    done += 1;
  }

  const missing = missingOcrModelFiles(modelDir);
  if (missing.length === 0) {
    setState({ state: 'downloaded', percent: 100, error: null });
    return { ok: true, missingFiles: [] };
  }
  setState({ state: 'error', percent: null, error: failure ?? 'model files still missing after download' });
  return { ok: false, missingFiles: missing };
}
