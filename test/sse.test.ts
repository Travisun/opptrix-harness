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
async function connect(url: string, extraHeaders: Record<string, string> = {}): Promise<SseConn> {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream', ...extraHeaders },
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

/** 轮询等待某 topic 订阅数到位（断开清理是异步事件） */
async function waitClientCount(hub: SseHub, topic: string, expected: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hub.clientCount(topic) !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(hub.clientCount(topic)).toBe(expected);
}

describe('SseHub Last-Event-ID 断线重放', () => {
  let appA: FastifyInstance;
  let appBuf2: FastifyInstance;
  let appNoReplay: FastifyInstance;
  let hubA: SseHub;
  let hubBuf2: SseHub;
  let hubNoReplay: SseHub;
  let baseA: string;
  let baseBuf2: string;
  let baseNoReplay: string;

  beforeAll(async () => {
    const registry = new AuthProviderRegistry();
    registry.register({
      name: 'static',
      verify: async (input) =>
        input.token === 'user-tok' ? { userId: 'u1', role: 'normal', scopes: ['stream'] } : null,
    });
    const checker = createAuthChecker({ rootToken: ROOT_TOKEN, registry });

    const listen = async (hub: SseHub): Promise<{ app: FastifyInstance; base: string }> => {
      const app = Fastify({ logger: false });
      hub.attach(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address();
      return { app, base: `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}` };
    };

    // hubA：默认重放（缓冲 100 条/topic）；hubBuf2：缓冲仅 2 条；hubNoReplay：关闭重放
    hubA = new SseHub({ checker, heartbeatMs: 1000 });
    ({ app: appA, base: baseA } = await listen(hubA));
    hubBuf2 = new SseHub({ checker, heartbeatMs: 1000, replayBufferPerTopic: 2 });
    ({ app: appBuf2, base: baseBuf2 } = await listen(hubBuf2));
    hubNoReplay = new SseHub({ checker, heartbeatMs: 1000, replay: false });
    ({ app: appNoReplay, base: baseNoReplay } = await listen(hubNoReplay));
  });

  afterAll(async () => {
    await hubA.close();
    await hubBuf2.close();
    await hubNoReplay.close();
    await appA.close();
    await appBuf2.close();
    await appNoReplay.close();
  });

  it('发布 3 条→断开→再连带 lastEventId=topic:1 → 按序重放 2、3 并无缝衔接实时流（不重复）', async () => {
    hubA.publish('rp-solo', 'rp.evt', { n: 1 });
    hubA.publish('rp-solo', 'rp.evt', { n: 2 });
    hubA.publish('rp-solo', 'rp.evt', { n: 3 }); // 无订阅者也照常入缓冲

    const conn = await connect(`${baseA}/api/v1/stream?topics=rp-solo&token=${ROOT_TOKEN}&lastEventId=rp-solo:1`);
    expect(conn.res.status).toBe(200);
    await conn.waitFor((b) => b.includes('"n":3'), 'replay frames 2,3');

    hubA.publish('rp-solo', 'rp.evt', { n: 4 });
    await conn.waitFor((b) => b.includes('"n":4'), 'live frame n=4');

    const frames = [...conn.buf.matchAll(/id: (\d+)\nevent: rp\.evt\ndata: (\{"n":\d+\})\n\n/g)];
    expect(frames.map((f) => f[1])).toEqual(['2', '3', '4']); // 重放 2、3 后实时 4，序列连续不重复
    expect(frames.map((f) => JSON.parse(f[2] ?? '{}'))).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
    expect((conn.buf.match(/: replay\n/g) ?? []).length).toBe(2); // 每个重放帧前置 ': replay'
    expect(conn.buf).not.toContain('"n":1'); // 游标之前的帧不重放
    expect(conn.buf).not.toContain('replay-gap');

    conn.abort();
    await waitClientCount(hubA, 'rp-solo', 0);
  });

  it('seq 过旧（缓冲只留 2 条）→ 先收 replay-gap（含 latestSeq），不做部分重放，实时照常', async () => {
    for (const n of [1, 2, 3, 4]) hubBuf2.publish('sb', 'sb.evt', { n }); // 缓冲只留 seq 3、4

    const conn = await connect(`${baseBuf2}/api/v1/stream?topics=sb&token=${ROOT_TOKEN}&lastEventId=sb:1`);
    await conn.waitFor((b) => b.includes('replay-gap'), 'replay-gap frame');
    const m = /event: replay-gap\ndata: (.*)\n\n/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1] ?? '{}')).toEqual({ topic: 'sb', latestSeq: 4 });
    expect(conn.buf).not.toContain(': replay\n'); // gap 时不做部分重放（'event: replay-gap' 不算重放注释行）
    expect(conn.buf).not.toContain('sb.evt'); // gap 时不做部分重放

    hubBuf2.publish('sb', 'sb.evt', { n: 5 });
    await conn.waitFor((b) => b.includes('"n":5'), 'live frame after gap');

    conn.abort();
    await waitClientCount(hubBuf2, 'sb', 0);
  });

  it('多 topic 游标 lastEventId=ma:0,mb:0 → 各 topic 独立重放缓冲内全部事件', async () => {
    hubA.publish('rp-ma', 'm.evt', { t: 'ma', n: 1 });
    hubA.publish('rp-mb', 'm.evt', { t: 'mb', n: 1 });
    hubA.publish('rp-ma', 'm.evt', { t: 'ma', n: 2 });

    const conn = await connect(
      `${baseA}/api/v1/stream?topics=rp-ma,rp-mb&token=${ROOT_TOKEN}&lastEventId=rp-ma:0,rp-mb:0`,
    );
    await conn.waitFor((b) => b.includes('"t":"mb","n":1'), 'all replay frames');
    expect(conn.buf).toContain('id: 1\nevent: m.evt\ndata: {"t":"ma","n":1}');
    expect(conn.buf).toContain('id: 2\nevent: m.evt\ndata: {"t":"ma","n":2}');
    expect(conn.buf).toContain('id: 1\nevent: m.evt\ndata: {"t":"mb","n":1}');
    expect(conn.buf).not.toContain('replay-gap');

    hubA.publish('rp-mb', 'm.evt', { t: 'mb', n: 2 });
    await conn.waitFor((b) => b.includes('"t":"mb","n":2'), 'live mb frame');
    const m = /id: (\d+)\nevent: m\.evt\ndata: \{"t":"mb","n":2\}/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('2'); // 实时帧紧接该 topic 已重放序列，不重复

    conn.abort();
    await waitClientCount(hubA, 'rp-ma', 0);
    await waitClientCount(hubA, 'rp-mb', 0);
  });

  it('标准 Last-Event-ID 头（单 topic）：裸 seq 与 topic:seq 两种形式均触发重放', async () => {
    hubA.publish('rp-hdr', 'hdr.evt', { n: 1 });
    hubA.publish('rp-hdr', 'hdr.evt', { n: 2 });
    const conn = await connect(`${baseA}/api/v1/stream?topics=rp-hdr&token=${ROOT_TOKEN}`, {
      'last-event-id': '1', // EventSource 重连回发的就是帧 id（裸数字）
    });
    await conn.waitFor((b) => b.includes('"n":2'), 'replayed frame (bare header)');
    expect(conn.buf).toContain(': replay\nid: 2\nevent: hdr.evt\ndata: {"n":2}');
    expect(conn.buf).not.toContain('"n":1');
    expect(conn.buf).not.toContain('replay-gap');
    conn.abort();
    await waitClientCount(hubA, 'rp-hdr', 0);

    hubA.publish('rp-hdr2', 'hdr2.evt', { n: 1 });
    hubA.publish('rp-hdr2', 'hdr2.evt', { n: 2 });
    const conn2 = await connect(`${baseA}/api/v1/stream?topics=rp-hdr2&token=${ROOT_TOKEN}`, {
      'last-event-id': 'rp-hdr2:1',
    });
    await conn2.waitFor((b) => b.includes('"n":2'), 'replayed frame (prefixed header)');
    expect(conn2.buf).toContain(': replay\nid: 2\nevent: hdr2.evt\ndata: {"n":2}');
    conn2.abort();
    await waitClientCount(hubA, 'rp-hdr2', 0);
  });

  it('replay:false → 零行为变化：不缓冲、不重放、无 replay-gap、无订阅者发布不占序列', async () => {
    const c1 = await connect(`${baseNoReplay}/api/v1/stream?topics=nr&token=${ROOT_TOKEN}`);
    await c1.waitFor((b) => b.includes(': connected'), 'connected');
    hubNoReplay.publish('nr', 'nr.evt', { n: 1 });
    hubNoReplay.publish('nr', 'nr.evt', { n: 2 });
    await c1.waitFor((b) => b.includes('"n":2'), 'live frames');
    c1.abort();
    await waitClientCount(hubNoReplay, 'nr', 0);

    hubNoReplay.publish('nr', 'nr.evt', { n: 3 }); // 无订阅者：旧语义下序列不前移

    const c2 = await connect(`${baseNoReplay}/api/v1/stream?topics=nr&token=${ROOT_TOKEN}&lastEventId=nr:2`);
    await c2.waitFor((b) => b.includes(': connected'), 'reconnected');
    expect(c2.buf).not.toContain('nr.evt');
    expect(c2.buf).not.toContain(': replay');
    expect(c2.buf).not.toContain('replay-gap');

    hubNoReplay.publish('nr', 'nr.evt', { n: 4 });
    await c2.waitFor((b) => b.includes('"n":4'), 'live only');
    const m = /id: (\d+)\nevent: nr\.evt\ndata: \{"n":4\}/.exec(c2.buf);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('3'); // 断连窗口内的发布未占序列（旧语义保持）

    c2.abort();
    await waitClientCount(hubNoReplay, 'nr', 0);
  });

  it('客户端 seq 超前（如服务端重启序列重置）→ replay-gap 且 latestSeq 为服务端最新', async () => {
    hubA.publish('gap-ahead', 'ga.evt', { n: 1 });
    const conn = await connect(`${baseA}/api/v1/stream?topics=gap-ahead&token=${ROOT_TOKEN}&lastEventId=gap-ahead:99`);
    await conn.waitFor((b) => b.includes('replay-gap'), 'gap frame');
    const m = /event: replay-gap\ndata: (.*)\n\n/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1] ?? '{}')).toEqual({ topic: 'gap-ahead', latestSeq: 1 });
    expect(conn.buf).not.toContain('event: ga.evt'); // 无可重放帧

    hubA.publish('gap-ahead', 'ga.evt', { n: 2 });
    await conn.waitFor((b) => b.includes('"n":2'), 'live after ahead-gap');

    conn.abort();
    await waitClientCount(hubA, 'gap-ahead', 0);
  });

  it('游标恰为最新 seq → 无重放无 gap，直接进实时流', async () => {
    hubA.publish('rp-cu', 'cu.evt', { n: 1 });
    const conn = await connect(`${baseA}/api/v1/stream?topics=rp-cu&token=${ROOT_TOKEN}&lastEventId=rp-cu:1`);
    await conn.waitFor((b) => b.includes(': connected'), 'connected');
    expect(conn.buf).not.toContain('cu.evt');
    expect(conn.buf).not.toContain('replay');

    hubA.publish('rp-cu', 'cu.evt', { n: 2 });
    await conn.waitFor((b) => b.includes('"n":2'), 'live frame');
    const m = /id: (\d+)\nevent: cu\.evt\ndata: \{"n":2\}/.exec(conn.buf);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('2');

    conn.abort();
    await waitClientCount(hubA, 'rp-cu', 0);
  });

  it('非法游标条目（非数字 seq / 空段 / 多 topic 下裸数字）→ 忽略：不重放不报错', async () => {
    hubA.publish('rp-bad', 'bad.evt', { n: 1 });
    const conn = await connect(
      `${baseA}/api/v1/stream?topics=rp-bad,rp-bad2&token=${ROOT_TOKEN}&lastEventId=rp-bad:abc,,5`,
    );
    await conn.waitFor((b) => b.includes(': connected'), 'connected');
    expect(conn.buf).not.toContain('bad.evt');
    expect(conn.buf).not.toContain('replay-gap');

    hubA.publish('rp-bad', 'bad.evt', { n: 2 });
    await conn.waitFor((b) => b.includes('"n":2'), 'live frame');

    conn.abort();
    await waitClientCount(hubA, 'rp-bad', 0);
  });

  it('topic 名含冒号（chat:rp）→ lastEventId 按最后一个冒号切分 topic 与 seq', async () => {
    hubA.publish('chat:rp', 'chat.message.created', { n: 1 });
    hubA.publish('chat:rp', 'chat.message.created', { n: 2 });
    const conn = await connect(`${baseA}/api/v1/stream?topics=chat:rp&token=${ROOT_TOKEN}&lastEventId=chat:rp:1`);
    await conn.waitFor((b) => b.includes('"n":2'), 'replayed chat frame');
    expect(conn.buf).toContain(': replay\nid: 2\nevent: chat.message.created\ndata: {"n":2}');
    expect(conn.buf).not.toContain('"n":1');

    conn.abort();
    await waitClientCount(hubA, 'chat:rp', 0);
  });

  it('缓冲 topic 数达上限（256）→ 淘汰最久未发布 topic：被淘汰者 replay-gap，新 topic 仍可重放', async () => {
    // 放在 describe 末尾执行：灌满并淘汰会清掉此前用例的缓冲（用例此时均已结束，互不影响）
    for (let i = 0; i < 256; i++) {
      hubA.publish(`evict-${i}`, 'ev.evt', { n: 1 });
      hubA.publish(`evict-${i}`, 'ev.evt', { n: 2 });
    }
    hubA.publish('rp-keep', 'ev.evt', { n: 1 }); // 第 257 个 topic → 淘汰最久未发布的 evict-0
    hubA.publish('rp-keep', 'ev.evt', { n: 2 });

    const evicted = await connect(`${baseA}/api/v1/stream?topics=evict-0&token=${ROOT_TOKEN}&lastEventId=evict-0:1`);
    await evicted.waitFor((b) => b.includes('replay-gap'), 'gap after eviction');
    const m = /event: replay-gap\ndata: (.*)\n\n/.exec(evicted.buf);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1] ?? '{}')).toEqual({ topic: 'evict-0', latestSeq: 2 });
    evicted.abort();
    await waitClientCount(hubA, 'evict-0', 0);

    const kept = await connect(`${baseA}/api/v1/stream?topics=rp-keep&token=${ROOT_TOKEN}&lastEventId=rp-keep:1`);
    await kept.waitFor((b) => b.includes(': replay\nid: 2\nevent: ev.evt\ndata: {"n":2}'), 'kept topic replay');
    expect(kept.buf).not.toContain('replay-gap');
    kept.abort();
    await waitClientCount(hubA, 'rp-keep', 0);
  });
});
