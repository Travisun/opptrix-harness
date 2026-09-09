/**
 * 平台连接器测试（ChatChannels connectors）。
 *
 * - 出站投递：deps.fetchImpl 注入 mock，断言 URL / 头 / 体 / 鉴权（telegram botToken path、
 *   slack Bearer、feishu tenant_access_token、dingtalk 加签、wecom webhook）；
 * - feishu token 进程内缓存（过期前 5 分钟，deps.now 注入推进时钟）；
 * - 入站 parseInbound / verifyInbound（telegram secret_token 头）；
 * - 统一回调路由 E2E（真库 + 真 ChatService + fastify 注入）：telegram/slack 落库、
 *   错 token 401（不回显）、未支持平台 404、feishu challenge 回显。
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { registerChatRoutes } from '../src/api/chat.js';
import { createPlatformConnectors, platformTargetFromMeta } from '../src/kernel/chat/connectors/index.js';
import { createDingtalkConnector } from '../src/kernel/chat/connectors/dingtalk.js';
import { createFeishuConnector, parseFeishuChallenge } from '../src/kernel/chat/connectors/feishu.js';
import { createSlackConnector } from '../src/kernel/chat/connectors/slack.js';
import { createTelegramConnector } from '../src/kernel/chat/connectors/telegram.js';
import { createWecomConnector } from '../src/kernel/chat/connectors/wecom.js';
import { ChatService } from '../src/kernel/chat/service.js';
import { ChatStore } from '../src/kernel/chat/store.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { HookManager } from '../src/kernel/hooks/index.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

const DELIVERY_FAILED_CODE = 'HARNESS-7001';

/** 对齐 channels/types.ts 的 ChatMessagePayload 契约 */
const baseMessage = {
  id: 'msg-1',
  channelId: 'ch-1',
  channelSlug: 'ops',
  senderType: 'user' as const,
  senderId: 'u-1',
  content: 'deploy finished',
  createdAt: 1_788_763_200_000,
};

// ---------------------------------------------------------------- mock fetch

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  rawBody: string;
  body: unknown;
}

interface MockReply {
  status?: number;
  body?: unknown;
}

/**
 * 可编程 mock fetch：记录全部请求；respond 按调用序返回应答
 * （handlers 耗尽后复用最后一个），便于模拟 feishu「先 auth 后发消息」。
 */
function mockFetch(handlers: MockReply | MockReply[]): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const list = Array.isArray(handlers) ? handlers : [handlers];
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = null;
    try {
      body = rawBody === '' ? null : (JSON.parse(rawBody) as unknown);
    } catch {
      body = rawBody;
    }
    requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), rawBody, body });
    const reply = list[Math.min(requests.length - 1, list.length - 1)] as MockReply;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, requests };
}

// ---------------------------------------------------------------- telegram

describe('telegram connector', () => {
  it('outbound → POST api.telegram.org/bot<token>/sendMessage {chat_id, text}', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { ok: true, result: { message_id: 1 } } });
    const telegram = createTelegramConnector({ fetchImpl });

    await telegram.deliverOutbound(
      { ...baseMessage, content: { type: 'text', text: 'structured text' } },
      { botToken: 'BOT123', chatId: -100200 },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.telegram.org/botBOT123/sendMessage');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers.get('content-type')).toBe('application/json');
    expect(requests[0]!.body).toEqual({ chat_id: -100200, text: 'structured text' });
  });

  it('outbound → 平台 ok:false → DELIVERY_FAILED（detail 不含 botToken）', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { ok: false, description: 'chat not found' } });
    const telegram = createTelegramConnector({ fetchImpl });

    const failure = telegram.deliverOutbound(baseMessage, { botToken: 'BOT123', chatId: '42' });
    await expect(failure).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
      message: expect.stringContaining('chat not found'),
    });
    // 密钥安全：错误文本不回传 URL path 中的 botToken
    await failure.catch((e: { message: string }) => expect(e.message).not.toContain('BOT123'));
    expect(requests).toHaveLength(1);
  });

  it('outbound → HTTP 500 → DELIVERY_FAILED；target 非法 → DELIVERY_FAILED 且不发请求', async () => {
    const failing = mockFetch({ status: 500, body: { ok: false } });
    const telegram = createTelegramConnector({ fetchImpl: failing.fetchImpl });
    await expect(
      telegram.deliverOutbound(baseMessage, { botToken: 'BOT123', chatId: '42' }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE, message: expect.stringContaining('HTTP 500') });

    const untouched = mockFetch({ body: { ok: true } });
    const plain = createTelegramConnector({ fetchImpl: untouched.fetchImpl });
    await expect(plain.deliverOutbound(baseMessage, { botToken: '' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
    });
    expect(untouched.requests).toHaveLength(0);
  });

  it('verifyInbound → secretToken 配置时校验 X-Telegram-Bot-Api-Secret-Token 头；未配置仅凭 URL 令牌', () => {
    const telegram = createTelegramConnector();
    const headers = (value?: string): Record<string, string | string[] | undefined> =>
      value === undefined ? {} : { 'x-telegram-bot-api-secret-token': value };
    const target = { botToken: 'BOT123', chatId: '42', secretToken: 'tg-s3cret' };

    expect(telegram.verifyInbound?.({ headers: headers('tg-s3cret'), body: null }, target)).toBe(true);
    expect(telegram.verifyInbound?.({ headers: headers('wrong'), body: null }, target)).toBe(false);
    expect(telegram.verifyInbound?.({ headers: {}, body: null }, target)).toBe(false);
    // 未配置 target / 无 secretToken：不启用头校验
    expect(telegram.verifyInbound?.({ headers: {}, body: null }, undefined)).toBe(true);
    expect(telegram.verifyInbound?.({ headers: {}, body: null }, { botToken: 'B', chatId: '1' })).toBe(true);
  });

  it('parseInbound → update.message 取 text/first_name + meta；非消息 update → null', () => {
    const telegram = createTelegramConnector();
    const parsed = telegram.parseInbound({
      headers: {},
      body: {
        update_id: 7,
        message: { message_id: 11, from: { first_name: 'Alice' }, chat: { id: -100200 }, text: 'hello from tg' },
      },
    });
    expect(parsed).toMatchObject({ text: 'hello from tg', senderName: 'Alice' });
    expect(parsed?.meta).toEqual({ updateId: 7, chatId: -100200, messageId: 11 });

    // edited_message / 无文本 / 空文本 → null
    expect(telegram.parseInbound({ headers: {}, body: { update_id: 8, edited_message: { text: 'x' } } })).toBeNull();
    expect(telegram.parseInbound({ headers: {}, body: { update_id: 9, message: { from: {} } } })).toBeNull();
    expect(telegram.parseInbound({ headers: {}, body: { update_id: 10, message: { text: '   ' } } })).toBeNull();
  });
});

// ---------------------------------------------------------------- slack

describe('slack connector', () => {
  it('outbound → POST slack.com/api/chat.postMessage（Bearer）{channel, text}', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { ok: true, ts: '1.2' } });
    const slack = createSlackConnector({ fetchImpl });

    await slack.deliverOutbound(baseMessage, { botToken: 'xoxb-1', channel: 'C123' });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer xoxb-1');
    expect(requests[0]!.body).toEqual({ channel: 'C123', text: 'deploy finished' });
  });

  it('outbound → ok:false → DELIVERY_FAILED；target 非法 → DELIVERY_FAILED', async () => {
    const { fetchImpl } = mockFetch({ body: { ok: false, error: 'channel_not_found' } });
    const slack = createSlackConnector({ fetchImpl });
    await expect(slack.deliverOutbound(baseMessage, { botToken: 'xoxb-1', channel: 'C123' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
      message: expect.stringContaining('channel_not_found'),
    });
    await expect(slack.deliverOutbound(baseMessage, { botToken: 'xoxb-1' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
    });
  });

  it('parseInbound → event_callback message 取 text/user；bot_id（防回声）与 subtype → null', () => {
    const slack = createSlackConnector();
    const parsed = slack.parseInbound({
      headers: {},
      body: {
        team_id: 'T1',
        event: { type: 'message', text: 'hi from slack', user: 'U1', channel: 'C123', ts: '1.2' },
      },
    });
    expect(parsed).toEqual({
      text: 'hi from slack',
      senderName: 'U1',
      meta: { channel: 'C123', ts: '1.2', teamId: 'T1' },
    });

    expect(
      slack.parseInbound({ headers: {}, body: { event: { type: 'message', text: 'echo', bot_id: 'B1' } } }),
    ).toBeNull();
    expect(
      slack.parseInbound({
        headers: {},
        body: { event: { type: 'message', text: 'edit', subtype: 'message_changed' } },
      }),
    ).toBeNull();
    expect(slack.parseInbound({ headers: {}, body: { event: { type: 'app_mention', text: 'x' } } })).toBeNull();
  });
});

// ---------------------------------------------------------------- feishu

describe('feishu connector', () => {
  const target = { appId: 'cli_a', appSecret: 's3cret', receiveId: 'oc_chat1' };
  const tokenReply = { body: { code: 0, tenant_access_token: 'tk-1', expire: 3600 } };
  const sendReply = { body: { code: 0, msg: 'success' } };

  it('outbound → 先取 tenant_access_token 再发消息（Bearer + receive_id_type query + content JSON）', async () => {
    const { fetchImpl, requests } = mockFetch([tokenReply, sendReply]);
    const feishu = createFeishuConnector({ fetchImpl });

    await feishu.deliverOutbound(baseMessage, target);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    expect(requests[0]!.body).toEqual({ app_id: 'cli_a', app_secret: 's3cret' });
    expect(requests[1]!.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
    expect(requests[1]!.headers.get('authorization')).toBe('Bearer tk-1');
    expect(requests[1]!.body).toEqual({
      receive_id: 'oc_chat1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'deploy finished' }),
    });
  });

  it('token 进程内缓存：第二次投递不重取 token（now 推进但未过期）', async () => {
    const { fetchImpl, requests } = mockFetch([tokenReply, sendReply, sendReply]);
    let currentTime = 1_000_000;
    const feishu = createFeishuConnector({ fetchImpl, now: () => currentTime });

    await feishu.deliverOutbound(baseMessage, target);
    currentTime += 60_000; // 未到「过期前 5 分钟」
    await feishu.deliverOutbound(baseMessage, target);

    expect(requests).toHaveLength(3); // 1 次 auth + 2 次发消息
    expect(requests.filter((r) => r.url.endsWith('tenant_access_token/internal'))).toHaveLength(1);
  });

  it('token 过期前 5 分钟刷新：推进 now 越过失效时刻后重新获取', async () => {
    const { fetchImpl, requests } = mockFetch([
      tokenReply,
      sendReply,
      { body: { code: 0, tenant_access_token: 'tk-2', expire: 3600 } },
      sendReply,
    ]);
    let currentTime = 1_000_000;
    const feishu = createFeishuConnector({ fetchImpl, now: () => currentTime });

    await feishu.deliverOutbound(baseMessage, target);
    // expire=3600s → 失效时刻 = 签发 + 3600s - 300s；推进 3301s 越过之
    currentTime += 3_301_000;
    await feishu.deliverOutbound(baseMessage, target);

    expect(requests[2]!.body).toEqual({ app_id: 'cli_a', app_secret: 's3cret' });
    expect(requests[3]!.headers.get('authorization')).toBe('Bearer tk-2');
  });

  it('outbound → auth code!=0 / 发送 code!=0 → DELIVERY_FAILED', async () => {
    const authFail = createFeishuConnector({
      fetchImpl: mockFetch({ body: { code: 10014, msg: 'app_id invalid' } }).fetchImpl,
    });
    await expect(authFail.deliverOutbound(baseMessage, target)).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
      message: expect.stringContaining('app_id invalid'),
    });

    const sendFail = createFeishuConnector({
      fetchImpl: mockFetch([tokenReply, { body: { code: 99991663, msg: 'token expired' } }]).fetchImpl,
    });
    await expect(sendFail.deliverOutbound(baseMessage, target)).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
      message: expect.stringContaining('token expired'),
    });
  });

  it('parseInbound → content（JSON 字符串）取 text + sender_id；损坏 content → null', () => {
    const feishu = createFeishuConnector();
    const parsed = feishu.parseInbound({
      headers: {},
      body: {
        event: {
          message: { content: '{"text":"ni hao"}', chat_id: 'oc_1', message_id: 'om_1', message_type: 'text' },
          sender: { sender_id: { open_id: 'ou_1', user_id: 'usr_1' } },
        },
      },
    });
    expect(parsed).toEqual({
      text: 'ni hao',
      senderName: 'ou_1',
      meta: { chatId: 'oc_1', messageId: 'om_1', messageType: 'text' },
    });

    expect(
      feishu.parseInbound({ headers: {}, body: { event: { message: { content: '{not-json' } } } }),
    ).toBeNull();
    expect(
      feishu.parseInbound({ headers: {}, body: { event: { message: { content: '{"image_key":"k"}' } } } }),
    ).toBeNull();
  });

  it('parseFeishuChallenge → url_verification 提取 challenge；其余 → null', () => {
    expect(parseFeishuChallenge({ type: 'url_verification', challenge: 'abc-123' })).toBe('abc-123');
    expect(parseFeishuChallenge({ type: 'url_verification', challenge: '' })).toBeNull();
    expect(parseFeishuChallenge({ event: {} })).toBeNull();
    expect(parseFeishuChallenge(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- dingtalk

describe('dingtalk connector', () => {
  it('outbound → secret 加签：timestamp/sign 追加到 webhook query，签名为 HMAC-SHA256 base64', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { errcode: 0, errmsg: 'ok' } });
    const dingtalk = createDingtalkConnector({ fetchImpl });
    const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=abc';
    const secret = 'SECxxx';

    await dingtalk.deliverOutbound(baseMessage, { webhook, secret });

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://oapi.dingtalk.com/robot/send');
    expect(url.searchParams.get('access_token')).toBe('abc');
    const timestamp = url.searchParams.get('timestamp');
    expect(timestamp).toMatch(/^\d+$/);
    const expectedSign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`, 'utf8').digest('base64');
    expect(url.searchParams.get('sign')).toBe(expectedSign);
    expect(requests[0]!.body).toEqual({ msgtype: 'text', text: { content: 'deploy finished' } });
  });

  it('outbound → 无 secret：URL 原样、无签名参数；errcode!=0 → DELIVERY_FAILED', async () => {
    const ok = mockFetch({ body: { errcode: 0, errmsg: 'ok' } });
    const dingtalk = createDingtalkConnector({ fetchImpl: ok.fetchImpl });
    const webhook = 'https://oapi.dingtalk.com/robot/send?access_token=abc';
    await dingtalk.deliverOutbound(baseMessage, { webhook });
    expect(ok.requests[0]!.url).toBe(webhook);

    const fail = mockFetch({ body: { errcode: 310000, errmsg: 'sign not match' } });
    const failing = createDingtalkConnector({ fetchImpl: fail.fetchImpl });
    await expect(failing.deliverOutbound(baseMessage, { webhook, secret: 'SECxxx' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
      message: expect.stringContaining('sign not match'),
    });
    // 错误信息不含 query 中的 access_token（密钥安全）
    await (failing.deliverOutbound(baseMessage, { webhook, secret: 'SECxxx' }) as Promise<never>).catch(
      (e: { message: string }) => expect(e.message).not.toContain('access_token=abc'),
    );
  });

  it('outbound → target 非法（webhook 非法 URL）→ DELIVERY_FAILED；parseInbound v1 恒 null', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { errcode: 0 } });
    const dingtalk = createDingtalkConnector({ fetchImpl });
    await expect(dingtalk.deliverOutbound(baseMessage, { webhook: 'not-a-url' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
    });
    expect(requests).toHaveLength(0);
    // 入站 v1 不做（钉钉接收侧为 Stream 模式）：恒返回 null
    expect(dingtalk.parseInbound({ headers: {}, body: { msgtype: 'text' } })).toBeNull();
  });
});

// ---------------------------------------------------------------- wecom

describe('wecom connector', () => {
  it('outbound → POST webhook {msgtype:text, text:{content}}；errcode=0 成功', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { errcode: 0, errmsg: 'ok' } });
    const wecom = createWecomConnector({ fetchImpl });
    const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1';

    await wecom.deliverOutbound(baseMessage, { webhook });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(webhook);
    expect(requests[0]!.body).toEqual({ msgtype: 'text', text: { content: 'deploy finished' } });
  });

  it('outbound → errcode!=0 / target 非法 → DELIVERY_FAILED；parseInbound v1 恒 null', async () => {
    const { fetchImpl } = mockFetch({ body: { errcode: 93000, errmsg: 'invalid webhook' } });
    const wecom = createWecomConnector({ fetchImpl });
    await expect(
      wecom.deliverOutbound(baseMessage, { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' }),
    ).rejects.toMatchObject({ code: DELIVERY_FAILED_CODE, message: expect.stringContaining('invalid webhook') });
    await expect(wecom.deliverOutbound(baseMessage, { webhook: 'nope' })).rejects.toMatchObject({
      code: DELIVERY_FAILED_CODE,
    });
    expect(wecom.parseInbound({ headers: {}, body: { xml: '<xml/>' } })).toBeNull();
  });
});

// ---------------------------------------------------------------- registry

describe('createPlatformConnectors', () => {
  it('导出五个内置平台（字典序）；imessage 无运行时连接器；bridgeDrivers 为 ChatBridgeDriver 视图', async () => {
    const { fetchImpl, requests } = mockFetch({ body: { errcode: 0 } });
    const registry = createPlatformConnectors({ fetchImpl });

    expect(registry.platforms()).toEqual(['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']);
    expect(registry.get('imessage')).toBeUndefined();
    expect(registry.get('telegram')?.platform).toBe('telegram');

    const drivers = registry.bridgeDrivers();
    expect(drivers.map((d) => d.name)).toEqual(['telegram', 'slack', 'feishu', 'dingtalk', 'wecom']);
    // driver 视图直接可投递（与 ChatBridgeDriver 契约同构，可直接 registerChatBridgeDriver）
    const wecomDriver = drivers.find((d) => d.name === 'wecom')!;
    await wecomDriver.deliverOutbound(baseMessage, { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K1' });
    expect(requests[0]!.body).toEqual({ msgtype: 'text', text: { content: 'deploy finished' } });
  });

  it('platformTargetFromMeta → 按 driver 提取 target；meta 非 bridges 形状 → undefined', () => {
    const meta = {
      bridges: [
        { driver: 'telegram', target: { botToken: 'B', chatId: '1' } },
        { driver: 'slack', target: { botToken: 'S', channel: 'C' } },
      ],
    };
    expect(platformTargetFromMeta(meta, 'telegram')).toEqual({ botToken: 'B', chatId: '1' });
    expect(platformTargetFromMeta(meta, 'slack')).toEqual({ botToken: 'S', channel: 'C' });
    expect(platformTargetFromMeta(meta, 'feishu')).toBeUndefined();
    for (const bad of [null, undefined, 'x', [], { bridges: 'no' }, { bridges: [null, { driver: 'telegram' }] }]) {
      expect(platformTargetFromMeta(bad, 'telegram')).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------- 路由 E2E（真库 + 真 ChatService）

const ADMIN_TOKEN = 'token-admin';

interface E2ECtx {
  app: FastifyInstance;
  service: ChatService;
}

describe('POST /hooks/connector/:platform/:token（E2E）', () => {
  let dir: string;
  let db: Knex;
  let store: ChatStore;

  /** 组装被测服务器：真库 + 真 ChatService + 全部内置连接器（无 bridgeDispatch，不出站） */
  function buildServer(): E2ECtx {
    const service = new ChatService({
      store,
      hooks: new HookManager({ logger: pino({ level: 'silent' }) }),
      publish: () => undefined,
      emit: () => Promise.resolve({ delivered: 1, errors: [] }),
      logger: pino({ level: 'silent' }),
    });
    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
    const { app } = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => {
        registerChatRoutes(a, {
          checker: async ({ token }) => {
            if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['chat'] };
            throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
          },
          service,
          connectors: createPlatformConnectors(),
        });
      },
    });
    return { app, service };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'opptrix-chat-connectors-'));
    db = await openSqlite(join(dir, 'chat-connectors.sqlite'));
    const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
    await migrator.latest();
    store = new ChatStore(db);
  });

  afterAll(async () => {
    await closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('telegram 正确 secret_token 头 → 202 落库（senderType=webhook、senderName 为 senderId）', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({
      name: 'tg-inbound',
      meta: { bridges: [{ driver: 'telegram', target: { botToken: 'B', chatId: '1', secretToken: 'tg-s3cret' } }] },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/hooks/connector/telegram/${ch.webhookToken as string}`,
      headers: { 'x-telegram-bot-api-secret-token': 'tg-s3cret' },
      payload: {
        update_id: 1,
        message: { message_id: 10, from: { first_name: 'Alice' }, chat: { id: 1 }, text: 'hello from telegram' },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: true, blocked: false });

    const stored = await store.getMessage(res.json().messageId as string);
    expect(stored).toMatchObject({
      channelId: ch.id,
      senderType: 'webhook',
      senderId: 'Alice',
      content: { type: 'text', text: 'hello from telegram' },
    });
  });

  it('telegram 错误/缺失 secret_token 头 → 401 HARNESS-1006（不落库）', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({
      name: 'tg-verify',
      meta: { bridges: [{ driver: 'telegram', target: { botToken: 'B', chatId: '1', secretToken: 'tg-s3cret' } }] },
    });
    const url = `/hooks/connector/telegram/${ch.webhookToken as string}`;
    const payload = { update_id: 2, message: { text: 'should not persist' } };

    const wrong = await app.inject({ method: 'POST', url, headers: { 'x-telegram-bot-api-secret-token': 'nope' }, payload });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('HARNESS-1006');

    const missing = await app.inject({ method: 'POST', url, payload });
    expect(missing.statusCode).toBe(401);

    expect(await store.listMessages(ch.id)).toEqual([]);
  });

  it('错误频道 token → 401 且响应不回显令牌；未内置平台 → 404', async () => {
    const { app, service } = buildServer();
    await service.createChannel({ name: 'any' });
    const invalidToken = 'definitely-not-a-token';

    const bad = await app.inject({
      method: 'POST',
      url: `/hooks/connector/telegram/${invalidToken}`,
      payload: { update_id: 3, message: { text: 'x' } },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('HARNESS-1006');
    expect(JSON.stringify(bad.json())).not.toContain(invalidToken);

    const unsupported = await app.inject({
      method: 'POST',
      url: `/hooks/connector/imessage/${invalidToken}`,
      payload: {},
    });
    expect(unsupported.statusCode).toBe(404);
    expect(unsupported.json().code).toBe('HARNESS-3004');
  });

  it('feishu url_verification → 200 {challenge} 直回（不落库）', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'feishu-verify' });

    const res = await app.inject({
      method: 'POST',
      url: `/hooks/connector/feishu/${ch.webhookToken as string}`,
      payload: { type: 'url_verification', challenge: 'ajls384kdd' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge: 'ajls384kdd' });
    expect(await store.listMessages(ch.id)).toEqual([]);
  });

  it('slack message 事件 → 202 落库；bot_id 消息（防回声）→ 202 {ignored:true} 不落库', async () => {
    const { app, service } = buildServer();
    const ch = await service.createChannel({ name: 'slack-inbound' });
    const url = `/hooks/connector/slack/${ch.webhookToken as string}`;

    const res = await app.inject({
      method: 'POST',
      url,
      payload: { team_id: 'T1', event: { type: 'message', text: 'hi from slack', user: 'U1', channel: 'C1' } },
    });
    expect(res.statusCode).toBe(202);
    expect(await store.getMessage(res.json().messageId as string)).toMatchObject({
      channelId: ch.id,
      senderType: 'webhook',
      senderId: 'U1',
    });

    const bot = await app.inject({
      method: 'POST',
      url,
      payload: { event: { type: 'message', text: 'echo', bot_id: 'B1' } },
    });
    expect(bot.statusCode).toBe(202);
    expect(bot.json()).toEqual({ accepted: true, ignored: true });

    const messages = await store.listMessages(ch.id);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { senderId: string }).senderId).toBe('U1');
  });
});
