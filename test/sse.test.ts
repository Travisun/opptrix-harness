import Fastify, { type FastifyInstance } from 'fastify';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthProviderRegistry } from '../src/kernel/auth/AuthProviderRegistry.js';
import { createAuthChecker } from '../src/kernel/auth/authProxy.js';
import { SseHub } from '../src/kernel/http/sse/hub.js';

const ROOT_TOKEN = 'root-tok-test';

interface SseConn {
  readonly res: Response;
  /** 已累积的原始 SSE 流文本（实时） */
  readonly buf: string;
  waitFor: (pred: (buf: string) => boolean, what: string, timeoutMs?: number) => Promise<void>;
  finished: () => boolean;
  abort: () => void;
}

/** 建立真实 SSE 连接：fetch + AbortController，后台泵持续读取字节流 */
async function connect(url: string): Promise<SseConn> {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream' },
  });
  let buf = '';
  let done = false;
  const reader = res.body!.getReader(); // res.body 在 Node fetch 中非空
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // abort 后 reader 抛错属预期
    } finally {
      done = true;
    }
  })();
  return {
    res,
    get buf() {
      return buf;
    },
    waitFor: async (pred, what, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!pred(buf)) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for ${what}; got: ${JSON.stringify(buf.slice(0, 500))}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    finished: () => done,
    abort: () => controller.abort(),
  };
}

describe('SseHub（真实 HTTP 服务）', () => {
  let app: FastifyInstance;
  let appLimited: FastifyInstance;
  let appBadChecker: FastifyInstance;
  let hub: SseHub;
  let hubLimited: SseHub;
  let base: string;
  let baseLimited: string;
  let baseBadChecker: string;

  beforeAll(async () => {
    const registry = new AuthProviderRegistry();
    registry.register({
      name: 'static',
      verify: async (input) =>
        input.token === 'user-tok' ? { userId: 'u1', role: 'normal', scopes: ['stream'] } : null,
    });
    const checker = createAuthChecker({ rootToken: ROOT_TOKEN, registry });

    hub = new SseHub({ checker, heartbeatMs: 50 });
    app = Fastify({ logger: false });
    hub.attach(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;

    hubLimited = new SseHub({ checker, heartbeatMs: 1000, maxClientsPerTopic: 1 });
    appLimited = Fastify({ logger: false });
    hubLimited.attach(appLimited);
    await appLimited.listen({ port: 0, host: '127.0.0.1' });
    const addr2 = appLimited.server.address();
    baseLimited = `http://127.0.0.1:${typeof addr2 === 'object' && addr2 !== null ? addr2.port : 0}`;

    // checker 抛非 HarnessError 的故障注入实例（不传 logger：可选依赖缺省不崩）
    const badChecker = async (): Promise<never> => {
      throw new Error('secret checker boom');
    };
    const hubBad = new SseHub({ checker: badChecker, heartbeatMs: 1000 });
    appBadChecker = Fastify({ logger: false });
    hubBad.attach(appBadChecker, '/bad/stream');
    await appBadChecker.listen({ port: 0, host: '127.0.0.1' });
    const addr3 = appBadChecker.server.address();
    baseBadChecker = `http://127.0.0.1:${typeof addr3 === 'object' && addr3 !== null ? addr3.port : 0}`;
  });

  afterAll(async () => {
    await hub.close();
    await hubLimited.close();
    await app.close();
    await appLimited.close();
    await appBadChecker.close();
  });

  it('未带 token → 401 HarnessError JSON', async () => {
    const res = await fetch(`${base}/api/v1/stream?topics=a`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe('HARNESS-1006');
  });

  it('连接 topics=a,b：content-type、事件帧格式（id/event/data）、clientCount、心跳', async () => {
    const conn = await connect(`${base}/api/v1/stream?topics=a,b&token=${ROOT_TOKEN}`);
    expect(conn.res.status).toBe(200);
    expect(conn.res.headers.get('content-type')).toContain('text/event-stream');
    await conn.waitFor((b) => b.includes(': connected'), 'connect comment');

    expect(hub.clientCount()).toBe(1);
    expect(hub.clientCount('a')).toBe(1);
    expect(hub.clientCount('b')).toBe(1);
    expect(hub.clientCount('not-subscribed')).toBe(0);

    hub.publish('a', 'evt.one', { hello: 1 });
    await conn.waitFor((b) => b.includes('event: evt.one'), 'frame evt.one');
    const m = /id: (\d+)\nevent: evt\.one\ndata: (.*)\n\n/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('1');
    expect(JSON.parse(m![2])).toEqual({ hello: 1 });

    // topic b 序列独立：id 从 1 开始
    hub.publish('b', 'evt.two', { x: 'y' });
    await conn.waitFor((b) => b.includes('event: evt.two'), 'frame evt.two');
    const m2 = /id: (\d+)\nevent: evt\.two\ndata: (.*)\n\n/.exec(conn.buf);
    expect(m2).not.toBeNull();
    expect(m2![1]).toBe('1');
    expect(JSON.parse(m2![2])).toEqual({ x: 'y' });

    // heartbeatMs=50 → 心跳注释行
    await conn.waitFor((b) => b.includes(': ping'), 'heartbeat');

    // 未订阅 topic 的事件不推送
    hub.publish('zzz', 'evt.other', { nope: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(conn.buf).not.toContain('evt.other');

    conn.abort();
    const deadline = Date.now() + 2000;
    while (hub.clientCount() !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hub.clientCount()).toBe(0);
    expect(hub.clientCount('a')).toBe(0);
  });

  it('未带 topics 缺省订阅 system；user token（provider 命中）也可连接', async () => {
    const conn = await connect(`${base}/api/v1/stream?token=user-tok`);
    expect(conn.res.status).toBe(200);
    await conn.waitFor((b) => b.includes(': connected'), 'connect comment');
    expect(hub.clientCount('system')).toBe(1);

    hub.publish('system', 'sys.hi', { v: 1 });
    await conn.waitFor((b) => b.includes('event: sys.hi'), 'system frame');
    const m = /id: (\d+)\nevent: sys\.hi\ndata: (.*)\n\n/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![2])).toEqual({ v: 1 });

    conn.abort();
    const deadline = Date.now() + 2000;
    while (hub.clientCount('system') !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hub.clientCount('system')).toBe(0);
  });

  it('topic 订阅超额 → 429 RATE_LIMITED（附 Retry-After: 5）', async () => {
    const first = await connect(`${baseLimited}/api/v1/stream?topics=solo&token=${ROOT_TOKEN}`);
    await first.waitFor((b) => b.includes(': connected'), 'connect comment');

    const res = await fetch(`${baseLimited}/api/v1/stream?topics=solo&token=${ROOT_TOKEN}`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('HARNESS-1004');
    expect(res.headers.get('retry-after')).toBe('5');

    first.abort();
    const deadline = Date.now() + 2000;
    while (hubLimited.clientCount('solo') !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(hubLimited.clientCount('solo')).toBe(0);
  });

  it('checker 抛非 HarnessError → 500 INTERNAL 形状，不带原始信息', async () => {
    const res = await fetch(`${baseBadChecker}/bad/stream?topics=a&token=${ROOT_TOKEN}`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string; message?: string; detail?: unknown };
    expect(body.code).toBe('HARNESS-9003');
    expect(body.message).toBe('internal error');
    expect(JSON.stringify(body)).not.toContain('secret checker boom');
  });

  it('单连接 topic 数超上限（>16）→ 400 BAD_REQUEST，detail 说明限额', async () => {
    const topics = Array.from({ length: 17 }, (_, i) => `t${i}`).join(',');
    const res = await fetch(`${base}/api/v1/stream?topics=${topics}&token=${ROOT_TOKEN}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: unknown };
    expect(body.code).toBe('HARNESS-1008');
    expect(JSON.stringify(body.detail)).toContain('16');
    expect(hub.clientCount()).toBe(0);
  });

  it('topic 名超长（>128 字符）→ 400 BAD_REQUEST', async () => {
    const res = await fetch(`${base}/api/v1/stream?topics=${'x'.repeat(129)}&token=${ROOT_TOKEN}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: unknown };
    expect(body.code).toBe('HARNESS-1008');
    expect(JSON.stringify(body.detail)).toContain('128');
    expect(hub.clientCount()).toBe(0);
  });

  it('topics 为重复 query 参数（数组形状）→ 400 BAD_REQUEST（zod 契约）', async () => {
    const res = await fetch(`${base}/api/v1/stream?topics=a&topics=b&token=${ROOT_TOKEN}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('HARNESS-1008');
  });

  it('publish data 无法序列化（循环引用）→ 不抛错、跳过该帧、后续帧正常', async () => {
    const conn = await connect(`${base}/api/v1/stream?topics=cyc&token=${ROOT_TOKEN}`);
    await conn.waitFor((b) => b.includes(': connected'), 'connect comment');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => hub.publish('cyc', 'cyclic.evt', cyclic)).not.toThrow();

    hub.publish('cyc', 'after.cyclic', { ok: 1 });
    await conn.waitFor((b) => b.includes('event: after.cyclic'), 'frame after cyclic');
    expect(conn.buf).not.toContain('cyclic.evt');
    const m = /id: (\d+)\nevent: after\.cyclic\n/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('1'); // 跳过的帧不占序列

    conn.abort();
  });

  it('close() 后连接结束、计数归零', async () => {
    const conn = await connect(`${base}/api/v1/stream?topics=bye&token=${ROOT_TOKEN}`);
    await conn.waitFor((b) => b.includes(': connected'), 'connect comment');
    expect(hub.clientCount('bye')).toBe(1);

    await hub.close();
    const deadline = Date.now() + 2000;
    while (!conn.finished() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(conn.finished()).toBe(true);
    expect(hub.clientCount()).toBe(0);

    // close 后 publish 无订阅者，不抛错
    expect(() => hub.publish('bye', 'after.close', {})).not.toThrow();
  });
});
