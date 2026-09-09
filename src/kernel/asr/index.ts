/**
 * asr — 语音识别模块出口（Whisper via @huggingface/transformers）。
 *
 * 装配示例（内核 provider 层，本包不接线）：
 * ```ts
 * const manager = new AsrManager({ modelDir: join(config.dataDir, 'asr', 'models'), logger });
 * manager.init(); // autoDownload 开启时后台静默下载（fire-and-forget）
 * registerAsrRoutes(app, { checker, manager }); // REST
 * const bridgeHandlers = createAsrBridge({ manager, requirePermission }); // 扩展桥并表
 * ```
 *
 * 本文件还承载：
 * - **PCM 线格式编解码**（REST 与扩展桥共用）：16kHz 单声道 Float32 PCM 的 base64
 *   （小端字节流）编解码与上限约束——见 `decodePcmBase64` / `encodePcmBase64`；
 * - **createAsrBridge**：KERNEL_TOPICS.asrStatus / asrTranscribe 的内核服务实现表，
 *   权限闸模式照搬 kernel-handlers 的 requireSandboxPermission（manifest 必须声明
 *   'asr' 权限）。总控接线时把它并进桥 handler 表即可。
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';

import { createAsrEngine } from './engine.js';
export { createAsrEngine } from './engine.js';
export type { AsrEngine, AsrPipelineFactory, AsrPipelineInstance } from './engine.js';
export { createModelDownloader, DEFAULT_ASR_MODEL_ID, REQUIRED_MODEL_FILES, OPTIONAL_MODEL_FILES } from './downloader.js';
export type { ModelDownloader, ModelDownloaderDeps, MirrorChainConfig } from './downloader.js';
export { AsrManager } from './manager.js';
export type { AsrManagerDeps } from './manager.js';
export type {
  AsrState,
  AsrStatus,
  AsrProgressEvent,
  AsrEnsureResult,
  AsrTranscribeOptions,
  AsrTranscribeResult,
} from './types.js';
import { AsrManager } from './manager.js';
import type { AsrTranscribeOptions, AsrTranscribeResult } from './types.js';

// ---------------------------------------------------------------------------
// PCM 线格式（REST 与扩展桥共用）
// ---------------------------------------------------------------------------

/**
 * 单次转写接受的采样数上限（10 分钟 @16kHz）。
 * 内存护栏：whisper pipeline 长音频经 chunked 推理，不设上限会让一次恶意请求
 * 占用数十秒推理与数百 MB 内存；更长音频由调用方分段送入。
 */
export const MAX_PCM_SAMPLES = 10 * 60 * 16_000;

/** 预期采样率（Whisper 前端特征抽取的固定输入率；重采样由调用方在上传前完成） */
export const EXPECTED_SAMPLE_RATE = 16_000;

/**
 * base64（Float32 小端字节流）→ Float32Array。
 * @throws 形状非法（非 4 字节对齐 / 超采样上限 / 空）时抛描述性 Error——由调用方决定映射的错误码
 */
export function decodePcmBase64(base64: string): Float32Array {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.byteLength === 0) {
    throw new Error('"samplesBase64" decodes to zero bytes — expected little-endian float32 PCM');
  }
  return float32FromBuffer(buffer);
}

/** Buffer → 4 字节对齐的 Float32Array 视图（Buffer 可能非 4 字节对齐，先复制） */
export function float32FromBuffer(buffer: Buffer): Float32Array {
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) {
    throw new Error(
      `PCM byte length must be a positive multiple of 4 (float32), got ${buffer.byteLength} bytes`,
    );
  }
  const samples = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readFloatLE(i * 4);
  }
  if (samples.length > MAX_PCM_SAMPLES) {
    throw new Error(
      `PCM exceeds the ${MAX_PCM_SAMPLES} sample limit (10 minutes @16kHz) — split longer audio into segments`,
    );
  }
  return samples;
}

/** Float32Array → base64（小端字节流；bridge/REST 应答或客户端自测用） */
export function encodePcmBase64(pcm: Float32Array): string {
  const buffer = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length; i += 1) {
    buffer.writeFloatLE(pcm[i]!, i * 4);
  }
  return buffer.toString('base64');
}

// ---------------------------------------------------------------------------
// 扩展桥（KERNEL_TOPICS.asrStatus / asrTranscribe 的实现表）
// ---------------------------------------------------------------------------

/** 桥 handler 表形状（与 kernel-handlers 的 KernelBridgeHandlers 结构一致） */
export type AsrBridgeHandlers = Record<string, (payload: unknown, from: string) => Promise<unknown>>;

/** 扩展调用 asr.* 内核服务所需的 manifest 权限名 */
export const ASR_PERMISSION = 'asr';

/** asr.transcribe 桥 payload（samplesBase64 主形态；samples 数组为小负载便利形态） */
const bridgeTranscribePayloadSchema = z.object({
  samplesBase64: z.string().min(4).optional(),
  samples: z.array(z.number()).min(1).max(MAX_PCM_SAMPLES).optional(),
  sampleRate: z.number().optional(),
  language: z.string().max(32).optional(),
});

/** createAsrBridge 依赖集合 */
export interface AsrBridgeDeps {
  /** ASR 管理器（状态机 + 转写门面） */
  manager: AsrManager;
  /**
   * 细粒度权限复核回调（接线层注入，通常为 kernel-handlers 同款 requirePermission 闭包：
   * `(extId, topic, permission) => void`，权限不满足时抛 FORBIDDEN）。
   */
  requirePermission: (extId: string, topic: string, permission: string) => void;
}

/**
 * 装配 ASR 内核服务实现表（并进桥 handler 表；topic 键取 KERNEL_TOPICS 值）。
 *
 * 权限边界（照搬 kernel-handlers.requireSandboxPermission 模式）：
 * - 调用方必须是扩展端点（'kernel' 端点 → RPC_PERMISSION_DENIED）；
 * - 调用方 manifest 必须声明 'asr' 权限（缺失 → FORBIDDEN）。
 *
 * 线格式：
 * - asrStatus：无参数 → AsrStatus 快照；
 * - asrTranscribe：`{ samplesBase64, sampleRate?, language? }` 或 `{ samples: number[], ... }`
 *   → `{ text, durationMs }`。sampleRate 若携带必须为 16000（重采样是调用方责任）。
 */
export function createAsrBridge(deps: AsrBridgeDeps): AsrBridgeHandlers {
  /** 非日志 topic 的调用方闸：必须是扩展端点（kernel-handlers 同款规则） */
  const requireExtId = (from: string, topic: string): string => {
    const extId = from === 'kernel' ? null : from.startsWith('ext:') ? from.slice('ext:'.length) : from;
    if (extId === null || extId === '') {
      throw err('RPC_PERMISSION_DENIED', {
        message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
        detail: { topic, from },
      });
    }
    return extId;
  };

  const requireAsrPermission = (extId: string, topic: string): void => {
    deps.requirePermission(extId, topic, ASR_PERMISSION);
  };

  /** 桥 payload → Float32Array（形状/上限非法 → BAD_REQUEST；缺字段 → VALIDATION_FAILED） */
  const pcmOf = (payload: Record<string, unknown>): Float32Array => {
    try {
      if (typeof payload['samplesBase64'] === 'string') {
        return decodePcmBase64(payload['samplesBase64']);
      }
      if (Array.isArray(payload['samples'])) {
        const samples = new Float32Array(payload['samples'] as number[]);
        if (samples.length > MAX_PCM_SAMPLES) {
          throw new Error(
            `PCM exceeds the ${MAX_PCM_SAMPLES} sample limit (10 minutes @16kHz) — split longer audio into segments`,
          );
        }
        return samples;
      }
    } catch (error) {
      throw err('VALIDATION_FAILED', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw err('VALIDATION_FAILED', {
      message: 'asr.transcribe requires "samplesBase64" (base64 of little-endian float32 PCM) or "samples": number[]',
    });
  };

  return {
    [KERNEL_TOPICS.asrStatus]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.asrStatus);
      requireAsrPermission(extId, KERNEL_TOPICS.asrStatus);
      return deps.manager.status();
    },

    [KERNEL_TOPICS.asrTranscribe]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.asrTranscribe);
      requireAsrPermission(extId, KERNEL_TOPICS.asrTranscribe);
      const parsed = bridgeTranscribePayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'asr.transcribe requires payload { samplesBase64 | samples, sampleRate?, language? }',
          detail: parsed.error.issues,
        });
      }
      const record = parsed.data;
      if (record.sampleRate !== undefined && record.sampleRate !== EXPECTED_SAMPLE_RATE) {
        throw err('VALIDATION_FAILED', {
          message: `asr.transcribe requires 16kHz PCM (got ${record.sampleRate}Hz) — resample client-side ` +
            '(browser: AudioContext.decodeAudioData + resample) before calling',
          detail: { sampleRate: record.sampleRate, expected: EXPECTED_SAMPLE_RATE },
        });
      }
      const pcm = pcmOf(record);
      const options: AsrTranscribeOptions = {
        ...(record.language !== undefined && record.language !== '' ? { language: record.language } : {}),
      };
      const result: AsrTranscribeResult = await deps.manager.transcribe(pcm, options);
      return result;
    },
  };
}
