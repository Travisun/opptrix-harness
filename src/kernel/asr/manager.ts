/**
 * asr/manager — ASR 状态机编排（下载 / 就绪 / 转写）。
 *
 * 状态机：disabled → (enabled) not-downloaded → downloading → ready ⇄ error
 * （error 可经再次 ensureReady 重试；ready 后模型文件常驻磁盘，pipeline 懒加载）。
 *
 * 关键语义：
 * - **后台静默下载**：`init()`（boot 期调用）在 autoDownload 配置开启时 fire-and-forget
 *   触发 ensureReady——失败只落状态与日志，不影响启动；下载中 status() 返回
 *   { state: 'downloading', progress }，REST ensure 亦复用同一次下载（去重）；
 * - **transcribe 等待下载**：调用时若模型未就绪会 await 同一下载任务（含现场触发的），
 *   完成后立即转写——调用方无需感知下载状态机；
 * - **单飞**：并发 ensureReady 共享同一个下载 Promise；进度经监听器集合扇出给各方。
 *
 * 门禁由上层收口：REST 层（../api/asr.ts）做身份/角色校验；扩展桥
 * （createAsrBridge）做 manifest 'asr' 权限校验。manager 自身不做鉴权。
 */
import { HarnessError } from '../errors/index.js';

import { createAsrEngine, type AsrEngine } from './engine.js';
import { createModelDownloader, DEFAULT_ASR_MODEL_ID, type ModelDownloader } from './downloader.js';
import type {
  AsrEnsureResult,
  AsrProgressEvent,
  AsrStatus,
  AsrTranscribeOptions,
  AsrTranscribeResult,
} from './types.js';

/** createAsrManager 依赖集合 */
export interface AsrManagerDeps {
  /** 模型缓存根目录（建议 `<dataDir>/asr/models`，由装配层决定） */
  modelDir: string;
  /** 内核 pino logger */
  logger: import('pino').Logger;
  /** 是否启用 ASR（缺省读 env HARNESS_ASR_ENABLED !== 'false' → 默认启用） */
  enabled?: boolean;
  /** 启动期自动后台下载（缺省读 env HARNESS_ASR_AUTO_DOWNLOAD === 'true' → 默认关闭） */
  autoDownload?: boolean;
  /** 下载器注入点（缺省 createModelDownloader） */
  downloader?: ModelDownloader;
  /** 引擎注入点（缺省 createAsrEngine，modelId 随下载器） */
  engine?: AsrEngine;
  /** 空闲卸载阈值毫秒（透传 engine；缺省 env/12 分钟，见 engine.ts） */
  idleUnloadMs?: number;
}

/** ASR 管理器：状态机 + 转写门面（REST 与扩展桥共用） */
export class AsrManager {
  readonly #logger: import('pino').Logger;
  readonly #downloader: ModelDownloader;
  readonly #engine: AsrEngine;
  readonly #enabled: boolean;
  readonly #modelId: string;

  #inFlight: Promise<AsrEnsureResult> | null = null;
  #lastError: string | null = null;
  #lastProgress: number | null = null;
  #ready = false;
  #progressListeners = new Set<(event: AsrProgressEvent) => void>();

  constructor(deps: AsrManagerDeps) {
    this.#logger = deps.logger;
    this.#enabled = deps.enabled ?? process.env['HARNESS_ASR_ENABLED'] !== 'false';
    const autoDownload = deps.autoDownload ?? process.env['HARNESS_ASR_AUTO_DOWNLOAD'] === 'true';
    this.#downloader =
      deps.downloader ?? createModelDownloader({ modelDir: deps.modelDir, logger: this.#logger });
    this.#engine =
      deps.engine ?? createAsrEngine({ modelDir: deps.modelDir, logger: this.#logger, modelId: this.#downloader.modelId, ...(deps.idleUnloadMs !== undefined ? { idleUnloadMs: deps.idleUnloadMs } : {}) });
    this.#modelId = this.#downloader.modelId;
    if (!this.#enabled) {
      this.#logger.info({ modelId: this.#modelId }, '[asr] disabled (HARNESS_ASR_ENABLED=false)');
    }
    this.#autoDownload = autoDownload;
  }

  /** 构造期固化的 autoDownload（init 用） */
  readonly #autoDownload: boolean;

  /**
   * boot 期钩子：autoDownload 开启且模型未缓存时 fire-and-forget 后台静默下载。
   * 失败只落 error 状态与日志——绝不阻塞/破坏内核启动。
   */
  init(): void {
    if (!this.#enabled || !this.#autoDownload) return;
    if (this.#downloader.isCached() || this.#inFlight !== null) return;
    this.#logger.info({ modelId: this.#modelId }, '[asr] auto-download started');
    void this.ensureReady().catch(() => {
      /* 状态与日志已在 ensureReady 内落好；init 侧无需再处理 */
    });
  }

  /** 统一状态快照（REST status 与扩展桥 asrStatus 共用形状） */
  status(): AsrStatus {
    if (!this.#enabled) {
      return { state: 'disabled', modelId: this.#modelId, enabled: false };
    }
    if (this.#inFlight !== null) {
      return {
        state: 'downloading',
        progress: this.#lastProgress ?? 0,
        modelId: this.#modelId,
        enabled: true,
      };
    }
    // #ready 为进程内状态机的成功记忆（isCached 只在启动期/外部改动后兜底一次 fs 检查）
    if (this.#ready || this.#downloader.isCached()) {
      this.#ready = true;
      return { state: 'ready', modelId: this.#modelId, enabled: true };
    }
    if (this.#lastError !== null) {
      return { state: 'error', error: this.#lastError, modelId: this.#modelId, enabled: true };
    }
    return { state: 'not-downloaded', modelId: this.#modelId, enabled: true };
  }

  /**
   * 确保模型就绪：已缓存立即返回；下载中并入在飞任务；否则现场启动一次下载。
   * @param onProgress 订阅本次任务的进度扇出（并发调用各自收到全部进度事件）
   * @throws HARNESS-1003 SERVICE_UNAVAILABLE：ASR 已禁用；下载失败时错误带各源失败原因
   */
  async ensureReady(onProgress?: (event: AsrProgressEvent) => void): Promise<AsrEnsureResult> {
    if (!this.#enabled) {
      throw new HarnessError('SERVICE_UNAVAILABLE', {
        message: 'ASR is disabled (enable it by removing HARNESS_ASR_ENABLED=false or setting it to true)',
      });
    }
    if (onProgress !== undefined) {
      this.#progressListeners.add(onProgress);
    }
    try {
      if (this.#inFlight !== null) {
        return await this.#inFlight;
      }
      if (this.#ready || this.#downloader.isCached()) {
        this.#ready = true;
        return { dir: this.#downloader.modelPath, source: 'cache', cached: true };
      }
      this.#lastProgress = 0;
      // 包装只做一次（并发调用共享同一在飞 Promise，不会重复叠 wrapper/message）
      this.#inFlight = this.#downloader
        .ensureModel((event) => {
          this.#lastProgress = event.pct;
          for (const listener of this.#progressListeners) {
            try {
              listener(event);
            } catch {
              /* 监听器异常不阻断下载 */
            }
          }
        })
        .then(
          (result) => {
            this.#ready = true;
            this.#lastError = null;
            return result;
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            this.#lastError = message;
            this.#lastProgress = null;
            this.#logger.warn({ err: error, modelId: this.#modelId }, '[asr] model download failed');
            throw new HarnessError('SERVICE_UNAVAILABLE', {
              message: `ASR model download failed: ${message}`,
              cause: error,
            });
          },
        );
      return await this.#inFlight;
    } finally {
      this.#inFlight = null;
      this.#lastProgress = null;
      if (onProgress !== undefined) {
        this.#progressListeners.delete(onProgress);
      }
    }
  }

  /**
   * 转写 16kHz 单声道 Float32 PCM（内部确保模型就绪：下载中→等待，未开始→现场下载）。
   * @throws HARNESS-1008 BAD_REQUEST：pcm 为空；HARNESS-1003：禁用/下载失败；
   *                 推理失败原样上抛（HTTP 层统一脱敏为 INTERNAL）
   */
  async transcribe(pcm: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    if (!this.#enabled) {
      throw new HarnessError('SERVICE_UNAVAILABLE', {
        message: 'ASR is disabled (enable it by removing HARNESS_ASR_ENABLED=false or setting it to true)',
      });
    }
    if (!(pcm instanceof Float32Array) || pcm.length === 0) {
      throw new HarnessError('BAD_REQUEST', {
        message: 'transcribe requires a non-empty Float32Array PCM resampled to 16kHz mono ' +
          '(resample client-side with WebAudio before uploading)',
      });
    }
    await this.ensureReady();
    return await this.#engine.transcribe(pcm, options);
  }

  /**
   * 预热：确保模型文件就绪并立即加载 pipeline（首次转写零加载延迟）。
   * 幂等；失败语义同 ensureReady。
   */
  async warmup(): Promise<AsrStatus> {
    await this.ensureReady();
    await this.#engine.load();
    return this.status();
  }

  /** 引擎是否已加载 pipeline（观测用） */
  isEngineLoaded(): boolean {
    return this.#engine.isLoaded();
  }

  /** 立即卸载 pipeline（空闲卸载的手动触发口；幂等） */
  async unloadEngine(): Promise<void> {
    await this.#engine.unload();
  }

  /** 默认模型 id（装配层日志/文档引用；实际以 manager.status().modelId 为准） */
  static readonly defaultModelId = DEFAULT_ASR_MODEL_ID;
}
