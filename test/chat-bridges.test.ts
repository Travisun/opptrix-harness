/**
 * 聊天桥与调度器单测：webhook 桥（真实本地 HTTP 服务器 + HMAC 签名头断言，走共享 signedPost）、
 * email 桥（mock transport）、ChatBridgeDispatcher（并发 / 失败隔离 / 投递记录）。
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

import {
  ChatBridgeDispatcher,
  createEmailBridge,
  createWebhookBridge,
  type DeliveryRecord,
  type EmailTransportOptions,
} from '../src/kernel/chat/bridges.js';

const DELIVERY_FAILED_CODE = 'HARNESS-7001';
const SIGNATURE_HEADER = 'x-harness-signature';
const TIMESTAMP_HEADER = 'x-harness-timestamp';

/** 对齐 channels/types.ts 的 ChatMessagePayload 契约（createdAt 为 epoch ms） */
const baseMessage = {
  id: 'msg-1',
  channelId: 'ch-1',
  channelSlug: 'ops',
  senderType: 'user' as const,
  senderId: 'u-1',
  content: 'deploy finished',
  createdAt: 1_788_763_200_000,
};

// ---------------------------------------------------------------- 本地 HTTP 捕获服务器

interface CapturedRequest {
  method: string;
  contentType: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
}

interface CaptureServer {
  server: Server;
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** 启动 127.0.0.1 随机端口捕获服务器；respond 决定响应码（默认 200） */
async function startCaptureServer(
  respond?: (req: CapturedRequest) => { status: number },
): Promise<CaptureServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        signature: req.headers[SIGNATURE_HEADER] as string | undefined,
        timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
        rawBody: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      res.statusCode = respond?.(captured).status ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 共享 signedPost 的签名算法：hex(hmac_sha256(secret, '<timestamp>.<rawBody>')) */
function expectedSignature(req: CapturedRequest, secret: string): string {
  expect(req.timestamp).toMatch(/^\d+$/);
  return createHmac('sha256', secret).update(`${req.timestamp}.${req.rawBody}`, 'utf8').digest('hex');
}

/** 伪造 pino logger（只关心 error 调用） */
function fakeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  return { logger: { error } as unknown as Logger, error };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterAll(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- webhook 桥

describe('createWebhookBridge', () => {
  it('delivers a signed JSON POST carrying the chat payload to the endpoint', async () => {
    const hook = await startCaptureServer();
    try {
      const bridge = createWebhookBridge();
      await bridge.deliverOutbound(baseMessage, { url: hook.url, secret: 'wh-s3cret' });

      expect(hook.requests).toHaveLength(1);
      const req = hook.requests[0]!;
      expect(req.method).toBe('POST');
      expect(req.contentType).toBe('application/json');

      const body = JSON.parse(req.rawBody) as Record<string, unknown>;
      expect(body).toMatchObject({
        channel: 'ops',
        senderType: 'user',
        senderId: 'u-1',
        content: 'deploy finished',
        createdAt: 1_788_763_200_000,
      });
      expect(body.text).toBe('[ops] user/u-1: deploy finished');
      expect(req.signature).toBe(expectedSignature(req, 'wh-s3cret'));
    } finally {
      await hook.close();
    }
  });

  it('prefers target.secret over secretRef (resolveSecret not called)', async () => {
    const hook = await startCaptureServer();
    try {
      const resolveSecret = vi.fn(() => 'ref-secret');
      const bridge = createWebhookBridge({ resolveSecret });
      await bridge.deliverOutbound(baseMessage, {
        url: hook.url,
        secret: 'inline-s3cret',
        secretRef: 'wh/ref',
      });

      expect(resolveSecret).not.toHaveBeenCalled();
      const req = hook.requests[0]!;
      expect(req.signature).toBe(expectedSignature(req, 'inline-s3cret'));
    } finally {
      await hook.close();
    }
  });

  it('resolves secretRef via deps.resolveSecret and signs with the resolved secret', async () => {
    const hook = await startCaptureServer();
    try {
      const resolveSecret = vi.fn(() => 'ref-s3cret');
      const bridge = createWebhookBridge({ resolveSecret });
      await bridge.deliverOutbound(baseMessage, { url: hook.url, secretRef: 'wh/ref' });

      expect(resolveSecret).toHaveBeenCalledWith('wh/ref');
      const req = hook.requests[0]!;
      expect(req.signature).toBe(expectedSignature(req, 'ref-s3cret'));
    } finally {
      await hook.close();
    }
  });

  it('rejects with DELIVERY_FAILED when secretRef cannot be resolved', async () => {
    const bridge = createWebhookBridge({ resolveSecret: () => undefined });
    await expect(
      bridge.deliverOutbound(baseMessage, { url: 'http://127.0.0.1:9/hook', secretRef: 'missing/ref' }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE });
  });

  it('rejects with DELIVERY_FAILED when the endpoint rejects the signature (403)', async () => {
    const hook = await startCaptureServer((req) => ({
      status: req.signature === expectedSignature(req, 'right-s3cret') ? 200 : 403,
    }));
    try {
      const bridge = createWebhookBridge();
      await expect(
        bridge.deliverOutbound(baseMessage, { url: hook.url, secret: 'wrong-s3cret' }),
      ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE });
      // retries: 2 → 共 3 次尝试
      expect(hook.requests).toHaveLength(3);
    } finally {
      await hook.close();
    }
  });

  it('retries twice on 5xx then fails with DELIVERY_FAILED', async () => {
    const hook = await startCaptureServer(() => ({ status: 500 }));
    try {
      const bridge = createWebhookBridge();
      await expect(
        bridge.deliverOutbound(baseMessage, { url: hook.url, secret: 'wh-s3cret' }),
      ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE });
      expect(hook.requests).toHaveLength(3);
    } finally {
      await hook.close();
    }
  });

  it('rejects with DELIVERY_FAILED for an invalid target config', async () => {
    const bridge = createWebhookBridge();
    await expect(bridge.deliverOutbound(baseMessage, { url: 'not-a-url' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
    });
  });

  it('sends without signature headers when no secret is configured', async () => {
    const hook = await startCaptureServer();
    try {
      const bridge = createWebhookBridge();
      await bridge.deliverOutbound(baseMessage, { url: hook.url });
      expect(hook.requests[0]!.signature).toBeUndefined();
      expect(hook.requests[0]!.timestamp).toBeUndefined();
    } finally {
      await hook.close();
    }
  });
});

// ---------------------------------------------------------------- email 桥

describe('createEmailBridge', () => {
  it('renders a plain-text body and sends via the injected transport', async () => {
    const sent: { from: string; to: string; subject: string; text: string }[] = [];
    let factoryInput: EmailTransportOptions | undefined;
    const bridge = createEmailBridge({
      transportFactory: (opts) => {
        factoryInput = opts;
        return { sendMail: async (mail) => void sent.push(mail) };
      },
    });

    await bridge.deliverOutbound(baseMessage, {
      to: 'oncall@example.com',
      from: 'bot@example.com',
      smtp: { host: 'smtp.example.com', port: 2525, secure: false },
    });

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe('oncall@example.com');
    expect(mail.from).toBe('bot@example.com');
    expect(mail.subject).toContain('[ops]');
    expect(mail.subject).toContain('user/u-1');
    expect(mail.text).toContain('ops');
    expect(mail.text).toContain('deploy finished');
    expect(mail.text).toContain(String(baseMessage.createdAt));

    // JSON 摘要可解析且字段齐全
    const marker = '--- payload (JSON) ---';
    expect(mail.text).toContain(marker);
    const payload = JSON.parse(mail.text.slice(mail.text.indexOf(marker) + marker.length)) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      channel: 'ops',
      senderType: 'user',
      senderId: 'u-1',
      content: 'deploy finished',
      createdAt: 1_788_763_200_000,
    });
    expect(factoryInput).toMatchObject({ host: 'smtp.example.com', port: 2525, secure: false });
  });

  it('resolves passSecretRef and passes SMTP auth to the transport', async () => {
    let factoryInput: EmailTransportOptions | undefined;
    const resolveSecret = vi.fn(() => 'smtp-s3cret');
    const bridge = createEmailBridge({
      resolveSecret,
      transportFactory: (opts) => {
        factoryInput = opts;
        return { sendMail: async () => undefined };
      },
    });

    await bridge.deliverOutbound(baseMessage, {
      to: 'oncall@example.com',
      from: 'bot@example.com',
      smtp: { host: 'smtp.example.com', user: 'bot', passSecretRef: 'smtp/pass' },
    });

    expect(resolveSecret).toHaveBeenCalledWith('smtp/pass');
    expect(factoryInput!.auth).toEqual({ user: 'bot', pass: 'smtp-s3cret' });
    // 默认端口：未给 port 且 secure 缺省 → 587
    expect(factoryInput!.port).toBe(587);
    expect(factoryInput!.secure).toBe(false);
  });

  it('rejects with DELIVERY_FAILED when SMTP send fails', async () => {
    const bridge = createEmailBridge({
      transportFactory: () => ({
        sendMail: async () => {
          throw new Error('ECONNREFUSED smtp');
        },
      }),
    });
    await expect(
      bridge.deliverOutbound(baseMessage, {
        to: 'oncall@example.com',
        from: 'bot@example.com',
        smtp: { host: 'smtp.example.com' },
      }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE, message: expect.stringContaining('oncall@example.com') });
  });

  it('rejects with DELIVERY_FAILED for an invalid target config (transport never built)', async () => {
    const factory = vi.fn(() => ({ sendMail: async () => undefined }));
    const bridge = createEmailBridge({ transportFactory: factory });
    await expect(
      bridge.deliverOutbound(baseMessage, {
        to: 'not-an-email',
        from: 'bot@example.com',
        smtp: { host: 'smtp.example.com' },
      }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE });
    expect(factory).not.toHaveBeenCalled();
  });

  it('omits auth when no SMTP credentials are configured', async () => {
    const sent: unknown[] = [];
    let factoryInput: EmailTransportOptions | undefined;
    const bridge = createEmailBridge({
      transportFactory: (opts) => {
        factoryInput = opts;
        return { sendMail: async (mail) => void sent.push(mail) };
      },
    });

    await bridge.deliverOutbound(baseMessage, {
      to: 'oncall@example.com',
      from: 'bot@example.com',
      smtp: { host: 'smtp.example.com' },
    });

    expect(factoryInput!.auth).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it('rejects with DELIVERY_FAILED when passSecretRef cannot be resolved', async () => {
    const bridge = createEmailBridge({
      resolveSecret: () => undefined,
      transportFactory: () => ({ sendMail: async () => undefined }),
    });
    await expect(
      bridge.deliverOutbound(baseMessage, {
        to: 'oncall@example.com',
        from: 'bot@example.com',
        smtp: { host: 'smtp.example.com', user: 'bot', passSecretRef: 'smtp/pass' },
      }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE });
  });
});

// ---------------------------------------------------------------- ChatBridgeDispatcher

describe('ChatBridgeDispatcher', () => {
  it('delivers concurrently through all bridges, isolates one failure, and records both deliveries', async () => {
    const deliveries: DeliveryRecord[] = [];
    const { logger, error } = fakeLogger();
    const gateOk = deferred();
    const gateFail = deferred();
    let startedOk = false;
    let startedFail = false;

    const dispatcher = new ChatBridgeDispatcher({
      registry: {
        getChatBridgeDriver: (name: string) => {
          if (name === 'ok-bridge') {
            return {
              deliverOutbound: async () => {
                startedOk = true;
                await gateOk.promise;
              },
            };
          }
          if (name === 'fail-bridge') {
            return {
              deliverOutbound: async () => {
                startedFail = true;
                await gateFail.promise;
                throw new Error('bridge down');
              },
            };
          }
          return undefined;
        },
      },
      getChannelBridges: (channelId: string) =>
        channelId === 'ch-1'
          ? [
              { driver: 'ok-bridge', target: { url: 'https://hooks.example/a' } },
              { driver: 'fail-bridge', target: { url: 'https://hooks.example/b', secret: 'topsecret' } },
            ]
          : [],
      recordDelivery: (entry) => void deliveries.push(entry),
      logger,
    });

    const pending = dispatcher.dispatch(baseMessage, { id: 'ch-1', slug: 'ops' });

    // 两桥都已启动才放行 → 证明并发投递
    await vi.waitFor(() => {
      expect(startedOk).toBe(true);
      expect(startedFail).toBe(true);
    });
    gateOk.resolve();
    gateFail.resolve();

    // 单桥失败不抛
    await expect(pending).resolves.toBeUndefined();

    expect(deliveries).toHaveLength(2);
    const ok = deliveries.find((d) => d.ok === true)!;
    const failed = deliveries.find((d) => d.ok === false)!;
    expect(ok).toMatchObject({ kind: 'chat_bridge', channel: 'ch-1', target: '{"url":"https://hooks.example/a"}' });
    expect(typeof ok.durationMs).toBe('number');
    expect(failed).toMatchObject({ kind: 'chat_bridge', channel: 'ch-1', error: 'bridge down' });
    // target 摘要脱敏：secret 不落记录/日志
    expect(failed.target).toContain('[redacted]');
    expect(failed.target).not.toContain('topsecret');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the channel has no bridges configured', async () => {
    const getDriver = vi.fn();
    const recordDelivery = vi.fn();
    const { logger } = fakeLogger();
    const dispatcher = new ChatBridgeDispatcher({
      registry: { getChatBridgeDriver: getDriver },
      getChannelBridges: () => [],
      recordDelivery,
      logger,
    });

    await expect(dispatcher.dispatch(baseMessage, { id: 'ch-1', slug: 'ops' })).resolves.toBeUndefined();
    expect(getDriver).not.toHaveBeenCalled();
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it('records a failure (not a throw) for an unregistered driver', async () => {
    const recordDelivery = vi.fn();
    const { logger, error } = fakeLogger();
    const dispatcher = new ChatBridgeDispatcher({
      registry: { getChatBridgeDriver: () => undefined },
      getChannelBridges: () => [{ driver: 'ghost', target: {} }],
      recordDelivery,
      logger,
    });

    await expect(dispatcher.dispatch(baseMessage, { id: 'ch-1', slug: 'ops' })).resolves.toBeUndefined();
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'chat_bridge',
        channel: 'ch-1',
        ok: false,
        error: expect.stringContaining('not registered'),
      }),
    );
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('records kind/channel/duration on success through a real webhook bridge', async () => {
    const hook = await startCaptureServer();
    try {
      const deliveries: DeliveryRecord[] = [];
      const { logger } = fakeLogger();
      const dispatcher = new ChatBridgeDispatcher({
        registry: { getChatBridgeDriver: () => createWebhookBridge() },
        getChannelBridges: () => [{ driver: 'webhook', target: { url: hook.url, secret: 'wh-s3cret' } }],
        recordDelivery: (entry) => void deliveries.push(entry),
        logger,
      });

      await dispatcher.dispatch(baseMessage, { id: 'ch-1', slug: 'ops' });

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({ kind: 'chat_bridge', channel: 'ch-1', ok: true });
      expect(typeof deliveries[0]!.durationMs).toBe('number');
      expect(hook.requests).toHaveLength(1);
      expect(hook.requests[0]!.signature).toBe(expectedSignature(hook.requests[0]!, 'wh-s3cret'));
    } finally {
      await hook.close();
    }
  });

  it('normalizes message.channelSlug to the authoritative channel slug', async () => {
    const hook = await startCaptureServer();
    try {
      const { logger } = fakeLogger();
      const dispatcher = new ChatBridgeDispatcher({
        registry: { getChatBridgeDriver: () => createWebhookBridge() },
        getChannelBridges: () => [{ driver: 'webhook', target: { url: hook.url } }],
        recordDelivery: () => undefined,
        logger,
      });

      const stale = { ...baseMessage, channelSlug: 'stale-slug' };
      await dispatcher.dispatch(stale, { id: 'ch-1', slug: 'ops' });

      const body = JSON.parse(hook.requests[0]!.rawBody) as Record<string, unknown>;
      expect(body.channel).toBe('ops');
    } finally {
      await hook.close();
    }
  });
});
