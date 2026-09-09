/**
 * asr/downloader — Whisper ONNX 模型的后台静默下载器（镜像优选链）。
 *
 * 设计（镜像链照搬 Opptrix Desktop 的 whisper-download/sensevoice-download 参考实现）：
 * - **源顺序**：HuggingFace 直连 → hf-mirror.com → ModelScope（env 可覆盖各自的 base）。
 *   每个文件独立按序试源：源 1 失败（网络/HTTP 非 2xx/HTML 投毒）自动换源 2、源 3；
 * - **HTML 投毒检测**：响应 content-type 为 text/html/xhtml，或首段字节以
 *   `<!doctype`/`<html` 开头（被劫持返回登录页/错误页）→ 该源判失败换下一源；
 * - **原子写入**：先写 `<target>.part` 临时文件，全部写毕后 rename 到目标——
 *   中断/失败不会留下半截文件污染 FileCache（失败时 .part 一律删除）；
 * - **FileCache 布局**：文件落在 `<modelDir>/<org>/<name>/<relpath>`，与
 *   @huggingface/transformers 的 `pipeline(..., { cache_dir: modelDir })` 磁盘缓存
 *   （FileCache：`path.join(cacheDir, '<model>/<file>')`）逐字节对齐——下载完成后
 *   engine 以 `local_files_only: true` 纯本地加载，推理阶段零外联。
 *
 * 不做的事：不做并发池（v1 逐文件串行，进度确定性优先）；不做断点续传（失败整文件
 * 重下，whisper-base q8 全量约百 MB 量级，可接受）；不做校验和校验（源侧 LFS 完整性
 * 由 HTTP 层保证，投毒检测兜底最常见的劫持形态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import type { AsrEnsureResult, AsrProgressEvent } from './types.js';

/** 模块 logger 形状（与内核 pino logger 结构一致的窄接口，便于测试注入） */
type ModuleLogger = {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

/** 单文件下载超时（大权重 ONNX 文件在慢链路上也需余量；不区分文件大小一刀切） */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** 下载请求 UA（对齐仓库惯例：服务端静默 fetch，不用浏览器 UA） */
const DOWNLOAD_USER_AGENT = 'Opptrix-Harness-ASR/1.0';

/** 默认模型：whisper-base 多语言（ONNX 社区转换，transformers.js 官方格式） */
export const DEFAULT_ASR_MODEL_ID = 'onnx-community/whisper-base';

/**
 * 必需文件清单（dtype 'q8' → ONNX 权重后缀 '_quantized'；whisper 为 Seq2Seq 结构 →
 * encoder_model + decoder_model_merged 两个 session 文件，与 transformers.js
 * MODEL_TYPES.Seq2Seq 的 sessions 表一致）。任一缺失即模型不完整 → 重新下载。
 */
export const REQUIRED_MODEL_FILES: readonly string[] = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

/**
 * 可选文件清单：transformers.js 侧 fatal=false（generation_config/特殊 token 等），
 * 缺失不阻断加载；下载 404 也只记 warn 不失败。
 */
export const OPTIONAL_MODEL_FILES: readonly string[] = [
  'generation_config.json',
  'added_tokens.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'normalizer.json',
];

/** 镜像链配置（从注入 env 或 process.env 解析；解析结果在工厂调用时固化） */
export interface MirrorChainConfig {
  /** HF 直连源（缺省 https://huggingface.co） */
  hfDirect: string;
  /** HF 镜像源（缺省 https://hf-mirror.com；env HARNESS_HF_MIRROR 覆盖） */
  hfMirror: string;
  /** ModelScope 源（缺省 https://modelscope.cn；env HARNESS_MODELSCOPE_BASE 覆盖） */
  modelScope: string;
}

/** createModelDownloader 依赖集合 */
export interface ModelDownloaderDeps {
  /** 模型缓存根目录（= engine 侧 pipeline 的 cache_dir） */
  modelDir: string;
  /** 内核 logger */
  logger: ModuleLogger;
  /**
   * 模型 id（缺省 env HARNESS_ASR_MODEL，再缺省 onnx-community/whisper-base）。
   * 允许换同族模型（whisper-tiny/base/small 等社区 ONNX 转换，文件清单同形）。
   */
  modelId?: string;
  /** fetch 注入点（测试 mock；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
  /** env 注入点（测试隔离；缺省 process.env） */
  env?: NodeJS.ProcessEnv;
}

/** 下载源描述 */
interface DownloadSource {
  label: string;
  url: string;
}

/** 去尾部斜杠 + 去空白；空值回退缺省 */
function normalizeBase(raw: string | undefined, fallback: string): string {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  return value.replace(/\/+$/, '');
}

/** 从 env 解析镜像链配置 */
export function resolveMirrorChain(env: NodeJS.ProcessEnv): MirrorChainConfig {
  return {
    hfDirect: normalizeBase(env['HARNESS_HF_DIRECT'], 'https://huggingface.co'),
    hfMirror: normalizeBase(env['HARNESS_HF_MIRROR'], 'https://hf-mirror.com'),
    modelScope: normalizeBase(env['HARNESS_MODELSCOPE_BASE'], 'https://modelscope.cn'),
  };
}

/**
 * 校验模型 id 并拆成 FileCache 布局段。仅允许 `org/name` 形态（字母数字与 . _ - /），
 * 显式拒绝 `..` 段与反斜杠——modelId 进路径，防目录穿越。
 */
export function safeModelSegments(modelId: string): string[] {
  const segments = modelId.split('/');
  if (
    segments.length !== 2 ||
    segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
  ) {
    throw new Error(
      `invalid ASR model id "${modelId}" — expected "<org>/<name>" (e.g. "onnx-community/whisper-base"); ` +
        'set HARNESS_ASR_MODEL to a valid Hugging Face model id',
    );
  }
  return segments;
}

/** HF 系（huggingface.co / hf-mirror.com）resolve URL（照搬参考实现的 ?download=true 形态） */
function buildHfResolveUrl(base: string, repo: string, filename: string): string {
  return `${base}/${repo}/resolve/main/${filename}?download=true`;
}

/** ModelScope resolve URL（照搬 sensevoice 参考实现：/models/<repo>/resolve/master/<file>） */
function buildModelScopeResolveUrl(base: string, repo: string, filename: string): string {
  return `${base}/models/${repo}/resolve/master/${filename}`;
}

/** 组装单文件的镜像优选链（顺序：HF 直连 → hf-mirror → ModelScope） */
export function buildDownloadSources(file: string, modelId: string, chain: MirrorChainConfig): DownloadSource[] {
  return [
    { label: 'huggingface', url: buildHfResolveUrl(chain.hfDirect, modelId, file) },
    { label: 'hf-mirror', url: buildHfResolveUrl(chain.hfMirror, modelId, file) },
    { label: 'modelscope', url: buildModelScopeResolveUrl(chain.modelScope, modelId, file) },
  ];
}

/** 首段字节是否形似 HTML 文档（投毒：镜像被劫持返回 HTML 页面而非模型文件） */
export function looksLikeHtmlBody(head: Uint8Array): boolean {
  const prefix = Buffer.from(head).toString('utf8', 0, Math.min(head.length, 256)).trimStart().toLowerCase();
  return prefix.startsWith('<!doctype') || prefix.startsWith('<html');
}

/**
 * 单文件从单源下载（流式写 .part + 首段投毒检测 + 原子 rename）。
 * 任一环节失败都保证 .part 被清理，目标路径要么不存在要么是完整文件。
 */
async function downloadFileFromSource(
  source: DownloadSource,
  targetPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const partPath = `${targetPath}.part`;
  try {
    const resp = await fetchImpl(source.url, {
      redirect: 'follow',
      headers: { 'User-Agent': DOWNLOAD_USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
      throw new Error('source returned an HTML page instead of the model file (poisoned or hijacked mirror)');
    }

    const fileStream = fs.createWriteStream(partPath, { flags: 'w' });
    const reader = resp.body.getReader();
    let headChecked = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (!headChecked) {
          if (looksLikeHtmlBody(value)) {
            throw new Error('source returned an HTML page instead of the model file (poisoned or hijacked mirror)');
          }
          headChecked = true;
        }
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => fileStream.once('drain', resolve));
        }
      }
      fileStream.end();
      await finished(fileStream);
    } catch (error) {
      fileStream.destroy();
      throw error;
    }
    await fs.promises.rename(partPath, targetPath);
  } catch (error) {
    try {
      await fs.promises.unlink(partPath);
    } catch {
      /* .part 不存在等——忽略 */
    }
    throw error;
  }
}

/** 模型下载器实例（createModelDownloader 产物） */
export interface ModelDownloader {
  /** 模型 id（工厂按 deps.modelId → env → 默认值解析后的最终值） */
  readonly modelId: string;
  /** FileCache 布局根目录（`<modelDir>/<org>/<name>`，engine 侧本地加载目录） */
  readonly modelPath: string;
  /** 必需文件是否全部已在本地（快速缓存命中判断，不做网络请求） */
  isCached(): boolean;
  /**
   * 确保模型文件齐备：已缓存直接返回（cached: true）；否则按镜像链逐文件静默下载。
   * @param onProgress 每完成一个文件回调一次（{source, pct}，pct 为文件计数口径 0–100）
   */
  ensureModel(onProgress?: (event: AsrProgressEvent) => void): Promise<AsrEnsureResult>;
}

/**
 * 创建模型下载器。
 *
 * env 约定（经 deps.env 注入，缺省读 process.env，工厂调用时固化）：
 * - HARNESS_ASR_MODEL：模型 id（onnx-community/whisper-tiny/base/small 等，默认 base）
 * - HARNESS_HF_DIRECT：HF 直连 base（默认 https://huggingface.co）
 * - HARNESS_HF_MIRROR：HF 镜像 base（默认 https://hf-mirror.com）
 * - HARNESS_MODELSCOPE_BASE：ModelScope base（默认 https://modelscope.cn）
 */
export function createModelDownloader(deps: ModelDownloaderDeps): ModelDownloader {
  const env = deps.env ?? process.env;
  const modelId = (deps.modelId ?? env['HARNESS_ASR_MODEL'] ?? DEFAULT_ASR_MODEL_ID).trim();
  const segments = safeModelSegments(modelId); // fail-fast：非法 id 在装配期即抛
  const modelPath = path.join(deps.modelDir, ...segments);
  const chain = resolveMirrorChain(env);
  const fetchImpl = deps.fetchImpl ?? fetch;

  /** 单个文件的本地目标路径（relPath 为 repo 内相对路径，元素来自固定清单，无穿越面） */
  const targetPathOf = (relPath: string): string => path.join(modelPath, ...relPath.split('/'));

  const isCached = (): boolean => REQUIRED_MODEL_FILES.every((f) => fs.existsSync(targetPathOf(f)));

  const ensureModel = async (onProgress?: (event: AsrProgressEvent) => void): Promise<AsrEnsureResult> => {
    if (isCached()) {
      return { dir: modelPath, source: 'cache', cached: true };
    }

    // 目录树一次建齐：模型根 + onnx 子目录（清单文件只会落在这两层）
    await fs.promises.mkdir(path.join(modelPath, 'onnx'), { recursive: true });

    const total = REQUIRED_MODEL_FILES.length + OPTIONAL_MODEL_FILES.length;
    let completed = 0;
    let lastSource = 'cache';
    const report = (source: string): void => {
      onProgress?.({ source, pct: Math.round((completed / total) * 100) });
    };

    for (const file of REQUIRED_MODEL_FILES) {
      const target = targetPathOf(file);
      if (fs.existsSync(target)) {
        completed += 1;
        report(lastSource);
        continue;
      }
      const errors: string[] = [];
      let done = false;
      for (const source of buildDownloadSources(file, modelId, chain)) {
        try {
          await downloadFileFromSource(source, target, fetchImpl);
          lastSource = source.label;
          done = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${source.label}: ${message}`);
        }
      }
      if (!done) {
        // 必需文件三源全败：整体失败（已有的成功文件留在原地——下次 ensure 跳过它们续传）
        throw new Error(`failed to download required model file "${file}" — ${errors.join('; ')}`);
      }
      completed += 1;
      report(lastSource);
    }

    for (const file of OPTIONAL_MODEL_FILES) {
      const target = targetPathOf(file);
      if (fs.existsSync(target)) {
        completed += 1;
        report(lastSource);
        continue;
      }
      const errors: string[] = [];
      let done = false;
      for (const source of buildDownloadSources(file, modelId, chain)) {
        try {
          await downloadFileFromSource(source, target, fetchImpl);
          lastSource = source.label;
          done = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${source.label}: ${message}`);
        }
      }
      if (!done) {
        deps.logger.warn({ modelId, file, errors }, '[asr] optional model file unavailable from all mirrors, skipping');
      } else {
        completed += 1;
        report(lastSource);
      }
    }

    deps.logger.info({ modelId, dir: modelPath, source: lastSource }, '[asr] model ready');
    return { dir: modelPath, source: lastSource, cached: false };
  };

  return { modelId, modelPath, isCached, ensureModel };
}
