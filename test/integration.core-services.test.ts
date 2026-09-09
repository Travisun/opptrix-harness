/**
 * 核心服务总装配 E2E（真实 Kernel + 真实 createHttpServer + 真库 + 临时 dataDir）。
 *
 * 覆盖 createCoreServices 总装配后的完整链路：
 * channels CRUD → chat 消息（REST + 入站 webhook）→ notifications（直发 + SSE 实时帧）→
 * files（multipart 上传/下载）→ tasks（echo 线程池全链路）→ cron（建任务 + runNow + history）→
 * shutdown 清理（容器 db 键被 forget）。
 *
 * root 令牌从 kernel.container.resolve('auth.identity') 取（HARNESS_PERSIST_ROOT_TOKEN='0'，
 * 每次启动新生成）；HTTP 交互经 fastify.inject，SSE 用真实监听端口的 fetch 流。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0 = 系统分配、静音日志、单工作线程）
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let base = '';

const auth = { authorization: '' }; // beforeAll 中填充

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-core-e2e-'));
  kernel = new Kernel({
    // loadConfig 校验 port ≥1，此处直接覆写 port=0（系统分配临时端口；KernelOptions.config 即为此设计）
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

  const addr = app.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await kernel?.shutdown('e2e-afterall'); // 幂等：测试内已 shutdown 时直接返回
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

/** 轮询直到 pred 成立或超时（毫秒） */
async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'，与 @fastify/multipart 对齐） */
function multipartBody(filename: string, mime: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----opptrixe2eboundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// ---------------------------------------------------------------------------
// 装配冒烟：核心服务已登记 + 驱动清单
// ---------------------------------------------------------------------------

describe('核心服务总装配 E2E', () => {
  it('boot 后核心服务登记进容器（channels.registry/notify/chat/files/tasks），drivers API 列出全部内置驱动', async () => {
    for (const key of [CONTAINER_KEYS.channels, CONTAINER_KEYS.notify, CONTAINER_KEYS.chat, CONTAINER_KEYS.files, CONTAINER_KEYS.tasks]) {
      expect(kernel.container.has(key)).toBe(true);
      expect(kernel.container.resolve(key)).toBeDefined();
    }
    const drivers = await app.inject({ method: 'GET', url: '/api/v1/notifications/drivers', headers: auth });
    expect(drivers.statusCode).toBe(200);
    expect(drivers.json()).toEqual({
      notification: ['console', 'email', 'inbox', 'webhook'],
      // webhook/email 纯出站桥 + 平台连接器 ×5（chat-platforms：出站驱动 + 入站回调）
      chat: ['dingtalk', 'email', 'feishu', 'slack', 'telegram', 'webhook', 'wecom'],
    });
  });

  // -------------------------------------------------------------------------
  // channels
  // -------------------------------------------------------------------------

  it('POST /api/v1/channels 建 general（admin/root）→ 201 + slug/webhookToken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: auth,
      payload: { name: 'General', slug: 'general' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ slug: 'general', name: 'General', type: 'public' });
    expect(body.webhookToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('GET /api/v1/channels 列表包含 general', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/channels', headers: auth });
    expect(res.statusCode).toBe(200);
    const slugs = (res.json() as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain('general');
  });

  // -------------------------------------------------------------------------
  // chat 消息 + 入站 webhook
  // -------------------------------------------------------------------------

  let inboundToken = '';

  it('POST messages（text）→ 201 blocked=false，GET messages 有该消息', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/channels/general/messages',
      headers: auth,
      payload: { type: 'text', text: 'hello from e2e' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ blocked: false, message: { senderType: 'user', senderId: 'root', content: { type: 'text', text: 'hello from e2e' } } });

    const list = await app.inject({ method: 'GET', url: '/api/v1/channels/general/messages', headers: auth });
    expect(list.statusCode).toBe(200);
    const messages = list.json();
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.at(-1)).toMatchObject({ senderType: 'user', senderId: 'root', content: { type: 'text', text: 'hello from e2e' } });
  });

  it('POST /hooks/chat/:token 入站 → 202，消息落库 senderType=webhook（token 取自频道 webhookToken 字段）', async () => {
    const ch = await app.inject({ method: 'GET', url: '/api/v1/channels/general', headers: auth });
    expect(ch.statusCode).toBe(200);
    inboundToken = ch.json().webhookToken as string;
    expect(inboundToken).toBeTruthy();

    const hook = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${inboundToken}`,
      payload: { text: 'inbound via webhook', sender: 'ci-bot' },
    });
    expect(hook.statusCode).toBe(202);
    expect(hook.json()).toMatchObject({ accepted: true, blocked: false });

    const list = await app.inject({ method: 'GET', url: '/api/v1/channels/general/messages', headers: auth });
    const messages = list.json() as Array<{ senderType: string; senderId: string; content: { text?: string } }>;
    const inbound = messages.find((m) => m.senderType === 'webhook');
    expect(inbound).toBeDefined();
    expect(inbound).toMatchObject({ senderId: 'ci-bot', content: { type: 'text', text: 'inbound via webhook' } });
  });

  // -------------------------------------------------------------------------
  // notifications（直发 + 列表/未读）
  // -------------------------------------------------------------------------

  it('POST /api/v1/notifications/send（无 channels）→ 201；GET notifications 可见且 unread≥1', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/send',
      headers: auth,
      payload: { title: 'e2e notification', body: 'wired by core-services', level: 'info' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ title: 'e2e notification', level: 'info' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { items: Array<{ title: string }>; unread: number };
    expect(body.items.some((n) => n.title === 'e2e notification')).toBe(true);
    expect(body.unread).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // SSE 实时帧（真实监听端口 fetch 流）
  // -------------------------------------------------------------------------

  it('SSE /api/v1/stream?topics=notifications 收到 notification.created 帧（≤5s）', async () => {
    const controller = new AbortController();
    let buf = '';
    try {
      const res = await fetch(`${base}/api/v1/stream?topics=notifications&token=${rootToken}`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader(); // Node fetch 的 body 非空
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

      // 等连接就绪帧，再触发直发
      const connectedDeadline = Date.now() + 3000;
      while (!buf.includes(': connected')) {
        if (Date.now() > connectedDeadline) throw new Error(`timeout waiting for SSE connect; got: ${buf}`);
        await new Promise((r) => setTimeout(r, 10));
      }

      const fired = app.inject({
        method: 'POST',
        url: '/api/v1/notifications/send',
        headers: auth,
        payload: { title: 'sse-fanout', body: 'over the wire' },
      });
      const frameDeadline = Date.now() + 5000;
      while (!buf.includes('event: notification.created')) {
        if (Date.now() > frameDeadline) throw new Error(`timeout waiting for notification.created frame; got: ${buf.slice(0, 400)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      await fired;
      expect(buf).toContain('data: {"id"');
      expect(buf).toContain('sse-fanout');
    } finally {
      controller.abort();
    }
  });

  // -------------------------------------------------------------------------
  // files（multipart 上传/下载）
  // -------------------------------------------------------------------------

  it('POST /api/v1/files multipart 上传 → 201；GET /:id 内容逐字节一致', async () => {
    const content = Buffer.from('e2e file payload — core services 上传往返 ✓', 'utf8');
    const { payload, headers } = multipartBody('e2e.txt', 'text/plain', content);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { ...auth, ...headers },
      payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const record = uploaded.json();
    expect(record).toMatchObject({ origName: 'e2e.txt', mime: 'text/plain', size: content.byteLength, visibility: 'private' });

    const downloaded = await app.inject({ method: 'GET', url: `/api/v1/files/${record.id}`, headers: auth });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(content);
  });

  // -------------------------------------------------------------------------
  // tasks（echo 线程池全链路）
  // -------------------------------------------------------------------------

  it('POST /api/v1/tasks/dispatch echo → 201；轮询 GET /:id 至 done（≤10s）且 result 正确', async () => {
    const dispatched = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: auth,
      payload: { name: 'echo', args: { ping: 1 } },
    });
    expect(dispatched.statusCode).toBe(201);
    const created = dispatched.json();
    expect(created).toMatchObject({ name: 'echo', status: 'queued' });

    await waitFor('task done', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${created.id}`, headers: auth });
      return res.statusCode === 200 && res.json().status === 'done';
    }, 10_000);

    const done = await app.inject({ method: 'GET', url: `/api/v1/tasks/${created.id}`, headers: auth });
    const record = done.json();
    expect(record).toMatchObject({ status: 'done', result: { ping: 1 } });
    expect(record.startedAt).not.toBeNull();
    expect(record.finishedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // cron（建任务 + runNow + history）
  // -------------------------------------------------------------------------

  it('POST /api/v1/cron 建 job → 201；runNow → 202；history 轮询出现执行记录（≤3s）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: auth,
      payload: { name: 'e2e-tick', expr: '0 4 * * *', payload: { source: 'e2e' } },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json();
    expect(job).toMatchObject({ name: 'e2e-tick', expr: '0 4 * * *', enabled: true });

    const run = await app.inject({ method: 'POST', url: `/api/v1/cron/${job.id}/run`, headers: auth });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ started: true });

    await waitFor('cron history entry', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/cron/${job.id}/history`, headers: auth });
      return res.statusCode === 200 && (res.json() as unknown[]).length >= 1;
    }, 3_000);

    const history = await app.inject({ method: 'GET', url: `/api/v1/cron/${job.id}/history`, headers: auth });
    const entries = history.json() as Array<{ ok: boolean; durationMs: number | null; error: string | null }>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({ ok: true, error: null });
  });

  // -------------------------------------------------------------------------
  // shutdown 清理（放最后：shutdown 是终态）
  // -------------------------------------------------------------------------

  it('shutdown 后容器中 db 键已被 forget（http 同样清理），state=stopped', async () => {
    await kernel.shutdown('e2e-complete');
    expect(kernel.state()).toBe('stopped');
    expect(kernel.container.has(CONTAINER_KEYS.db)).toBe(false);
    expect(kernel.container.has(CONTAINER_KEYS.http)).toBe(false);
  });
});
