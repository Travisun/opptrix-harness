/**
 * 文本内嵌工具调用标记恢复层（tool-markup）单测。
 *
 * 覆盖：
 * - 纯函数 recoverToolCallsFromText/hasToolMarkup：单块/多块按序提取、arguments 缺省 {}、
 *   name 缺失跳过（原文保留）、JSON 破损保留原文不吞、三种标记族变体
 *   （<longcat_tool_call>/<tool_call>/<|tool_call|> 及对应闭标签形态）、前后正文保留与
 *   空白行折叠、标记独占正文时 cleanedText 收敛为空串、kind 归一化、id 形状与唯一性、
 *   解析块与破损块混合（仅剥离可解析块）、误伤防护（Markdown 表格/普通文本不触发）、
 *   跨族闭标签不匹配、残缺块（无闭标签）原样保留。
 * - openai-chat 适配器非流式后处理（mock fetch 注入响应）：无原生 tool_calls 且 content
 *   含标记 → 恢复 toolCalls + text 清洗；原生 tool_calls 存在 → 绝不恢复（正文原样）；
 *   JSON 破损 → 不带 toolCalls 键；恢复项形状与原生一致（id/name/argsJson，无 kind 泄漏）。
 * - 适配器流式：标记正文仅按 delta 透传（流契约不变，无合成事件）。
 * - runner 流式聚合点（runAgentLoop 消费流事件）：未收到任何 tool_call_delta 且累积正文
 *   含标记 → 恢复调用并执行工具（正文清洗后回填 assistant 消息）；存在原生 tool_call_delta
 *   时不恢复。
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import { runAgentLoop, type AgentLoopDeps, type AgentLoopToolRuntime } from '../src/kernel/agents/runner.js';
import {
  hasToolMarkup,
  openaiChatAdapter,
  recoverToolCallsFromText,
  type LlmChatInput,
  type LlmChatResult,
  type LlmProviderConfig,
  type LlmStreamEvent,
} from '../src/kernel/llm/index.js';

const logger = pino({ level: 'silent' });

// ---------- 纯函数：recoverToolCallsFromText / hasToolMarkup ----------

describe('recoverToolCallsFromText — 基本解析', () => {
  it('单块 longcat 标记：恢复 name/argsJson，cleanedText 剥离标记块', () => {
    const text = '<longcat_tool_call>{"name": "workspace_read", "arguments": {"path": "a.md"}}</longcat_tool_call>';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.name).toBe('workspace_read');
    expect(out.toolCalls[0]?.argsJson).toBe('{"path":"a.md"}');
    expect(out.toolCalls[0]?.id).toMatch(/^call_[0-9a-f]{8}$/);
    expect(out.toolCalls[0]?.kind).toBe('longcat_tool_call');
    expect(out.cleanedText).toBe('');
  });

  it('前后正文保留，标记块剥离后空白行折叠（尾随空行/首部空行收敛）', () => {
    const text = [
      '好的，我来读取该文件。',
      '',
      '',
      '<longcat_tool_call>{"name":"workspace_read","arguments":{"path":"a.md"}}</longcat_tool_call>',
      '',
      '',
      '',
      '如果读取失败我会再尝试其他路径。',
    ].join('\n');
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.cleanedText).toBe(
      '好的，我来读取该文件。\n\n如果读取失败我会再尝试其他路径。',
    );
  });

  it('多块（一次响应多个调用）按出现序全部提取，全部自正文剥离', () => {
    const text = [
      '先查再读：',
      '<tool_call>{"name":"cron_list","arguments":{"limit":5}}</tool_call>',
      '中间说明文字。',
      '<tool_call>{"name":"files_read","arguments":{"id":"f1"}}</tool_call>',
      '完毕。',
    ].join('\n');
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls.map((tc) => tc.name)).toEqual(['cron_list', 'files_read']);
    expect(out.toolCalls.map((tc) => tc.argsJson)).toEqual(['{"limit":5}', '{"id":"f1"}']);
    expect(out.cleanedText).toBe('先查再读：\n中间说明文字。\n完毕。');
  });

  it('arguments 缺省 → argsJson 为 "{}"', () => {
    const text = '<tool_call>{"name":"skills_list"}</tool_call>';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.argsJson).toBe('{}');
  });

  it('name 缺失 → 该块跳过且原文保留（不吞正文）', () => {
    const text = '前文 <tool_call>{"arguments":{"a":1}}</tool_call> 后文';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toEqual([]);
    expect(out.cleanedText).toBe('前文 <tool_call>{"arguments":{"a":1}}</tool_call> 后文');
  });

  it('JSON 破损 → 保留原文不吞（可能是正文碰巧包含该字符串）', () => {
    const text = '代码示例：<tool_call>{"name": "x", "arguments": </tool_call> 不是真调用';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toEqual([]);
    expect(out.cleanedText).toBe(text);
  });

  it('标签体为非对象 JSON（数组/标量）→ 跳过且保留原文', () => {
    const arr = '<tool_call>[1,2,3]</tool_call>';
    const scalar = '<tool_call>"just a quote"</tool_call>';
    expect(recoverToolCallsFromText(arr)).toEqual({ toolCalls: [], cleanedText: arr });
    expect(recoverToolCallsFromText(scalar)).toEqual({ toolCalls: [], cleanedText: scalar });
  });
});

describe('recoverToolCallsFromText — 标记族变体与边界', () => {
  it('三种开标签变体均识别：longcat 前缀 / 裸 tool_call / 竖线 <|tool_call|>', () => {
    const cases: Array<{ open: string; close: string; kind: string }> = [
      { open: '<longcat_tool_call>', close: '</longcat_tool_call>', kind: 'longcat_tool_call' },
      { open: '<tool_call>', close: '</tool_call>', kind: 'tool_call' },
      { open: '<|tool_call|>', close: '<|/tool_call|>', kind: 'tool_call' },
    ];
    for (const { open, close, kind } of cases) {
      const text = `${open}{"name":"t","arguments":{"k":"v"}}${close}`;
      const out = recoverToolCallsFromText(text);
      expect(out.toolCalls).toHaveLength(1);
      expect(out.toolCalls[0]?.kind).toBe(kind);
      expect(out.toolCalls[0]?.argsJson).toBe('{"k":"v"}');
      expect(out.cleanedText).toBe('');
    }
  });

  it('闭标签 </|tool_call|> 形态（竖线在斜杠后）同样识别', () => {
    const text = '<|tool_call|>{"name":"t","arguments":{}}</|tool_call|>';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.cleanedText).toBe('');
  });

  it('跨族闭标签不匹配：<tool_call> 不会被 </longcat_tool_call> 闭合（原样保留）', () => {
    const text = '<tool_call>{"name":"t","arguments":{}}</longcat_tool_call>';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toEqual([]);
    expect(out.cleanedText).toBe(text);
  });

  it('残缺块（开标签无闭标签）→ 原样保留不解析', () => {
    const text = '<tool_call>{"name":"t","arguments":{}} 没有闭合就断了';
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toEqual([]);
    expect(out.cleanedText).toBe(text);
  });

  it('解析块与破损块混合：仅剥离可解析块，破损块原文保留', () => {
    const good = '<tool_call>{"name":"ok_tool","arguments":{"a":1}}</tool_call>';
    const bad = '<tool_call>{"name": broken</tool_call>';
    const text = `前 ${bad} 中 ${good} 后`;
    const out = recoverToolCallsFromText(text);
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.name).toBe('ok_tool');
    expect(out.cleanedText).toBe(`前 ${bad} 中  后`);
    expect(out.cleanedText).toContain(bad);
  });

  it('id 每次调用独立生成且互不重复', () => {
    const text = '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>';
    const out = recoverToolCallsFromText(text);
    const ids = out.toolCalls.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^call_[0-9a-f]{8}$/);
  });

  it('误伤防护：Markdown 表格竖线/普通含 tool_call 字样的文本不触发恢复', () => {
    const table = '| 列A | 列B |\n|-----|-----|\n| tool_call | 值 |';
    const plain = '正文提到 tool_call 但没有任何标签';
    expect(recoverToolCallsFromText(table)).toEqual({ toolCalls: [], cleanedText: table });
    expect(recoverToolCallsFromText(plain)).toEqual({ toolCalls: [], cleanedText: plain });
  });

  it('无标记文本原样返回（cleanedText === 原文）', () => {
    const text = '普通回复，无需恢复。';
    expect(recoverToolCallsFromText(text)).toEqual({ toolCalls: [], cleanedText: text });
    expect(recoverToolCallsFromText('')).toEqual({ toolCalls: [], cleanedText: '' });
  });
});

describe('hasToolMarkup — 快速探测', () => {
  it('三种标记族（开/闭标签）均判 true', () => {
    expect(hasToolMarkup('<longcat_tool_call>{"name":"t"}</longcat_tool_call>')).toBe(true);
    expect(hasToolMarkup('前文 <tool_call>{}</tool_call> 后文')).toBe(true);
    expect(hasToolMarkup('流式片段 <|tool_call|>{"name"')).toBe(true);
    expect(hasToolMarkup('孤立闭标签 </tool_call>')).toBe(true);
  });

  it('普通文本/Markdown/空串判 false；复数标签 <tool_calls> 不误报', () => {
    expect(hasToolMarkup('')).toBe(false);
    expect(hasToolMarkup('a | b | c')).toBe(false);
    expect(hasToolMarkup('说到了 tool_call 这个词')).toBe(false);
    expect(hasToolMarkup('<tool_calls>{"name":"t"}</tool_calls>')).toBe(false);
  });
});

// ---------- 适配器：openai-chat 非流式后处理（mock fetch） ----------

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
  messages: [{ role: 'user', content: '读一下 a.md' }],
};

/** 注入 mock fetch 返回给定 choices 消息（openai-chat 非流式） */
async function chatWithMessage(message: Record<string, unknown>): Promise<LlmChatResult> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ choices: [{ index: 0, message, finish_reason: 'stop' }] })),
  );
  try {
    return await openaiChatAdapter.chat(provider(), 'sk-test', CHAT_INPUT);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('openai-chat adapter — 文本内嵌工具标记恢复（非流式）', () => {
  it('原生 tool_calls 缺失且 content 含标记 → 恢复 toolCalls，text 为清洗后正文', async () => {
    const res = await chatWithMessage({
      role: 'assistant',
      content:
        '<longcat_tool_call>{"name": "workspace_read", "arguments": {"path": "a.md"}}</longcat_tool_call>',
    });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls?.[0]?.name).toBe('workspace_read');
    expect(res.toolCalls?.[0]?.argsJson).toBe('{"path":"a.md"}');
    expect(res.toolCalls?.[0]?.id).toMatch(/^call_[0-9a-f]{8}$/);
    expect(res.text).toBe('');
  });

  it('恢复项形状与原生一致：仅 id/name/argsJson（无 kind 泄漏进 LlmChatResult）', async () => {
    const res = await chatWithMessage({
      role: 'assistant',
      content: '<tool_call>{"name":"cron_list","arguments":{"limit":3}}</tool_call>',
    });
    expect(res.toolCalls).toEqual([
      { id: expect.stringMatching(/^call_[0-9a-f]{8}$/), name: 'cron_list', argsJson: '{"limit":3}' },
    ]);
    expect(Object.keys(res.toolCalls?.[0] ?? {}).sort()).toEqual(['argsJson', 'id', 'name']);
  });

  it('原生 tool_calls 存在 → 绝不恢复（原生优先），正文原样不清洗', async () => {
    const content = '<tool_call>{"name":"should_not_recover","arguments":{}}</tool_call>';
    const res = await chatWithMessage({
      role: 'assistant',
      content,
      tool_calls: [{ id: 'call_native', type: 'function', function: { name: 'native_tool', arguments: '{}' } }],
    });
    expect(res.toolCalls).toEqual([{ id: 'call_native', name: 'native_tool', argsJson: '{}' }]);
    expect(res.text).toBe(content);
  });

  it('content 含标记但 JSON 破损 → 不恢复（无 toolCalls 键），text 原样', async () => {
    const content = '<tool_call>{"name": oops</tool_call>';
    const res = await chatWithMessage({ role: 'assistant', content });
    expect(res.toolCalls).toBeUndefined();
    expect('toolCalls' in res).toBe(false);
    expect(res.text).toBe(content);
  });

  it('普通文本无标记 → 结果与既有行为一致（无 toolCalls 键，text 原样）', async () => {
    const res = await chatWithMessage({ role: 'assistant', content: 'plain answer' });
    expect('toolCalls' in res).toBe(false);
    expect(res.text).toBe('plain answer');
  });
});

// ---------- 适配器流式：契约不变（无合成事件） ----------

describe('openai-chat adapter — 流式透传（标记正文不合成事件）', () => {
  it('标记正文按 delta 原样透传，事件仅 delta/done（流契约不变）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const frames = [
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"<tool_call>"}}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"{\\"name\\":\\"t\\",\\"arguments\\":{}}"}}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"</tool_call>"}}]}\n\n',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
          'data: [DONE]\n\n',
        ];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            for (const f of frames) controller.enqueue(enc.encode(f));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    try {
      const events: LlmStreamEvent[] = [];
      for await (const ev of openaiChatAdapter.stream(provider(), 'sk', CHAT_INPUT)) events.push(ev);
      expect(events).toEqual([
        { type: 'delta', text: '<tool_call>' },
        { type: 'delta', text: '{"name":"t","arguments":{}}' },
        { type: 'delta', text: '</tool_call>' },
        { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------- runner 流式聚合点恢复 ----------

/** 流式 gateway stub：chat 返回按脚本出栈的事件流生成器 */
function streamingGateway(script: LlmStreamEvent[][]) {
  const chats: LlmChatInput[] = [];
  const gateway = {
    chat: vi.fn(async (input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> => {
      chats.push(input);
      const events = script.shift();
      if (events === undefined) throw new Error('script exhausted');
      return (async function* gen() {
        for (const ev of events) yield ev;
      })();
    }),
  };
  return { gateway, chats };
}

function stubTools(): AgentLoopToolRuntime & { executions: Array<{ name: string; args: unknown }> } {
  const executions: Array<{ name: string; args: unknown }> = [];
  return {
    listSchemas: () => [{ name: 'workspace_read', description: '读', inputSchema: { type: 'object' } }],
    execute: async (name, args) => {
      executions.push({ name, args });
      return { ok: true };
    },
    executions,
  };
}

describe('runAgentLoop — 流式汇总层标记恢复', () => {
  it('整条流无 tool_call_delta 且正文含标记 → 恢复调用并执行；assistant 正文为清洗后文本', async () => {
    const tools = stubTools();
    const { gateway } = streamingGateway([
      [
        { type: 'delta', text: '<longcat_tool_call>{"name":"workspace_read","arguments":{"path":"a.md"}}' },
        { type: 'delta', text: '</longcat_tool_call>' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [{ type: 'delta', text: '已读取 a.md，任务完成。' }, { type: 'done', usage: { inputTokens: 20, outputTokens: 8 } }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep: async () => {} },
      { agentId: 'ag-1', depth: 0, prompt: '读文件' },
    );
    expect(tools.executions).toEqual([{ name: 'workspace_read', args: { path: 'a.md' } }]);
    expect(out.toolCalls).toBe(1);
    expect(out.finalText).toBe('已读取 a.md，任务完成。');
    const assistantMsg = (out.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    );
    expect(assistantMsg?.content).toEqual({
      toolCalls: [{ id: expect.stringMatching(/^call_[0-9a-f]{8}$/), name: 'workspace_read', arguments: '{"path":"a.md"}' }],
    });
  });

  it('正文为「标记 + 前后说明」→ 恢复的同时保留前后正文（清洗后回填）', async () => {
    const tools = stubTools();
    const { gateway } = streamingGateway([
      [
        { type: 'delta', text: '我先读取文件。\n<tool_call>{"name":"workspace_read","arguments":{}}</tool_call>\n马上汇报。' },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'done' }, { type: 'done' }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep: async () => {} },
      { agentId: 'ag-1', depth: 0, prompt: '读' },
    );
    expect(tools.executions).toHaveLength(1);
    const assistantMsg = (out.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    );
    expect((assistantMsg?.content as { text?: string }).text).toBe('我先读取文件。\n马上汇报。');
  });

  it('存在原生 tool_call_delta 时不恢复（正文含标记字符串也原样保留）', async () => {
    const tools = stubTools();
    const { gateway } = streamingGateway([
      [
        { type: 'delta', text: '<tool_call>{"name":"x"}</tool_call>' },
        {
          type: 'tool_call_delta',
          index: 0,
          payload: { id: 'call_native', function: { name: 'native_tool', arguments: '{}' } },
        },
        { type: 'done' },
      ],
      [{ type: 'delta', text: 'final' }, { type: 'done' }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep: async () => {} },
      { agentId: 'ag-1', depth: 0, prompt: 'x' },
    );
    // 只有原生调用被执行；正文未被清洗（含标记原文）
    expect(tools.executions).toEqual([{ name: 'native_tool', args: {} }]);
    const assistantMsg = (out.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    );
    expect((assistantMsg?.content as { text?: string }).text).toBe('<tool_call>{"name":"x"}</tool_call>');
    expect(out.finalText).toBe('final');
  });

  it('无标记普通流 → 行为与既有完全一致（不注 toolCalls，文本不清洗）', async () => {
    const tools = stubTools();
    const { gateway } = streamingGateway([
      [{ type: 'delta', text: 'plain ' }, { type: 'delta', text: 'text' }, { type: 'done' }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep: async () => {} },
      { agentId: 'ag-1', depth: 0, prompt: 'x' },
    );
    expect(out.finalText).toBe('plain text');
    expect(out.toolCalls).toBe(0);
    expect(tools.executions).toEqual([]);
  });
});
