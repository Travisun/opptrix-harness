import { afterAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChannelRegistry,
  signedPost,
  type ChatBridgeDriver,
  type NotificationDriver,
  type NotificationPayload,
} from '../src/kernel/channels/index.js';
import { HarnessError } from '../src/kernel/errors/index.js';

// ---- 测试工具：本地 webhook 服务器 ----

interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  raw: string;
}

interface TestServer {
  url: string;
  /** 已收到的请求（含头与原始 body），按到达顺序 */
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Handler = (ctx: {
  res: http.ServerResponse;
  raw: string;
  /** 当前请求是第几个（1-based） */
  count: number;
}) => void | Promise<void>;

/** 在 127.0.0.1 随机端口起一个 POST 接收器；close 时强制断开残余连接 */
function startServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, raw });
      void Promise.resolve()
        .then(() => handler({ res, raw, count: requests.length }))
        .catch(() => {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end();
          }
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const SECRET = 'test-shared-secret';

function expectedSignature(secret: string, timestamp: string, raw: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
}

function signaturesMatch(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

const openServers: TestServer[] = [];
async function start(handler: Handler): Promise<TestServer> {
  const srv = await startServer(handler);
  openServers.push(srv);
  return srv;
}

afterAll(async () => {
  for (const srv of openServers.splice(0)) await srv.close();
});

// ---- ChannelRegistry ----

describe('ChannelRegistry', () => {
  const notificationDriver: NotificationDriver = {
    name: 'webhook',
    deliver: async () => {},
  };
  const chatDriver: ChatBridgeDriver = {
    name: 'slack',
    deliverOutbound: async () => {},
  };

  it('注册并按名获取通知驱动（同一引用）', () => {
    const registry = new ChannelRegistry();
    registry.registerNotificationDriver(notificationDriver);
    expect(registry.getNotificationDriver('webhook')).toBe(notificationDriver);
  });

  it('注册并按名获取聊天桥驱动；与通知驱动同名也互不干扰', () => {
    const registry = new ChannelRegistry();
    const sameNameNotification: NotificationDriver = { name: 'slack', deliver: async () => {} };
    registry.registerNotificationDriver(sameNameNotification);
    registry.registerChatBridgeDriver(chatDriver);
    expect(registry.getChatBridgeDriver('slack')).toBe(chatDriver);
    expect(registry.getNotificationDriver('slack')).toBe(sameNameNotification);
  });

  it('同名重复注册 = 覆盖（后注册者生效，list 不重复）', () => {
    const registry = new ChannelRegistry();
    const first: NotificationDriver = { name: 'webhook', deliver: async () => {} };
    const second: NotificationDriver = { name: 'webhook', deliver: async () => {} };
    registry.registerNotificationDriver(first);
    registry.registerNotificationDriver(second);
    expect(registry.getNotificationDriver('webhook')).toBe(second);
    expect(registry.listNotificationDrivers()).toEqual(['webhook']);
  });

  it('未注册的名字返回 undefined', () => {
    const registry = new ChannelRegistry();
    expect(registry.getNotificationDriver('nope')).toBeUndefined();
    expect(registry.getChatBridgeDriver('nope')).toBeUndefined();
  });

  it('list 去重且字典序排序；通知与聊天桥两张表各自独立', () => {
    const registry = new ChannelRegistry();
    for (const name of ['smtp', 'webhook', 'dingtalk']) {
      registry.registerNotificationDriver({ name, deliver: async () => {} });
    }
    for (const name of ['feishu', 'slack']) {
      registry.registerChatBridgeDriver({ name, deliverOutbound: async () => {} });
    }
    expect(registry.listNotificationDrivers()).toEqual(['dingtalk', 'smtp', 'webhook']);
    expect(registry.listChatBridgeDrivers()).toEqual(['feishu', 'slack']);
  });

  it('空注册中心 list 为空数组', () => {
    const registry = new ChannelRegistry();
    expect(registry.listNotificationDrivers()).toEqual([]);
    expect(registry.listChatBridgeDrivers()).toEqual([]);
  });

  it('缺 name / 空 name 的驱动 fail-fast（[channels] 前缀 INTERNAL）', () => {
    const registry = new ChannelRegistry();
    expect(() => registry.registerNotificationDriver({ name: '', deliver: async () => {} })).toThrowError(
      /\[channels\] registerNotificationDriver/,
    );
    expect(() => registry.registerChatBridgeDriver({ name: '' as string, deliverOutbound: async () => {} })).toThrowError(
      /\[channels\] registerChatBridgeDriver/,
    );
    try {
      registry.registerNotificationDriver(undefined as unknown as NotificationDriver);
      expect.unreachable('应抛出 HarnessError');
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as HarnessError).code).toBe('HARNESS-9003');
    }
  });

  it('驱动即纯接口：deliver / deliverOutbound 收到原样 payload 与 target', async () => {
    const seen: { payload: NotificationPayload; target: unknown }[] = [];
    const echo: NotificationDriver = {
      name: 'echo',
      deliver: async (payload, target) => {
        seen.push({ payload, target });
      },
    };
    const registry = new ChannelRegistry();
    registry.registerNotificationDriver(echo);
    const payload: NotificationPayload = {
      id: 'n-1',
      level: 'warn',
      title: 'disk almost full',
      body: 'usage 92%',
      data: { usage: 0.92 },
      createdAt: 1_760_000_000_000,
    };
    await registry.getNotificationDriver('echo')?.deliver(payload, { url: 'https://example.com/hook' });
    expect(seen).toEqual([{ payload, target: { url: 'https://example.com/hook' } }]);
  });
});

// ---- signedPost ----

describe('signedPost（本地 http 服务器）', () => {
  it('正确 secret：服务端验签通过返回 200；签名头/时间戳/body 均符合契约', async () => {
    const body = { hello: 'harness', n: 1 };
    let serverSeenSig: string | undefined;
    const srv = await start(({ res, raw, count }) => {
      const timestamp = srv.requests[count - 1]?.headers['x-harness-timestamp'];
      const signature = srv.requests[count - 1]?.headers['x-harness-signature'];
      const valid =
        typeof timestamp === 'string' &&
        signaturesMatch(signature, expectedSignature(SECRET, timestamp, raw)) &&
        Math.abs(Date.now() - Number(timestamp)) < 60_000;
      if (valid) {
        serverSeenSig = signature;
        res.statusCode = 200;
        res.end('ok');
      } else {
        res.statusCode = 401;
        res.end('bad signature');
      }
    });

    const result = await signedPost({ url: srv.url, body, secret: SECRET });
    expect(result).toEqual({ ok: true, durationMs: expect.any(Number) });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(serverSeenSig).toBeDefined();

    const [req] = srv.requests;
    expect(req?.headers['content-type']).toBe('application/json');
    expect(req?.raw).toBe(JSON.stringify(body));
    await srv.close();
  });

  it('错误 secret：服务端 401，最终抛 DELIVERY_FAILED 且 detail.status = 401', async () => {
    const srv = await start(({ res, raw, count }) => {
      const timestamp = srv.requests[count - 1]?.headers['x-harness-timestamp'];
      const signature = srv.requests[count - 1]?.headers['x-harness-signature'];
      const valid =
        typeof timestamp === 'string' && signaturesMatch(signature, expectedSignature(SECRET, timestamp, raw));
      res.statusCode = valid ? 200 : 401;
      res.end(valid ? 'ok' : 'unauthorized');
    });

    const promise = signedPost({ url: srv.url, body: { x: 1 }, secret: 'wrong-secret', retries: 0 });
    await expect(promise).rejects.toThrowError(HarnessError);
    await promise.catch((e: HarnessError) => {
      expect(e.code).toBe('HARNESS-7001');
      expect(e.detail).toMatchObject({ url: srv.url, status: 401, error: expect.stringContaining('401') });
      expect(e.retryable).toBe(true);
    });
    expect(srv.requests).toHaveLength(1); // retries: 0 → 不重试
    await srv.close();
  });

  it('超时：服务器 delay > timeoutMs 时中止本次尝试并抛 DELIVERY_FAILED', async () => {
    const srv = await start(async ({ res }) => {
      await new Promise((r) => setTimeout(r, 500));
      if (!res.writableEnded && !res.destroyed) {
        res.statusCode = 200;
        res.end('too late');
      }
    });

    let thrown: unknown;
    try {
      await signedPost({ url: srv.url, body: {}, secret: SECRET, timeoutMs: 80, retries: 0 });
      expect.unreachable('应超时抛错');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HarnessError);
    const detail = (thrown as HarnessError).detail as { status?: number; error?: string; durationMs?: number };
    expect(detail.status).toBeUndefined(); // 未收到响应
    expect(detail.error).toContain('timeout');
    expect(detail.durationMs).toBeGreaterThanOrEqual(50);
    await srv.close();
  });

  it('重试：前 2 次 500，第 3 次 200 → 成功且服务端恰收到 3 次请求', async () => {
    const srv = await start(({ res, count }) => {
      res.statusCode = count <= 2 ? 500 : 200;
      res.end(count <= 2 ? 'boom' : 'ok');
    });

    const result = await signedPost({ url: srv.url, body: { i: 0 }, secret: SECRET });
    expect(result.ok).toBe(true);
    expect(srv.requests).toHaveLength(3);
    await srv.close();
  });

  it('最终失败：默认重试 3 次（共 4 次尝试）后抛 DELIVERY_FAILED，durationMs 被记录', async () => {
    const srv = await start(({ res }) => {
      res.statusCode = 500;
      res.end('always broken');
    });

    let thrown: unknown;
    try {
      await signedPost({ url: srv.url, body: {}, secret: SECRET });
      expect.unreachable('应抛 DELIVERY_FAILED');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HarnessError);
    const e = thrown as HarnessError;
    expect(e.code).toBe('HARNESS-7001');
    expect(e.status).toBe(502);
    expect(e.message).toContain(srv.url);
    const detail = e.detail as { status?: number; attempts?: number; durationMs?: number };
    expect(detail.status).toBe(500);
    expect(detail.attempts).toBe(4);
    expect(detail.durationMs).toEqual(expect.any(Number));
    expect(detail.durationMs).toBeGreaterThanOrEqual(500); // 至少含首次退避等待
    expect(srv.requests).toHaveLength(4);
    await srv.close();
  });

  it('不传 secret：不附带签名相关头，请求正常送达', async () => {
    const srv = await start(({ res }) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const result = await signedPost({ url: srv.url, body: { anon: true } });
    expect(result.ok).toBe(true);
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]?.headers['x-harness-signature']).toBeUndefined();
    expect(srv.requests[0]?.headers['x-harness-timestamp']).toBeUndefined();
    await srv.close();
  });

  it('自定义 headers 覆盖默认头并可附加透传头', async () => {
    const srv = await start(({ res }) => {
      res.statusCode = 200;
      res.end('ok');
    });

    const result = await signedPost({
      url: srv.url,
      body: {},
      headers: { 'content-type': 'text/plain', 'x-trace-id': 'trace-1' },
    });
    expect(result.ok).toBe(true);
    expect(srv.requests[0]?.headers['content-type']).toBe('text/plain');
    expect(srv.requests[0]?.headers['x-trace-id']).toBe('trace-1');
    await srv.close();
  });
});
