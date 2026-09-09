/**
 * asr/engine — Whisper 推理引擎（@huggingface/transformers pipeline 封装）。
 *
 * 语义：
 * - **懒加载单例**：首次 transcribe/warmup 才构建 pipeline（`automatic-speech-recognition`，
 *   dtype 'q8'，cache_dir = 模型目录，local_files_only = true——权重由 downloader 预先
 *   静默下载进 FileCache 布局，推理阶段零外联）；后续调用复用同一 pipeline 实例；
 * - **输入契约**：16kHz 单声道 Float32 PCM（transformers.js whisper 原生输入形状）。
 *   容器解码/重采样由前端 WebAudio 完成，内核不依赖 ffmpeg（见 types.ts 契约说明）；
 * - **空闲卸载**：空闲（无 transcribe）超过 idleUnloadMs（默认 12 分钟，env
 *   HARNESS_ASR_IDLE_UNLOAD_MS 可配）后 dispose pipeline 释放内存；下次调用自动重建；
 * - **可测性**：pipeline 工厂经 deps.pipelineFactory 注入（生产缺省动态 import 官方包），
 *   测试用 mock 工厂验证懒加载/单例/卸载语义，永不下载真实模型。
 */
import type { AsrProgressEvent, AsrTranscribeOptions, AsrTranscribeResult } from './types.js';

/** 与内核 pino logger 结构一致的窄接口（便于测试注入） */
type ModuleLogger = {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

/** transformers.js ASR pipeline 的最小调用面（仅用到的部分；dispose 兼容缺省） */
export interface AsrPipelineInstance {
  (audio: Float32Array, options?: { language?: string; task?: string }): Promise<
    { text: string } | Array<{ text: string }>
  >;
  /** transformers.js pipeline 提供的资源释放钩子（缺省时卸载仅丢弃引用） */
  dispose?: () => Promise<void>;
}

/** pipeline 工厂形状（与 transformers.js `pipeline` 签名对齐的最小子集） */
export type AsrPipelineFactory = (
  task: 'automatic-speech-recognition',
  modelId: string,
  options: {
    dtype: 'q8';
    cache_dir: string;
    local_files_only: true;
    progress_callback?: (event: Record<string, unknown>) => void;
  },
) => Promise<AsrPipelineInstance>;

/** createAsrEngine 依赖集合 */
export interface AsrEngineDeps {
  /** 模型缓存根目录（FileCache 布局根，pipeline 的 cache_dir） */
  modelDir: string;
  /** 内核 logger */
  logger: ModuleLogger;
  /** 模型 id（缺省 onnx-community/whisper-base；一般与 downloader 的 modelId 保持一致） */
  modelId?: string;
  /** pipeline 工厂注入点（测试 mock；缺省动态 import @huggingface/transformers） */
  pipelineFactory?: AsrPipelineFactory;
  /** 空闲卸载阈值毫秒（缺省 env HARNESS_ASR_IDLE_UNLOAD_MS，再缺省 12 分钟；0 = 永不卸载） */
  idleUnloadMs?: number;
}

/** 默认空闲卸载：12 分钟（错峰典型使用间隔；内存敏感部署可调小） */
const DEFAULT_IDLE_UNLOAD_MS = 12 * 60_000;

/** 生产 pipeline 工厂：动态 import 官方包（保持模块加载期零副作用、可被注入替换） */
async function defaultPipelineFactory(
  task: 'automatic-speech-recognition',
  modelId: string,
  options: Parameters<AsrPipelineFactory>[2],
): Promise<AsrPipelineInstance> {
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    pipeline: AsrPipelineFactory;
  };
  return transformers.pipeline(task, modelId, options);
}

/** ASR 推理引擎实例（createAsrEngine 产物） */
export interface AsrEngine {
  /** 模型 id */
  readonly modelId: string;
  /** pipeline 是否已加载（内存中存在单例） */
  isLoaded(): boolean;
  /** 预加载 pipeline（warmup 用；幂等——已加载直接返回） */
  load(): Promise<void>;
  /**
   * 转写 16kHz 单声道 Float32 PCM。
   * @throws 模型未就绪（FileCache 缺文件）或推理失败时原样上抛底层错误（由 manager 包装）
   */
  transcribe(pcm: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult>;
  /** 立即卸载 pipeline（dispose + 清理空闲定时器；幂等） */
  unload(): Promise<void>;
}

/**
 * 创建 ASR 推理引擎（懒加载单例 + 空闲卸载；见模块头注释）。
 */
export function createAsrEngine(deps: AsrEngineDeps): AsrEngine {
  const modelId = deps.modelId ?? 'onnx-community/whisper-base';
  const factory = deps.pipelineFactory ?? defaultPipelineFactory;
  const idleUnloadMs =
    deps.idleUnloadMs ??
    Number.parseInt(process.env['HARNESS_ASR_IDLE_UNLOAD_MS'] ?? '', 10);

  /** NaN/负值回退默认；0 = 永不卸载 */
  const idleMs = Number.isFinite(idleUnloadMs) && idleUnloadMs >= 0 ? idleUnloadMs : DEFAULT_IDLE_UNLOAD_MS;

  let pipeline: AsrPipelineInstance | null = null;
  let loadPromise: Promise<void> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const clearIdleTimer = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const scheduleIdleUnload = (): void => {
    clearIdleTimer();
    if (idleMs === 0) return; // 0 = 永不卸载
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pipeline !== null) {
        void unload().catch(() => {
          /* 卸载失败不影响下一次调用（pipeline 仍在，可复用） */
        });
      }
    }, idleMs);
    idleTimer.unref?.();
  };

  const unload = async (): Promise<void> => {
    clearIdleTimer();
    const current = pipeline;
    pipeline = null;
    loadPromise = null;
    if (current?.dispose) {
      await current.dispose();
      deps.logger.info({ modelId }, '[asr] pipeline unloaded (idle)');
    }
  };

  const load = async (): Promise<void> => {
    if (pipeline !== null) return;
    // 并发加载去重：多个 transcribe 同时到达只触发一次工厂调用
    loadPromise ??= (async () => {
      deps.logger.info({ modelId, modelDir: deps.modelDir }, '[asr] loading whisper pipeline');
      const started = Date.now();
      const instance = await factory('automatic-speech-recognition', modelId, {
        dtype: 'q8',
        cache_dir: deps.modelDir,
        local_files_only: true,
        progress_callback: (event: Record<string, unknown>) => {
          deps.logger.debug({ event }, '[asr] pipeline load progress');
        },
      });
      pipeline = instance;
      deps.logger.info({ modelId, durationMs: Date.now() - started }, '[asr] whisper pipeline loaded');
    })();
    try {
      await loadPromise;
    } catch (error) {
      loadPromise = null; // 失败后允许重试
      throw error;
    }
  };

  const transcribe = async (
    pcm: Float32Array,
    options?: AsrTranscribeOptions,
  ): Promise<AsrTranscribeResult> => {
    if (pcm.length === 0) {
      throw new Error('transcribe requires a non-empty Float32Array PCM (16kHz mono)');
    }
    await load();
    clearIdleTimer(); // 推理期间挂起空闲卸载
    const started = Date.now();
    const output = await pipeline!(pcm, {
      ...(options?.language !== undefined && options.language !== '' ? { language: options.language } : {}),
      task: 'transcribe',
    });
    const durationMs = Date.now() - started;
    const first = Array.isArray(output) ? output[0] : output;
    scheduleIdleUnload();
    return { text: (first?.text ?? '').trim(), durationMs };
  };

  return { modelId, isLoaded: () => pipeline !== null, load, transcribe, unload };
}

/** 引擎加载进度事件 → 进度回调的透传形状（供 manager 接线；v1 仅 debug 记录） */
export type EngineLoadProgress = AsrProgressEvent;
