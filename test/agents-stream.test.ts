/**
 * Chat 流式管道端到端与单元（chat-progress 协议 + runner 流式化 + 会话进度 + SSE 端点）。
 *
 * 覆盖：
 * - formatToolLabel 纯函数：已知系统工具中文映射（工作区/报告/浏览器/编码/子代理）+
 *   参数摘要后缀；未知工具回退原名；预览截断上限（args ≤240 / result ≤180）；
 * - runAgentLoop 流式：onDelta 传入 → gateway 以 stream:true 调用、思考链/正文节流回调
 *   （片段 = 合并增量；流结束 flush 残余）、tool_call_delta 按 index 聚合执行、
 *   reasoningSegments 每轮一段、空回复守卫（有思考链空正文 → 用户提示收束）、
 *   onDelta 抛错只 warn 不中断；未传 onDelta 维持非流式现状（回归）；
 * - store：reasoning_segments 落库/读出 round-trip + 脏 JSON 容错；
 * - Kernel 全链路（伪 OpenAI 上游 SSE 流）：manager.sendMessage onProgress 事件序列
 *   （thinking/reply/tool_start/tool_done/done + 中文 label + 落库思考分段）、
 *   POST messages/stream SSE 端到端（响应头 + 帧序列 + done 载荷 + 未认证 401）、
 *   客户端断开联动取消生成、非流式 POST messages 回归不变。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import {
  EMPTY_REPLY_HINT,
  estimateTokens,
  formatArgsPreview,
  formatResultPreview,
  formatToolLabel,
  type ChatProgressEvent,
} from '../src/kernel/agents/chat-progress.js';
import { runAgentLoop, type AgentLoopDeltaChunk, type AgentLoopToolRuntime } from '../src/kernel/agents/runner.js';
import { AgentSessionStore } from '../src/kernel/agents/session-store.js';
import type { AgentSessionManager } from '../src/kernel/agents/session.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { openaiChatAdapter } from '../src/kernel/llm/adapters/openai-chat.js';
import type { LlmChatInput, LlmChatResult, LlmStreamEvent } from '../src/kernel/llm/index.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// 一、chat-progress 纯函数
// ---------------------------------------------------------------------------

describe('formatToolLabel — 工具中文标签映射', () => {
  it('工作区/报告类：中文映射 + 路径 basename / 标题摘要后缀', () => {
    expect(formatToolLabel('workspace_write', { path: 'reports/report.md', content: 'x' })).toBe(
      '写入工作区文件 · report.md',
    );
    expect(formatToolLabel('workspace_read', { path: 'notes/a.md' })).toBe('读取工作区文件 · a.md');
    expect(formatToolLabel('workspace_list', {})).toBe('列出工作区');
    expect(formatToolLabel('workspace_list', { path: 'sub/dir' })).toBe('列出工作区 · sub/dir');
    expect(formatToolLabel('workspace_delete', { path: 'old.txt' })).toBe('删除工作区文件 · old.txt');
    expect(formatToolLabel('report_create', { title: '季度总结', html: '<h1/>' })).toBe('生成 HTML 报告 · 季度总结');
  });

  it('浏览器/编码/子代理类：hostname、命令行、language、任务摘要后缀', () => {
    expect(formatToolLabel('browser_navigate', { url: 'https://example.com/page?q=1' })).toBe('打开网页 · example.com');
    expect(formatToolLabel('browser_screenshot', {})).toBe('网页截图');
    expect(formatToolLabel('coding_exec', { cmd: 'npm', args: ['run', 'test'] })).toBe('执行命令 · npm run test');
    expect(formatToolLabel('coding_run_code', { language: 'python', code: 'print(1)' })).toBe('运行代码 · python');
    expect(formatToolLabel('subagent_spawn', { prompt: '巡检全部技能并汇报' })).toBe('派出子代理 · 巡检全部技能并汇报');
  });

  it('未知工具回退原名（无摘要后缀）；纯函数（同入参同输出，不产生副作用）', () => {
    expect(formatToolLabel('my_custom_tool', {})).toBe('my_custom_tool');
    expect(formatToolLabel('my_custom_tool', { path: 'a.txt' })).toBe('my_custom_tool');
    const args = { path: 'x.md' };
    expect(formatToolLabel('workspace_read', args)).toBe(formatToolLabel('workspace_read', args));
    expect(args).toEqual({ path: 'x.md' }); // 入参未被修改
  });

  it('预览上限：argsPreview ≤240、resultPreview ≤180；estimateTokens = ceil(chars/4)', () => {
    const longArgs = { content: 'x'.repeat(2000) };
    const argsPreview = formatArgsPreview(longArgs);
    expect(argsPreview.length).toBeLessThanOrEqual(240);
    expect(argsPreview.endsWith('…')).toBe(true);

    const longResult = { text: 'y'.repeat(5000) };
    const resultPreview = formatResultPreview(longResult);
    expect(resultPreview.length).toBeLessThanOrEqual(180);
    expect(resultPreview.endsWith('…')).toBe(true);

    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 二、runAgentLoop 流式化（脚本化流式网关 + 内存工具运行时）
// ---------------------------------------------------------------------------

const SCHEMAS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  { name: 'skills_list', description: '列出技能', inputSchema: { type: 'object', properties: {} } },
];

const BASE_INPUT = { agentId: 'agent-1', depth: 0, prompt: '做一件事', model: 'model-under-test' };

/** 脚本化流式网关：每次 chat 按序弹出一组 LlmStreamEvent，包装为 AsyncGenerator 返回 */
function streamingGateway(script: LlmStreamEvent[][]) {
  const calls: LlmChatInput[] = [];
  const gateway = {
    chat: vi.fn(async (input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> => {
      calls.push(structuredClone(input));
      const events = script.shift();
      if (events === undefined) throw new Error(`script exhausted (chat call #${calls.length})`);
      return (async function* () {
        for (const event of events) yield event;
      })();
    }),
  };
  return { gateway, calls };
}

/** 脚本化非流式网关（回归对照；与既有 agent-loop.test.ts 同款） */
function scriptedGateway(script: LlmChatResult[]) {
  const calls: LlmChatInput[] = [];
  const gateway = {
    chat: vi.fn(async (input: LlmChatInput): Promise<LlmChatResult> => {
      calls.push(structuredClone(input));
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    }),
  };
  return { gateway, calls };
}

function stubTools(overrides: Record<string, () => unknown> = {}): AgentLoopToolRuntime & {
  executions: Array<{ name: string; args: unknown }>;
} {
  const executions: Array<{ name: string; args: unknown }> = [];
  return {
    listSchemas: () => SCHEMAS.map((s) => ({ ...s, inputSchema: { ...s.inputSchema } })),
    execute: async (name, args) => {
      executions.push({ name, args });
      const factory = overrides[name];
      if (factory !== undefined) return factory();
      return { tool: name, args };
    },
    executions,
  };
}

const sleep = async (): Promise<void> => {};

describe('runAgentLoop — 流式（onDelta）', () => {
  it('onDelta 传入 → gateway 以 stream:true 调用；思考链/正文节流片段按序回调；reasoningSegments 收段', async () => {
    const tools = stubTools();
    const { gateway, calls } = streamingGateway([
      [
        { type: 'reasoning_delta', text: '思考' },
        { type: 'delta', text: '你' },
        { type: 'done', usage: { inputTokens: 3, outputTokens: 2 } },
      ],
    ]);
    const deltas: AgentLoopDeltaChunk[] = [];
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep },
      { ...BASE_INPUT, onDelta: (chunk) => deltas.push({ ...chunk }) },
    );

    expect(calls[0]?.stream).toBe(true);
    expect(deltas).toEqual([{ reasoning: '思考' }, { text: '你' }]);
    expect(out.finalText).toBe('你');
    expect(out.iterations).toBe(1);
    expect(out.reasoningSegments).toEqual(['思考']);
    expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('节流：80ms 窗口内正文增量合并为一次回调、流结束 flush 残余；思考链不足 120 字的尾段 flush', async () => {
    const { gateway } = streamingGateway([
      [
        { type: 'delta', text: 'aaaaa' },
        { type: 'delta', text: 'bbbbb' },
        { type: 'delta', text: 'ccccc' },
        { type: 'done' },
      ],
    ]);
    const deltas: AgentLoopDeltaChunk[] = [];
    const out = await runAgentLoop(
      { gateway, tools: stubTools(), logger, sleep },
      { ...BASE_INPUT, onDelta: (chunk) => deltas.push({ ...chunk }) },
    );
    // 首个增量立即回调；其后同窗口合并；流结束 flush 'bbbbbccccc'
    expect(deltas).toEqual([{ text: 'aaaaa' }, { text: 'bbbbbccccc' }]);
    expect(out.finalText).toBe('aaaaabbbbbccccc');

    const { gateway: gw2 } = streamingGateway([
      [
        { type: 'reasoning_delta', text: 'x'.repeat(130) }, // 首段立即回调
        { type: 'reasoning_delta', text: 'y'.repeat(10) }, // 未跨 120 字边界 → 留待 flush
        { type: 'done' },
      ],
    ]);
    const deltas2: AgentLoopDeltaChunk[] = [];
    await runAgentLoop(
      { gateway: gw2, tools: stubTools(), logger, sleep },
      { ...BASE_INPUT, onDelta: (chunk) => deltas2.push({ ...chunk }) },
    );
    expect(deltas2).toEqual([{ reasoning: 'x'.repeat(130) }, { reasoning: 'y'.repeat(10) }]);
  });

  it('tool_call_delta 按 index 聚合（id 覆盖、name/arguments 拼接）→ 工具执行 → 二轮流式文本', async () => {
    const tools = stubTools();
    const { gateway, calls } = streamingGateway([
      [
        { type: 'reasoning_delta', text: '先查技能' },
        {
          type: 'tool_call_delta',
          index: 0,
          payload: { id: 'call_1', type: 'function', function: { name: 'skills_', arguments: '{"li' } },
        },
        {
          type: 'tool_call_delta',
          index: 0,
          payload: { function: { name: 'list', arguments: 'mit":3}' } },
        },
        { type: 'done' },
      ],
      [{ type: 'delta', text: '共 3 项技能' }, { type: 'done', usage: { inputTokens: 8, outputTokens: 4 } }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools, logger, sleep },
      { ...BASE_INPUT, onDelta: () => {} },
    );

    expect(tools.executions).toEqual([{ name: 'skills_list', args: { limit: 3 } }]);
    expect(out.finalText).toBe('共 3 项技能');
    expect(out.toolCalls).toBe(1);
    expect(out.iterations).toBe(2);
    // 聚合结果按消息规约回填（arguments 为拼接后的完整 JSON 串）
    const assistantMsg = calls[1]?.messages[2] as { role: string; content: { toolCalls: Array<Record<string, unknown>> } };
    expect(assistantMsg.content.toolCalls).toEqual([{ id: 'call_1', name: 'skills_list', arguments: '{"limit":3}' }]);
  });

  it('多轮思考分段：工具轮 + 终轮各收一段（reasoningSegments 按轮次序）', async () => {
    const { gateway } = streamingGateway([
      [
        { type: 'reasoning_delta', text: '第一段' },
        { type: 'tool_call_delta', index: 0, payload: { id: 'c1', function: { name: 'skills_list', arguments: '{}' } } },
        { type: 'done' },
      ],
      [{ type: 'reasoning_delta', text: '第二段' }, { type: 'delta', text: '完成' }, { type: 'done' }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools: stubTools(), logger, sleep },
      { ...BASE_INPUT, onDelta: () => {} },
    );
    expect(out.reasoningSegments).toEqual(['第一段', '第二段']);
    expect(out.finalText).toBe('完成');
    expect(out.iterations).toBe(2);
  });

  it('空回复守卫：终轮空正文但有思考链 → finalText 收敛为用户提示，不再无效轮询', async () => {
    const { gateway, calls } = streamingGateway([
      [{ type: 'reasoning_delta', text: '思考占满了输出' }, { type: 'done' }],
    ]);
    const out = await runAgentLoop(
      { gateway, tools: stubTools(), logger, sleep },
      { ...BASE_INPUT, onDelta: () => {} },
    );
    expect(out.finalText).toBe(EMPTY_REPLY_HINT);
    expect(out.reasoningSegments).toEqual(['思考占满了输出']);
    expect(out.iterations).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('onDelta 回调抛错 → 只 warn 不中断，循环正常收束', async () => {
    const warn = vi.fn();
    const noisyLogger = { debug: vi.fn(), warn, info: vi.fn(), error: vi.fn() } as unknown as typeof logger;
    const { gateway } = streamingGateway([
      [
        { type: 'reasoning_delta', text: '思考' },
        { type: 'delta', text: '正文' },
        { type: 'done' },
      ],
    ]);
    const out = await runAgentLoop(
      { gateway, tools: stubTools(), logger: noisyLogger, sleep },
      {
        ...BASE_INPUT,
        onDelta: () => {
          throw new Error('consumer boom');
        },
      },
    );
    expect(out.finalText).toBe('正文');
    expect(warn).toHaveBeenCalled();
  });

  it('非流式回归：未传 onDelta → gateway 不带 stream 标志、结果形状与既有语义一致（无 reasoningSegments 键）', async () => {
    const tools = stubTools();
    const { gateway, calls } = scriptedGateway([{ text: '技能库共 1 项' }]);
    const out = await runAgentLoop({ gateway, tools, logger, sleep }, BASE_INPUT);
    expect(calls[0]?.stream).toBeUndefined();
    expect(out).toEqual({
      finalText: '技能库共 1 项',
      iterations: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: '做一件事' },
      ],
    });
    expect('reasoningSegments' in out).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 三、store：reasoning_segments 落库
// ---------------------------------------------------------------------------

describe('AgentSessionStore — reasoning_segments', () => {
  it('addMessage 带 reasoningSegments → JSON 落库；getMessages 原样读出', async () => {
    const store = new AgentSessionStore(db!);
    await store.createSession({
      id: 's-stream-1',
      title: 't',
      model: null,
      systemPrompt: null,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_message_at: null,
      userId: null,
      parentId: null,
    });
    await store.addMessage('s-stream-1', { role: 'assistant', content: '正文', reasoningSegments: ['一', '二'] });
    const items = await store.getMessages('s-stream-1');
    expect(items[0]?.reasoningSegments).toEqual(['一', '二']);
    // 不带 reasoningSegments 的消息读出不含该键
    await store.addMessage('s-stream-1', { role: 'user', content: '问' });
    const items2 = await store.getMessages('s-stream-1');
    expect('reasoningSegments' in (items2[1] ?? {})).toBe(false);
  });

  it('reasoning_segments 脏 JSON → 读取容错为键省略，不抛错', async () => {
    const store = new AgentSessionStore(db!);
    await store.createSession({
      id: 's-stream-2',
      title: 't',
      model: null,
      systemPrompt: null,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_message_at: null,
      userId: null,
      parentId: null,
    });
    const msg = await store.addMessage('s-stream-2', { role: 'assistant', content: '脏数据' });
    await db!('agent_messages').where('id', msg.id).update({ reasoning_segments: '{corrupted' });
    const items = await store.getMessages('s-stream-2');
    expect(items[0]?.content).toBe('脏数据');
    expect('reasoningSegments' in (items[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 四、Kernel 全链路（伪 OpenAI 上游：JSON / SSE 流式）
// ---------------------------------------------------------------------------

type UpstreamMode = 'text' | 'stream-text' | 'stream-tool-once' | 'stream-tool-hang';

interface RecordedUpstreamRequest {
  model: string;
  stream: boolean;
}

/** 伪上游：按 mode 以 JSON 或 SSE 帧应答（stream 请求检测 parsed.stream === true） */
class FakeStreamUpstream {
  readonly server: Server;
  port = 0;
  readonly requests: RecordedUpstreamRequest[] = [];
  mode: UpstreamMode = 'stream-text';
  private pendingRelease: (() => void) | null = null;

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; stream?: boolean };
        this.requests.push({ model: parsed.model, stream: parsed.stream === true });
        const n = this.requests.length;
        if (parsed.stream !== true) {
          this.respondJsonText(res, `回复-${n}`);
          return;
        }
        // tool-once / tool-hang：首轮即时回 tool_calls（挂起模式第二轮挂起至 release）
        if ((this.mode === 'stream-tool-once' || this.mode === 'stream-tool-hang') && n === 1) {
          this.respondStreamToolCall(res);
          return;
        }
        if (this.mode === 'stream-tool-hang' && n >= 2) {
          this.pendingRelease = () => this.respondStreamToolCall(res);
          return;
        }
        this.respondStreamText(res);
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  release(): void {
    this.pendingRelease?.();
    this.pendingRelease = null;
  }

  /** 非流式 JSON 文本回复 */
  private respondJsonText(res: ServerResponse, text: string): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'model-a',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
  }

  /** SSE 帧写出（思考链 + 正文 + usage + [DONE]） */
  private respondStreamText(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '让我想一下' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /** SSE 工具调用帧（system_info + 思考链 + usage） */
  private respondStreamToolCall(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: '需要系统信息' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'system_info', arguments: '{}' } }],
            },
          },
        ],
      })}\n\n`,
    );
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let base = '';
let upstream: FakeStreamUpstream;
let db: Knex | undefined;
let manager: AgentSessionManager;
/** 服务端连接跟踪（afterAll 诊断/兜底清理用） */
const serverSockets = new Set<import('node:net').Socket>();

const auth = { authorization: '' };

async function waitFor(what: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>);
}

async function createSession(body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/sessions',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Record<string, unknown>;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-agents-stream-'));
  upstream = new FakeStreamUpstream();
  await upstream.listen();

  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
      }),
      port: 0,
    },
  });
  await kernel.boot();

  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  auth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
  db = kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
  manager = kernel.container.resolve<AgentSessionManager>('agents.sessionManager');

  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;

  app.server.on('connection', (socket) => {
    serverSockets.add(socket);
    socket.on('close', () => serverSockets.delete(socket));
  });

  const put = await app.inject({
    method: 'PUT',
    url: '/api/v1/llm/providers',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: [
      {
        name: 'fake',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: 'sk-fake',
        models: ['model-a', 'model-b'],
      },
    ],
  });
  if (put.statusCode !== 200) throw new Error(`provider setup failed: ${put.body}`);
}, 30_000);

afterAll(async () => {
  // 客户端（undici fetch）的预连接/中止套接字可能以半开状态滞留，阻塞 server.close 的
  // 优雅等待——测试收口：显式销毁服务端仍存活的连接后再关停内核。
  for (const socket of serverSockets) socket.destroy();
  serverSockets.clear();
  await kernel?.shutdown('e2e-afterall');
  (upstream.server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  await upstream?.close();
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
}, 30_000);

describe('sendMessage onProgress（真实内核 + 伪 SSE 上游）', () => {
  it('文本流：thinking → reply → done 事件序列；done 带最终消息/usage/思考分段；落库含 reasoningSegments', async () => {
    upstream.mode = 'stream-text';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const events: ChatProgressEvent[] = [];
    const msg = await manager.sendMessage(id, '流式问候', (e) => events.push(e));

    expect(events.map((e) => e.type)).toEqual(['thinking', 'reply', 'done']);
    expect(events[0]).toMatchObject({ type: 'thinking', round: 1, segmentIndex: 1, content: '让我想一下' });
    expect(events[1]).toMatchObject({ type: 'reply', content: '你好', estimatedTokens: 1, draft: true });
    const done = events[2] as Extract<ChatProgressEvent, { type: 'done' }>;
    expect(done.message.id).toBe(msg.id);
    expect(done.message.content).toBe('你好');
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(done.reasoningSegments).toEqual(['让我想一下']);

    // 上游确实以 stream:true 被调用
    expect(upstream.requests[0]?.stream).toBe(true);

    // 最终 assistant 消息已带思考分段落库
    const items = await manager.getMessages(id);
    const assistant = items.find((m) => m.id === msg.id);
    expect(assistant).toMatchObject({ role: 'assistant', content: '你好' });
    expect(assistant?.reasoningSegments).toEqual(['让我想一下']);
  }, 20_000);

  it('工具流：tool_start(running) → tool_done(done) 中文 label；两轮思考分段 segmentIndex 递增', async () => {
    upstream.mode = 'stream-tool-once';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const events: ChatProgressEvent[] = [];
    const msg = await manager.sendMessage(id, '查系统信息', (e) => events.push(e));

    expect(events.map((e) => e.type)).toEqual([
      'thinking',
      'tool_start',
      'tool_done',
      'thinking',
      'reply',
      'done',
    ]);
    const start = (events[1] as Extract<ChatProgressEvent, { type: 'tool_start' }>).step;
    const finish = (events[2] as Extract<ChatProgressEvent, { type: 'tool_done' }>).step;
    expect(start).toMatchObject({ tool: 'system_info', label: '读取系统信息', status: 'running', argsPreview: '{}' });
    expect(typeof start.startedAt).toBe('number');
    expect(finish.id).toBe(start.id); // 同一步骤补全后二次下发
    expect(finish.status).toBe('done');
    expect(finish.resultPreview ?? '').toContain('ok');
    expect(typeof finish.endedAt).toBe('number');
    // 两轮思考：segmentIndex 1 → 2（工具步骤开启新段；第二轮为文本流缺省思考文案）
    expect(events[0]).toMatchObject({ type: 'thinking', segmentIndex: 1, content: '需要系统信息' });
    expect(events[3]).toMatchObject({ type: 'thinking', segmentIndex: 2, content: '让我想一下' });
    const done = events[5] as Extract<ChatProgressEvent, { type: 'done' }>;
    expect(done.message.content).toBe('你好');
    expect(done.reasoningSegments).toEqual(['需要系统信息', '让我想一下']);
    expect(msg.content).toBe('你好');
  }, 20_000);
});

describe('POST /messages/stream — SSE 端点', () => {

  it('端到端：响应头 + data 帧序列（thinking/reply/done）+ done 载荷；未认证 → 401（JSON 形状）', async () => {
    upstream.mode = 'stream-text';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);

    const res = await fetch(`${base}/api/v1/agents/sessions/${id}/messages/stream`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'SSE 问候' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const events = parseSseFrames(await res.text());
    expect(events.map((e) => e['type'])).toEqual(['thinking', 'reply', 'done']);
    expect(events[0]).toMatchObject({ type: 'thinking', round: 1, segmentIndex: 1, content: '让我想一下' });
    expect(events[1]).toMatchObject({ type: 'reply', content: '你好', draft: true });
    expect(events[2]).toMatchObject({ type: 'done' });
    const done = events[2] as { message: { content: string }; reasoningSegments: string[] };
    expect(done.message.content).toBe('你好');
    expect(done.reasoningSegments).toEqual(['让我想一下']);

    const unauthorized = await fetch(`${base}/api/v1/agents/sessions/${id}/messages/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x' }),
    });
    expect(unauthorized.status).toBe(401);
  }, 20_000);

  it('客户端断开 → 联动取消生成（isGenerating 收敛 false、互斥解除），恢复后可继续发送', async () => {
    upstream.mode = 'stream-tool-hang';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);

    const controller = new AbortController();
    const pending = fetch(`${base}/api/v1/agents/sessions/${id}/messages/stream`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '挂起我' }),
      signal: controller.signal,
    });
    // 首轮 tool_call 即答、第二轮挂起（已计入请求数）
    await waitFor('upstream received second request', () => upstream.requests.length >= 2);
    expect(manager.isGenerating(id)).toBe(true);

    controller.abort(); // 客户端断开 → 服务端联动 cancelGeneration
    await pending.catch(() => {});
    upstream.release(); // 挂起请求应答 → 循环在最近检查点收敛 AbortError
    await waitFor('generation converged after cancel', () => !manager.isGenerating(id));

    // 互斥解除：非流式发送恢复正常（伪上游按全局请求计数应答 回复-N）
    upstream.mode = 'text';
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/sessions/${id}/messages`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: '再来一次' },
    });
    expect(again.statusCode).toBe(200);
    expect(String((again.json() as Record<string, unknown>)['content'])).toMatch(/^回复-\d+$/);
  }, 20_000);

  it('非流式 POST messages 回归不变：JSON 应答 → 200 最终 assistant（不产生流式帧）', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/sessions/${id}/messages`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { content: '普通问候' },
    });
    expect(res.statusCode).toBe(200);
    const assistant = res.json() as Record<string, unknown>;
    expect(assistant).toMatchObject({ role: 'assistant', content: '回复-1' });
    expect(assistant['usage']).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(upstream.requests[0]?.stream).toBe(false); // 非流式路径显式 stream:false
    const items = await manager.getMessages(id);
    expect(items.map((m) => m.role)).toEqual(['user', 'assistant']);
  }, 20_000);
});
