/**
 * 通知中心单测（store / manager / inbox / webhook / console）。
 *
 * - store：临时文件库 + Migrator 跑内核迁移（notifications 由 008 建立）→
 *   验证 CRUD、list 过滤（unreadOnly/level/limit 钳制）与降序、已读/未读统计、
 *   data/channels JSON 往返与损坏容错。
 * - manager：入库 + SSE publish 断言（created/delivered 两事件）、未知驱动跳过、
 *   单渠道失败不抛、hook beforeSend 改写、投递计划落库脱敏。
 * - retry/manager 重试编排：withDeliveryRetry 指数退避纯函数、notify.retry 覆盖、
 *   每驱动缺省口径（email 2 次 2s/4s、webhook 3 次 500ms/1s/2s）、target.retries
 *   逐目标覆盖、不可重试错误短路、读取失败回落默认。
 * - manager 投递记录：recordDelivery 每渠道回调（kind='notification'、target 脱敏、
 *   ok/durationMs/error），回调抛错不外溢。
 * - webhook：真实 signedPost 打本地 http 服务器（成功/签名验签/secretRef 解析/
 *   非 2xx 抛 DELIVERY_FAILED/target 校验）。
 * - console：logger.info 输出断言。
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { type IncomingMessage, createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';

import { ChannelRegistry, type NotificationPayload } from '../src/kernel/channels/index.js';
import { err, HarnessError } from '../src/kernel/errors/index.js';
import { HookManager } from '../src/kernel/hooks/index.js';
import {
  NotificationManager,
  NotificationStore,
  createConsoleDriver,
  createWebhookDriver,
  defaultSleep,
  inboxDriver,
  FALLBACK_DELIVERY_RETRY,
  NOTIFICATION_RETRY_DEFAULTS,
  normalizeRetryOverride,
  resolveChannelRetry,
  withDeliveryRetry,
  type NotificationDeliveryEntry,
  type NotificationManagerDeps,
  type NotificationRecord,
} from '../src/kernel/notification/index.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 公共装配
// ---------------------------------------------------------------------------

let dir: string;
let db: Knex;
let store: NotificationStore;

let seq = 0;

/** 构造 store 测试记录（id 与 createdAt 自动递增，保证排序断言稳定） */
function makeRecord(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  seq += 1;
  return {
    id: `n-${seq}`,
    level: 'info',
    title: `通知 ${seq}`,
    body: `正文 ${seq}`,
    readAt: null,
    createdAt: 1_000 + seq,
    ...overrides,
  };
}

/** 构造 manager + 全套可观测替身（publish 用 vi.fn，hooks 用真 HookManager） */
function makeManager(overrides: Partial<NotificationManagerDeps> = {}) {
  const registry = new ChannelRegistry();
  const hooks = new HookManager();
  const publish = vi.fn();
  const logger = pino({ level: 'silent' });
  const manager = new NotificationManager({
    store,
    registry,
    hooks,
    publish,
    logger,
    ...overrides,
  });
  return { manager, registry, hooks, publish, logger };
}

/** 构造驱动测试用通知载荷 */
function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    id: `p-${seq}`,
    level: 'info',
    title: 'Webhook 通知',
    body: 'webhook 正文',
    data: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 本地 http 捕获服务器（webhook 驱动端到端）
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string | undefined;
  headers: IncomingMessage['headers'];
  rawBody: string;
}

async function startCaptureServer(status: number): Promise<{
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({ method: req.method, headers: req.headers, rawBody: raw });
      res.statusCode = status;
      res.end(status < 400 ? 'ok' : 'boom');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 按 channels 包 signedPost 约定复算期望签名：hex(hmac_sha256(secret, `${ts}.${rawBody}`)) */
function expectedSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-notification-'));
  db = await openSqlite(join(dir, 'notification.sqlite'));
  const migrator = new Migrator(db, { migrations: KERNEL_MIGRATIONS });
  await migrator.latest();
  store = new NotificationStore(db);
});

afterAll(async () => {
  await db?.destroy();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db('notifications').del(); // 用例间隔离：列表/统计断言不受他例残留影响
});

// ---- store ----

describe('NotificationStore', () => {
  it('create + get 全字段 JSON 往返（data 对象 / channels 投递计划）', async () => {
    const rec = makeRecord({
      data: { a: 1, nested: { ok: true } },
      channels: [{ driver: 'webhook', target: { url: 'https://example.test/hook', secret: 's' } }],
    });
    await store.create(rec);
    await expect(store.get(rec.id)).resolves.toEqual(rec);
  });

  it('get 不存在的 id 返回 null', async () => {
    await expect(store.get('missing-id')).resolves.toBeNull();
  });

  it('create 最小记录：data/channels/readAt 缺省归一化为 null', async () => {
    const rec = makeRecord();
    await store.create(rec);
    await expect(store.get(rec.id)).resolves.toEqual({
      id: rec.id,
      level: 'info',
      title: rec.title,
      body: rec.body,
      data: null,
      channels: null,
      readAt: null,
      createdAt: rec.createdAt,
    });
  });

  it('data/channels 损坏（非法 JSON）置 null，其余字段正常返回', async () => {
    await db('notifications').insert({
      id: 'corrupt-1',
      level: 'warn',
      title: '脏数据通知',
      body: 'B',
      data: '{oops',
      channels: '[1,',
      read_at: null,
      created_at: 42,
    });
    await expect(store.get('corrupt-1')).resolves.toEqual({
      id: 'corrupt-1',
      level: 'warn',
      title: '脏数据通知',
      body: 'B',
      data: null,
      channels: null,
      readAt: null,
      createdAt: 42,
    });
  });

  it('list 按 created_at 降序（最新在前）', async () => {
    for (const at of [300, 100, 200]) await store.create(makeRecord({ createdAt: at }));
    const rows = await store.list();
    expect(rows.map((r) => r.createdAt)).toEqual([300, 200, 100]);
  });

  it('list unreadOnly 只列未读', async () => {
    const a = makeRecord();
    const b = makeRecord();
    const c = makeRecord();
    await store.create(a);
    await store.create(b);
    await store.create(c);
    await store.markRead(b.id);
    const rows = await store.list({ unreadOnly: true });
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
  });

  it('list level 精确过滤', async () => {
    const a = makeRecord({ level: 'info' });
    const b = makeRecord({ level: 'warn' });
    const c = makeRecord({ level: 'warn' });
    await store.create(a);
    await store.create(b);
    await store.create(c);
    const rows = await store.list({ level: 'warn' });
    expect(rows.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
  });

  it('list limit 钳制：0 → 1，正常值生效，超大不超实际行数', async () => {
    for (let i = 0; i < 5; i++) await store.create(makeRecord());
    expect((await store.list({ limit: 0 })).length).toBe(1); // 钳到下限 1
    expect((await store.list({ limit: 2 })).length).toBe(2);
    expect((await store.list({ limit: 9999 })).length).toBe(5); // 钳到上限 500 内
    expect((await store.list()).length).toBe(5); // 缺省 50 未触发
  });

  it('markRead：未读 → true 且写入 readAt；幂等二连标 → false；不存在 → false', async () => {
    const rec = makeRecord();
    await store.create(rec);
    await expect(store.markRead(rec.id)).resolves.toBe(true);
    const after = await store.get(rec.id);
    expect(typeof after?.readAt).toBe('number');
    await expect(store.markRead(rec.id)).resolves.toBe(false); // 已读不再重复计数
    await expect(store.markRead('missing-id')).resolves.toBe(false);
  });

  it('markAllRead 返回转为已读的条数；unreadCount 归零', async () => {
    for (let i = 0; i < 3; i++) await store.create(makeRecord());
    await expect(store.unreadCount()).resolves.toBe(3);
    await expect(store.markAllRead()).resolves.toBe(3);
    await expect(store.unreadCount()).resolves.toBe(0);
    await expect(store.markAllRead()).resolves.toBe(0); // 无未读时 0
  });

  it('unreadCount 只数未读', async () => {
    const a = makeRecord();
    const b = makeRecord();
    const c = makeRecord();
    await store.create(a);
    await store.create(b);
    await store.create(c);
    await store.markRead(a.id);
    await expect(store.unreadCount()).resolves.toBe(2);
  });
});

// ---- manager ----

describe('NotificationManager', () => {
  it('无 channels：只入库 + 仅发布 notification.created（默认 level/body/data 归一化）', async () => {
    const { manager, publish } = makeManager();
    const rec = await manager.send({ title: '站内通知' });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('notifications', 'notification.created', expect.objectContaining({ id: rec.id }));

    const stored = await store.get(rec.id);
    expect(stored).toEqual({
      id: rec.id,
      level: 'info',
      title: '站内通知',
      body: '',
      data: null,
      channels: [], // 投递计划：空数组落库
      readAt: null,
      createdAt: expect.any(Number),
    });
  });

  it('level/body/data 显式值经 store 往返一致（level 枚举非 info 亦合法）', async () => {
    const { manager } = makeManager();
    const rec = await manager.send({ title: '磁盘告警', body: '用量 92%', level: 'warn', data: { used: 0.92 } });
    const stored = await store.get(rec.id);
    expect(stored?.level).toBe('warn');
    expect(stored?.body).toBe('用量 92%');
    expect(stored?.data).toEqual({ used: 0.92 });
    expect(rec.createdAt).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - rec.createdAt).toBeLessThan(5_000);
  });

  it('多渠道：成功渠道计 ok/durationMs，未知驱动名跳过不抛并计失败', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry, publish, logger } = makeManager();
    registry.registerNotificationDriver({ name: 'stub', deliver });
    const warnSpy = vi.spyOn(logger, 'warn');

    const rec = await manager.send({
      title: '多渠道',
      channels: [
        { driver: 'stub', target: { x: 1 } },
        { driver: 'nope', target: {} }, // 未注册
      ],
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, targetArg] = deliver.mock.calls[0] as unknown as [NotificationPayload, unknown];
    expect(targetArg).toEqual({ x: 1 });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(2, 'notifications', 'notification.delivered', {
      id: rec.id,
      results: [
        { driver: 'stub', ok: true, durationMs: expect.any(Number) },
        { driver: 'nope', ok: false, durationMs: 0, error: expect.stringContaining('not found') },
      ],
    });
    expect(warnSpy).toHaveBeenCalled(); // 未知驱动有告警但不抛
  });

  it('单渠道失败不抛出：logger.error + 失败计数，其余渠道继续投递', async () => {
    const bad = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'boom' });
    });
    const good = vi.fn(async () => {});
    const { manager, registry, publish, logger } = makeManager();
    registry.registerNotificationDriver({ name: 'bad', deliver: bad });
    registry.registerNotificationDriver({ name: 'good', deliver: good });
    const errorSpy = vi.spyOn(logger, 'error');

    const rec = await manager.send({
      title: '部分失败',
      channels: [
        { driver: 'bad', target: {} },
        { driver: 'good', target: {} },
      ],
    });

    expect(good).toHaveBeenCalledTimes(1); // bad 失败未阻断 good
    expect(publish).toHaveBeenCalledWith('notifications', 'notification.delivered', {
      id: rec.id,
      results: [
        { driver: 'bad', ok: false, durationMs: expect.any(Number), error: 'boom' },
        { driver: 'good', ok: true, durationMs: expect.any(Number) },
      ],
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('投递计划落库脱敏：secret → ***，但驱动收到原始 target', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry } = makeManager();
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({
      title: '脱敏',
      channels: [{ driver: 'stub', target: { url: 'https://example.test/hook', secret: 's3cret' } }],
    });

    const stored = await store.get(rec.id);
    const plan = stored?.channels as { driver: string; target: { url: string; secret: string } }[];
    expect(plan[0]?.target.secret).toBe('***'); // 落库/SSE 不泄露明文
    expect(plan[0]?.target.url).toBe('https://example.test/hook');
    const [, targetArg] = deliver.mock.calls[0] as unknown as [NotificationPayload, unknown];
    expect((targetArg as { secret: string }).secret).toBe('s3cret'); // 驱动拿原始值
  });

  it('hook beforeSend 可改写通知内容并生效到落库与投递载荷', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry, hooks, publish } = makeManager();
    registry.registerNotificationDriver({ name: 'stub', deliver });
    hooks.add('notification.beforeSend', (value) => {
      const v = value as { title: string; body: string };
      return { ...v, title: `${v.title}（升级）` };
    });

    const rec = await manager.send({ title: '原始标题', channels: [{ driver: 'stub', target: {} }] });

    expect(rec.title).toBe('原始标题（升级）');
    expect((await store.get(rec.id))?.title).toBe('原始标题（升级）');
    const [payloadArg] = deliver.mock.calls[0] as unknown as [NotificationPayload];
    expect(payloadArg.title).toBe('原始标题（升级）');
    const created = publish.mock.calls[0]?.[2] as NotificationRecord;
    expect(created.title).toBe('原始标题（升级）');
  });

  it('hook 返回非法形状 → VALIDATION_FAILED（fail-fast，不静默吞）', async () => {
    const { manager, hooks, publish } = makeManager();
    hooks.add('notification.beforeSend', () => ({ title: 42 }) as unknown);
    await expect(manager.send({ title: 'x' })).rejects.toMatchObject({ code: 'HARNESS-1009' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('入参非法（空标题/未知 level）→ VALIDATION_FAILED 且不入库不发布', async () => {
    const { manager, publish } = makeManager();
    await expect(manager.send({ title: '' })).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(manager.send({ title: 'x', level: 'nope' as never })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    expect(publish).not.toHaveBeenCalled();
  });

  // ---- 默认渠道路由（settings 'notify.routes'，经 deps.getRoutes 注入）----

  it('未显式传 channels 时按 level 匹配路由规则：命中规则的 channels 进入投递计划', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry, publish } = makeManager({
      getRoutes: async () => [
        { match: { level: 'error' }, channels: [{ driver: 'stub', target: { kind: 'error' } }] },
        { match: {}, channels: [{ driver: 'stub', target: { kind: 'all' } }] }, // 无 level = 全级别
      ],
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({ title: '路由投递', level: 'error' });

    // error 级别命中两条规则 → 两个计划渠道都投递
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(['error', 'all']);
    expect(publish).toHaveBeenCalledWith('notifications', 'notification.delivered', {
      id: rec.id,
      results: expect.any(Array),
    });
    // 路由产生的计划随记录落库（channels 字段）
    expect(await store.get(rec.id)).toMatchObject({
      channels: [
        { driver: 'stub', target: { kind: 'error' } },
        { driver: 'stub', target: { kind: 'all' } },
      ],
    });
  });

  it('level 不匹配的规则不追加；未注入 getRoutes 时行为不变（空计划）', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry } = makeManager({
      getRoutes: async () => [{ match: { level: 'error' }, channels: [{ driver: 'stub', target: {} }] }],
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const infoRec = await manager.send({ title: 'info 不命中', level: 'info' });
    expect(deliver).not.toHaveBeenCalled();
    expect((await store.get(infoRec.id))?.channels).toEqual([]);

    // 无 getRoutes（默认装配）：不读路由、无投递
    const bare = makeManager();
    bare.registry.registerNotificationDriver({ name: 'stub', deliver });
    const bareRec = await bare.manager.send({ title: '无路由依赖' });
    expect(deliver).not.toHaveBeenCalled();
    expect((await store.get(bareRec.id))?.channels).toEqual([]);
  });

  it('显式传入 channels 优先：不读路由（getRoutes 不被调用）', async () => {
    const deliver = vi.fn(async () => {});
    const getRoutes = vi.fn(async () => [
      { match: {}, channels: [{ driver: 'stub', target: { kind: 'routed' } }] },
    ]);
    const { manager, registry } = makeManager({ getRoutes });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    await manager.send({ title: '显式优先', channels: [{ driver: 'stub', target: { kind: 'explicit' } }] });

    expect(getRoutes).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((deliver.mock.calls[0]?.[1] as { kind: string }).kind).toBe('explicit');
  });

  it('路由读取失败/形状非法：warn + 忽略（通知照常入库，不抛）', async () => {
    const warnSpy = vi.fn();
    const boom = makeManager({
      getRoutes: async () => {
        throw new Error('settings unavailable');
      },
      logger: { warn: warnSpy } as never,
    });
    const rec1 = await boom.manager.send({ title: '路由读取失败' });
    expect(rec1.channels).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    const invalid = makeManager({
      getRoutes: async () => [{ channels: [] }], // 缺 match 且 channels 空 → 形状非法
      logger: { warn: warnSpy } as never,
    });
    const rec2 = await invalid.manager.send({ title: '路由形状非法' });
    expect(rec2.channels).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ---- drivers ----

describe('inbox 驱动', () => {
  it("name 'inbox'，deliver 为 no-op（入库即 inbox，持久化由 manager 负责）", async () => {
    expect(inboxDriver.name).toBe('inbox');
    await expect(inboxDriver.deliver(makePayload(), {})).resolves.toBeUndefined();
  });
});

describe('webhook 驱动', () => {
  it('成功投递：POST JSON 载荷 + 携带可验签的 HMAC 签名头', async () => {
    const server = await startCaptureServer(200);
    try {
      const driver = createWebhookDriver();
      const payload = makePayload();
      await driver.deliver(payload, { url: server.url, secret: 's3cret' });

      expect(server.requests).toHaveLength(1);
      const req = server.requests[0];
      expect(req?.method).toBe('POST');
      expect(req?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(req?.rawBody ?? '{}')).toEqual(payload);

      const ts = req?.headers['x-harness-timestamp'] as string;
      const sig = req?.headers['x-harness-signature'] as string;
      expect(typeof ts).toBe('string');
      expect(sig).toBe(expectedSignature('s3cret', ts, req?.rawBody ?? ''));
    } finally {
      await server.close();
    }
  });

  it('secretRef 经 deps.resolveSecret 解析出明文密钥并参与验签', async () => {
    const server = await startCaptureServer(200);
    try {
      const resolveSecret = vi.fn(async () => 'ref-secret');
      const driver = createWebhookDriver({ resolveSecret });
      await driver.deliver(makePayload(), { url: server.url, secretRef: 'hook-ref' });

      expect(resolveSecret).toHaveBeenCalledWith('hook-ref');
      const req = server.requests[0];
      const ts = req?.headers['x-harness-timestamp'] as string;
      expect(req?.headers['x-harness-signature']).toBe(expectedSignature('ref-secret', ts, req?.rawBody ?? ''));
    } finally {
      await server.close();
    }
  });

  it('secretRef 无解析器 → DELIVERY_FAILED（提示两种修复方式）', async () => {
    const driver = createWebhookDriver();
    try {
      await driver.deliver(makePayload(), { url: 'https://example.test/hook', secretRef: 'r' });
      expect.unreachable('deliver should have thrown');
    } catch (e) {
      expect((e as HarnessError).code).toBe('HARNESS-7001');
      expect((e as Error).message).toContain('resolveSecret');
    }
  });

  it('非 2xx（retries:0 加速）→ 抛 HARNESS-701 DELIVERY_FAILED', async () => {
    const server = await startCaptureServer(500);
    try {
      const driver = createWebhookDriver();
      try {
        await driver.deliver(makePayload(), { url: server.url, retries: 0 });
        expect.unreachable('deliver should have thrown');
      } catch (e) {
        expect((e as HarnessError).code).toBe('HARNESS-7001');
        expect((e as HarnessError).retryable).toBe(true);
      }
      expect(server.requests).toHaveLength(1); // retries:0 → 仅一次尝试
    } finally {
      await server.close();
    }
  });

  it('target 非法（缺 url）→ HARNESS-1009 VALIDATION_FAILED', async () => {
    const driver = createWebhookDriver();
    await expect(driver.deliver(makePayload(), { secret: 's' })).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
  });
});

describe('console 驱动', () => {
  it("name 'console'，logger.info 输出标题与级别", async () => {
    const logger = pino({ level: 'silent' });
    const infoSpy = vi.spyOn(logger, 'info');
    const driver = createConsoleDriver(logger);

    expect(driver.name).toBe('console');
    await driver.deliver(makePayload({ title: '控制台通知', level: 'warn' }), {});

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [fields, message] = infoSpy.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(fields.level).toBe('warn');
    expect(String(message)).toContain('控制台通知');
    expect(String(message)).toContain('warn');
  });
});

// ---------------------------------------------------------------------------
// 统一投递重试（retry.ts 纯函数）与 manager 重试编排 / 投递记录落库
// ---------------------------------------------------------------------------

/** 记录退避序列的 sleep 替身（免真实等待，直接断言指数退避口径） */
function makeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe('withDeliveryRetry（统一指数退避重试）', () => {
  it('首次成功：fn 恰好调用 1 次，无退避等待，原值透传', async () => {
    const { sleep, delays } = makeSleep();
    const fn = vi.fn(async () => 'ok');
    await expect(withDeliveryRetry(fn, { retries: 3, baseMs: 500, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('失败后成功：按指数退避（base, base*2）重试并返回原值', async () => {
    const { sleep, delays } = makeSleep();
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error(`fail-${n}`);
      return 'done';
    });
    await expect(withDeliveryRetry(fn, { retries: 3, baseMs: 500, sleep })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
  });

  it('重试耗尽：共 retries+1 次尝试（email 口径退避 2s/4s），抛最后一次原始错误', async () => {
    const { sleep, delays } = makeSleep();
    const fn = vi.fn(async () => {
      throw new Error('permanent');
    });
    await expect(withDeliveryRetry(fn, { retries: 2, baseMs: 2000, sleep })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it('retries:0：单次尝试、零等待（负数/非整数口径被钳制为不重试）', async () => {
    const { sleep, delays } = makeSleep();
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withDeliveryRetry(fn, { retries: 0, baseMs: 500, sleep })).rejects.toThrow('boom');
    await expect(withDeliveryRetry(fn, { retries: -3, baseMs: 500, sleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([]);
  });

  it('retryOn 判定不可重试（如 VALIDATION_FAILED）→ 立即抛出不重试', async () => {
    const { sleep, delays } = makeSleep();
    const fn = vi.fn(async () => {
      throw err('VALIDATION_FAILED', { message: 'bad target' });
    });
    await expect(
      withDeliveryRetry(fn, {
        retries: 5,
        baseMs: 10,
        sleep,
        retryOn: (e) => !(e instanceof HarnessError) || e.retryable,
      }),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('口径解析：每驱动缺省表（email 2 次 2s / webhook 3 次 500ms）+ target.retries + notify.retry 覆盖优先', () => {
    expect(NOTIFICATION_RETRY_DEFAULTS['email']).toEqual({ retries: 2, baseMs: 2000 });
    expect(NOTIFICATION_RETRY_DEFAULTS['webhook']).toEqual({ retries: 3, baseMs: 500 });
    expect(resolveChannelRetry('email', {}, null)).toEqual({ retries: 2, baseMs: 2000 });
    expect(resolveChannelRetry('webhook', {}, null)).toEqual({ retries: 3, baseMs: 500 });
    expect(resolveChannelRetry('nope', {}, null)).toEqual(FALLBACK_DELIVERY_RETRY);
    // webhook 逐目标覆盖（历史契约：target.retries；0 合法）
    expect(resolveChannelRetry('webhook', { url: 'https://x', retries: 0 }, null)).toEqual({ retries: 0, baseMs: 500 });
    expect(resolveChannelRetry('webhook', { retries: 99 }, null)).toEqual({ retries: 10, baseMs: 500 });
    expect(resolveChannelRetry('webhook', { retries: 1.5 }, null)).toEqual({ retries: 3, baseMs: 500 });
    // settings notify.retry 覆盖优先于逐目标与缺省表
    expect(resolveChannelRetry('email', {}, { retries: 1, baseMs: 250 })).toEqual({ retries: 1, baseMs: 250 });
    expect(resolveChannelRetry('webhook', { retries: 0 }, { retries: 1, baseMs: 250 })).toEqual({
      retries: 1,
      baseMs: 250,
    });
    // 归一化：缺失/形状非法 → null（用默认）
    expect(normalizeRetryOverride({ retries: 2, baseMs: 100 })).toEqual({ retries: 2, baseMs: 100 });
    expect(normalizeRetryOverride(undefined)).toBeNull();
    expect(normalizeRetryOverride(null)).toBeNull();
    expect(normalizeRetryOverride({ retries: -1, baseMs: 100 })).toBeNull();
    expect(normalizeRetryOverride({ retries: 11, baseMs: 100 })).toBeNull();
    expect(normalizeRetryOverride({ retries: 2 })).toBeNull();
    expect(normalizeRetryOverride('fast')).toBeNull();
  });
});

describe('NotificationManager — 投递记录落库（recordDelivery → deliveries 表）', () => {
  it('成功渠道：每渠道回调一次 {kind:"notification", channel, target 脱敏摘要, ok:true, durationMs}', async () => {
    const deliver = vi.fn(async () => {});
    const recordDelivery = vi.fn();
    const { manager, registry } = makeManager({ recordDelivery });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({
      title: '落库成功',
      channels: [{ driver: 'stub', target: { url: 'https://example.test/hook', secret: 's3cret' } }],
    });

    expect(recordDelivery).toHaveBeenCalledTimes(1);
    const entry = recordDelivery.mock.calls[0]?.[0] as NotificationDeliveryEntry;
    expect(entry.kind).toBe('notification');
    expect(entry.channel).toBe('stub');
    expect(entry.ok).toBe(true);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.error).toBeUndefined();
    // target 脱敏摘要：secret → ***，非敏感字段原样
    expect(JSON.parse(entry.target)).toEqual({ url: 'https://example.test/hook', secret: '***' });
    expect(rec.id).toBeTruthy();
  });

  it('失败与未知驱动：ok:false + error；多渠道按计划序逐一记录，成功渠道不受影响', async () => {
    const bad = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'smtp down' });
    });
    const good = vi.fn(async () => {});
    const recordDelivery = vi.fn();
    const { manager, registry } = makeManager({ recordDelivery });
    registry.registerNotificationDriver({ name: 'bad', deliver: bad });
    registry.registerNotificationDriver({ name: 'good', deliver: good });

    const rec = await manager.send({
      title: '落库失败',
      channels: [
        { driver: 'bad', target: { host: 'smtp.example.com' } },
        { driver: 'nope', target: {} }, // 未注册
        { driver: 'good', target: {} },
      ],
    });

    expect(recordDelivery).toHaveBeenCalledTimes(3);
    const entries = recordDelivery.mock.calls.map((c) => c[0] as NotificationDeliveryEntry);
    expect(entries[0]).toMatchObject({ kind: 'notification', channel: 'bad', ok: false, error: 'smtp down' });
    expect(JSON.parse(entries[0]?.target ?? '{}')).toEqual({ host: 'smtp.example.com' });
    expect(entries[1]).toMatchObject({ kind: 'notification', channel: 'nope', ok: false, durationMs: 0 });
    expect(entries[1]?.error).toContain('not found');
    expect(entries[2]).toMatchObject({ kind: 'notification', channel: 'good', ok: true });
    expect(rec.id).toBeTruthy();
    // delivered SSE 仍发布（结果数组序一致）
    expect(recordDelivery).toHaveBeenCalled();
  });

  it('recordDelivery 回调同步抛错：仅 warn 不外溢，send 正常返回', async () => {
    const deliver = vi.fn(async () => {});
    const warnSpy = vi.fn();
    const recordDelivery = vi.fn(() => {
      throw new Error('db write failed');
    });
    const { manager, registry, publish } = makeManager({
      recordDelivery,
      logger: { warn: warnSpy, error: vi.fn() } as never,
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({ title: '回调抛错', channels: [{ driver: 'stub', target: {} }] });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recordDelivery).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2); // created + delivered 照常
    expect(rec.id).toBeTruthy();
  });

  it('未注入 recordDelivery：投递照常（向后兼容）', async () => {
    const deliver = vi.fn(async () => {});
    const { manager, registry, publish } = makeManager();
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({ title: '无落库依赖', channels: [{ driver: 'stub', target: {} }] });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(rec.id).toBeTruthy();
  });
});

describe('NotificationManager — 统一重试编排（notify.retry 覆盖 / 每驱动缺省）', () => {
  it('notify.retry 覆盖：getRetry 返回 {retries:2, baseMs:5} → 失败渠道尝试 3 次、退避 [5,10]', async () => {
    const deliver = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'down' });
    });
    const { sleep, delays } = makeSleep();
    const { manager, registry, publish } = makeManager({
      getRetry: async () => ({ retries: 2, baseMs: 5 }),
      sleep,
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const rec = await manager.send({ title: '重试覆盖', channels: [{ driver: 'stub', target: {} }] });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([5, 10]);
    expect(publish).toHaveBeenCalledWith('notifications', 'notification.delivered', {
      id: rec.id,
      results: [{ driver: 'stub', ok: false, durationMs: expect.any(Number), error: 'down' }],
    });
  });

  it('缺省口径按驱动名：email 驱动失败 → 重试 2 次、退避 [2000,4000]（sleep 注入免真实等待）', async () => {
    const deliver = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'smtp 5.4.1' });
    });
    const { sleep, delays } = makeSleep();
    const { manager, registry } = makeManager({ sleep });
    registry.registerNotificationDriver({ name: 'email', deliver });

    await manager.send({
      title: 'email 缺省重试',
      channels: [{ driver: 'email', target: { smtp: { host: 'smtp.example.com' }, from: 'a@b.c', to: 'd@e.f' } }],
    });

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it('webhook target.retries 逐目标生效（manager 统一编排，base 500 历史口径）', async () => {
    const deliver = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'http 500' });
    });
    const { sleep, delays } = makeSleep();
    const { manager, registry } = makeManager({ sleep });
    registry.registerNotificationDriver({ name: 'webhook', deliver });

    await manager.send({
      title: '目标级重试',
      channels: [{ driver: 'webhook', target: { url: 'https://example.test/hook', retries: 1 } }],
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it('VALIDATION_FAILED（retryable=false）不重试：即使 notify.retry 配置了重试', async () => {
    const deliver = vi.fn(async () => {
      throw err('VALIDATION_FAILED', { message: 'bad target' });
    });
    const { sleep, delays } = makeSleep();
    const { manager, registry } = makeManager({
      getRetry: async () => ({ retries: 3, baseMs: 1 }),
      sleep,
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    await manager.send({ title: '配置错误不重试', channels: [{ driver: 'stub', target: {} }] });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('getRetry 读取失败/形状非法 → 回落每驱动缺省口径（warn，不阻断投递）', async () => {
    const deliver = vi.fn(async () => {
      throw err('DELIVERY_FAILED', { message: 'down' });
    });
    const warnSpy = vi.fn();
    const errorSpy = vi.fn();
    const { sleep, delays } = makeSleep();
    const boom = makeManager({
      getRetry: async () => {
        throw new Error('settings unavailable');
      },
      sleep,
      logger: { warn: warnSpy, error: errorSpy } as never,
    });
    boom.registry.registerNotificationDriver({ name: 'email', deliver });
    await boom.manager.send({ title: '读取失败回落', channels: [{ driver: 'email', target: {} }] });
    expect(deliver).toHaveBeenCalledTimes(3); // email 缺省口径 2 次重试
    expect(delays).toEqual([2000, 4000]);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    const invalid = makeManager({
      getRetry: async () => ({ retries: 'fast' }),
      sleep,
      logger: { warn: warnSpy, error: errorSpy } as never,
    });
    invalid.registry.registerNotificationDriver({ name: 'email', deliver });
    await invalid.manager.send({ title: '形状非法回落', channels: [{ driver: 'email', target: {} }] });
    expect(deliver).toHaveBeenCalledTimes(6);
    expect(delays).toEqual([2000, 4000, 2000, 4000]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    // 投递失败不上抛：send 正常返回（record 已入库，由断言外 store 可查）
  });
});

describe('withDeliveryRetry / 投递流水 — 边界补齐', () => {
  it('defaultSleep：setTimeout 实现可等待完成', async () => {
    const start = Date.now();
    await defaultSleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(3);
  });

  it('target 含循环引用：store 桩放行后，投递流水摘要兜底为 [unserializable target]', async () => {
    const deliver = vi.fn(async () => {});
    const recordDelivery = vi.fn();
    const { manager, registry } = makeManager({
      recordDelivery,
      // 绕过真实 store 的 channels 序列化（循环引用会在落库期被 DB_ERROR 拦截）
      store: { create: async () => {} } as never,
    });
    registry.registerNotificationDriver({ name: 'stub', deliver });

    const circular: Record<string, unknown> = { url: 'https://example.test/hook' };
    circular['self'] = circular;
    const rec = await manager.send({ title: '循环引用', channels: [{ driver: 'stub', target: circular }] });

    expect(deliver).toHaveBeenCalledTimes(1);
    const entry = recordDelivery.mock.calls[0]?.[0] as NotificationDeliveryEntry;
    expect(entry.ok).toBe(true);
    expect(entry.target).toBe('[unserializable target]');
    expect(rec.id).toBeTruthy();
  });
});
