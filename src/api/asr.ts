/**
 * asr — 语音识别 REST API（/api/v1/asr*，全部已认证）。
 *
 * 路由：
 * - GET  /api/v1/asr/status     状态快照（任意已认证身份）→ AsrStatus
 *                               { state: disabled|not-downloaded|downloading|ready|error,
 *                                 progress?, error?, modelId, enabled }；
 *                               state==='downloading' 时携带 progress（0–100）。
 * - POST /api/v1/asr/ensure     触发后台静默下载（admin）→ 202 + 当前状态快照；
 *                               已缓存/下载中幂等（单飞去重）；disabled → 503。
 * - POST /api/v1/asr/transcribe 转写（任意已认证身份）→ { text, durationMs }；
 *                               下载中会等待模型就绪后推理（调用方无需轮询）。
 *
 * PCM 契约（重要，见 docs 站 asr.mdx）：
 * - 输入一律是 **16kHz 单声道 Float32 PCM**（Whisper 特征抽取的固定输入率）；
 *   浏览器端 MediaRecorder 产出的 webm/opus 容器由前端在上传前用 WebAudio
 *   `decodeAudioData` 解码并重采样为 16kHz——内核不依赖 ffmpeg，不做容器解码；
 * - JSON 形态：`{ samplesBase64, sampleRate?, language? }`，samplesBase64 为
 *   Float32 **小端**字节流的 base64（受全局 body 上限约束，适合短音频）；
 * - 二进制形态：`content-type: application/octet-stream` 直发 Float32 小端裸字节，
 *   `?sampleRate=16000&language=zh`（本路由放宽 bodyLimit 至 48MB，适合长音频）；
 * - sampleRate 非 16000 → 400 VALIDATION_FAILED（重采样是调用方责任）。
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 *   ensure 要求 role 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 失败统一 400 HARNESS-1009；
 * - 推理失败等非 HarnessError 由全局错误处理器统一脱敏为 500 INTERNAL。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import {
  decodePcmBase64,
  EXPECTED_SAMPLE_RATE,
  float32FromBuffer,
  MAX_PCM_SAMPLES,
} from '../kernel/asr/index.js';
import type { AsrManager } from '../kernel/asr/manager.js';
import { err, HarnessError } from '../kernel/errors/index.js';

/** registerAsrRoutes 依赖集合 */
export interface AsrRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** ASR 管理器（状态机 + 转写门面，全部操作委托于此） */
  manager: AsrManager;
}

/** 二进制直传路由的 body 上限：48MB float32 ≈ 12.5 分钟 16kHz 音频（解码侧另有采样数上限） */
const TRANSCRIBE_BODY_LIMIT_BYTES = 48 * 1024 * 1024;

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST /api/v1/asr/transcribe JSON 请求体（samplesBase64 = float32 小端字节流 base64） */
const transcribeBodySchema = z.object({
  /** base64(Float32 LE 字节流)；4 字节起（至少 1 个采样） */
  samplesBase64: z.string().min(4).max(96 * 1024 * 1024),
  /** 采样率，缺省 16000；非 16000 → 400（重采样由调用方完成） */
  sampleRate: z.coerce.number().int().positive().max(768_000).optional(),
  /** 源语言提示（ISO 639-1 或语言英文名）；缺省自动检测 */
  language: z.string().min(1).max(32).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** fastify JSON body 解析类错误码（映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
 * HarnessError 按自身状态码下发；其余异常重新抛出交回全局错误处理器兜底。
 */
function mapBodyParseError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof HarnessError) {
    reply.code(error.status).send(error.toJSON());
    return;
  }
  if (typeof error.code === 'string' && JSON_PARSE_ERROR_CODES.has(error.code)) {
    const invalid = err('VALIDATION_FAILED', {
      message: 'request body is not valid JSON — fix the JSON syntax and send content-type: application/json',
      detail: [{ code: error.code, message: error.message }],
    });
    reply.code(invalid.status).send(invalid.toJSON());
    return;
  }
  throw error;
}

/** 形状/上限类解码错误 → 400 VALIDATION_FAILED（保留可操作的原始 message） */
function asValidationError(error: unknown): HarnessError {
  return err('VALIDATION_FAILED', {
    message: error instanceof Error ? error.message : String(error),
  });
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册 ASR API 路由（status/transcribe 任意已认证身份，ensure 仅 admin）。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerAsrRoutes(app: FastifyInstance, deps: AsrRoutesDeps): void {
  /** 鉴权：返回身份（401 由 checker 抛 UNAUTHORIZED 决定） */
  const requireAuth = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** admin 门禁：ensure 是宿主级资源操作（触发下载占磁盘/带宽），仅 root/admin */
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await requireAuth(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `asr ensure requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  // octet-stream 直传解析（全局未注册时补一个应用级 parser；幂等，避免与并行模块冲突）
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_request, body: unknown, done: (err: Error | null, result?: unknown) => void) => {
        done(null, body as Buffer);
      },
    );
  }

  const routeOptions = { schema: { tags: ['asr'] } };

  // GET /api/v1/asr/status — 状态快照（任意已认证身份）
  app.get('/api/v1/asr/status', routeOptions, async (request) => {
    await requireAuth(request);
    return deps.manager.status();
  });

  // POST /api/v1/asr/ensure — 触发后台静默下载（admin）→ 202 + 状态快照
  app.post(
    '/api/v1/asr/ensure',
    routeOptions,
    async (_request, reply) => {
      await requireAdmin(_request);
      const status = deps.manager.status();
      if (status.state === 'disabled') {
        throw err('SERVICE_UNAVAILABLE', {
          message: 'ASR is disabled (enable it by removing HARNESS_ASR_ENABLED=false or setting it to true)',
        });
      }
      // fire-and-forget：下载在后台进行，客户端轮询 GET /status 观察 progress；
      // ensureReady 单飞——与 autoDownload/其他调用方共享同一次下载
      void deps.manager.ensureReady().catch(() => {
        /* 失败落 status.error（state: 'error'），由 GET /status 暴露 */
      });
      reply.code(202);
      return deps.manager.status();
    },
  );

  // POST /api/v1/asr/transcribe — 转写（任意已认证身份；JSON / octet-stream 双形态）
  app.post(
    '/api/v1/asr/transcribe',
    { ...routeOptions, errorHandler: mapBodyParseError, bodyLimit: TRANSCRIBE_BODY_LIMIT_BYTES },
    async (request) => {
      await requireAuth(request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      const isRaw = contentType === 'application/octet-stream';

      // 1) 解出 PCM（二种形态）+ 语言提示
      let pcm: Float32Array;
      let language: string | undefined;
      let sampleRate: number | undefined;
      if (isRaw) {
        const body = request.body as Buffer;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          throw err('VALIDATION_FAILED', {
            message: 'empty body — send raw little-endian float32 PCM with content-type: application/octet-stream',
          });
        }
        const rawRate = typeof query['sampleRate'] === 'string' ? Number(query['sampleRate']) : undefined;
        sampleRate = rawRate !== undefined && Number.isFinite(rawRate) ? rawRate : EXPECTED_SAMPLE_RATE;
        language = typeof query['language'] === 'string' && query['language'] !== '' ? query['language'] : undefined;
        try {
          pcm = float32FromBuffer(body);
        } catch (error) {
          throw asValidationError(error);
        }
      } else {
        const parsed = transcribeBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw err('VALIDATION_FAILED', {
            message: 'body requires { samplesBase64, sampleRate?, language? } — samplesBase64 is base64 of ' +
              'little-endian float32 PCM resampled to 16kHz mono',
            detail: parsed.error.issues,
          });
        }
        sampleRate = parsed.data.sampleRate ?? EXPECTED_SAMPLE_RATE;
        language = parsed.data.language;
        try {
          pcm = decodePcmBase64(parsed.data.samplesBase64);
        } catch (error) {
          throw asValidationError(error);
        }
      }

      // 2) 采样率契约：模型固定吃 16kHz，重采样是调用方责任（浏览器 WebAudio 可做）
      if (sampleRate !== EXPECTED_SAMPLE_RATE) {
        throw err('VALIDATION_FAILED', {
          message: `ASR requires 16kHz mono PCM (got ${sampleRate}Hz) — resample client-side ` +
            '(browser: AudioContext decodeAudioData + resample to 16000) before uploading',
          detail: { sampleRate, expected: EXPECTED_SAMPLE_RATE },
        });
      }
      if (pcm.length > MAX_PCM_SAMPLES) {
        throw err('VALIDATION_FAILED', {
          message: `PCM exceeds the ${MAX_PCM_SAMPLES} sample limit (10 minutes @16kHz) — split longer audio into segments`,
        });
      }

      // 3) 转写（下载中 → 等待模型就绪；推理失败由全局处理器脱敏）
      return await deps.manager.transcribe(pcm, language !== undefined ? { language } : undefined);
    },
  );
}
