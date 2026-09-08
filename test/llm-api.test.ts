/**
 * llm REST API 集成测试（真实 fastify 注入，经 createHttpServer 挂载 registerLlmRoutes；
 * checker/gateway/gatewayStream/providersAdmin 全部 stub）。
 *
 * 覆盖：无 token 401、normal 调 chat 200 / 调管理端点 403、非流式全字段透传与结果返回、
 * body 校验失败 400（model 缺失/空 messages/role 非法/超 256 条/非法 JSON）、
 * gateway 抛 LLM_MODEL_NOT_FOUND → 404 错误体透传、stream 无 gatewayStream → 501、
 * stream SSE 帧格式（delta OpenAI chunk 形状/usage/收尾 data: [DONE]、done 后不再写出）、
 * 流中网关异常 → 错误帧 + [DONE]、客户端断开 → 生成器 return() 中止（真实 HTTP + fetch abort）、
 * providers GET/PUT admin 门禁与 501 两态、PUT 校验失败 400 不落 set、models 聚合（脱敏）。
 */
import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';

import {
  registerLlmRoutes,
  type LlmRoutesDeps,
  type LlmStreamEvent,
} from '../src/api/llm.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err, HarnessError } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

// ---------------------------------------------------------------------------
// 依赖 stub
// ---------------------------------------------------------------------------

/** 非流式网关 stub：记录入参，可注入返回值与异常 */
class GatewayStub {
  readonly inputs: unknown[] = [];
  result: unknown = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  };
  throws: HarnessError | undefined = undefined;

  async chat(input: unknown): Promise<unknown> {
    this.inputs.push(input);
    if (this.throws !== undefined) throw this.throws;
    return this.result;
  }
}

/** 供应商管理 stub：list 回读 stored，set 记录入参并更新 stored */
class ProvidersAdminStub {
  stored: unknown = SEED_PROVIDERS;
  listCalls = 0;
  readonly setInputs: unknown[] = [];

  async list(): Promise<unknown> {
    this.listCalls += 1;
    return this.stored;
  }

  async set(providers: unknown): Promise<void> {
    this.setInputs.push(providers);
    this.stored = providers;
  }
}

/** 流式网关 stub：按序 yield events，可选在末尾抛错；记录入参与 return() 调用次数 */
type LlmStreamFactory = (input: unknown) => AsyncGenerator<LlmStreamEvent, void, unknown>;

function trackedStream(
  events: LlmStreamEvent[],
  opts: { throwAfter?: HarnessError } = {},
): { stream: LlmStreamFactory; state: { inputs: unknown[]; returnCalls: number } } {
  const state = { inputs: [] as unknown[], returnCalls: 0 };
  const stream: LlmStreamFactory = (input) => {
    const inner = (async function* () {
      state.inputs.push(input);
      for (const ev of events) yield ev;
      if (opts.throwAfter !== undefined) throw opts.throwAfter;
    })();
    const tracked: AsyncGenerator<LlmStreamEvent, void, unknown> = {
      next: (...args) => inner.next(...args),
      return: async (value) => {
        state.returnCalls += 1;
        return inner.return(value);
      },
      throw: (e) => inner.throw(e),
      [Symbol.asyncIterator]() {
        return tracked;
      },
      [Symbol.asyncDispose]() {
        return inner[Symbol.asyncDispose]();
      },
    };
    return tracked;
  };
  return { stream, state };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHAT_BODY = {
  model: 'gpt-x',
  messages: [{ role: 'user', content: 'hi' }],
} as const;

/** 非流式全字段 body（透传断言用） */
const FULL_BODY = {
  model: 'gpt-x',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: { text: 'structured' } },
  ],
  stream: false,
  maxTokens: 512,
  temperature: 0.3,
  topP: 0.9,
  stop: ['\n\n'],
  tools: [{ type: 'function', function: { name: 'ping' } }],
  providerParams: { user: 'u-1' },
};

const SEED_PROVIDERS = [
  {
    name: 'opena',
    protocol: 'openai',
    baseUrl: 'https://api.opena.example.com/v1',
    apiKeySecretRef: 'secrets/opena-key',
    models: ['gpt-x', 'o4-mini'],
  },
  {
    name: 'local-ollama',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    apiKeySecretRef: 'secrets/none',
    models: ['llama3'],
  },
  // 第三条故意用 provider 键 + 混入非字符串模型项：验证聚合容错
  { provider: 'vertex', models: ['gemini-1', 42] },
] as const;

const PUT_BODY = [
  {
    name: 'opena',
    protocol: 'openai-chat',
    baseUrl: 'https://api.opena.example.com/v1',
    apiKeySecretRef: 'secrets/opena-key',
    models: ['gpt-x'],
    paramAllowlist: ['user', 'temperature'],
    timeoutMs: 30_000,
  },
];

interface BuildCtx {
  app: FastifyInstance;
  gateway: GatewayStub;
  providers: ProvidersAdminStub;
  streamState: { inputs: unknown[]; returnCalls: number };
}

/** 组装被测服务器：stub checker + gateway + 可选 gatewayStream/providersAdmin/secrets */
function buildServer(
  opts: {
    withStream?: boolean;
    withAdmin?: boolean;
    streamEvents?: LlmStreamEvent[];
    throwAfter?: HarnessError;
    secrets?: { set(name: string, value: string): Promise<void> };
  } = {},
): BuildCtx {
  const gateway = new GatewayStub();
  const providers = new ProvidersAdminStub();
  const { stream, state } = trackedStream(
    opts.streamEvents ?? [
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'usage', usage: { total_tokens: 7 } },
      { type: 'done' },
      { type: 'delta', text: 'SHOULD-NOT-APPEAR' },
    ],
    { throwAfter: opts.throwAfter },
  );
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: './data' });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      const deps: LlmRoutesDeps = {
        checker: async ({ token }) => {
          if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['llm'] };
          if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
          if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
          return null;
        },
        gateway,
        ...(opts.withStream === false ? {} : { gatewayStream: stream }),
        ...(opts.withAdmin === false ? {} : { providersAdmin: providers }),
        ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
      };
      registerLlmRoutes(a, deps);
    },
  });
  return { app, gateway, providers, streamState: state };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('llm api — 鉴权与角色门禁', () => {
  const ALL_ROUTES = [
    { method: 'POST', url: '/api/v1/llm/chat', body: CHAT_BODY },
    { method: 'GET', url: '/api/v1/llm/providers' },
    { method: 'PUT', url: '/api/v1/llm/providers', body: PUT_BODY },
    { method: 'GET', url: '/api/v1/llm/models' },
  ] as const;

  it.each(ALL_ROUTES)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006', retryable: false });
  });

  it.each(ALL_ROUTES.slice(1, 3))('$method $url normal 角色 → 403 HARNESS-1007', async (route) => {
    const { app } = buildServer();
    const res = await app.inject({
      method: route.method,
      url: route.url,
      headers: AUTH_NORMAL,
      ...('body' in route ? { payload: route.body } : {}),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(res.json().message).toContain('admin or root');
  });

  it('chat 对 normal 放行（任意已认证身份）；root 放行管理端点；?token= 亦可认证', async () => {
    const { app } = buildServer();
    const chat = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_NORMAL, payload: CHAT_BODY });
    expect(chat.statusCode).toBe(200);
    const root = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: AUTH_ROOT });
    expect(root.statusCode).toBe(200);
    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/llm/models?token=${NORMAL_TOKEN}` });
    expect(viaQuery.statusCode).toBe(200);
  });
});

describe('llm api — POST /api/v1/llm/chat（非流式）', () => {
  it('200：全字段 body 原样透传 gateway.chat，响应体为 gateway 结果', async () => {
    const { app, gateway } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: FULL_BODY });
    expect(res.statusCode).toBe(200);
    expect(gateway.inputs).toEqual([FULL_BODY]);
    expect(res.json()).toEqual(gateway.result);
  });

  it('body 校验失败 → 400 HARNESS-1009 且不触达 gateway', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['缺 model', { messages: [{ role: 'user', content: 'hi' }] }],
      ['缺 messages', { model: 'gpt-x' }],
      ['messages 空数组', { model: 'gpt-x', messages: [] }],
      ['role 非法', { model: 'gpt-x', messages: [{ role: 'robot', content: 'hi' }] }],
      ['maxTokens 非正整数', { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }], maxTokens: -1 }],
      ['temperature 超界', { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }], temperature: 3 }],
      ['providerParams 非对象', { model: 'gpt-x', messages: [{ role: 'user', content: 'x' }], providerParams: [] }],
    ];
    const { app, gateway } = buildServer();
    for (const [label, body] of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: body });
      expect(res.statusCode, `${label} 应为 400`).toBe(400);
      expect(res.json().code, label).toBe('HARNESS-1009');
    }
    expect(gateway.inputs).toEqual([]);
  });

  it('messages 超 256 条 → 400 HARNESS-1009', async () => {
    const { app, gateway } = buildServer();
    const body = {
      model: 'gpt-x',
      messages: Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })),
    };
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(gateway.inputs).toEqual([]);
  });

  it('gateway 抛 LLM_MODEL_NOT_FOUND → 404 错误体原样透传', async () => {
    const { app, gateway } = buildServer();
    gateway.throws = err('LLM_MODEL_NOT_FOUND', { detail: { model: 'gpt-x' } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: CHAT_BODY });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      code: 'HARNESS-5003',
      message: 'model not configured',
      detail: { model: 'gpt-x' },
      retryable: false,
    });
  });

  it('body 非法 JSON → 400 HARNESS-1009', async () => {
    const { app } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/llm/chat',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{"model": not-json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });
});

describe('llm api — POST /api/v1/llm/chat（流式 SSE）', () => {
  const STREAM_BODY = { ...CHAT_BODY, stream: true };

  it('stream=true 且无 gatewayStream → 501 HARNESS-9004，不触达非流式网关', async () => {
    const { app, gateway } = buildServer({ withStream: false });
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: STREAM_BODY });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'HARNESS-9004' });
    expect(gateway.inputs).toEqual([]);
  });

  it('stream=true → SSE：content-type、delta 帧 OpenAI chunk 形状、usage 帧、[DONE] 收尾、done 后不再写出', async () => {
    const { app, streamState } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: STREAM_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.payload).toBe(
      [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"usage":{"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );
    expect(res.payload).not.toContain('SHOULD-NOT-APPEAR');
    expect(streamState.inputs).toEqual([STREAM_BODY]);
    expect(streamState.returnCalls).toBeGreaterThanOrEqual(1); // 收尾请求生成器中止（幂等）
  });

  it('stream=true 但 body 校验失败 → 400（校验先于 501/SSE）', async () => {
    const { app, streamState } = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/llm/chat',
      headers: AUTH_ADMIN,
      payload: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(streamState.inputs).toEqual([]);
  });

  it('流中网关抛 HarnessError → 错误帧（带 code/message）+ [DONE]', async () => {
    const { app } = buildServer({
      streamEvents: [{ type: 'delta', text: 'par' }],
      throwAfter: err('LLM_PROVIDER_ERROR', { detail: 'upstream 500' }),
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/llm/chat', headers: AUTH_ADMIN, payload: STREAM_BODY });
    expect(res.statusCode).toBe(200); // 已 hijack，状态码不再变更
    expect(res.payload).toBe(
      [
        'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
        'data: {"error":{"code":"HARNESS-5002","message":"llm provider error"}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    );
  });
});

describe('llm api — SSE 客户端断开 abort（真实 HTTP）', () => {
  it('客户端中断连接 → 生成器 return() 被调用（服务端停止消费）', async () => {
    const gateway = new GatewayStub();
    const { stream, state } = trackedStream(
      Array.from({ length: 500 }, (_, i) => ({ type: 'delta', text: `chunk-${i}` })),
    );
    const app = Fastify({ logger: false });
    registerLlmRoutes(app, {
      checker: async () => ({ userId: 'admin-1', role: 'admin', scopes: ['*'] }),
      gateway,
      gatewayStream: stream,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/llm/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], stream: true }),
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader(); // Node fetch 的 body 非空
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('chunk-0');
      ac.abort();
      await vi.waitFor(() => expect(state.returnCalls).toBe(1), { timeout: 3000 });
    } finally {
      await app.close();
    }
  });
});

describe('llm api — GET/PUT /api/v1/llm/providers（admin）', () => {
  it('GET providers admin → 透传 providersAdmin.list() 结果', async () => {
    const { app, providers } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SEED_PROVIDERS);
    expect(providers.listCalls).toBe(1);
    expect(providers.setInputs).toEqual([]);
  });

  it('PUT providers admin 合法 → {ok:true}，set 收到解析后的数组；GET 回读新配置', async () => {
    const { app, providers } = buildServer();
    const res = await app.inject({ method: 'PUT', url: '/api/v1/llm/providers', headers: AUTH_ADMIN, payload: PUT_BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(providers.setInputs).toEqual([PUT_BODY]);
    const readBack = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: AUTH_ADMIN });
    expect(readBack.json()).toEqual(PUT_BODY);
  });

  it('PUT providers admin 空数组（清空）→ {ok:true}', async () => {
    const { app, providers } = buildServer();
    const res = await app.inject({ method: 'PUT', url: '/api/v1/llm/providers', headers: AUTH_ADMIN, payload: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(providers.setInputs).toEqual([[]]);
  });

  it.each([
    ['protocol 非三值', [{ name: 'x', protocol: 'grpc', baseUrl: 'https://a.com', apiKeySecretRef: 's/x', models: ['m'] }]],
    ['models 空数组', [{ name: 'x', protocol: 'openai-chat', baseUrl: 'https://a.com', apiKeySecretRef: 's/x', models: [] }]],
    ['apiKey 与 apiKeySecretRef 皆缺', [{ name: 'x', protocol: 'openai-chat', baseUrl: 'https://a.com', models: ['m'] }]],
    ['baseUrl 非 URL', [{ name: 'x', protocol: 'openai-chat', baseUrl: 'not-a-url', apiKeySecretRef: 's/x', models: ['m'] }]],
    ['缺 name', [{ protocol: 'openai-chat', baseUrl: 'https://a.com', apiKeySecretRef: 's/x', models: ['m'] }]],
    ['timeoutMs 非数字', [{ name: 'x', protocol: 'openai-chat', baseUrl: 'https://a.com', apiKeySecretRef: 's/x', models: ['m'], timeoutMs: 'slow' }]],
    ['顶层非数组', { name: 'x' }],
  ])('PUT providers 非法（%s）→ 400 HARNESS-1009 且不落 set', async (_label, body) => {
    const { app, providers } = buildServer();
    const res = await app.inject({ method: 'PUT', url: '/api/v1/llm/providers', headers: AUTH_ADMIN, payload: body });
    expect(res.statusCode, `${_label} 应为 400`).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(providers.setInputs).toEqual([]);
  });

  it('PUT providers 含明文 apiKey 且 secrets 未接线 → 400，不落 set（明文不入配置）', async () => {
    const { app, providers } = buildServer();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/llm/providers',
      headers: AUTH_ADMIN,
      payload: [{ name: 'x', protocol: 'openai-chat', baseUrl: 'https://a.com', apiKeySecretRef: 's/x', models: ['m'], apiKey: 'sk-plain' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(providers.setInputs).toEqual([]);
  });

  it('PUT providers 含明文 apiKey 且 secrets 已接线 → 转存 secrets、以 ref 落 set、明文不回传', async () => {
    const secrets = { set: vi.fn(async (_name: string, _value: string) => {}) };
    const { app, providers } = buildServer({ secrets });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/llm/providers',
      headers: AUTH_ADMIN,
      payload: [{
        name: 'x',
        protocol: 'openai-chat',
        baseUrl: 'https://a.com',
        models: ['m'],
        apiKey: 'sk-plain',
        paramAllowlist: ['user'],
        timeoutMs: 1000,
      }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(secrets.set).toHaveBeenCalledWith('llm.x', 'sk-plain');
    expect(providers.setInputs).toEqual([
      [{
        name: 'x',
        protocol: 'openai-chat',
        baseUrl: 'https://a.com',
        apiKeySecretRef: 'llm.x',
        models: ['m'],
        paramAllowlist: ['user'],
        timeoutMs: 1000,
      }],
    ]);
    expect(JSON.stringify(providers.setInputs)).not.toContain('sk-plain');
  });

  it('providersAdmin 缺省 → GET/PUT providers、GET models 均 501 HARNESS-9004（门禁之后）', async () => {
    const { app } = buildServer({ withAdmin: false });
    const get = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: AUTH_ADMIN });
    expect(get.statusCode).toBe(501);
    expect(get.json()).toMatchObject({ code: 'HARNESS-9004' });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/llm/providers', headers: AUTH_ADMIN, payload: PUT_BODY });
    expect(put.statusCode).toBe(501);
    const models = await app.inject({ method: 'GET', url: '/api/v1/llm/models', headers: AUTH_ADMIN });
    expect(models.statusCode).toBe(501);
    // 门禁仍先于 501：normal 角色依旧 403
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: AUTH_NORMAL });
    expect(forbidden.statusCode).toBe(403);
  });
});

describe('llm api — GET /api/v1/llm/models（聚合）', () => {
  it('任意已认证身份 → 聚合 [{provider, models}]，不回显 apiKey 等其他字段', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/llm/models', headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { provider: 'opena', models: ['gpt-x', 'o4-mini'] },
      { provider: 'local-ollama', models: ['llama3'] },
      { provider: 'vertex', models: ['gemini-1'] }, // provider 键回退 + 非字符串模型项剔除
    ]);
    expect(JSON.stringify(res.json())).not.toContain('secrets/');
  });

  it('list() 返回非数组 → 空数组兜底', async () => {
    const { app, providers } = buildServer();
    providers.stored = { unexpected: true };
    const res = await app.inject({ method: 'GET', url: '/api/v1/llm/models', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
