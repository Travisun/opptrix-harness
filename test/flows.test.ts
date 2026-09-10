/**
 * flows（传入 Webhook / FlowTrigger）集成测试——真实内核 boot + 真实 fastify + 真库。
 *
 * 覆盖：
 * - 装配冒烟：container 'flows.manager' 已登记；
 * - 端点 CRUD：201 + 一次性 secret 明文（64 hex；列表/详情不再含明文）、slug 唯一性
 *   （同名多次创建 slug 互异、格式 slugify+4 位后缀）、PATCH/DELETE（级联 + secrets 清理）、
 *   flow_type 结构校验（notify 缺 notification / llm 缺 prompt / llm 缺 gateway → 400）；
 * - 签名方案（Stripe 风格 `x-harness-signature: sha256=<hex hmac>`，crypto.createHmac 造签名）：
 *   正确 200 / 缺失 401 / 篡改 401 / rotateSecret 换钥后旧签名 401 新签名 200 / 无密钥端点跳过校验；
 * - 入站路由：disabled → 403 HARNESS-3013；未知 slug → 404 HARNESS-3004；
 * - 分派：log 事件落库 processed（digest 断言）；notify 触发真实 NotificationManager
 *   （模板占位符 {{amount}}/{{字段路径}} 渲染 + notifications 列表可见）；llm 用 mock gateway
 *   断言 prompt 组装（{{payload}} 注入 JSON）与 result {text,usage}；llm 抛错 → failed 事件；
 * - 事件列表：脱敏（无原始 payload）+ 分页（limit/before）；
 * - SSE：`flow:{endpointId}` topic 收到 flow.processed 实时帧（真实监听端口 fetch 流）。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { FlowManager, type FlowEndpointRecord, type FlowEventRecord, type FlowManagerDeps } from '../src/kernel/flow/index.js';
import { loadConfig } from '../src/kernel/config/index.js';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0、静音日志）
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let db: Knex;
let rootToken = '';
let base = '';
const auth = { authorization: '' }; // beforeAll 填充

/** FlowManager 替身读取（容器登记的是真实实例） */
function flowManager(): import('../src/kernel/flow/index.js').FlowManager {
  return kernel.container.resolve(CONTAINER_KEYS.flows);
}

/** FlowManager 域内的 llm 网关替身（boot 后注入容器 'llm' 键） */
class MockFlowGateway {
  calls: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
  reply = { text: 'mock summary', usage: { inputTokens: 11, outputTokens: 7 } };
  fail = false;
  providers = [{ name: 'mock', models: ['mock-model'] }];

  async chat(input: { model: string; messages: Array<{ role: string; content: unknown }> }): Promise<{
    text?: string;
    usage?: { inputTokens: number; outputTokens: number };
  }> {
    this.calls.push(input);
    if (this.fail) throw new Error('mock llm boom');
    return this.reply;
  }

  async getProviders(): Promise<Array<{ name: string; models: string[] }>> {
    return this.providers;
  }
}

let mockGateway: MockFlowGateway;

/** 用容器里的 mock gateway 替换 'llm' 键（FlowManager 经懒解析 getter 在调用期取到 mock） */
function installMockGateway(): void {
  mockGateway = new MockFlowGateway();
  kernel.container.forget(CONTAINER_KEYS.llm);
  kernel.container.instance(CONTAINER_KEYS.llm, mockGateway);
}

/** Stripe 风格签名头构造（crypto.createHmac） */
function signatureOf(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

/** 公开入站 POST（body 以原始字符串发送，保证签名与字节一致） */
function postHook(slug: string, body: string, headers: Record<string, string> = {}): ReturnType<typeof app.inject> {
  return app.inject({
    method: 'POST',
    url: `/hooks/flow/${slug}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

/** 创建端点便捷方法（返回含一次性 secret 的响应体） */
async function createEndpoint(payload: Record<string, unknown>): Promise<{ status: number; body: FlowEndpointRecord & { secret?: string } }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/flows/endpoints', headers: auth, payload });
  return { status: res.statusCode, body: res.json() as FlowEndpointRecord & { secret?: string } };
}

/** 创建并返回 { endpoint, secret }（默认 log 型） */
async function create(name: string, flowType: 'log' | 'notify' | 'llm', extra: Record<string, unknown> = {}): Promise<{
  ep: FlowEndpointRecord;
  secret: string;
}> {
  const { body } = await createEndpoint({ name, flowType, ...extra });
  expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
  return { ep: body, secret: body.secret as string };
}

const tick = (ms = 8): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-flows-'));
  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
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
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await kernel?.shutdown('flows-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('flows 装配与管理面鉴权', () => {
  it('boot 后容器登记 flows.manager（CONTAINER_KEYS.flows）', () => {
    expect(kernel.container.has(CONTAINER_KEYS.flows)).toBe(true);
    expect(flowManager()).toBeDefined();
  });

  it('管理面无 token → 401（GET/POST/DELETE 全部）', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/flows/endpoints' });
    expect(get.statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/api/v1/flows/endpoints', payload: { name: 'x', flowType: 'log' } });
    expect(post.statusCode).toBe(401);
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/flows/endpoints/no-such' });
    expect(del.statusCode).toBe(401);
  });
});

describe('端点 CRUD 与 secret 一次性', () => {
  it('POST 创建 log 端点 → 201 + secret 明文（64 hex）+ slug 自动生成 + secretRef 引用', async () => {
    const { status, body } = await createEndpoint({ name: 'Audit Hook', flowType: 'log' });
    expect(status).toBe(201);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.slug).toMatch(/^audit-hook-[0-9a-f]{4}$/);
    expect(body.secretRef).toBe(`flow.${body.id}.secret`);
    expect(body.enabled).toBe(true);
    expect(body.flowType).toBe('log');
    expect(body.llmPrompt).toBeNull();
  });

  it('secret 一次性：GET 列表与详情都不含明文 secret（只有 secretRef）', async () => {
    const { ep } = await create('One Shot', 'log');
    const list = await app.inject({ method: 'GET', url: '/api/v1/flows/endpoints', headers: auth });
    expect(list.statusCode).toBe(200);
    for (const item of list.json() as Array<FlowEndpointRecord & { secret?: string }>) {
      expect(item.secret).toBeUndefined();
      expect(item.secretRef).toMatch(/^flow\.[0-9a-f-]{36}\.secret$/);
    }
    const got = await app.inject({ method: 'GET', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { secret?: string }).secret).toBeUndefined();
  });

  it('slug 唯一性：同名多次创建 slug 互异且格式一致（slugify + 4 位随机后缀）', async () => {
    const slugs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { ep } = await create('Stripe Callback', 'log');
      slugs.push(ep.slug);
      expect(ep.slug).toMatch(/^stripe-callback-[0-9a-f]{4}$/);
    }
    expect(new Set(slugs).size).toBe(3);
  });

  it('PATCH 更新 name/enabled；未知 id → 404 HARNESS-3004', async () => {
    const { ep } = await create('Patch Me', 'log');
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/flows/endpoints/${ep.id}`,
      headers: auth,
      payload: { name: 'Patched', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: ep.id, name: 'Patched', enabled: false });
    // 复原，后续用例继续用该端点
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/flows/endpoints/${ep.id}`,
      headers: auth,
      payload: { enabled: true },
    });
    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/v1/flows/endpoints/${randomUUID()}`,
      headers: auth,
      payload: { name: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  it('flow_type 结构校验：notify 缺 notification → 400；llm 缺 llmPrompt → 400；非法 flowType → 400', async () => {
    const noCfg = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/endpoints',
      headers: auth,
      payload: { name: 'bad notify', flowType: 'notify' },
    });
    expect(noCfg.statusCode).toBe(400);
    expect(noCfg.json()).toMatchObject({ code: 'HARNESS-1009' });

    const noPrompt = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/endpoints',
      headers: auth,
      payload: { name: 'bad llm', flowType: 'llm' },
    });
    expect(noPrompt.statusCode).toBe(400);

    const badType = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/endpoints',
      headers: auth,
      payload: { name: 'bad type', flowType: 'crypto' },
    });
    expect(badType.statusCode).toBe(400);
  });

  it('gateway 缺失时创建 llm 端点 → 400 VALIDATION_FAILED（依赖 fail-fast）', async () => {
    kernel.container.forget(CONTAINER_KEYS.llm); // 容器摘除 llm → 懒解析 getter 返回 undefined
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/flows/endpoints',
        headers: auth,
        payload: { name: 'needs gateway', flowType: 'llm', llmPrompt: 'p' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'HARNESS-1009' });
    } finally {
      installMockGateway(); // 后续 llm 用例使用 mock gateway
    }
  });
});

describe('签名校验（Stripe 风格 HMAC）', () => {
  let ep: FlowEndpointRecord;
  let secret: string;
  const body = JSON.stringify({ event: 'invoice.paid', amount: 4200 });

  it('正确签名 → 200 {eventId, status:processed}', async () => {
    ({ ep, secret } = await create('Signed Hook', 'log'));
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed' });
    expect((res.json() as { eventId: string }).eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('缺失签名头 → 401 HARNESS-1006', async () => {
    const res = await postHook(ep.slug, body);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006' });
  });

  it('篡改签名 → 401（时序安全比较路径）', async () => {
    const forged = `sha256=${'0'.repeat(64)}`;
    const res = await postHook(ep.slug, body, { 'x-harness-signature': forged });
    expect(res.statusCode).toBe(401);
    // 换一个 body 但沿用旧签名同样拒绝（签名绑定字节）
    const res2 = await postHook(ep.slug, `${body} `, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res2.statusCode).toBe(401);
  });

  it('rotateSecret 换钥：旧签名 401、新签名 200、返回一次性新明文', async () => {
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/flows/endpoints/${ep.id}/rotate-secret`,
      headers: auth,
    });
    expect(rotated.statusCode).toBe(200);
    const newSecret = (rotated.json() as { secret: string }).secret;
    expect(newSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(newSecret).not.toBe(secret);

    const oldSig = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(oldSig.statusCode).toBe(401);
    const newSig = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(newSecret, body) });
    expect(newSig.statusCode).toBe(200);
    secret = newSecret; // 供本 describe 后续断言
  });

  it('无 secret 端点跳过签名校验（secret_ref 置空后无签名头也放行）', async () => {
    const { ep: openEp } = await create('Open Hook', 'log');
    await db('flow_endpoints').where('id', openEp.id).update({ secret_ref: null });
    const res = await postHook(openEp.slug, JSON.stringify({ hello: 'world' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed' });
  });

  it('disabled 端点 → 403 HARNESS-3013；未知 slug → 404 HARNESS-3004', async () => {
    const { ep: offEp } = await create('Disabled Hook', 'log');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/flows/endpoints/${offEp.id}`,
      headers: auth,
      payload: { enabled: false },
    });
    const forbidden = await postHook(offEp.slug, body);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'HARNESS-3013' });

    const missing = await postHook('no-such-slug', body);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'HARNESS-3004' });
  });
});

describe('flow_type 分派：log / notify / llm', () => {
  it('flow=log：事件落库 processed，digest = sha256(rawBody)，sourceIp 记录，result={logged:true}', async () => {
    const { ep, secret } = await create('Log Flow', 'log');
    const body = JSON.stringify({ kind: 'log-event', n: 1 });
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);
    const { eventId } = res.json() as { eventId: string };

    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events`,
      headers: auth,
    });
    expect(events.statusCode).toBe(200);
    const list = events.json() as FlowEventRecord[];
    const hit = list.find((e) => e.id === eventId);
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({
      endpointId: ep.id,
      status: 'processed',
      sourceIp: '127.0.0.1',
      result: { logged: true },
      error: null,
    });
    const crypto = await import('node:crypto');
    expect(hit!.payloadDigest).toBe(
      crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
    );
  });

  it('flow=notify（正确签名）：模板占位符按 payload 渲染，真实 NotificationManager 入库可见 + 事件 result.notificationId', async () => {
    const { ep, secret } = await create('Notify Flow Signed', 'notify', {
      flowConfig: {
        notification: {
          title: '支付提醒 {{amount}} 元',
          body: '订单 {{data.orderId}}',
          level: 'warn',
          data: { from: 'flow', orderId: '{{data.orderId}}' },
        },
      },
    });
    const body = JSON.stringify({ amount: 42, data: { orderId: 'A-1' } });
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ id: string; title: string; body: string; level: string; data: unknown }> }).items;
    const hit = items.find((n) => n.title === '支付提醒 42 元');
    expect(hit).toBeDefined();
    expect(hit!.body).toBe('订单 A-1');
    expect(hit!.level).toBe('warn');
    expect(hit!.data).toEqual({ from: 'flow', orderId: 'A-1' });

    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events`,
      headers: auth,
    });
    const recorded = (events.json() as FlowEventRecord[]).find((e) => e.status === 'processed');
    expect(recorded?.result).toMatchObject({ notificationId: hit!.id });
  });

  it('flow=llm：mock gateway 收到 {{payload}} 渲染后的 prompt 与指定 model；事件 result={text,usage}', async () => {
    const { ep, secret } = await create('Llm Flow', 'llm', {
      llmPrompt: 'Summarize this event: {{payload}}',
      flowConfig: { model: 'mock-model' },
    });
    const body = JSON.stringify({ orderId: 'X-9', total: 995 });
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed' });

    expect(mockGateway.calls).toHaveLength(1);
    expect(mockGateway.calls[0]).toMatchObject({ model: 'mock-model' });
    expect(mockGateway.calls[0]!.messages[0]!.role).toBe('user');
    expect(mockGateway.calls[0]!.messages[0]!.content).toBe('Summarize this event: {"orderId":"X-9","total":995}');

    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events`,
      headers: auth,
    });
    const recorded = (events.json() as FlowEventRecord[])[0]!;
    expect(recorded.status).toBe('processed');
    expect(recorded.result).toEqual({ text: 'mock summary', usage: { inputTokens: 11, outputTokens: 7 } });
  });

  it('flow=llm 抛错 → 事件 failed + error（HTTP 恒 200，不外溢）', async () => {
    const { ep, secret } = await create('Llm Flow Fail', 'llm', {
      llmPrompt: 'doomed {{payload}}',
      flowConfig: { model: 'mock-model' },
    });
    mockGateway.fail = true;
    try {
      const body = '{"x":1}';
      const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'failed' });
      const events = await app.inject({
        method: 'GET',
        url: `/api/v1/flows/endpoints/${ep.id}/events`,
        headers: auth,
      });
      const recorded = (events.json() as FlowEventRecord[])[0]!;
      expect(recorded.status).toBe('failed');
      expect(recorded.error).toContain('mock llm boom');
      expect(recorded.result).toBeNull();
    } finally {
      mockGateway.fail = false;
    }
  });
});

describe('事件列表脱敏与分页', () => {
  it('limit/before 分页 + 全程不泄原始 payload（只有 digest/status/result/error）', async () => {
    const { ep, secret } = await create('Paged Hook', 'log');
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++) {
      const body = JSON.stringify({ seq: i });
      bodies.push(body);
      const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
      expect(res.statusCode).toBe(200);
      await tick(); // 错开 created_at，保证分页游标稳定
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events?limit=2`,
      headers: auth,
    });
    expect(page1.statusCode).toBe(200);
    const first = page1.json() as FlowEventRecord[];
    expect(first).toHaveLength(2);
    expect(first[0]!.createdAt).toBeGreaterThanOrEqual(first[1]!.createdAt);

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events?limit=2&before=${first[1]!.createdAt}`,
      headers: auth,
    });
    const second = page2.json() as FlowEventRecord[];
    expect(second).toHaveLength(2);
    const ids = new Set([...first, ...second].map((e) => e.id));
    expect(ids.size).toBe(4); // 两页无重叠

    for (const event of [...first, ...second]) {
      expect(Object.keys(event)).not.toContain('payload');
      expect(Object.keys(event)).not.toContain('raw');
      expect(event.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // 最旧一条的 digest 与对应原始字节一致（sha256）
    const crypto = await import('node:crypto');
    const oldestBody = bodies[0]!;
    const oldest = [...first, ...second].at(-1)!;
    expect(oldest.payloadDigest).toBe(crypto.createHash('sha256').update(Buffer.from(oldestBody, 'utf8')).digest('hex'));
  });
});

describe('SSE 推送与删除级联', () => {
  it('SSE topic flow:{endpointId} 收到 flow.processed 实时帧（≤5s）', async () => {
    const { ep, secret } = await create('Sse Hook', 'log');
    const controller = new AbortController();
    let buf = '';
    try {
      const res = await fetch(`${base}/api/v1/stream?topics=flow:${ep.id}&token=${rootToken}`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
          }
        } catch {
          // abort 后 reader 抛错属预期
        }
      })();
      const connectedDeadline = Date.now() + 3000;
      while (!buf.includes(': connected')) {
        if (Date.now() > connectedDeadline) throw new Error(`timeout waiting for SSE connect; got: ${buf}`);
        await tick(10);
      }

      const body = JSON.stringify({ ping: 'sse' });
      const posted = postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
      const frameDeadline = Date.now() + 5000;
      while (!buf.includes('event: flow.processed')) {
        if (Date.now() > frameDeadline) throw new Error(`timeout waiting for flow.processed frame; got: ${buf.slice(0, 400)}`);
        await tick(10);
      }
      await posted;
      expect(buf).toContain('"endpointId"');
      expect(buf).toContain(`"slug":"${ep.slug}"`);
    } finally {
      controller.abort();
    }
  });

  it('DELETE 级联：端点/事件/secrets 全清理，入站 slug 失效 404', async () => {
    const { ep, secret } = await create('Doomed Hook', 'log');
    const body = JSON.stringify({ bye: true });
    await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ deleted: true });

    const got = await app.inject({ method: 'GET', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth });
    expect(got.statusCode).toBe(404);
    const events = await app.inject({ method: 'GET', url: `/api/v1/flows/endpoints/${ep.id}/events`, headers: auth });
    expect(events.statusCode).toBe(404);
    const inbound = await postHook(ep.slug, body);
    expect(inbound.statusCode).toBe(404);

    // secrets 层清理：密钥本体一并抹除
    const secrets = kernel.container.resolve<{ get(n: string): Promise<string | null> }>(CONTAINER_KEYS.secrets);
    await expect(secrets.get(`flow.${ep.id}.secret`)).resolves.toBeNull();
  });

  it('rotate/delete 未知 id → 404 HARNESS-3004', async () => {
    const missing = randomUUID();
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/flows/endpoints/${missing}/rotate-secret`,
      headers: auth,
    });
    expect(rotated.statusCode).toBe(404);
    expect(rotated.json()).toMatchObject({ code: 'HARNESS-3004' });
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/flows/endpoints/${missing}`, headers: auth });
    expect(del.statusCode).toBe(404);
  });

  it('无密钥端点 rotate → 回填 secretRef（此后入站强制验签）', async () => {
    const { ep } = await create('Open Then Sealed', 'log');
    await db('flow_endpoints').where('id', ep.id).update({ secret_ref: null });
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/flows/endpoints/${ep.id}/rotate-secret`,
      headers: auth,
    });
    expect(rotated.statusCode).toBe(200);
    const secret = (rotated.json() as { secret: string }).secret;

    const got = await app.inject({ method: 'GET', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth });
    expect((got.json() as FlowEndpointRecord).secretRef).toBe(`flow.${ep.id}.secret`);

    const unsigned = await postHook(ep.slug, '{}');
    expect(unsigned.statusCode).toBe(401);
    const body = JSON.stringify({ sealed: true });
    const signed = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(signed.statusCode).toBe(200);
  });

  it('入站载荷边界：空体与非 JSON 体都受理（digest 按原始字节）', async () => {
    const { ep, secret } = await create('Edge Payload Hook', 'log');
    const empty = await postHook(ep.slug, '', { 'x-harness-signature': signatureOf(secret, '') });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ status: 'processed' });

    const text = 'plain-text-not-json';
    const raw = await app.inject({
      method: 'POST',
      url: `/hooks/flow/${ep.slug}`,
      headers: { 'content-type': 'text/plain', 'x-harness-signature': signatureOf(secret, text) },
      payload: text,
    });
    expect(raw.statusCode).toBe(200);
    const events = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/endpoints/${ep.id}/events`,
      headers: auth,
    });
    const list = events.json() as FlowEventRecord[];
    const crypto = await import('node:crypto');
    const byDigest = new Map(list.map((e) => [e.payloadDigest, e]));
    expect(byDigest.get(crypto.createHash('sha256').update(text, 'utf8').digest('hex'))).toBeDefined();
    expect(byDigest.get(crypto.createHash('sha256').update('', 'utf8').digest('hex'))).toBeDefined();
  });

  it('PATCH flow_type 切换与结构校验（llm 需提示词/网关，notify 需合法 notification 配置）', async () => {
    const { ep } = await create('Shape Shifter', 'log');
    const patch = (payload: Record<string, unknown>): ReturnType<typeof app.inject> =>
      app.inject({ method: 'PATCH', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth, payload });

    // log → llm（mock gateway 已在容器；带提示词）
    const toLlm = await patch({ flowType: 'llm', llmPrompt: 'hello {{payload}}' });
    expect(toLlm.statusCode).toBe(200);
    expect(toLlm.json()).toMatchObject({ flowType: 'llm', llmPrompt: 'hello {{payload}}' });

    // llm 提示词擦除（null）→ 校验失败；空白提示词 → manager 侧 trim 校验失败
    const erase = await patch({ llmPrompt: null });
    expect(erase.statusCode).toBe(400);
    const blank = await patch({ llmPrompt: '   ' });
    expect(blank.statusCode).toBe(400);

    // llm → notify：合法配置通过；非法配置与非法 flowType 拒绝
    const toNotify = await patch({ flowType: 'notify', flowConfig: { notification: { title: 't' } } });
    expect(toNotify.statusCode).toBe(200);
    expect(toNotify.json()).toMatchObject({ flowType: 'notify' });
    const badNotifyCfg = await patch({ flowConfig: { nope: 1 } });
    expect(badNotifyCfg.statusCode).toBe(400);
    const badType = await patch({ flowType: 'crypto' });
    expect(badType.statusCode).toBe(400);
    const badName = await patch({ name: '' });
    expect(badName.statusCode).toBe(400);

    // llm flowConfig 形状校验（model 必须是字符串）
    const { ep: llmEp } = await create('Llm Config Guard', 'llm', { llmPrompt: 'p', flowConfig: { model: 'm' } });
    const badModel = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/endpoints',
      headers: auth,
      payload: { name: 'bad model', flowType: 'llm', llmPrompt: 'p', flowConfig: { model: 42 } },
    });
    expect(badModel.statusCode).toBe(400);
    expect(llmEp.flowConfig).toMatchObject({ model: 'm' });
  });

  it('notify data 深度模板渲染（数组/标量/缺失字段）+ 脏 flow_config 容错', async () => {
    const { ep, secret } = await create('Deep Render', 'notify', {
      flowConfig: {
        notification: {
          title: '订单 {{data.orderId}}',
          body: '缺失 {{ghost}}、嵌套标量 {{amount.x}}、全量 {{payload}}',
          data: { items: ['{{data.a}}', 7], n: 3, ok: true },
        },
      },
    });
    const body = JSON.stringify({ amount: 5, data: { orderId: 'B-2', a: 'v' } });
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    const hit = (list.json() as { items: Array<{ title: string; body: string; data: unknown }> }).items.find(
      (n) => n.title === '订单 B-2',
    );
    expect(hit).toBeDefined();
    expect(hit!.body).toContain('缺失 ');            // 缺失字段 → 空串
    expect(hit!.body).toContain('全量 {"amount":5');  // {{payload}} → 整包 JSON
    expect(hit!.data).toEqual({ items: ['v', 7], n: 3, ok: true });

    // 脏 flow_config（库外直改）：GET 容错置 null，dispatch 兜底为 failed 事件
    await db('flow_endpoints').where('id', ep.id).update({ flow_config: '{broken-json' });
    const got = await app.inject({ method: 'GET', url: `/api/v1/flows/endpoints/${ep.id}`, headers: auth });
    expect((got.json() as FlowEndpointRecord).flowConfig).toBeNull();
    const res2 = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res2.json()).toMatchObject({ status: 'failed' });
  });

  it('llm 模型回退：flowConfig 无 model 时取第一可用 provider 缺省模型', async () => {
    const { ep, secret } = await create('Model Fallback', 'llm', { llmPrompt: 'fallback {{payload}}' });
    const body = '{"q":1}';
    const res = await postHook(ep.slug, body, { 'x-harness-signature': signatureOf(secret, body) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processed' });
    expect(mockGateway.calls.at(-1)).toMatchObject({ model: 'mock-model' });
  });
});

describe('manager 直连分支（防御性校验与运行期降级）', () => {
  /** 裸装配 FlowManager：无 gateway/notifications/publish（覆盖依赖缺失与降级分支） */
  function bareManager(overrides: Partial<FlowManagerDeps> = {}): FlowManager {
    const secrets = kernel.container.resolve<FlowManagerDeps['secrets']>(CONTAINER_KEYS.secrets);
    return new FlowManager({
      db,
      secrets,
      logger: pino({ level: 'silent' }),
      ...overrides,
    });
  }

  it('依赖缺失 fail-fast：裸装配下创建 llm/notify、坏 flowType、坏 flowConfig、坏 name → VALIDATION_FAILED', async () => {
    const bare = bareManager();
    await expect(bare.createEndpoint({ name: 'x', flowType: 'llm', llmPrompt: 'p' })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(
      bare.createEndpoint({ name: 'x', flowType: 'notify', flowConfig: { notification: { title: 't' } } }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(bare.createEndpoint({ name: 'x', flowType: 'crypto' as never })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(bare.createEndpoint({ name: 'x', flowType: 'llm', llmPrompt: 'p', flowConfig: { model: 1 } })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(bare.createEndpoint({ name: '', flowType: 'log' })).rejects.toMatchObject({ code: 'HARNESS-1009' });

    // update 侧同款守卫：log → llm/notify 在依赖缺失时拒绝
    const { ep } = await create('Bare Update Guard', 'log');
    await expect(bare.updateEndpoint(ep.id, { flowType: 'llm', llmPrompt: 'p' })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(
      bare.updateEndpoint(ep.id, { flowType: 'notify', flowConfig: { notification: { title: 't' } } }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(bare.updateEndpoint(randomUUID(), { name: 'ghost' })).resolves.toBeNull();
    const { ep: namedEp } = await create('Bare Name Guard', 'log');
    await expect(bare.updateEndpoint(namedEp.id, { name: '' })).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });

  it('运行期降级：notify/llm 依赖缺失或模型不可解析 → 事件 failed（HTTP 不受影响）', async () => {
    const bare = bareManager();
    // notify 型运行期缺 notifications → failed 事件
    const { ep: notifyEp } = await create('Runtime Degraded Notify', 'log');
    await db('flow_endpoints').where('id', notifyEp.id).update({
      flow_type: 'notify',
      flow_config: JSON.stringify({ notification: { title: 't' } }),
      secret_ref: null,
    });
    await expect(bare.handleInbound(notifyEp.slug, Buffer.from('{}', 'utf8'), {}, '127.0.0.1')).resolves.toMatchObject({
      status: 'failed',
    });

    // llm 型运行期缺 gateway → failed 事件
    const { ep: llmEp } = await create('Runtime Degraded Llm', 'log');
    await db('flow_endpoints').where('id', llmEp.id).update({
      flow_type: 'llm',
      llm_prompt: 'p {{payload}}',
      secret_ref: null,
    });
    await expect(bare.handleInbound(llmEp.slug, Buffer.from('{}', 'utf8'), {}, '127.0.0.1')).resolves.toMatchObject({
      status: 'failed',
    });

    // llm 型模型不可解析（provider 目录抛错）→ failed 事件
    const failingGateway = {
      chat: async () => ({ text: 'never' }),
      getProviders: () => {
        throw new Error('provider directory offline');
      },
    };
    const bareWithGateway = bareManager({ gateway: () => failingGateway });
    await expect(
      bareWithGateway.handleInbound(llmEp.slug, Buffer.from('{"k":1}', 'utf8'), {}, '127.0.0.1'),
    ).resolves.toMatchObject({ status: 'failed' });
    const events = await bare.listEvents(llmEp.id, { limit: 1 });
    // getProviders 抛错被 #resolveModel 捕获记 warn，事件 error 收敛为 LLM_NOT_CONFIGURED 语义
    expect(events[0]!.error).toContain('no llm model resolvable');
  });

  it('publish 抛错不影响入站结果（fire-and-forget 门面兜底）', async () => {
    const bare = bareManager({
      publish: () => {
        throw new Error('sse down');
      },
    });
    const { ep } = await create('Publish Throw', 'log');
    await db('flow_endpoints').where('id', ep.id).update({ secret_ref: null });
    await expect(bare.handleInbound(ep.slug, Buffer.from('{"ok":1}', 'utf8'), {}, '127.0.0.1')).resolves.toMatchObject({
      status: 'processed',
    });
  });
});
