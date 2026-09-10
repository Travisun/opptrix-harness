/**
 * Agent 会话子系统 E2E（真实 Kernel boot + REST + SSE + 真实 LLM 网关 → 本地伪 OpenAI 上游）。
 *
 * 覆盖：
 * - 装配：'agents.sessionManager' 登记进容器；REST /api/v1/agents/sessions* 全部已认证；
 * - 会话 CRUD：创建（缺省标题 '新对话'）/ 列表（last_message_at 降序 + status 过滤）/
 *   读取 / PATCH（改名 + 归档，非法 status 400）/ DELETE（级联删消息）；
 * - sendMessage 全链路：user 消息落库 → 上下文组装（历史 + 当前消息）→ 模型解析链
 *   （会话显式 → settings 'agents.defaultModel' → 第一可用 provider models[0]）→
 *   Agent 循环（伪上游 tool_calls → 真实系统工具 system_info → 最终文本）→
 *   assistant/工具轨迹落库 → SSE `agent:{sessionId}` 实时推送；
 * - 分页（?before= 消息 id 游标 + ?limit=）、并发互斥（429）、cancelGeneration（202 + 503 收敛）、
 *   脏数据容错（tool_calls/usage 非法 JSON 不拖垮读取）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import type { AgentSessionManager } from '../src/kernel/agents/session.js';
import { AgentSessionStore } from '../src/kernel/agents/session-store.js';
import { createSessionRunner } from '../src/kernel/agents/session-runner.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { SettingsService } from '../src/kernel/storage/settings.js';

const silentLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// 伪 OpenAI 上游（openai-chat 协议；脚本化四种行为 + 请求录制）
// ---------------------------------------------------------------------------

interface RecordedRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

class FakeUpstream {
  readonly server: Server;
  port = 0;
  readonly requests: RecordedRequest[] = [];
  /**
   * text：恒即时文本回复；
   * tool-once：首个请求回 tool_calls（system_info），其后即时文本（单轮工具循环收束）；
   * tool-loop：首个请求即时 tool_calls，其后挂起至 release() 再回 tool_calls（取消演练）；
   * hang-first：首个请求挂起至 release() 再回文本（并发互斥演练）。
   */
  mode: 'text' | 'tool-once' | 'tool-loop' | 'hang-first' = 'text';
  private hungFirst = false;
  private pendingRelease: (() => void) | null = null;

  constructor() {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; messages: RecordedRequest['messages'] };
        this.requests.push({ model: parsed.model, messages: parsed.messages });
        const n = this.requests.length;
        if (this.mode === 'tool-once' && n === 1) {
          this.respondToolCall(res, parsed.model, n);
          return;
        }
        if (this.mode === 'tool-loop') {
          if (n === 1) this.respondToolCall(res, parsed.model, n);
          else this.pendingRelease = () => this.respondToolCall(res, parsed.model, n);
          return;
        }
        if (this.mode === 'hang-first' && !this.hungFirst) {
          this.hungFirst = true;
          this.pendingRelease = () => this.respondText(res, parsed.model, '挂起已释放');
          return;
        }
        this.respondText(res, parsed.model, `回复-${n}`);
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

  /** 释放挂起的请求（未挂起时 no-op；释放后以对应脚本行为应答） */
  release(): void {
    this.pendingRelease?.();
    this.pendingRelease = null;
  }

  private respondText(res: ServerResponse, model: string, text: string): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
    );
  }

  private respondToolCall(res: ServerResponse, model: string, n: number): void {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-tool-${n}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: `call_${n}`, type: 'function', function: { name: 'system_info', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0）+ 伪上游 + providers 配置
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let base = '';
let upstream: FakeUpstream;
let settings: SettingsService;
let store: AgentSessionStore;

const auth = { authorization: '' };

async function waitFor(what: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-agent-session-'));
  upstream = new FakeUpstream();
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
  settings = kernel.container.resolve<SettingsService>(CONTAINER_KEYS.settings);
  store = new AgentSessionStore(kernel.container.resolve<Knex>(CONTAINER_KEYS.db));

  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;

  // 经 REST 配置伪供应商（PUT providers：apiKey 明文自动转存 secrets，配置只留引用）
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
  await kernel?.shutdown('e2e-afterall');
  await upstream?.close();
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

/** 创建会话的便捷封装 */
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

/** 发送消息的便捷封装（返回原始响应） */
function postMessage(id: string, content: string): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/agents/sessions/${id}/messages`,
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { content },
  });
}

/** 读取会话消息列表 */
async function getMessages(id: string, query = ''): Promise<Array<Record<string, unknown>>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/agents/sessions/${id}/messages${query}`,
    headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 装配与鉴权
// ---------------------------------------------------------------------------

describe('装配与鉴权', () => {
  it('boot 后 agents.sessionManager 登记进容器；REST 路由已挂载', async () => {
    expect(kernel.container.has('agents.sessionManager')).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/agents/sessions', headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it('全部路由未认证 → 401', async () => {
    for (const spec of [
      { method: 'POST', url: '/api/v1/agents/sessions' },
      { method: 'GET', url: '/api/v1/agents/sessions' },
      { method: 'GET', url: '/api/v1/agents/sessions/no-such' },
      { method: 'PATCH', url: '/api/v1/agents/sessions/no-such' },
      { method: 'DELETE', url: '/api/v1/agents/sessions/no-such' },
      { method: 'GET', url: '/api/v1/agents/sessions/no-such/messages' },
      { method: 'POST', url: '/api/v1/agents/sessions/no-such/messages' },
      { method: 'POST', url: '/api/v1/agents/sessions/no-such/cancel' },
    ] as const) {
      const res = await app.inject({ method: spec.method, url: spec.url });
      expect(res.statusCode, `${spec.method} ${spec.url}`).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// 会话 CRUD
// ---------------------------------------------------------------------------

describe('会话 CRUD', () => {
  it('POST 创建：缺省标题 新对话 / 显式 title+model+systemPrompt 回显；status 恒 active', async () => {
    const bare = await createSession({});
    expect(bare).toMatchObject({ title: '新对话', status: 'active', model: null, systemPrompt: null });
    expect(typeof bare['created_at']).toBe('number');
    expect(bare['last_message_at']).toBeNull();

    const full = await createSession({ title: '发布检查', model: 'model-a', systemPrompt: '你是测试助手' });
    expect(full).toMatchObject({ title: '发布检查', model: 'model-a', systemPrompt: '你是测试助手' });
  });

  it('GET 列表按 last_message_at 降序；?status=archived 过滤；非法 status → 400', async () => {
    const s1 = await createSession({ title: '排序一' });
    const s2 = await createSession({ title: '排序二' });
    const s3 = await createSession({ title: '排序三' });
    const base1 = Date.now();
    // 显式时间戳保证 last_message_at 严格有序（s2 最新、s1 其次、s3 无消息）
    await store.addMessage(String(s1['id']), { role: 'user', content: 's1 消息' }, base1);
    await store.addMessage(String(s2['id']), { role: 'user', content: 's2 消息' }, base1 + 5);

    const list = await app.inject({ method: 'GET', url: '/api/v1/agents/sessions', headers: auth });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<Record<string, unknown>>;
    const titles = items.map((r) => r['title']);
    expect(titles.indexOf('排序二')).toBeLessThan(titles.indexOf('排序一'));
    expect(titles.indexOf('排序一')).toBeLessThan(titles.indexOf('排序三')); // 无消息的靠后

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/sessions/${String(s3['id'])}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { status: 'archived' },
    });
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/sessions?status=archived',
      headers: auth,
    });
    const archivedItems = filtered.json() as Array<Record<string, unknown>>;
    expect(archivedItems.length).toBeGreaterThanOrEqual(1);
    expect(archivedItems.every((r) => r['status'] === 'archived')).toBe(true);

    const bad = await app.inject({ method: 'GET', url: '/api/v1/agents/sessions?status=bogus', headers: auth });
    expect(bad.statusCode).toBe(400);
  });

  it('GET 单个：200；未知 id → 404 HARNESS-3004', async () => {
    const created = await createSession({});
    const got = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${String(created['id'])}`,
      headers: auth,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: created['id'] });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/agents/sessions/no-such-id', headers: auth });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  it('PATCH 改名 + 归档 → updated_at 刷新；空 body → 400；未知 id → 404', async () => {
    const created = await createSession({ title: '旧标题' });
    const id = String(created['id']);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/sessions/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: '新标题', status: 'archived' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id, title: '新标题', status: 'archived' });
    expect((patched.json() as Record<string, unknown>)['updated_at']).toBeGreaterThanOrEqual(
      created['updated_at'] as number,
    );

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/agents/sessions/${id}`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/agents/sessions/no-such-id',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { title: 'x' },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE 级联删消息：会话与消息一并消失；未知 id → 404', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const sent = await postMessage(id, '删除前的一条消息');
    expect(sent.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/agents/sessions/${id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, deleted: true });

    const gone = await app.inject({ method: 'GET', url: `/api/v1/agents/sessions/${id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
    const msgs = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${id}/messages`,
      headers: auth,
    });
    expect(msgs.statusCode).toBe(404);

    const again = await app.inject({ method: 'DELETE', url: `/api/v1/agents/sessions/${id}`, headers: auth });
    expect(again.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// sendMessage 全链路（模型解析链 / 上下文组装 / 工具循环）
// ---------------------------------------------------------------------------

describe('sendMessage 全链路', () => {
  it('空 content → 400；未知会话 → 404；非法 JSON body → 400', async () => {
    upstream.mode = 'text';
    const created = await createSession({});
    const id = String(created['id']);
    const empty = await postMessage(id, '   ');
    expect(empty.statusCode).toBe(400);

    const missing = await postMessage('no-such-id', 'hi');
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/sessions/${id}/messages`,
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('模型解析链第三级：无显式 model 且无 settings → 第一可用 provider models[0]', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    await settings.set('agents.defaultModel', '');
    const created = await createSession({});
    const res = await postMessage(String(created['id']), '默认链');
    expect(res.statusCode).toBe(200);
    expect(upstream.requests[0]?.model).toBe('model-a');
  });

  it('模型解析链第二级：settings agents.defaultModel 优先生效', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    await settings.set('agents.defaultModel', 'model-b');
    const created = await createSession({});
    const res = await postMessage(String(created['id']), 'settings 链');
    expect(res.statusCode).toBe(200);
    expect(upstream.requests[0]?.model).toBe('model-b');
    await settings.set('agents.defaultModel', ''); // 还原，避免影响后续用例
  });

  it('模型解析链第一级：会话显式 model 最优先', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    await settings.set('agents.defaultModel', 'model-b');
    const created = await createSession({ model: 'model-a' });
    const res = await postMessage(String(created['id']), '显式链');
    expect(res.statusCode).toBe(200);
    expect(upstream.requests[0]?.model).toBe('model-a');
    await settings.set('agents.defaultModel', '');
  });

  it('文本回复落库：user+assistant 成对、usage 落最终 assistant、last_message_at 触碰', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    const created = await createSession({ systemPrompt: '你是简洁助手' });
    const id = String(created['id']);
    const res = await postMessage(id, '你好');
    expect(res.statusCode).toBe(200);
    const assistant = res.json() as Record<string, unknown>;
    expect(assistant).toMatchObject({ session_id: id, role: 'assistant', content: '回复-1' });
    expect(assistant['usage']).toMatchObject({ inputTokens: 12, outputTokens: 7 });

    const items = await getMessages(id);
    expect(items.map((m) => m['role'])).toEqual(['user', 'assistant']);
    expect(items[0]).toMatchObject({ content: '你好' });
    expect(items[1]).toMatchObject({ content: '回复-1' });
    // 会话时间戳被触碰
    const session = await app.inject({ method: 'GET', url: `/api/v1/agents/sessions/${id}`, headers: auth });
    expect((session.json() as Record<string, unknown>)['last_message_at']).toBeTypeOf('number');
  });

  it('上下文组装：第二条消息的 prompt 携带历史（首条问答）+ 当前消息标记', async () => {
    upstream.mode = 'text';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    await postMessage(id, '第一条消息');
    await postMessage(id, '第二条消息');
    expect(upstream.requests.length).toBe(2);
    const secondPrompt = upstream.requests[1]?.messages.find((m) => m.role === 'user')?.content;
    expect(typeof secondPrompt).toBe('string');
    const text = String(secondPrompt);
    expect(text).toContain('用户：第一条消息');
    expect(text).toContain('助手：回复-1');
    expect(text).toContain('（当前用户消息）第二条消息');
  });

  it('工具循环（tool-once）：伪上游 tool_calls → 真实系统工具 system_info → 最终文本；轨迹落库', async () => {
    upstream.mode = 'tool-once';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const res = await postMessage(id, '帮我看看系统信息');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'assistant', content: '回复-2' });

    const items = await getMessages(id);
    expect(items.map((m) => m['role'])).toEqual(['user', 'assistant', 'system', 'assistant']);
    const toolTurn = items[1] as Record<string, unknown>;
    const toolCalls = toolTurn['toolCalls'] as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ name: 'system_info' });
    expect(toolTurn['content']).toBe('');
    // tool 结果以 system 角色落库（真实内核 system_info 执行：ok:true + info）
    const systemMsg = items[2] as Record<string, unknown>;
    expect(JSON.parse(systemMsg['content'] as string)).toMatchObject({ ok: true });
    // 最终 assistant 带累计 usage（两轮：20+12 / 4+7）
    expect(items[3]).toMatchObject({ role: 'assistant', content: '回复-2' });
    expect((items[3] as Record<string, unknown>)['usage']).toMatchObject({ inputTokens: 32, outputTokens: 11 });

    // 下一轮上下文：工具调用轮以「（调用了工具 …）」标注进入历史（system 工具结果不进历史）
    upstream.mode = 'text';
    upstream.requests.length = 0;
    await postMessage(id, '再问一次');
    const nextPrompt = upstream.requests[0]?.messages.find((m) => m.role === 'user')?.content;
    expect(String(nextPrompt)).toContain('助手：（调用了工具 system_info）');
    expect(String(nextPrompt)).toContain('助手：回复-2');
    expect(String(nextPrompt)).not.toContain('ok":true'); // tool 结果文本不进历史
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 分页 / 并发 / 取消 / SSE
// ---------------------------------------------------------------------------

describe('分页与并发', () => {
  it('消息分页：limit + before（消息 id 游标）升序翻页；未知游标 → 空数组；limit 超限 → 400', async () => {
    const created = await createSession({});
    const id = String(created['id']);
    const baseTs = Date.now();
    // 显式时间戳：与消息序严格一致（同毫秒写入按 id 决胜会破坏断言）
    for (let i = 1; i <= 7; i++) {
      await store.addMessage(id, { role: 'user', content: `分页消息-${i}` }, baseTs + i);
    }

    // 无游标 = 最新一页（升序返回）；游标 = 当前页最旧消息的 id（向前翻页）
    const p1 = await getMessages(id, '?limit=3');
    expect(p1.map((m) => m['content'])).toEqual(['分页消息-5', '分页消息-6', '分页消息-7']);

    const cursor = String(p1[0]?.['id']);
    const p2 = await getMessages(id, `?limit=3&before=${cursor}`);
    expect(p2.map((m) => m['content'])).toEqual(['分页消息-2', '分页消息-3', '分页消息-4']);

    const p3 = await getMessages(id, `?limit=3&before=${String(p2[0]?.['id'])}`);
    expect(p3.map((m) => m['content'])).toEqual(['分页消息-1']);

    const badCursor = await getMessages(id, '?before=no-such-cursor');
    expect(badCursor).toEqual([]);

    const over = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${id}/messages?limit=999`,
      headers: auth,
    });
    expect(over.statusCode).toBe(400);
  });

  it('同会话并发互斥：生成中再发 → 429 TOO_MANY_CONCURRENT；释放后首个请求完成', async () => {
    upstream.mode = 'hang-first';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const first = postMessage(id, '挂起我');
    await waitFor('upstream received first', () => upstream.requests.length >= 1);

    const second = await postMessage(id, '并发我');
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'HARNESS-1011' });

    upstream.release();
    const done = await first;
    expect(done.statusCode).toBe(200);
    expect((done.json() as Record<string, unknown>)['content']).toBe('挂起已释放');
  }, 20_000);
});

describe('取消与 SSE', () => {
  it('cancelGeneration：生成中取消 → POST messages 收敛 503、无最终 assistant；幂等 cancelled=false；未知会话 404', async () => {
    upstream.mode = 'tool-loop';
    upstream.requests.length = 0;
    const created = await createSession({});
    const id = String(created['id']);
    const pending = postMessage(id, '取消我');
    // 首轮即时 tool_calls；第二轮挂起（已计入 requests）——此刻取消落在下一中断检查点之前
    await waitFor('upstream received second request', () => upstream.requests.length >= 2);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/sessions/${id}/cancel`,
      headers: auth,
    });
    expect(cancel.statusCode).toBe(202);
    expect(cancel.json()).toMatchObject({ ok: true, cancelled: true });

    upstream.release(); // 挂起请求应答 tool_calls → 循环在最近检查点抛 AbortError
    const done = await pending;
    expect(done.statusCode).toBe(503);
    expect(done.json()).toMatchObject({ code: 'HARNESS-1003' });

    // user 消息已落库，但没有带 usage 的最终 assistant 文本（中断点在工具执行/下一轮 chat 前）
    const items = await getMessages(id, '?limit=500');
    expect(items[0]).toMatchObject({ role: 'user', content: '取消我' });
    expect(items.some((m) => m['role'] === 'assistant' && m['usage'] !== undefined)).toBe(false);

    // 幂等：无进行中生成时 cancelled=false
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/sessions/${id}/cancel`,
      headers: auth,
    });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ ok: true, cancelled: false });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/sessions/no-such-id/cancel',
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
  }, 20_000);

  it('SSE agent:{sessionId}：user 与最终 assistant 消息实时推送（message.created 帧）', async () => {
    upstream.mode = 'text';
    const created = await createSession({});
    const id = String(created['id']);

    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/stream?topics=agent:${id}&token=${rootToken}`, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${rootToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body?.getReader();
    let streamed = '';
    const decoder = new TextDecoder();
    const readPromise = (async () => {
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        streamed += decoder.decode(chunk.value);
        if (streamed.split('event: message.created').length >= 3 && streamed.includes('回复-')) break;
      }
    })();

    await postMessage(id, 'SSE 推送我');
    await readPromise;
    controller.abort();

    expect(streamed.split('event: message.created').length).toBeGreaterThanOrEqual(3);
    expect(streamed).toContain('"content":"SSE 推送我"');
    expect(streamed).toContain('"content":"回复-');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 存储容错（脏 JSON 不拖垮读取）
// ---------------------------------------------------------------------------

describe('存储容错', () => {
  it('tool_calls / usage 非法 JSON → 读取时字段缺省，不抛错', async () => {
    const created = await createSession({});
    const id = String(created['id']);
    const msg = await store.addMessage(id, { role: 'assistant', content: '脏数据' });
    const db = kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
    await db('agent_messages').where('id', msg.id).update({ tool_calls: '{corrupted', usage: '{bad' });

    const items = await getMessages(id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: msg.id, content: '脏数据' });
    expect(items[0]['toolCalls']).toBeUndefined();
    expect(items[0]['usage']).toBeUndefined();
  });

  it('ensureTables 失败容错：抛 DB_ERROR（HARNESS-4003）且重置缓存允许重试', async () => {
    let fail = true;
    const broken = {
      schema: {
        hasTable: async () => {
          if (fail) throw new Error('boom');
          return true;
        },
        // 旧库加列守卫（user_id/parent_id）的列存在性检查：桩返回 true = 新列已就绪
        hasColumn: async () => true,
      },
    } as unknown as Knex;
    const failing = new AgentSessionStore(broken);
    await expect(failing.ensureTables()).rejects.toMatchObject({ code: 'HARNESS-4003' });
    // 缓存已重置：故障解除后第二次调用重建建表 Promise 并成功（未重置则会复用同一个 rejected promise）
    fail = false;
    await expect(failing.ensureTables()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 单元补充：manager.addMessage/isGenerating 与 session-runner 的工具桥
// ---------------------------------------------------------------------------

describe('manager 与 runner 单元补充', () => {
  it('manager.addMessage 直接落库并触碰会话；isGenerating 平时为 false', async () => {
    const manager = kernel.container.resolve<AgentSessionManager>('agents.sessionManager');
    const created = await createSession({});
    const id = String(created['id']);
    const msg = await manager.addMessage(id, { role: 'user', content: '直接落库' });
    expect(msg).toMatchObject({ session_id: id, role: 'user', content: '直接落库' });
    expect(await manager.getMessages(id)).toHaveLength(1);
    expect(manager.isGenerating(id)).toBe(false);
  });

  it('session-runner：系统工具运行时未 attach → execute 收敛 isError 且循环继续收束', async () => {
    let calls = 0;
    const runner = createSessionRunner({
      gateway: {
        chat: async () => {
          calls += 1;
          if (calls === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'any_tool', argsJson: '{}' }] };
          return { text: '收束' };
        },
      },
      systemRuntime: () => undefined,
      logger: silentLogger,
      sleep: async () => {},
    });
    const result = await runner({ agentId: 'sess-unit', prompt: 'p' });
    expect(result.finalText).toBe('收束');
    expect(result.toolCalls).toBe(1); // 参数解析成功即计数；execute 收敛为 isError 结果
    expect(JSON.stringify(result.messages)).toContain('system tool runtime is not attached yet');
  });

  it('session-runner：有运行时 → 目录投影 + 审计 ctx（agentId/depth）透传', async () => {
    const audits: Array<{ agentId?: string; depth?: number }> = [];
    let calls = 0;
    const runner = createSessionRunner({
      gateway: {
        chat: async () => {
          calls += 1;
          if (calls === 1) return { text: '', toolCalls: [{ id: 'c1', name: 'stub', argsJson: '{"x":1}' }] };
          return { text: '收束' };
        },
      },
      systemRuntime: () => ({
        listTools: () => [{ name: 'stub', description: 'd', inputSchema: {} }],
        call: async (_name, _args, audit) => {
          audits.push(audit ?? {});
          return { ok: true };
        },
      }),
      logger: silentLogger,
      sleep: async () => {},
    });
    const result = await runner({ agentId: 'sess-audit', depth: 0, prompt: 'p' });
    expect(audits).toEqual([{ agentId: 'sess-audit', depth: 0 }]);
    expect(result.toolCalls).toBe(1);
    expect(result.finalText).toBe('收束');
  });
});
