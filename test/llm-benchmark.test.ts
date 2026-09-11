/**
 * LLM 对话链路行业标杆优化 — 四条线基准测试（全 mock，不发真实网络）。
 *
 * 覆盖：
 * - A 兼容层：normalizeBaseUrl 各形态、<think> 剥离（非流式/流式跨 delta）、streamOptions
 *   开关、reasoning_content 工具轮回写（空串也带 key）；
 * - B 网络自适应：ProviderHealthRegistry 断路器（3 连败冷却/成功清零/指数递增封顶/时钟注入）、
 *   空流守卫错误计入健康、failover 跳过冷却 provider（全冷却照试）、尝试间抖动退避；
 * - C 上下文维护：工具结果 >32KB 溢出落盘（信封/截断降级/路径净化）、micro 压缩确定性
 *   与水位线（ContextBudget 边界一旦固定不再漂移，前缀逐字节稳定）；
 * - D 缓存命中：prompt_cache_key 携带与开关（不经参数白名单）、runner 透传 sessionKey、
 *   anthropic system/最后 user 消息 cache_control 断点。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  anthropicMessagesAdapter,
  createThinkStripper,
  extractThinkContent,
  jitteredFailoverDelayMs,
  LlmGateway,
  normalizeBaseUrl,
  openaiChatAdapter,
  ProviderHealthRegistry,
  type LlmChatInput,
  type LlmChatResult,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmStreamEvent,
} from '../src/kernel/llm/index.js';
import { ContextBudget, applyContextBudget } from '../src/kernel/agents/context-budget.js';
import { runAgentLoop, type AgentLoopDeps, type AgentLoopInput, type AgentLoopToolRuntime } from '../src/kernel/agents/runner.js';

const logger = pino({ level: 'silent' });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- mock fetch 基建（与 llm-gateway.test.ts 同款） ----------

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

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(respond: (url: string, body: Record<string, unknown>) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    calls.push({ url, headers: new Headers(init?.headers), body });
    return respond(url, body);
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchFn);
  return calls;
}

function openAiChunk(model: string, extra: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1_700_000_000, model, ...extra })}\n\n`;
}

function anthropicEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    name: 'mock-provider',
    protocol: 'openai-chat',
    baseUrl: 'https://mock.local/v1',
    apiKeySecretRef: 'secret://llm/mock',
    models: ['model-under-test'],
    timeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  };
}

const CHAT_INPUT: LlmChatInput = {
  model: 'model-under-test',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
  ],
};

async function collect(gen: AsyncGenerator<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// =========================================================================
// A1 normalizeBaseUrl
// =========================================================================

describe('A1 — normalizeBaseUrl（baseUrl 规范化）', () => {
  it('无协议前缀 → 补 https://', () => {
    expect(normalizeBaseUrl('mock.local/v1')).toBe('https://mock.local/v1');
    expect(normalizeBaseUrl('10.0.0.3:8000/api')).toBe('https://10.0.0.3:8000/api');
  });

  it('以 /chat/completions 结尾 → 剥掉（用户常把完整端点当 baseUrl），含尾斜杠形态', () => {
    expect(normalizeBaseUrl('https://x.cn/v1/chat/completions')).toBe('https://x.cn/v1');
    expect(normalizeBaseUrl('https://x.cn/v1/chat/completions/')).toBe('https://x.cn/v1');
    expect(normalizeBaseUrl('https://x.cn/CHAT/COMPLETIONS')).toBe('https://x.cn');
  });

  it('不自动补 /v1（国内网关路径各异：/paas/v4、/compatible-mode/v1、无版本后缀）', () => {
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(normalizeBaseUrl('https://api.host.com')).toBe('https://api.host.com');
  });

  it('trim + 去尾部斜杠；http:// 显式协议保留', () => {
    expect(normalizeBaseUrl('  https://a.b/v1/  ')).toBe('https://a.b/v1');
    expect(normalizeBaseUrl('http://localhost:8080/')).toBe('http://localhost:8080');
  });

  it('空串归空串；已规范 URL 原样（幂等）', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('https://a.b/v1')).toBe('https://a.b/v1');
    expect(normalizeBaseUrl(normalizeBaseUrl('mock.local/v1/chat/completions'))).toBe('https://mock.local/v1');
  });

  it('adapter clientOf 应用规范化：配置缺协议/带端点尾巴 → 实际请求 URL 已纠正', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(provider({ baseUrl: 'mock.local/v1/chat/completions' }), 'sk', CHAT_INPUT);
    expect(calls[0]?.url).toBe('https://mock.local/v1/chat/completions');
  });
});

// =========================================================================
// A2 <think> 剥离
// =========================================================================

describe('A2 — <think> 剥离（非流式）', () => {
  it('think 块 → reasoning，正文剥离（不进 text），正文前导空白吃掉', async () => {
    stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: '<think>让我想想</think>\n\n答案是 4' } }] }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('答案是 4');
    expect(res.reasoning).toBe('让我想想');
  });

  it('EOF 未闭合 think（截断输出）→ 整段归 reasoning，正文为空', async () => {
    stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: '<think>想了一半就被截断' } }] }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('');
    expect(res.reasoning).toBe('想了一半就被截断');
  });

  it('reasoning_content 字段优先于正文 think 块（显式约定 > 正文启发式）', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: '<think>正文里的思考</think>结果', reasoning_content: '字段里的思考' } }],
      }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('结果');
    expect(res.reasoning).toBe('字段里的思考');
  });

  it('无 think 时正文原样、无 reasoning 键（零破坏）', async () => {
    stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'plain text' } }] }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.text).toBe('plain text');
    expect('reasoning' in res).toBe(false);
  });

  it('extractThinkContent 纯函数：多块按序拼接；先文后块正文保留', () => {
    expect(extractThinkContent('<think>a</think>x<think>b</think>y')).toEqual({ text: 'xy', reasoning: 'ab' });
    expect(extractThinkContent('no tags')).toEqual({ text: 'no tags', reasoning: '' });
  });
});

describe('A2 — <think> 剥离（流式跨 delta 状态机）', () => {
  it('开/闭标签被拆在多个 delta → 思考分流 reasoning_delta、正文 delta（顺序保持）', async () => {
    const frames = [
      openAiChunk('m', { choices: [{ index: 0, delta: { content: '前缀<th' } }] }),
      openAiChunk('m', { choices: [{ index: 0, delta: { content: 'ink>思考A</th' } }] }),
      openAiChunk('m', { choices: [{ index: 0, delta: { content: 'ink>后缀' } }] }),
      openAiChunk('m', { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ];
    stubFetch(() => sseResponse(frames));
    const events = await collect(openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT));
    expect(events).toEqual([
      { type: 'delta', text: '前缀' },
      { type: 'reasoning_delta', text: '思考A' },
      { type: 'delta', text: '后缀' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it('无 think 的普通流：delta 原样透传（逐帧），不受状态机影响', async () => {
    const frames = [
      openAiChunk('m', { choices: [{ index: 0, delta: { content: 'Hello <world> ' } }] }),
      openAiChunk('m', { choices: [{ index: 0, delta: { content: 'a < b' } }] }),
    ];
    stubFetch(() => sseResponse(frames));
    const events = await collect(openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT));
    expect(events.filter((e) => e.type === 'delta')).toEqual([
      { type: 'delta', text: 'Hello <world> ' },
      { type: 'delta', text: 'a < b' },
    ]);
  });

  it('ThinkStripper 单元：标签逐字符拆分安全 + flush 残余归位', () => {
    // '<think>' 按 2 字符步进拆分
    const s1 = createThinkStripper();
    let text = '';
    let reasoning = '';
    for (let i = 0; i < '<think>思考'.length; i += 2) {
      const out = s1.push('<think>思考'.slice(i, i + 2));
      text += out.text;
      reasoning += out.reasoning;
    }
    const f1 = s1.flush();
    expect(text + f1.text).toBe('');
    expect(reasoning + f1.reasoning).toBe('思考');

    // 未闭合 flush：残余缓冲按当前状态归入 reasoning
    const s2 = createThinkStripper();
    let text2 = '';
    let reasoning2 = '';
    for (const piece of ['<think>', '未闭合残余']) {
      const out = s2.push(piece);
      text2 += out.text;
      reasoning2 += out.reasoning;
    }
    const f2 = s2.flush();
    expect(text2 + f2.text).toBe('');
    expect(reasoning2 + f2.reasoning).toBe('未闭合残余');

    // 文本态 flush：半个潜在标签是字面正文
    const s3 = createThinkStripper();
    let text3 = '';
    const p3 = s3.push('2 <');
    text3 += p3.text;
    const f3 = s3.flush();
    expect(text3 + f3.text).toBe('2 <');
    expect(f3.reasoning).toBe('');
  });

  it('think 剥离与工具标记恢复组合：think 里的标记样例不触发恢复、正文标记正常恢复', async () => {
    stubFetch(() =>
      jsonResponse({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content:
              '<think>可以用 <tool_call>{"name":"x","arguments":{}}</tool_call> 这种形式</think>' +
              '正文\n<tool_call>{"name":"lookup","arguments":{"q":1}}</tool_call>',
          },
        }],
      }),
    );
    const res = await openaiChatAdapter.chat(provider(), 'sk', CHAT_INPUT);
    expect(res.reasoning).toContain('这种形式');
    // 仅正文标记被恢复（id 由恢复层随机生成）；think 内的样例不产生第二个调用
    expect(res.toolCalls).toEqual([{ id: expect.any(String), name: 'lookup', argsJson: '{"q":1}' }]);
    expect(res.text).not.toContain('<tool_call>');
    expect(res.text).toContain('正文');
  });
});

// =========================================================================
// A3 stream_options 开关
// =========================================================================

describe('A3 — streamOptions 兼容开关', () => {
  it('缺省（true）→ 流式请求带 stream_options.include_usage', async () => {
    const calls = stubFetch(() =>
      sseResponse([
        openAiChunk('m', { choices: [{ index: 0, delta: { content: 'x' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    await collect(openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT));
    expect(calls[0]?.body.stream_options).toEqual({ include_usage: true });
    expect(calls[0]?.body.stream).toBe(true);
  });

  it('streamOptions:false → 请求不带 stream_options 键（部分网关校验未知键 400）', async () => {
    const calls = stubFetch(() =>
      sseResponse([
        openAiChunk('m', { choices: [{ index: 0, delta: { content: 'x' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    await collect(openaiChatAdapter.stream(provider({ streamOptions: false }), 'sk', CHAT_INPUT));
    expect('stream_options' in calls[0]?.body).toBe(false);
    expect(calls[0]?.body.stream).toBe(true);
  });
});

// =========================================================================
// A4 reasoning_content 工具轮回写
// =========================================================================

describe('A4 — reasoning_content 工具轮回写（DeepSeek/LongCat 硬要求）', () => {
  const richInput = (reasoning: string | undefined): LlmChatInput => ({
    model: 'model-under-test',
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: {
          ...(reasoning === undefined ? {} : { reasoning }),
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: '{}' }],
        },
      },
      { role: 'tool', content: { toolCallId: 'call_1', text: 'result' } },
    ],
  });

  it('assistant 富形状 reasoning 为空串 → SDK 请求仍写 reasoning_content: \'\'（丢思考也带 key）', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(provider(), 'sk', richInput(''));
    const messages = calls[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      reasoning_content: '',
    });
  });

  it('reasoning 非空 → reasoning_content 原样回写', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(provider(), 'sk', richInput('上一轮思考链'));
    const messages = calls[0]?.body.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.reasoning_content).toBe('上一轮思考链');
  });

  it('纯字符串 assistant / user 消息不写该键；runner 工具轮恒带 reasoning 字段', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(provider(), 'sk', {
      model: 'model-under-test',
      messages: [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: { text: 'plain', toolCalls: [{ id: 'c', name: 'n', arguments: '{}' }] } },
      ],
    });
    const messages = calls[0]?.body.messages as Array<Record<string, unknown>>;
    expect('reasoning_content' in (messages[0] as object)).toBe(false);
    expect('reasoning_content' in (messages[1] as object)).toBe(false);

    // runner 侧：assistant 富形状恒携带 reasoning（无思考轮为空串）
    const chatCalls: LlmChatInput[] = [];
    const tools: AgentLoopToolRuntime = { listSchemas: () => [], execute: async () => ({}) };
    await runAgentLoop(
      {
        gateway: {
          chat: async (input: LlmChatInput) => {
            chatCalls.push(structuredClone(input));
            if (chatCalls.length === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'n', argsJson: '{}' }] };
            return { text: 'done' };
          },
        },
        tools,
        logger,
        sleep: async () => {},
      },
      { agentId: 'a', depth: 0, prompt: 'p', model: 'model-under-test' },
    );
    const secondCallMessages = chatCalls[1]?.messages as Array<{ content: Record<string, unknown> }>;
    expect(secondCallMessages[2]?.content).toMatchObject({ toolCalls: [{ id: 'c1' }], reasoning: '' });
  });
});

// =========================================================================
// B1 ProviderHealthRegistry 断路器
// =========================================================================

describe('B1 — ProviderHealthRegistry 断路器', () => {
  it('3 连败 → 进入冷却（cooldownUntil = now + 30s）；不足 3 次不冷却', () => {
    let now = 1_000_000;
    const reg = new ProviderHealthRegistry({ now: () => now });
    reg.recordFailure('p');
    reg.recordFailure('p');
    expect(reg.isCoolingDown('p')).toBe(false);
    reg.recordFailure('p');
    expect(reg.isCoolingDown('p')).toBe(true);
    expect(reg.stat('p').cooldownUntil).toBe(1_000_000 + 30_000);
    expect(reg.stat('p').consecutiveFailures).toBe(3);
  });

  it('成功 → 连续失败清零、冷却解除', () => {
    let now = 1_000_000;
    const reg = new ProviderHealthRegistry({ now: () => now });
    reg.recordFailure('p');
    reg.recordFailure('p');
    reg.recordFailure('p');
    expect(reg.isCoolingDown('p')).toBe(true);
    reg.recordSuccess('p');
    expect(reg.isCoolingDown('p')).toBe(false);
    expect(reg.stat('p').consecutiveFailures).toBe(0);
    expect(reg.stat('p').cooldownUntil).toBeNull();
    expect(reg.stat('p')).toMatchObject({ total: 4, ok: 1, fail: 3 });
  });

  it('指数递增：第 4/5/6/7 次连败冷却 60s/120s/240s/封顶 300s', () => {
    let now = 1_000_000;
    const reg = new ProviderHealthRegistry({ now: () => now });
    reg.recordFailure('p'); // 1
    reg.recordFailure('p'); // 2
    reg.recordFailure('p'); // 3 → 30s
    expect(reg.stat('p').cooldownUntil).toBe(1_030_000);
    now += 60_000; // 冷却到期后再败
    reg.recordFailure('p'); // 4 → 60s
    expect(reg.stat('p').cooldownUntil).toBe(1_060_000 + 60_000);
    now += 120_000;
    reg.recordFailure('p'); // 5 → 120s
    expect(reg.stat('p').cooldownUntil).toBe(1_180_000 + 120_000);
    now += 240_000;
    reg.recordFailure('p'); // 6 → 240s
    expect(reg.stat('p').cooldownUntil).toBe(1_420_000 + 240_000);
    now += 300_000;
    reg.recordFailure('p'); // 7 → 480s 封顶 300s
    expect(reg.stat('p').cooldownUntil).toBe(1_720_000 + 300_000);
  });

  it('时钟注入：冷却到期自动恢复可用（无真实等待）', () => {
    let now = 0;
    const reg = new ProviderHealthRegistry({ now: () => now });
    reg.recordFailure('p');
    reg.recordFailure('p');
    reg.recordFailure('p');
    expect(reg.isAvailable('p')).toBe(false);
    now = 30_001;
    expect(reg.isAvailable('p')).toBe(true);
  });

  it('snapshot：按名称排序的全量概要；未记录 provider 返回全零形状', () => {
    let now = 5;
    const reg = new ProviderHealthRegistry({ now: () => now });
    reg.recordSuccess('b');
    reg.recordFailure('a');
    reg.recordFailure('a');
    const snap = reg.snapshot();
    expect(snap.map((s) => s.name)).toEqual(['a', 'b']);
    expect(snap[0]).toMatchObject({ name: 'a', total: 2, ok: 0, fail: 2, consecutiveFailures: 2, lastFailureAt: 5, cooldownUntil: null });
    expect(snap[1]).toMatchObject({ name: 'b', total: 1, ok: 1, fail: 0 });
    expect(reg.stat('never-seen')).toEqual({
      name: 'never-seen', total: 0, ok: 0, fail: 0, consecutiveFailures: 0, lastFailureAt: null, cooldownUntil: null,
    });
  });
});

// =========================================================================
// B2 空流/空响应计入健康统计
// =========================================================================

describe('B2 — 空流/空响应守卫计入失败', () => {
  it('零 chunk 空流重试 3 次后 → LLM_PROVIDER_ERROR（detail.kind empty-stream），网关记 fail', async () => {
    const calls = stubFetch(() => sseResponse([])); // 200 + 零 chunk
    const health = new ProviderHealthRegistry({ now: () => 0 });
    const gw = new LlmGateway({
      getProviders: async () => [provider()],
      resolveSecret: async () => 'sk',
      logger,
      health,
      sleep: async () => {},
    });
    let caught: unknown;
    try {
      await collect((await gw.chat({ ...CHAT_INPUT, stream: true })) as AsyncGenerator<LlmStreamEvent>);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).detail).toMatchObject({ kind: 'empty-stream' });
    expect(calls).toHaveLength(3); // 3 次 attempt 全部零 chunk
    expect(health.stat('mock-provider')).toMatchObject({ fail: 1, ok: 0 });
  });

  it('非流式 empty-body（200 空 body）→ LLM_PROVIDER_ERROR 保留 detail.kind；500 失败/成功均正确记账', async () => {
    let mode = 'empty';
    const calls = stubFetch(() => {
      if (mode === 'empty') return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
      if (mode === 'fail') return jsonResponse({ error: { message: 'upstream 500' } }, { status: 500 });
      return jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] });
    });
    const health = new ProviderHealthRegistry({ now: () => 0 });
    const gw = new LlmGateway({
      getProviders: async () => [provider()],
      resolveSecret: async () => 'sk',
      logger,
      health,
      sleep: async () => {},
    });
    // HA 关闭：原始错误原样抛
    await expect(gw.chat(CHAT_INPUT) as Promise<LlmChatResult>).rejects.toMatchObject({ code: 'HARNESS-5002' });
    expect(calls).toHaveLength(1);
    mode = 'ok';
    await gw.chat(CHAT_INPUT);
    expect(health.stat('mock-provider')).toMatchObject({ total: 2, ok: 1, fail: 1, consecutiveFailures: 0 });
    // 500 → LLM_PROVIDER_ERROR（kind 由 SDK 错误路径包装，无 kind 但错误码命中）
    mode = 'fail';
    await expect(gw.chat(CHAT_INPUT) as Promise<LlmChatResult>).rejects.toMatchObject({ code: 'HARNESS-5002' });
    expect(health.stat('mock-provider')).toMatchObject({ total: 3, ok: 1, fail: 2, consecutiveFailures: 1 });
  });
});

// =========================================================================
// B3 failover 跳过冷却 provider
// =========================================================================

describe('B3 — HA failover 冷却跳过', () => {
  function haProvider(name: string, models: string[]): LlmProviderConfig {
    return provider({ name, baseUrl: `https://${name}.local/v1`, apiKeySecretRef: `secret://llm/${name}`, models });
  }
  const SECRETS = { 'secret://llm/p1': 'sk1', 'secret://llm/p2': 'sk2' };
  const upstreamFail = (): Response => jsonResponse({ error: { message: 'down' } }, { status: 500 });
  const ok = (text: string): Response =>
    jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: text } }] });

  function makeGw(providers: LlmProviderConfig[], health: ProviderHealthRegistry): LlmGateway {
    return new LlmGateway({
      getProviders: async () => providers,
      resolveSecret: async (ref) => (SECRETS as Record<string, string>)[ref] ?? null,
      logger,
      health,
      haEnabled: async () => true,
      sleep: async () => {},
    });
  }

  it('failover 候选中冷却中的 provider 被跳过（不发请求、不进尝试链）', async () => {
    const calls = stubFetch(() => upstreamFail());
    const health = new ProviderHealthRegistry({ now: () => 0 });
    health.recordFailure('p2');
    health.recordFailure('p2');
    health.recordFailure('p2'); // p2 冷却中
    const gw = makeGw([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], health);
    let caught: unknown;
    try {
      await gw.chat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      caught = e;
    }
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-5002');
    const attempts = (he.detail as { attempts: Array<{ provider: string }> }).attempts;
    expect(attempts.map((a) => a.provider)).toEqual(['p1']); // p2 冷却被跳过
    expect(calls.map((c) => c.url)).toEqual(['https://p1.local/v1/chat/completions']);
  });

  it('全部候选都冷却 → 不过滤照试（有试总比没有强）', async () => {
    const calls = stubFetch((url) => (url.startsWith('https://p1.local') ? upstreamFail() : ok('from-p2')));
    const health = new ProviderHealthRegistry({ now: () => 0 });
    for (const name of ['p1', 'p2']) {
      health.recordFailure(name);
      health.recordFailure(name);
      health.recordFailure(name);
    }
    const gw = makeGw([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], health);
    const res = (await gw.chat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })) as LlmChatResult;
    expect(res.text).toBe('from-p2');
    expect(calls.map((c) => c.url)).toEqual([
      'https://p1.local/v1/chat/completions',
      'https://p2.local/v1/chat/completions',
    ]);
  });

  it('路由跳过：主 provider 冷却（模型仅它声明）→ 自剩余候选的缺省模型回退成功', async () => {
    const calls = stubFetch(() => ok('from-p2-default'));
    const health = new ProviderHealthRegistry({ now: () => 0 });
    health.recordFailure('p1');
    health.recordFailure('p1');
    health.recordFailure('p1'); // p1（m1 唯一声明方）冷却
    const gw = makeGw([haProvider('p1', ['m1']), haProvider('p2', ['m2'])], health);
    const res = (await gw.chat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })) as LlmChatResult;
    expect(res.text).toBe('from-p2-default');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://p2.local/v1/chat/completions');
    expect(calls[0]?.body.model).toBe('m2');
  });
});

// =========================================================================
// B4 failover 尝试间退避
// =========================================================================

describe('B4 — failover 抖动退避', () => {
  it('尝试间 sleep(200ms×已失败尝试数 ±25% 抖动)；首轮无退避', async () => {
    stubFetch(() => jsonResponse({ error: { message: 'down' } }, { status: 500 }));
    const sleep = vi.fn(async () => {});
    const haProvider = (name: string, models: string[]): LlmProviderConfig =>
      provider({ name, baseUrl: `https://${name}.local/v1`, apiKeySecretRef: `secret://llm/${name}`, models });
    const gw = new LlmGateway({
      getProviders: async () => [haProvider('p1', ['m1']), haProvider('p2', ['m2']), haProvider('p3', ['m3'])],
      resolveSecret: async (ref) => ({ 'secret://llm/p1': 's', 'secret://llm/p2': 's', 'secret://llm/p3': 's' })[ref] ?? null,
      logger,
      haEnabled: async () => true,
      sleep,
    });
    await expect(gw.chat({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'HARNESS-5002',
    });
    // 主 provider 失败后：第 1 次回退前 sleep(200*1±jitter)，第 2 次前 sleep(200*2±jitter)
    expect(sleep).toHaveBeenCalledTimes(2);
    const [d1, d2] = sleep.mock.calls.map((c) => c[0] as number);
    expect(d1).toBeGreaterThanOrEqual(200);
    expect(d1).toBeLessThanOrEqual(250);
    expect(d2).toBeGreaterThanOrEqual(400);
    expect(d2).toBeLessThanOrEqual(500);
  });

  it('jitteredFailoverDelayMs：界内 [200n, 250n]，n≥1', () => {
    for (let n = 1; n <= 20; n++) {
      const d = jitteredFailoverDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(200 * n);
      expect(d).toBeLessThanOrEqual(250 * n);
      expect(Number.isInteger(d)).toBe(true);
    }
    expect(jitteredFailoverDelayMs(0)).toBeGreaterThanOrEqual(200); // 下界保护
  });
});

// =========================================================================
// C1 工具结果溢出落盘（spill）
// =========================================================================

describe('C1 — 工具结果溢出落盘', () => {
  const BIG = 'x'.repeat(40_000);

  function loopDeps(workspacePath: string | undefined, tools: AgentLoopToolRuntime): AgentLoopDeps {
    return {
      gateway: {
        chat: async () => ({ text: '', toolCalls: [{ id: 'call_1', name: 'big_tool', argsJson: '{}' }] }),
      },
      tools,
      logger,
      sleep: async () => {},
      ...(workspacePath === undefined ? {} : { workspace: () => ({ path: workspacePath }) }),
    } as AgentLoopDeps;
  }

  function spillTools(): AgentLoopToolRuntime & { executions: number } {
    const executions = { count: 0 };
    return {
      listSchemas: () => [{ name: 'big_tool', description: 'd', inputSchema: {} }],
      execute: async () => {
        executions.count += 1;
        return { payload: BIG };
      },
      executions,
    } as AgentLoopToolRuntime & { executions: number };
  }

  it('>32KB + workspace → 完整结果落盘 tool-outputs/{callId}.json，消息体替换为 {_spilled,path,preview}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spill-'));
    const tools = spillTools();
    const out = await runAgentLoop(loopDeps(dir, tools), {
      agentId: 'a',
      depth: 0,
      prompt: 'p',
      model: 'model-under-test',
      maxIterations: 2,
    });
    const fullText = JSON.stringify({ payload: BIG });
    // 消息体 = 信封
    const toolMsg = (out.messages[3] as { content: { toolCallId: string; text: string } }).content;
    expect(toolMsg.toolCallId).toBe('call_1');
    const envelope = JSON.parse(toolMsg.text) as { _spilled: boolean; path: string; preview: string };
    expect(envelope._spilled).toBe(true);
    expect(envelope.path).toBe('tool-outputs/call_1.json');
    expect(envelope.preview).toBe(fullText.slice(0, 2048));
    expect(toolMsg.text.length).toBeLessThan(3_000); // 空间可控
    // 完整结果在盘上
    const onDisk = await readFile(join(dir, 'tool-outputs', 'call_1.json'), 'utf8');
    expect(onDisk).toBe(fullText);
  });

  it('>32KB 无 workspace → 截断 32KB + 确定性标注（不落盘）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spill-none-'));
    const out = await runAgentLoop(loopDeps(undefined, spillTools()), {
      agentId: 'a',
      depth: 0,
      prompt: 'p',
      model: 'model-under-test',
      maxIterations: 2,
    });
    const toolMsg = (out.messages[3] as { content: { text: string } }).content;
    const fullText = JSON.stringify({ payload: BIG });
    expect(toolMsg.text.startsWith(fullText.slice(0, 32 * 1024))).toBe(true);
    expect(toolMsg.text.endsWith('\n…[truncated: tool result exceeded 32KB]')).toBe(true);
    expect(toolMsg.text.length).toBe(32 * 1024 + '\n…[truncated: tool result exceeded 32KB]'.length);
    await expect(readdir(join(dir, 'tool-outputs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('≤32KB 结果原样内联（不落盘、不加信封）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spill-small-'));
    const tools: AgentLoopToolRuntime = {
      listSchemas: () => [{ name: 'big_tool', description: 'd', inputSchema: {} }],
      execute: async () => ({ small: true }),
    };
    const out = await runAgentLoop(loopDeps(dir, tools), {
      agentId: 'a',
      depth: 0,
      prompt: 'p',
      model: 'model-under-test',
      maxIterations: 2,
    });
    const toolMsg = (out.messages[3] as { content: { text: string } }).content;
    expect(toolMsg.text).toBe(JSON.stringify({ small: true }));
    await expect(readdir(join(dir, 'tool-outputs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('callId 路径净化（不可信 provider 侧 id 不逃出 tool-outputs）；落盘失败降级截断', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spill-sec-'));
    // 1) 恶意 callId
    const evilTools: AgentLoopToolRuntime = {
      listSchemas: () => [{ name: 'big_tool', description: 'd', inputSchema: {} }],
      execute: async () => ({ payload: BIG }),
    };
    const gateway = {
      chat: async () => ({ text: '', toolCalls: [{ id: '../../evil', name: 'big_tool', argsJson: '{}' }] }),
    };
    const out = await runAgentLoop(
      { ...(loopDeps(dir, evilTools) as AgentLoopDeps), gateway },
      { agentId: 'a', depth: 0, prompt: 'p', model: 'model-under-test', maxIterations: 2 },
    );
    const spilled = JSON.parse((out.messages[3] as { content: { text: string } }).content.text) as { path: string };
    expect(spilled.path).toBe('tool-outputs/.._.._evil.json');
    const files = await readdir(join(dir, 'tool-outputs'));
    expect(files).toEqual(['.._.._evil.json']); // 未逃出目录
    expect(await readFile(join(dir, spilled.path), 'utf8')).toBe(JSON.stringify({ payload: BIG }));

    // 2) workspace 路径是一个已存在的文件 → mkdir 失败 → 降级截断，循环不中断
    const filePath = join(dir, 'not-a-dir');
    await writeFile(filePath, 'i am a file');
    const out2 = await runAgentLoop(loopDeps(filePath, spillTools()), {
      agentId: 'a',
      depth: 0,
      prompt: 'p',
      model: 'model-under-test',
      maxIterations: 2,
    });
    const truncated = (out2.messages[3] as { content: { text: string } }).content;
    expect(truncated.text.endsWith('\n…[truncated: tool result exceeded 32KB]')).toBe(true);
  });
});

// =========================================================================
// C2 压缩确定性 + 水位线
// =========================================================================

describe('C2 — 缓存友好压缩（确定性 + watermark）', () => {
  it('micro 摘要确定性：同输入两次压缩输出逐字节一致（无时间戳/随机）', () => {
    const build = (): LlmMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u'.repeat(400) },
      { role: 'tool', content: { toolCallId: 'c1', text: JSON.stringify({ result: 'r'.repeat(600), items: [1, 2] }) } },
      { role: 'user', content: 'recent' },
    ];
    const a = applyContextBudget(build(), { budgetTokens: 150, keepRecent: 1 });
    const b = applyContextBudget(build(), { budgetTokens: 150, keepRecent: 1 });
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(a.compacted).toBe(true);
  });

  it('ContextBudget 水位线：一旦压缩即固定边界——后续轮次前缀逐字节稳定（超预算也不回头改写）', () => {
    const budget = new ContextBudget();
    const round1: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'tool', content: { toolCallId: 'c1', text: JSON.stringify({ result: 'r'.repeat(800) }) } },
      { role: 'user', content: 'recent-1' },
      { role: 'user', content: 'recent-2' },
    ];
    const r1 = budget.apply(round1, { budgetTokens: 200, keepRecent: 2 });
    expect(r1.compacted).toBe(true);
    expect(r1.watermark).toBe(2); // 边界固定在 index 2

    // 第二轮：追加消息（含超长新消息在保护窗口内），总量超预算——但冻结前缀不得改写
    const round2: LlmMessage[] = [
      ...round1,
      { role: 'user', content: 'new-big-'.repeat(100) },
      { role: 'user', content: 'recent-3' },
    ];
    const r2 = budget.apply(round2, { budgetTokens: 200, keepRecent: 2 });
    expect(r2.watermark).toBe(2); // 单调：不因重算而漂移
    expect(JSON.stringify(r2.messages.slice(0, 2))).toBe(JSON.stringify(r1.messages.slice(0, 2)));
    // 边界之后的消息原样保留（尽力而为，不抛错）
    expect(r2.messages.length).toBe(round2.length);
  });

  it('水位线单调推进：getter 与结果一致；未压缩时保持 0', () => {
    const budget = new ContextBudget();
    expect(budget.watermark).toBe(0);
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'short' },
    ];
    const r = budget.apply(messages, { budgetTokens: 10_000 });
    expect(r.compacted).toBe(false);
    expect(budget.watermark).toBe(0); // 未压缩 → 边界不固定
    expect(r.watermark).toBe(0);
  });

  it('丢轮阶段：水位线随被丢消息收缩（冻结前缀条数 = cut - 丢数），且 ≥ 0', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 8 }, (_, i): LlmMessage => ({ role: 'user', content: `u${i}-${'a'.repeat(300)}` })),
      { role: 'user', content: 'recent' },
    ];
    const result = applyContextBudget(messages, { budgetTokens: 60, keepRecent: 1 });
    expect(result.compacted).toBe(true);
    const cut = messages.length - 1;
    // 丢掉的消息彻底消失；被 micro 摘要保留的消息 preview 里仍带 u{i}- 标记
    const serialized = JSON.stringify(result.messages);
    const dropped = Array.from({ length: 8 }, (_, k) => k + 1).filter((i) => !serialized.includes(`u${i}-`)).length;
    expect(dropped).toBeGreaterThan(0);
    expect(result.watermark).toBe(cut - dropped);
    expect(result.watermark).toBeGreaterThanOrEqual(0);
    expect(result.estimatedTokens).toBeLessThanOrEqual(60);
  });

  it('纯函数 watermark 透传：传入水位线时压缩边界固定为它（不再按 keepRecent 重算）', () => {
    const build = (): LlmMessage[] => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u'.repeat(400) }, // index1：水位线之外（冻结区）
      { role: 'tool', content: { toolCallId: 'c1', text: 'r'.repeat(400) } }, // index2：边界后（保护）
      { role: 'user', content: 'recent' },
    ];
    // watermark=2 → index2 的 tool 虽超 240 字也不压缩（保护窗口）
    const r = applyContextBudget(build(), { budgetTokens: 170, keepRecent: 1, watermark: 2 });
    const tool = r.messages.find((m) => m.role === 'tool') as { content: { text: string } };
    expect(tool.content.text.startsWith('rrrr')).toBe(true); // 原文保留
    expect(r.watermark).toBe(2);
    expect(r.estimatedTokens).toBeLessThanOrEqual(170);
  });
});

// =========================================================================
// D1 prompt_cache_key + runner sessionKey 透传
// =========================================================================

describe('D1 — prompt_cache_key（缓存命中）', () => {
  it('sessionKey 非空 → payload 追加 prompt_cache_key；不经 paramAllowlist（默认白名单不拒绝）', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(
      provider(),
      'sk',
      { ...CHAT_INPUT, sessionKey: 'sess-9', providerParams: { user: 'u-1' } },
    );
    expect(calls[0]?.body.prompt_cache_key).toBe('sess-9');
    expect(calls[0]?.body.user).toBe('u-1');
  });

  it('promptCacheKey:false → 即使 sessionKey 存在也不携带', async () => {
    const calls = stubFetch(() =>
      jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }),
    );
    await openaiChatAdapter.chat(provider({ promptCacheKey: false }), 'sk', { ...CHAT_INPUT, sessionKey: 'sess-9' });
    expect('prompt_cache_key' in calls[0]?.body).toBe(false);
  });

  it('缺省无 sessionKey → 不携带该键；流式同样直写', async () => {
    const calls = stubFetch(() =>
      sseResponse([openAiChunk('m', { choices: [{ index: 0, delta: { content: 'x' } }] }), 'data: [DONE]\n\n']),
    );
    await collect(openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT));
    expect('prompt_cache_key' in calls[0]?.body).toBe(false);
    const calls2 = stubFetch(() =>
      sseResponse([openAiChunk('m', { choices: [{ index: 0, delta: { content: 'x' } }] }), 'data: [DONE]\n\n']),
    );
    await collect(openaiChatAdapter.stream(provider(), 'sk', { ...CHAT_INPUT, sessionKey: 'sess-stream' }));
    expect(calls2[0]?.body.prompt_cache_key).toBe('sess-stream');
  });

  it('runner：input.sessionKey 透传到每次 gateway.chat（含收尾轮）', async () => {
    const calls: LlmChatInput[] = [];
    const tools: AgentLoopToolRuntime = { listSchemas: () => [], execute: async () => ({}) };
    await runAgentLoop(
      {
        gateway: {
          chat: async (input: LlmChatInput) => {
            calls.push(structuredClone(input));
            if (calls.length === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'n', argsJson: '{}' }] };
            return { text: 'done' };
          },
        },
        tools,
        logger,
        sleep: async () => {},
      },
      { agentId: 'a', depth: 0, prompt: 'p', model: 'model-under-test', sessionKey: 'sess-42', maxIterations: 2 },
    );
    expect(calls[0]?.sessionKey).toBe('sess-42');
    expect(calls[1]?.sessionKey).toBe('sess-42');
  });
});

// =========================================================================
// D3 anthropic cache_control
// =========================================================================

describe('D3 — anthropic cache_control 断点', () => {
  const ANTHROPIC_OK = (): Response =>
    jsonResponse({
      id: 'm1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

  it('非流式：system → 单元素 text 块（ephemeral）；最后一条 user 消息块补标', async () => {
    const calls = stubFetch(ANTHROPIC_OK);
    await anthropicMessagesAdapter.chat(provider({ protocol: 'anthropic-messages' }), 'sk', {
      ...CHAT_INPUT,
      sessionKey: 'ignored-for-anthropic',
    });
    expect(calls[0]?.body.system).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }]);
    const messages = calls[0]?.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
    ]);
  });

  it('流式：同样携带 cache_control；块数组 content → 尾部块补标（前面块不动）', async () => {
    const calls = stubFetch(() =>
      sseResponse([
        anthropicEvent('message_start', {
          message: { id: 'm1', type: 'message', role: 'assistant', content: [], model: 'claude-test', usage: { input_tokens: 1, output_tokens: 1 } },
        }),
        anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }),
        anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        anthropicEvent('message_stop', {}),
      ]),
    );
    const messages: LlmMessage[] = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: { text: 'a', toolCalls: [{ id: 't1', name: 'n', arguments: '{}' }] } },
      { role: 'tool', content: { toolCallId: 't1', text: 'r' } },
    ];
    await collect(anthropicMessagesAdapter.stream(provider({ protocol: 'anthropic-messages' }), 'sk', {
      model: 'model-under-test',
      messages,
    }));
    expect(calls[0]?.body.system).toEqual([{ type: 'text', text: 'sys prompt', cache_control: { type: 'ephemeral' } }]);
    const sent = calls[0]?.body.messages as Array<{ role: string; content: unknown }>;
    // 最后一条 user = tool_result 块（tool 消息折叠为 user）→ 尾部块带 cache_control
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r', cache_control: { type: 'ephemeral' } }],
    });
  });
});
