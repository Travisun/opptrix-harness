/**
 * LLM 网关单测（不依赖真实网络：通过 vi.stubGlobal('fetch', …) 注入可拦截 fetch，
 * 三个协议 adapter 的流式响应用内存 ReadableStream 合成 SSE 帧）。
 *
 * 覆盖：filterProviderParams 白名单（透传/拒绝 LLM_PARAM_REJECTED/自定义 allowlist）、
 * openai-chat 非流式（choices/usage、参数映射、Bearer 头）与消息互转（tool_calls/tool role）、
 * openai-chat 流式（SSE → delta/tool_call_delta/done，stream_options.include_usage）、
 * provider HTTP 错误 → LLM_PROVIDER_ERROR、
 * openai-responses 非流式（output_text、max_output_tokens）与流式事件映射、
 * anthropic 非流式（system 提取、max_tokens 缺省 4096、tool_result/tool_use）与流式（content_block_delta）、
 * LlmChatResult.toolCalls 非流式结构化工具调用提取（openai-chat tool_calls / openai-responses
 * function_call / anthropic tool_use；无调用时缺省不出现；gateway 全链路透传）、
 * gateway 路由（模型未找到 LLM_MODEL_NOT_FOUND、secret 缺失 LLM_NOT_CONFIGURED、
 * 多 provider 取第一个、全链路参数透传与流式生成器透出）、
 * HA 自动回退（默认关闭：deps 缺省/显式 false/探测抛错 → 主路由失败原样抛、零回退；
 * 开启：主 provider 失败 → 按配置序自下一个 provider 的 models[0] 缺省模型回退成功、
 * 全部失败 → LLM_PROVIDER_ERROR（detail.attempts 完整尝试链、顺序=配置序跳过当前）、
 * 模型未命中 → 自第一个 provider 回退、secret 缺失（LLM_NOT_CONFIGURED）记入尝试链、
 * stream:true 仅路由级失败参与回退、每次尝试经 logger.warn 审计）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  anthropicMessagesAdapter,
  filterProviderParams,
  LlmGateway,
  openaiChatAdapter,
  openaiResponsesAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmProviderConfig,
  type LlmStreamEvent,
} from '../src/kernel/llm/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- mock fetch 基建 ----------

/** 用内存 ReadableStream 合成 SSE 响应（frames 为完整 SSE 帧文本） */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

interface RecordedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** 可拦截 fetch：记录 url/headers/body，按 respond(url, body) 产出响应 */
function mockFetch(respond: (url: string, body: Record<string, unknown>) => Response) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, headers, body });
    return respond(url, body);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** 注入全局 fetch（adapter 在调用时构建 SDK client，会拾取 stub） */
function stubFetch(respond: (url: string, body: Record<string, unknown>) => Response): RecordedCall[] {
  const { fetchFn, calls } = mockFetch(respond);
  vi.stubGlobal('fetch', fetchFn);
  return calls;
}

// ---------- SSE 帧构造 ----------

/** openai chat.completion.chunk SSE 帧 */
function openAiChunk(model: string, extra: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1_700_000_000, model, ...extra })}\n\n`;
}

/** anthropic SSE 帧（anthropic SDK 依赖 event: 行路由事件类型） */
function anthropicEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

// ---------- 公共夹具 ----------

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    name: 'mock-provider',
    protocol: 'openai-chat',
    baseUrl: 'https://mock.local/v1',
    apiKeySecretRef: 'secret://llm/mock',
    models: ['model-under-test'],
    timeoutMs: 5_000,
    ...overrides,
  };
}

const CHAT_INPUT: LlmChatInput = {
  model: 'model-under-test',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ],
  maxTokens: 128,
  temperature: 0.2,
};

function makeGateway(
  providers: LlmProviderConfig[],
  secrets: Record<string, string | null> = { 'secret://llm/mock': 'sk-test' },
  haEnabled?: () => Promise<boolean>,
): LlmGateway {
  return new LlmGateway({
    getProviders: async () => providers,
    resolveSecret: async (ref) => secrets[ref] ?? null,
    logger: pino({ level: 'silent' }),
    ...(haEnabled !== undefined ? { haEnabled } : {}),
  });
}

async function collect(gen: AsyncGenerator<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// ---------- filterProviderParams ----------

describe('filterProviderParams — provider 参数白名单', () => {
  it('默认白名单（user/metadata）透传且返回拷贝', () => {
    const input: LlmChatInput = { ...CHAT_INPUT, providerParams: { user: 'u-1', metadata: { trace: 't-1' } } };
    const out = filterProviderParams(input, provider());
    expect(out).toEqual({ user: 'u-1', metadata: { trace: 't-1' } });
    expect(out).not.toBe(input.providerParams);
  });

  it('非白名单键 → LLM_PARAM_REJECTED，detail.rejected 列出全部被拒键', () => {
    const fn = () =>
      filterProviderParams(
        { ...CHAT_INPUT, providerParams: { user: 'u-1', echo: true, temperature_boost: 2 } },
        provider(),
      );
    expect(fn).toThrowError(HarnessError);
    let caught: unknown;
    try {
      fn();
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5004');
    expect(he.detail).toEqual({ rejected: ['echo', 'temperature_boost'] });
  });

  it('自定义 allowlist 生效；未配置 providerParams 返回空对象', () => {
    const cfg = provider({ paramAllowlist: ['session_id'] });
    expect(filterProviderParams({ ...CHAT_INPUT, providerParams: { session_id: 's-1' } }, cfg)).toEqual({
      session_id: 's-1',
    });
    expect(filterProviderParams(CHAT_INPUT, cfg)).toEqual({});
  });
});

// ---------- openai-chat adapter ----------

describe('openai-chat adapter — 非流式与消息互转', () => {
  it('非流式：text/usage 取自 choices[0]/usage，参数映射到 snake_case，Authorization 为 Bearer', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk-openai-test', {
      ...CHAT_INPUT,
      topP: 0.9,
      stop: ['END'],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    });
    expect(res.text).toBe('hello world');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://mock.local/v1/chat/completions');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-openai-test');
    expect(calls[0]?.body).toMatchObject({
      model: 'model-under-test',
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['END'],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    });
  });

  it('消息互转：assistant 富形状 toolCalls → tool_calls；tool 消息 → role:tool + tool_call_id', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
    );
    await openaiChatAdapter.chat(provider(), 'sk', {
      model: 'model-under-test',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: { text: 'checking', toolCalls: [{ id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' }] },
        },
        { role: 'tool', content: { toolCallId: 'call_1', text: 'sunny 20C' } },
      ],
    });
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"SF"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny 20C' },
    ]);
  });
});

describe('openai-chat adapter — 流式与错误包装', () => {
  it('流式：SSE 帧 → delta/tool_call_delta/done(usage)，请求携带 stream_options.include_usage', async () => {
    const frames = [
      openAiChunk('model-under-test', { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] }),
      openAiChunk('model-under-test', { choices: [{ index: 0, delta: { content: 'lo' } }] }),
      openAiChunk('model-under-test', {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 2, id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
          },
        ],
      }),
      openAiChunk('model-under-test', { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      openAiChunk('model-under-test', { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
      'data: [DONE]\n\n',
    ];
    const calls = stubFetch(() => sseResponse(frames));
    const events = await collect(openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT));

    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'tool_call_delta', index: 2, payload: expect.objectContaining({ id: 'call_9' }) },
      { type: 'done', usage: { inputTokens: 4, outputTokens: 2 } },
    ]);
    expect(calls[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('provider HTTP 错误 → HarnessError LLM_PROVIDER_ERROR（cause 为原始 SDK 错误）', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ error: { message: 'model not found', type: 'invalid_request_error' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    let caught: unknown;
    try {
      await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    expect(he.retryable).toBe(true);
    expect(he.message).toContain('model not found');
    expect(he.cause).toBeDefined();
  });
});

// ---------- openai-responses adapter ----------

describe('openai-responses adapter', () => {
  it('非流式：output_text/usage 正确，maxTokens 映射为 max_output_tokens', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'r1',
        object: 'response',
        status: 'completed',
        output_text: 'resp text',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'resp text' }] }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
    const res = await openaiResponsesAdapter.chat(provider(), 'sk-resp', CHAT_INPUT);
    expect(res.text).toBe('resp text');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(calls[0]?.url).toBe('https://mock.local/v1/responses');
    expect(calls[0]?.body).toMatchObject({ model: 'model-under-test', max_output_tokens: 128, temperature: 0.2 });
  });

  it('消息映射：system/user 直传，assistant toolCalls → function_call 项，tool → function_call_output', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ id: 'r1', object: 'response', status: 'completed', output_text: 'ok', output: [] }),
    );
    await openaiResponsesAdapter.chat(provider(), 'sk', {
      model: 'model-under-test',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: { text: 'checking', toolCalls: [{ id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' }] },
        },
        { role: 'tool', content: { toolCallId: 'call_1', text: 'sunny 20C' } },
      ],
    });
    expect(calls[0]?.body.input).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: 'checking' },
      { type: 'function_call', call_id: 'call_1', name: 'weather', arguments: '{"city":"SF"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny 20C' },
    ]);
  });

  it('流式：response.output_text.delta → delta，response.completed → done(usage)', async () => {
    stubFetch(() =>
      sseResponse([
        'data: {"type":"response.output_text.delta","delta":"Good"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" day"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":9,"output_tokens":3}}}\n\n',
      ]),
    );
    const events = await collect(openaiResponsesAdapter.stream(provider(), 'sk', CHAT_INPUT));
    expect(events).toEqual([
      { type: 'delta', text: 'Good' },
      { type: 'delta', text: ' day' },
      { type: 'done', usage: { inputTokens: 9, outputTokens: 3 } },
    ]);
  });
});

// ---------- anthropic-messages adapter ----------

describe('anthropic-messages adapter — 非流式', () => {
  it('system 消息提取为顶层 system 参数（messages 不含 system），text 块 join，认证走 x-api-key', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Bon' },
          { type: 'text', text: 'jour' },
        ],
        model: 'claude-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    const res = await anthropicMessagesAdapter.chat(
      provider({ protocol: 'anthropic-messages', baseUrl: 'https://anthropic.mock' }),
      'sk-anthropic-test',
      CHAT_INPUT,
    );
    expect(res.text).toBe('Bonjour');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    expect(calls[0]?.headers.get('x-api-key')).toBe('sk-anthropic-test');
    expect(calls[0]?.body.system).toBe('be brief');
    const messages = calls[0]?.body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('max_tokens 缺省 4096、显式覆盖生效；stop 映射为 stop_sequences', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await anthropicMessagesAdapter.chat(provider({ protocol: 'anthropic-messages' }), 'sk', {
      ...CHAT_INPUT,
      maxTokens: undefined,
      stop: ['END'],
    });
    expect(calls[0]?.body.max_tokens).toBe(4096);
    expect(calls[0]?.body.stop_sequences).toEqual(['END']);

    await anthropicMessagesAdapter.chat(provider({ protocol: 'anthropic-messages' }), 'sk', {
      ...CHAT_INPUT,
      maxTokens: 77,
    });
    expect(calls[1]?.body.max_tokens).toBe(77);
  });

  it('tool 消息 → user 角色 tool_result 块；assistant toolCalls → tool_use 块（arguments 反序列化为 input）', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await anthropicMessagesAdapter.chat(provider({ protocol: 'anthropic-messages' }), 'sk', {
      model: 'model-under-test',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: { text: 'checking', toolCalls: [{ id: 'toolu_1', name: 'weather', arguments: '{"city":"SF"}' }] },
        },
        { role: 'tool', content: { toolCallId: 'toolu_1', text: 'sunny 20C' } },
      ],
    });
    expect(calls[0]?.body.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'SF' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny 20C' }] },
    ]);
  });
});

describe('anthropic-messages adapter — 流式', () => {
  it('content_block_delta(text_delta) → delta；message_start/message_delta 聚合为 done(usage)', async () => {
    stubFetch(() =>
      sseResponse([
        anthropicEvent('message_start', {
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            usage: { input_tokens: 6, output_tokens: 1 },
          },
        }),
        anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Bon' } }),
        anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'jour' } }),
        anthropicEvent('content_block_stop', { index: 0 }),
        anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
        anthropicEvent('message_stop', {}),
      ]),
    );
    const events = await collect(anthropicMessagesAdapter.stream(provider({ protocol: 'anthropic-messages' }), 'sk', CHAT_INPUT));
    expect(events).toEqual([
      { type: 'delta', text: 'Bon' },
      { type: 'delta', text: 'jour' },
      { type: 'done', usage: { inputTokens: 6, outputTokens: 5 } },
    ]);
  });
});

// ---------- LlmGateway 路由 ----------

describe('LlmGateway — 路由与配置解析', () => {
  it('无 provider 声明该模型 → LLM_MODEL_NOT_FOUND（detail.model）', async () => {
    const gw = makeGateway([provider({ models: ['other-model'] })]);
    let caught: unknown;
    try {
      await gw.chat(CHAT_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe('HARNESS-5003');
    expect((caught as HarnessError).detail).toEqual({ model: 'model-under-test' });
  });

  it('provider 命中但 secret 解析为 null → LLM_NOT_CONFIGURED（detail.provider）', async () => {
    const gw = makeGateway([provider()], {});
    let caught: unknown;
    try {
      await gw.chat(CHAT_INPUT);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe('HARNESS-5001');
    expect((caught as HarnessError).detail).toEqual({ provider: 'mock-provider' });
  });

  it('命中 provider：全链路透传 providerParams（白名单内）与 Bearer 密钥', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const gw = makeGateway([provider()], { 'secret://llm/mock': 'sk-live-key' });
    const res = (await gw.chat({ ...CHAT_INPUT, providerParams: { user: 'u-9' } })) as LlmChatResult;
    expect(res.text).toBe('pong');
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-live-key');
    expect(calls[0]?.body.user).toBe('u-9');
  });

  it('stream:true → 透出 AsyncGenerator 并可消费事件', async () => {
    stubFetch(() =>
      sseResponse([
        openAiChunk('model-under-test', { choices: [{ index: 0, delta: { content: 'hi' } }] }),
        openAiChunk('model-under-test', { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const gw = makeGateway([provider()]);
    const result = await gw.chat({ ...CHAT_INPUT, stream: true });
    expect(typeof (result as AsyncGenerator<LlmStreamEvent>)[Symbol.asyncIterator]).toBe('function');
    const events = await collect(result as AsyncGenerator<LlmStreamEvent>);
    expect(events).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it('多个 provider 声明同一模型 → 取第一个（按其协议路由）', async () => {
    const calls = stubFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-first' }, finish_reason: 'stop' }],
      }),
    );
    const first = provider({ name: 'p1', models: ['shared-model'] });
    const second = provider({ name: 'p2', protocol: 'anthropic-messages', baseUrl: 'https://anthropic.mock', models: ['shared-model'] });
    const gw = makeGateway([first, second], {
      'secret://llm/mock': 'sk',
      'secret://anthropic': 'sk-a',
    });
    const res = (await gw.chat({ model: 'shared-model', messages: [{ role: 'user', content: 'x' }] })) as LlmChatResult;
    expect(res.text).toBe('from-first');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://mock.local/v1/chat/completions');
  });
});

// ---------- LlmChatResult.toolCalls — 非流式结构化工具调用提取 ----------

describe('LlmChatResult.toolCalls — 三协议非流式结构化提取', () => {
  it('openai-chat：message.tool_calls(function) → {id,name,argsJson}；非 function 类型跳过；content null → 空文本', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
                { id: 'call_2', type: 'custom', custom: { name: 'weird' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', argsJson: '{"q":"x"}' }]);
  });

  it('openai-chat：无 tool_calls → 结果不带 toolCalls 键（既有字段零破坏）', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
      }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('plain');
    expect('toolCalls' in res).toBe(false);
  });

  it('openai-responses：output[] 中 function_call 项 → {id:call_id,name,argsJson}', async () => {
    stubFetch(() =>
      jsonResponse({
        id: 'r1',
        object: 'response',
        status: 'completed',
        output_text: '',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'let me check' }] },
          { type: 'function_call', call_id: 'fc_1', name: 'cron_list', arguments: '{"limit":5}' },
          { type: 'function_call', call_id: 'fc_2', name: 'system_info', arguments: '{}' },
        ],
        usage: { input_tokens: 4, output_tokens: 3 },
      }),
    );
    const res = await openaiResponsesAdapter.chat(provider({ protocol: 'openai-responses' }), 'sk', CHAT_INPUT);
    expect(res.text).toBe('let me check');
    expect(res.toolCalls).toEqual([
      { id: 'fc_1', name: 'cron_list', argsJson: '{"limit":5}' },
      { id: 'fc_2', name: 'system_info', argsJson: '{}' },
    ]);
  });

  it('anthropic-messages：content[] 中 tool_use 块 → {id,name,argsJson}（input 对象序列化）', async () => {
    stubFetch(() =>
      jsonResponse({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'SF' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 4 },
      }),
    );
    const res = await anthropicMessagesAdapter.chat(provider({ protocol: 'anthropic-messages' }), 'sk', CHAT_INPUT);
    expect(res.text).toBe('checking');
    expect(res.toolCalls).toEqual([{ id: 'toolu_1', name: 'weather', argsJson: '{"city":"SF"}' }]);
  });

  it('LlmGateway.chat 全链路透传 toolCalls（openai-chat provider）', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const gw = makeGateway([provider()]);
    const res = (await gw.chat(CHAT_INPUT)) as LlmChatResult;
    expect(res.toolCalls).toEqual([{ id: 'call_9', name: 'lookup', argsJson: '{}' }]);
  });
});

// ---------- LlmGateway — HA 自动回退（默认关闭） ----------

describe('LlmGateway — HA 自动回退（默认关闭）', () => {
  const HA_INPUT: LlmChatInput = { model: 'm1', messages: [{ role: 'user', content: 'hi' }] };
  const HA_SECRETS = {
    'secret://llm/p1': 'sk-1',
    'secret://llm/p2': 'sk-2',
    'secret://llm/p3': 'sk-3',
  };

  function haProvider(name: string, models: string[]): LlmProviderConfig {
    return provider({ name, baseUrl: `https://${name}.local/v1`, apiKeySecretRef: `secret://llm/${name}`, models });
  }

  function upstreamFail(): Response {
    return new Response(JSON.stringify({ error: { message: 'upstream down' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  function upstreamOk(text: string): Response {
    return jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    });
  }

  it('HA 关闭（deps 缺省未注入 haEnabled）→ 主 provider 失败原样抛 LLM_PROVIDER_ERROR，零回退', async () => {
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], HA_SECRETS);
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    expect(he.retryable).toBe(true);
    // 未回退：只打了主 provider 一次
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://p1.local/v1/chat/completions');
  });

  it('HA 关闭（haEnabled()===false）→ 同样保持单 provider 语义，原样抛不回退', async () => {
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], HA_SECRETS, async () => false);
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    expect((caught as HarnessError).code).toBe('HARNESS-5002');
    expect(calls).toHaveLength(1);
  });

  it('HA 开启 → 主 provider 上游失败 → 自动切下一 provider 的缺省模型成功（两次 fetch 上游）', async () => {
    const calls = stubFetch((url) => (url.startsWith('https://p1.local') ? upstreamFail() : upstreamOk('from-p2')));
    const gw = makeGateway(
      [haProvider('p1', ['m1']), haProvider('p2', ['m2', 'm2b'])],
      HA_SECRETS,
      async () => true,
    );
    const res = (await gw.chat(HA_INPUT)) as LlmChatResult;
    expect(res.text).toBe('from-p2');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://p1.local/v1/chat/completions');
    // 回退尝试用 provider2 的 models[0] 缺省模型 + 该 provider 自己的密钥
    expect(calls[1]?.url).toBe('https://p2.local/v1/chat/completions');
    expect(calls[1]?.body.model).toBe('m2');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer sk-2');
  });

  it('HA 开启 → 全部 provider 失败 → LLM_PROVIDER_ERROR，detail.attempts 为完整尝试链（配置序）', async () => {
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway(
      [haProvider('p1', ['m1']), haProvider('p2', ['m2']), haProvider('p3', ['m3'])],
      HA_SECRETS,
      async () => true,
    );
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    expect(he.detail).toEqual({
      model: 'm1',
      attempts: [
        { provider: 'p1', model: 'm1', error: { code: 'HARNESS-5002', message: expect.any(String) } },
        { provider: 'p2', model: 'm2', error: { code: 'HARNESS-5002', message: expect.any(String) } },
        { provider: 'p3', model: 'm3', error: { code: 'HARNESS-5002', message: expect.any(String) } },
      ],
    });
    expect(calls).toHaveLength(3);
  });

  it('attempt 顺序 = 配置序且跳过当前模型所在 provider 之前的候选（m2 命中 p2 → 只试 p2/p3）', async () => {
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway(
      [haProvider('p1', ['m1']), haProvider('p2', ['m2']), haProvider('p3', ['m3'])],
      HA_SECRETS,
      async () => true,
    );
    let caught: unknown;
    try {
      await gw.chat({ ...HA_INPUT, model: 'm2' });
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    const attempts = (he.detail as { attempts: Array<{ provider: string }> }).attempts;
    expect(attempts.map((a) => a.provider)).toEqual(['p2', 'p3']);
    expect(calls.map((c) => c.url)).toEqual(['https://p2.local/v1/chat/completions', 'https://p3.local/v1/chat/completions']);
  });

  it('HA 开启 → 模型未在任何 provider 声明 → 自第一个 provider 的缺省模型回退成功（非 LLM_MODEL_NOT_FOUND）', async () => {
    const calls = stubFetch(() => upstreamOk('from-p1-default'));
    const gw = makeGateway([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], HA_SECRETS, async () => true);
    const res = (await gw.chat({ ...HA_INPUT, model: 'no-such-model' })) as LlmChatResult;
    expect(res.text).toBe('from-p1-default');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe('m1');
  });

  it('HA 开启 → 主 provider secret 缺失（LLM_NOT_CONFIGURED）记入尝试链并继续回退到下一个', async () => {
    // p1 密钥不可解析（不发起 fetch）；p2/p3 上游 500 → 尝试链 [5001, 5002, 5002]
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway(
      [haProvider('p1', ['m1']), haProvider('p2', ['m2']), haProvider('p3', ['m3'])],
      { 'secret://llm/p2': 'sk-2', 'secret://llm/p3': 'sk-3' },
      async () => true,
    );
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    expect(he.detail).toEqual({
      model: 'm1',
      attempts: [
        { provider: 'p1', model: 'm1', error: { code: 'HARNESS-5001', message: expect.stringContaining('secret://llm/p1') } },
        { provider: 'p2', model: 'm2', error: { code: 'HARNESS-5002', message: expect.any(String) } },
        { provider: 'p3', model: 'm3', error: { code: 'HARNESS-5002', message: expect.any(String) } },
      ],
    });
    // p1 密钥缺失不发起上游请求：只有 p2/p3 两次 fetch
    expect(calls).toHaveLength(2);
  });

  it('HA 开启但 haEnabled() 自身抛错 → 视为关闭（原样抛，不回退）', async () => {
    const calls = stubFetch(() => upstreamFail());
    const gw = makeGateway([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], HA_SECRETS, async () => {
      throw new Error('settings read exploded');
    });
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    expect((caught as HarnessError).code).toBe('HARNESS-5002');
    expect(calls).toHaveLength(1);
  });

  it('HA 开启 → stream:true 主 provider 正常 → 生成器直接透出（回退不干预流式）', async () => {
    const calls = stubFetch(() =>
      sseResponse([
        openAiChunk('m1', { choices: [{ index: 0, delta: { content: 'hi' } }] }),
        openAiChunk('m1', { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        'data: [DONE]\n\n',
      ]),
    );
    const gw = makeGateway([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], HA_SECRETS, async () => true);
    const result = await gw.chat({ ...HA_INPUT, stream: true });
    const events = await collect(result as AsyncGenerator<LlmStreamEvent>);
    expect(events).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://p1.local/v1/chat/completions');
  });

  it('HA 开启 → stream:true 主 provider secret 缺失（路由级失败）→ 回退到下一 provider 的流', async () => {
    const calls = stubFetch(() =>
      sseResponse([
        openAiChunk('m2', { choices: [{ index: 0, delta: { content: 'p2-hello' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    const gw = makeGateway(
      [haProvider('p1', ['m1']), haProvider('p2', ['m2'])],
      { 'secret://llm/p2': 'sk-2' },
      async () => true,
    );
    const result = await gw.chat({ ...HA_INPUT, stream: true });
    const events = await collect(result as AsyncGenerator<LlmStreamEvent>);
    expect(events).toEqual([{ type: 'delta', text: 'p2-hello' }, { type: 'done' }]);
    // 回退流使用 provider2 的缺省模型与端点；p1 因密钥缺失未发起 fetch
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://p2.local/v1/chat/completions');
    expect(calls[0]?.body.model).toBe('m2');
  });

  it('每次回退尝试经 logger.warn 审计（begin → succeeded / begin → failed）', async () => {
    stubFetch((url) => (url.startsWith('https://p1.local') ? upstreamFail() : upstreamOk('from-p2')));
    const warn = vi.fn();
    const gw = new LlmGateway({
      getProviders: async () => [haProvider('p1', ['m1']), haProvider('p2', ['m2'])],
      resolveSecret: async (ref) => HA_SECRETS[ref] ?? null,
      logger: { debug: vi.fn(), warn } as unknown as import('pino').Logger,
      haEnabled: async () => true,
    });
    const res = (await gw.chat(HA_INPUT)) as LlmChatResult;
    expect(res.text).toBe('from-p2');
    const messages = warn.mock.calls.map((c) => c[1] as string);
    expect(messages).toEqual([
      'llm gateway: primary provider failed; HA failover begins',
      'llm gateway: HA failover succeeded',
    ]);
  });

  it('HA 开启 → 回退链上无 models 的 provider 记入尝试链（合成 5003）并被跳过；getProviders 透出配置目录', async () => {
    const calls = stubFetch(() => upstreamFail());
    const noModels = haProvider('p2', []);
    const gw = makeGateway(
      [haProvider('p1', ['m1']), noModels, haProvider('p3', ['m3'])],
      HA_SECRETS,
      async () => true,
    );
    expect(await gw.getProviders()).toHaveLength(3);
    let caught: unknown;
    try {
      await gw.chat(HA_INPUT);
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    expect(he.detail).toEqual({
      model: 'm1',
      attempts: [
        { provider: 'p1', model: 'm1', error: { code: 'HARNESS-5002', message: expect.any(String) } },
        { provider: 'p2', model: '', error: { code: 'HARNESS-5003', message: expect.stringContaining('no models') } },
        { provider: 'p3', model: 'm3', error: { code: 'HARNESS-5002', message: expect.any(String) } },
      ],
    });
    // 无 models 的 provider 不发起上游请求：只有 p1/p3 两次 fetch
    expect(calls).toHaveLength(2);
  });

  it('未知协议（配置脏数据）→ TypeError 原样抛，HA 开启也不回退（保持改动前失败面）', async () => {
    const calls = stubFetch(() => upstreamOk('should-not-happen'));
    const badProtocol = {
      name: 'p1',
      protocol: 'not-a-protocol',
      baseUrl: 'https://p1.local/v1',
      apiKeySecretRef: 'secret://llm/p1',
      models: ['m1'],
    } as unknown as LlmProviderConfig;
    const gw = makeGateway([badProtocol, haProvider('p2', ['m2'])], HA_SECRETS, async () => true);
    await expect(gw.chat(HA_INPUT)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
