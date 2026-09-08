/**
 * llm — LLM 网关 REST API（/api/v1/llm*）。
 *
 * 路由：
 * - POST /api/v1/llm/chat        对话补全（任意已认证身份）。
 *                                stream!==true → 委托 deps.gateway.chat → 结果 JSON（200）；
 *                                gateway 抛 HarnessError 原样上抛（全局错误处理器按 status 下发）；
 *                                stream===true → SSE 流式（deps.gatewayStream 缺省 → 501 HARNESS-9004）。
 * - GET  /api/v1/llm/providers   供应商配置清单（admin；deps.providersAdmin 缺省 → 501）
 * - PUT  /api/v1/llm/providers   覆写供应商配置数组（admin；校验通过后交集成方持久化 settings
 *                                并脱敏存储；deps.providersAdmin 缺省 → 501）→ {ok:true}
 *                                每项可携带 apiKey 明文：deps.secrets 已接线时自动转存
 *                                secrets（键 `llm.<name>`）并以 apiKeySecretRef 引用落盘
 *                                （明文不进配置存储）；未接线时含 apiKey 的项 → 400。
 * - GET  /api/v1/llm/models      供应商模型聚合视图（任意已认证身份；缺省 → 501）
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker
 *   校验；返回 null 视为未认证 → 401 HARNESS-1006（checker 自身抛 UNAUTHORIZED 同样生效）；
 *   管理类路由要求 role 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验；body 非法 JSON 与 zod 校验失败统一 400 HARNESS-1009 VALIDATION_FAILED；
 * - SSE：reply.hijack 后逐事件写 `data: {JSON}\n\n`——delta 帧为 OpenAI chunk 形状
 *   `{choices:[{delta:{content:text}}]}`，`done` 事件终止并写 `data: [DONE]\n\n`；
 *   客户端断开以 reply.raw 的 'close' 为准（注意：Node ≥16 的 request.raw 'close'
 *   在请求体读毕即触发——若监听它会把每个流式响应立即掐断，实测见 test/llm-api.test.ts），
 *   断开时对生成器调用 return() 请求中止并停止写出；
 * - 流中错误：已 hijack 无法改状态码，写 `data: {"error":{...}}` + `data: [DONE]` 后收尾
 *   （HarnessError 带 code/message，其余异常不泄露细节）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 鉴权后的最小身份视图（与 authProxy.createAuthChecker 的产物结构一致） */
export interface LlmRouteIdentity {
  userId: string;
  role: 'root' | 'admin' | 'normal';
  scopes: string[];
}

/** 流式网关事件。type：'delta' 文本增量 / 'usage' 用量 / 'error' 错误 / 'done' 终止 / 其他原样透传 */
export interface LlmStreamEvent {
  type: string;
  /** type==='delta' 时的增量文本 */
  text?: string;
  /** type==='usage' 时的 token 用量（形状由网关定义） */
  usage?: unknown;
  /** type==='error' 时的错误说明 */
  message?: string;
}

/** registerLlmRoutes 依赖集合 */
export interface LlmRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 返回 null = 未认证 → 401；写操作 role 非 'root'|'admin' → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<LlmRouteIdentity | null>;
  /** 非流式对话网关：校验后的 chat body → LlmChatResult（契约见 kernel/llm/types.ts） */
  gateway: { chat(input: unknown): Promise<unknown> };
  /**
   * 流式对话网关（可选）：校验后的 chat body → 事件流。
   * 未注入时 stream 请求返回 501 NOT_IMPLEMENTED。
   */
  gatewayStream?: (input: unknown) => AsyncGenerator<LlmStreamEvent, void, unknown>;
  /**
   * 供应商配置管理（可选）：list 返回持久化的供应商配置数组；
   * set 由集成方持久化 settings（apiKey 以 secret ref 存储，天然脱敏）。
   * 未注入时 providers/models 端点返回 501 NOT_IMPLEMENTED。
   */
  providersAdmin?: {
    list(): Promise<unknown>;
    set(providers: unknown): Promise<void>;
  };
  /**
   * 内核密钥存储（可选）：PUT providers 的项携带 apiKey 明文时自动转存
   * secrets（键 `llm.<name>`），配置层只留 secret 引用。未接线时含 apiKey
   * 明文的项 → 400 VALIDATION_FAILED（明文密钥不落配置存储）。
   */
  secrets?: { set(name: string, value: string): Promise<void> };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** chat message 角色（OpenAI 兼容四值） */
const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

/** POST /api/v1/llm/chat 请求体 */
const chatBodySchema = z.object({
  model: z.string().min(1).max(256),
  messages: z
    .array(z.object({ role: z.enum(MESSAGE_ROLES), content: z.unknown() }))
    .min(1)
    .max(256),
  stream: z.boolean().optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  stop: z.array(z.string().min(1)).min(1).max(8).optional(),
  tools: z.array(z.unknown()).max(128).optional(),
  providerParams: z.record(z.string(), z.unknown()).optional(),
});

/** 支持的供应商协议（与内核 LlmGateway 协议适配器一一对应：kernel/llm/types.ts LlmProtocol） */
export const LLM_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;

/**
 * 单个供应商配置骨架。
 * 密钥二选一：apiKey（明文，PUT 时自动转存 secrets，不落配置存储）或
 * apiKeySecretRef（既有 secret 引用）；两者皆缺 → 校验失败。
 */
const providerConfigSchema = z
  .object({
    name: z.string().min(1).max(64),
    protocol: z.enum(LLM_PROTOCOLS),
    baseUrl: z.url(),
    apiKey: z.string().min(1).max(4096).optional(),
    apiKeySecretRef: z.string().min(1).max(128).optional(),
    models: z.array(z.string().min(1)).min(1).max(256),
    paramAllowlist: z.array(z.string().min(1)).max(64).optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
  })
  .refine((p) => p.apiKey !== undefined || p.apiKeySecretRef !== undefined, {
    error: 'each provider requires either apiKey (plaintext, auto-stored to secrets) or apiKeySecretRef',
    path: ['apiKeySecretRef'],
  });

/** PUT /api/v1/llm/providers 请求体：供应商配置数组（允许空数组 = 清空全部供应商） */
const providersBodySchema = z.array(providerConfigSchema).max(64);

// ---------------------------------------------------------------------------
// SSE 辅助
// ---------------------------------------------------------------------------

const DONE_FRAME = 'data: [DONE]\n\n';

/** 事件 → SSE data 帧（delta 固定 OpenAI chunk 形状；usage/error 收敛为单键对象；其余原样透传） */
function sseFrameOf(event: LlmStreamEvent): string {
  if (event.type === 'delta') {
    const chunk = { choices: [{ delta: { content: event.text ?? '' } }] };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
  if (event.type === 'usage') {
    return `data: ${JSON.stringify({ usage: event.usage ?? null })}\n\n`;
  }
  if (event.type === 'error') {
    return `data: ${JSON.stringify({ error: { message: event.message ?? 'stream error' } })}\n\n`;
  }
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 流中异常 → 错误帧（HarnessError 带 code/message；其余不泄露细节） */
function sseErrorFrame(e: unknown): string {
  const payload =
    e instanceof HarnessError
      ? { error: { code: e.code, message: e.message } }
      : { error: { code: err('INTERNAL').code, message: 'internal error' } };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 消费流式网关并写 SSE 响应。
 *
 * 断开检测挂在 reply.raw（ServerResponse）的 'close' 上：客户端断开时置位、
 * 唤醒写入循环并对生成器调用 return() 请求中止。写入循环以 Promise.race 同时等
 * 下一事件与断开，保证生成器卡住时也能立即停止消费。
 */
async function streamChat(
  request: FastifyRequest,
  reply: FastifyReply,
  stream: (input: unknown) => AsyncGenerator<LlmStreamEvent, void, unknown>,
  input: unknown,
): Promise<void> {
  const iterator = stream(input);

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let clientGone = false;
  let returned = false;
  let notifyGone: (() => void) | undefined;
  /** 请求生成器中止（幂等；客户端断开与收尾各可能触发一次） */
  const returnIterator = (): void => {
    if (returned) return;
    returned = true;
    void iterator.return(undefined);
  };

  const onClose = (): void => {
    if (clientGone) return;
    clientGone = true;
    notifyGone?.();
    returnIterator();
  };
  raw.on('close', onClose);
  const gonePromise = new Promise<void>((resolve) => {
    notifyGone = resolve;
  });

  try {
    for (;;) {
      const raced = await Promise.race([iterator.next(), gonePromise.then(() => false)]);
      if (clientGone) break;
      const result = raced as IteratorResult<LlmStreamEvent, void>;
      if (result.done || result.value === undefined) break;
      if (result.value.type === 'done') {
        if (raw.writable) raw.write(DONE_FRAME);
        break;
      }
      if (raw.writable) raw.write(sseFrameOf(result.value));
    }
  } catch (e) {
    // 已 hijack：无法改状态码，降级为错误帧 + [DONE]（客户端已断开时跳过写出）
    if (!clientGone && raw.writable) {
      raw.write(sseErrorFrame(e));
      raw.write(DONE_FRAME);
    }
  } finally {
    raw.off('close', onClose);
    returnIterator();
    if (!clientGone && !raw.destroyed && raw.writable) raw.end();
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** deps.providersAdmin 缺省 → 501 NOT_IMPLEMENTED */
function notWired(what: string): HarnessError {
  return err('NOT_IMPLEMENTED', { message: `${what} is not wired (no deps.providersAdmin registered)` });
}

/**
 * providersAdmin.list() 结果 → 聚合模型视图 [{provider, models[]}]。
 * 容忍缺字段/形状偏差（非数组 → []；models 内非字符串项剔除），不回显 apiKey 等其他字段。
 */
function aggregateModels(raw: unknown): Array<{ provider: string; models: string[] }> {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const name = rec['name'];
    const provider =
      typeof name === 'string' && name !== ''
        ? name
        : typeof rec['provider'] === 'string' && rec['provider'] !== ''
          ? (rec['provider'] as string)
          : 'unknown';
    const models = Array.isArray(rec['models'])
      ? rec['models'].filter((m): m is string => typeof m === 'string')
      : [];
    return { provider, models };
  });
}

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PUT 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
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

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册 LLM 网关 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerLlmRoutes(app: FastifyInstance, deps: LlmRoutesDeps): void {
  /** 认证：checker 返回 null（或抛 UNAUTHORIZED）→ 401 */
  const authenticate = async (request: FastifyRequest): Promise<LlmRouteIdentity> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity === null) {
      throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
    }
    return identity;
  };

  /** 认证 + admin 门禁（root 放行）：否则 FORBIDDEN */
  const requireAdmin = async (request: FastifyRequest): Promise<LlmRouteIdentity> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `llm management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
    return identity;
  };

  const routeOptions = { schema: { tags: ['llm'] } };

  // -------------------------------------------------------------------------
  // POST /api/v1/llm/chat — 对话补全（非流式 JSON / 流式 SSE）
  // -------------------------------------------------------------------------

  app.post(
    '/api/v1/llm/chat',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await authenticate(request);
      const parsed = chatBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
      }
      if (parsed.data.stream === true) {
        if (deps.gatewayStream === undefined) {
          throw err('NOT_IMPLEMENTED', {
            message: 'llm streaming is not wired (no deps.gatewayStream registered)',
          });
        }
        const stream = deps.gatewayStream;
        await streamChat(request, reply, stream, parsed.data);
        return reply;
      }
      return deps.gateway.chat(parsed.data);
    },
  );

  // -------------------------------------------------------------------------
  // GET/PUT /api/v1/llm/providers — 供应商配置管理（admin）
  // -------------------------------------------------------------------------

  // GET providers — 供应商配置清单（原样透传 list() 结果）
  app.get('/api/v1/llm/providers', routeOptions, async (request) => {
    await requireAdmin(request);
    if (deps.providersAdmin === undefined) throw notWired('llm providers management');
    return deps.providersAdmin.list();
  });

  // PUT providers — 覆写供应商配置数组（校验后交集成方持久化并脱敏存储）
  app.put(
    '/api/v1/llm/providers',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      if (deps.providersAdmin === undefined) throw notWired('llm providers management');
      const parsed = providersBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message:
            'providers must be an array of { name, protocol: openai-chat|openai-responses|anthropic-messages, baseUrl, apiKey | apiKeySecretRef, models: [string, ...], paramAllowlist?, timeoutMs? }',
          detail: parsed.error.issues,
        });
      }
      // 明文 apiKey → 自动转存 secrets（键 `llm.<name>`）并以 secret 引用落配置（脱敏；
      // 明文不进 settings、不回显）。deps.secrets 未接线时含明文的项直接拒绝。
      const stored: unknown[] = [];
      for (const item of parsed.data) {
        if (item.apiKey === undefined) {
          stored.push(item);
          continue;
        }
        if (deps.secrets === undefined) {
          throw err('VALIDATION_FAILED', {
            message:
              'providers[].apiKey (plaintext) requires the kernel secrets store, which is not wired into this route; ' +
              'send apiKeySecretRef instead, or run the gateway via the kernel assembly (deps.secrets)',
            detail: [{ index: stored.length, name: item.name }],
          });
        }
        const secretRef = `llm.${item.name}`;
        await deps.secrets.set(secretRef, item.apiKey);
        stored.push({
          name: item.name,
          protocol: item.protocol,
          baseUrl: item.baseUrl,
          apiKeySecretRef: secretRef,
          models: item.models,
          ...(item.paramAllowlist !== undefined ? { paramAllowlist: item.paramAllowlist } : {}),
          ...(item.timeoutMs !== undefined ? { timeoutMs: item.timeoutMs } : {}),
        });
      }
      await deps.providersAdmin.set(stored);
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/v1/llm/models — 模型聚合视图（任意已认证身份）
  // -------------------------------------------------------------------------

  app.get('/api/v1/llm/models', routeOptions, async (request) => {
    await authenticate(request);
    if (deps.providersAdmin === undefined) throw notWired('llm model listing');
    return aggregateModels(await deps.providersAdmin.list());
  });
}
