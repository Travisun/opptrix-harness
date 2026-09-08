/**
 * 第三方扩展信任确认机制测试（产品层人工授信）。
 *
 * 覆盖（EXT_TRUST_REQUIRED / m015 trusted_at）：
 * - 第三方扩展首次 enable → 403 EXT_TRUST_REQUIRED（HARNESS-3012）且未激活
 *   （host.load 未触达、路由未提交、行 enabled=0 + last_error）；
 * - 错误 detail 形状 { id, permissions, confirmHint }；
 * - confirmTrust=true → 激活成功且 trusted_at/trusted_by 落库；
 * - 已授信扩展二次 enable / disable→enable / reload / 内核重启（start 自动激活）免确认；
 * - 受信第一方目录（isTrustedExtDir true）恒免确认，trusted_at 保持为空；
 * - uninstall 删行后重装需重新确认；
 * - 授信先于激活持久化：confirmTrust 后激活失败不回滚授信，修复后免确认激活；
 * - 表中残留 enabled=1 但未授信的第三方行 → start 时拒绝激活（enabled=0 + last_error）；
 * - isTrustedExtDir 未注入 → 信任闸关闭（向后兼容，测试 stub 场景）；
 * - REST API：enable body { confirmTrust } zod 校验 + manager 透传 + 403 原样下发。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

import { HOST_METHODS, type RpcEnvelope } from '../src/extension-host/protocol.js';
import type { WorkerLike } from '../src/kernel/extensions/bridge.js';
import { ExtensionManager } from '../src/kernel/extensions/manager.js';
import { err, HarnessError } from '../src/kernel/errors/index.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { HookManager } from '../src/kernel/hooks/manager.js';
import { registerExtensionRoutes, type ExtensionsApiDeps } from '../src/api/extensions.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// stub worker：按配置回执 host.load / host.unload（内存双相泵）
// ---------------------------------------------------------------------------

interface TrustWorkerStub extends WorkerLike {
  /** host.load 的扩展 id 序列（信任闸拒绝时不应增长） */
  loads: string[];
  unloads: string[];
  setFailLoad(extId: string | null): void;
}

function createTrustWorkerStub(): TrustWorkerStub {
  const listeners = new Set<(msg: unknown) => void>();
  let failLoadFor: string | null = null;
  const stub: TrustWorkerStub = {
    loads: [],
    unloads: [],
    setFailLoad(extId) {
      failLoadFor = extId;
    },
    postMessage(msg: unknown) {
      const env = msg as RpcEnvelope;
      if (env?.type !== 'call' || typeof env.to !== 'string' || !env.to.startsWith('ext:')) return;
      const extId = env.to.slice('ext:'.length);
      if (env.topic === HOST_METHODS.loadExt) {
        stub.loads.push(extId);
        const fail = failLoadFor === extId;
        queueReply(() =>
          fail
            ? replyOf(env, false, undefined, { code: 'EXT_LOAD_FAILED', message: 'injected load failure' })
            : replyOf(env, true, { contributions: { routes: [], crons: [], events: [], hooks: [], services: [] } }),
        );
        return;
      }
      if (env.topic === HOST_METHODS.unloadExt) {
        stub.unloads.push(extId);
        queueReply(() => replyOf(env, true, {}));
      }
    },
    on(type, fn) {
      if (type === 'message') listeners.add(fn);
    },
    off(type, fn) {
      if (type === 'message') listeners.delete(fn);
    },
    async terminate() {
      return 0;
    },
  };
  return stub;

  function queueReply(build: () => RpcEnvelope): void {
    setTimeout(() => {
      for (const fn of [...listeners]) fn(build());
    }, 0);
  }

  function replyOf(
    call: RpcEnvelope,
    ok: boolean,
    payload: unknown,
    errShape?: { code: string; message: string },
  ): RpcEnvelope {
    return ok
      ? { v: 1, id: call.id, from: call.to, to: 'kernel', type: 'reply', topic: call.topic, ok: true, payload }
      : {
          v: 1,
          id: call.id,
          from: call.to,
          to: 'kernel',
          type: 'reply',
          topic: call.topic,
          ok: false,
          err: errShape,
        };
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 合法 manifest（第三方扩展默认声明 http 权限，供 detail.permissions 断言） */
function manifestOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { api: 1, version: '1.0.0', permissions: [], provides: [], requires: [], ...over };
}

interface HarnessOptions {
  /** 第三方目录（dataDir/extensions）下的扩展 manifest */
  thirdParty?: Record<string, Record<string, unknown>>;
  /** 受信第一方目录（root/extensions）下的扩展 manifest */
  firstParty?: Record<string, Record<string, unknown>>;
  /** 预插 enabled=1 的残留行：id → 是否已授信（trusted_at 落库） */
  enabledRows?: Record<string, { trusted?: boolean }>;
  /** 不注入 isTrustedExtDir（信任闸关闭场景） */
  omitTrustPredicate?: boolean;
}

interface Harness {
  root: string;
  firstPartyDir: string;
  thirdPartyDir: string;
  db: Knex;
  manager: ExtensionManager;
  worker: TrustWorkerStub;
}

const harnesses: Harness[] = [];

async function buildHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'harness-ext-trust-'));
  const firstPartyDir = join(root, 'extensions');
  const thirdPartyDir = join(root, 'data', 'extensions');
  for (const [dir, manifests] of [
    [firstPartyDir, opts.firstParty ?? {}],
    [thirdPartyDir, opts.thirdParty ?? {}],
  ] as const) {
    for (const [id, manifest] of Object.entries(manifests)) {
      const extDir = join(dir, id);
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(extDir, 'index.js'), 'export {};\n');
    }
  }
  const dataDir = join(root, 'data');
  const db = await openSqlite(join(dataDir, 'db', 'kernel.sqlite'));
  await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
  for (const [id, row] of Object.entries(opts.enabledRows ?? {})) {
    const now = Date.now();
    await db('extensions').insert({
      id,
      version: '1.0.0',
      enabled: 1,
      builtin: 0,
      mount: null,
      uninstall: 'keep',
      crash_count: 0,
      last_error: null,
      installed_at: now,
      updated_at: now,
      ...(row.trusted ? { trusted_at: now, trusted_by: 'admin' } : {}),
    });
  }

  const config: HarnessConfig = {
    ...loadConfig({}),
    env: 'test',
    dataDir,
    rpcTimeoutMs: 500,
    maxRpcPayloadBytes: 64 * 1024,
    crashLoopWindowMs: 60_000,
    crashLoopMax: 5,
    maxRoutesPerExt: 100,
  };

  const worker = createTrustWorkerStub();
  const eventBus = new EventBus();
  const hookManager = new HookManager({ logger });
  const manager = new ExtensionManager({
    config,
    db,
    logger,
    workerFactory: () => worker,
    bridgeHandlers: {},
    scheduler: {
      schedule: async () => ({ id: 'cron-1' }),
      unschedule: async () => true,
      list: () => [],
    },
    eventBus,
    hooks: hookManager,
    extensionsDirs: [thirdPartyDir, firstPartyDir],
    ...(opts.omitTrustPredicate === true
      ? {}
      : {
          isTrustedExtDir: (dir: string) => {
            const resolved = dir.replaceAll('\\', '/');
            return resolved === firstPartyDir || resolved.startsWith(`${firstPartyDir}/`);
          },
        }),
  });
  const harness: Harness = { root, firstPartyDir, thirdPartyDir, db, manager, worker };
  harnesses.push(harness);
  return harness;
}

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.manager.stop().catch(() => undefined);
    await h.db.destroy().catch(() => undefined);
    rmSync(h.root, { recursive: true, force: true });
  }
});

interface ExtRowLike {
  enabled: number;
  last_error: string | null;
  trusted_at: number | null;
  trusted_by: string | null;
}

function rowOf(harness: Harness, id: string): Promise<ExtRowLike | undefined> {
  return harness.db('extensions').where({ id }).first();
}

const THIRD_PARTY = {
  'ext-3p': manifestOf({ id: 'ext-3p', permissions: ['http'] }),
} as const;

// ---------------------------------------------------------------------------
// manager 层用例
// ---------------------------------------------------------------------------

describe('第三方扩展信任确认（manager 层）', () => {
  it('第三方首启 enable → EXT_TRUST_REQUIRED（403）且未激活', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    await expect(h.manager.enable('ext-3p')).rejects.toMatchObject({
      code: err('EXT_TRUST_REQUIRED').code,
      status: 403,
      retryable: false,
    });
    // 未激活：host.load 未触达、无路由、行 enabled=0 + last_error
    expect(h.worker.loads).toEqual([]);
    expect(h.manager.getRoutes()).toEqual([]);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(false);
    const row = await rowOf(h, 'ext-3p');
    expect(row?.enabled).toBe(0);
    expect(row?.last_error).toContain(err('EXT_TRUST_REQUIRED').code);
    expect(row?.trusted_at ?? null).toBeNull();
  });

  it('EXT_TRUST_REQUIRED 的 detail 携带 { id, permissions, confirmHint }', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    const cause = await h.manager.enable('ext-3p').catch((e: HarnessError) => e);
    expect(cause.code).toBe(err('EXT_TRUST_REQUIRED').code);
    expect(cause.detail).toEqual({
      id: 'ext-3p',
      permissions: ['http'],
      confirmHint: `POST /api/v1/extensions/ext-3p/enable {"confirmTrust":true}`,
    });
  });

  it('confirmTrust=true → 激活成功且 trusted_at/trusted_by 落库', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    await h.manager.enable('ext-3p', { confirmTrust: true });
    expect(h.worker.loads).toEqual(['ext-3p']);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(true);
    const row = await rowOf(h, 'ext-3p');
    expect(row?.enabled).toBe(1);
    expect(typeof row?.trusted_at).toBe('number');
    expect((row?.trusted_at ?? 0) as number).toBeGreaterThan(0);
    expect(row?.trusted_by).toBe('admin');
    expect(row?.last_error ?? null).toBeNull();
  });

  it('已授信扩展后续 enable / disable→enable / reload 免确认', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    await h.manager.enable('ext-3p', { confirmTrust: true });
    // 二次 enable：幂等 no-op（无重复 load）
    await h.manager.enable('ext-3p');
    expect(h.worker.loads).toEqual(['ext-3p']);
    // disable → enable（不带 confirmTrust）：授信持久化生效
    await h.manager.disable('ext-3p');
    await h.manager.enable('ext-3p');
    expect(h.worker.loads).toEqual(['ext-3p', 'ext-3p']);
    // reload 免确认
    await h.manager.reload('ext-3p');
    expect(h.worker.loads).toEqual(['ext-3p', 'ext-3p', 'ext-3p']);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(true);
  });

  it('受信第一方目录免确认（trusted_at 保持为空）', async () => {
    const h = await buildHarness({ firstParty: { 'ext-1p': manifestOf({ id: 'ext-1p' }) } });
    await h.manager.start();
    await h.manager.enable('ext-1p'); // 无 confirmTrust，直接成功
    expect(h.worker.loads).toEqual(['ext-1p']);
    expect(h.manager.list().find((s) => s.id === 'ext-1p')?.enabled).toBe(true);
    const row = await rowOf(h, 'ext-1p');
    expect(row?.trusted_at ?? null).toBeNull();
    expect(row?.trusted_by ?? null).toBeNull();
  });

  it('uninstall 删行后重装需重新确认', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    await h.manager.enable('ext-3p', { confirmTrust: true });
    await h.manager.uninstall('ext-3p');
    expect(await rowOf(h, 'ext-3p')).toBeUndefined();
    // 重装 = 重新发现登记（rescan 语义）；trusted_at 随旧行删除
    const { discovered } = await h.manager.rescan();
    expect(discovered).toEqual(['ext-3p']);
    await expect(h.manager.enable('ext-3p')).rejects.toMatchObject({
      code: err('EXT_TRUST_REQUIRED').code,
    });
    // 信任闸拒绝发生在 host.load 之前：load 序列不增长（仍为首次授信激活的那一次）
    expect(h.worker.loads).toEqual(['ext-3p']);
    await h.manager.enable('ext-3p', { confirmTrust: true });
    expect(h.worker.loads).toEqual(['ext-3p', 'ext-3p']);
  });

  it('表中残留 enabled=1 但未授信的第三方行 → start 时拒绝激活', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY }, enabledRows: { 'ext-3p': {} } });
    await h.manager.start();
    // 单扩展激活失败不阻断启动，但该扩展保持停用并记录 last_error
    expect(h.worker.loads).toEqual([]);
    const row = await rowOf(h, 'ext-3p');
    expect(row?.enabled).toBe(0);
    expect(row?.last_error).toContain(err('EXT_TRUST_REQUIRED').code);
    expect(h.manager.getRoutes()).toEqual([]);
  });

  it('已授信且 enabled=1 的行 → start 自动激活（跨重启免确认）', async () => {
    const h = await buildHarness({
      thirdParty: { ...THIRD_PARTY },
      enabledRows: { 'ext-3p': { trusted: true } },
    });
    await h.manager.start();
    expect(h.worker.loads).toEqual(['ext-3p']);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(true);
  });

  it('confirmTrust 后激活失败不回滚授信；修复后 enable 免确认成功', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY } });
    await h.manager.start();
    h.worker.setFailLoad('ext-3p');
    await expect(h.manager.enable('ext-3p', { confirmTrust: true })).rejects.toMatchObject({
      code: err('EXT_ACTIVATION_FAILED').code,
    });
    // 授信是用户对来源的确认：激活失败不回滚 trusted_at
    const afterFail = await rowOf(h, 'ext-3p');
    expect(typeof afterFail?.trusted_at).toBe('number');
    // worker 修复后，不带 confirmTrust 的 enable 直接成功
    //（stub 的 loads 记录每次 load 尝试：失败的一次 + 修复后成功的一次）
    h.worker.setFailLoad(null);
    await h.manager.enable('ext-3p');
    expect(h.worker.loads).toEqual(['ext-3p', 'ext-3p']);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(true);
  });

  it('isTrustedExtDir 未注入 → 信任闸关闭（向后兼容）', async () => {
    const h = await buildHarness({ thirdParty: { ...THIRD_PARTY }, omitTrustPredicate: true });
    await h.manager.start();
    await h.manager.enable('ext-3p');
    expect(h.worker.loads).toEqual(['ext-3p']);
    expect(h.manager.list().find((s) => s.id === 'ext-3p')?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REST API 用例（fastify inject；manager stub 捕获 enable 入参）
// ---------------------------------------------------------------------------

/** enable 入参捕获 stub（ExtensionsApiDeps['manager'] 的结构子集） */
class CaptureManager {
  readonly enableCalls: Array<{ id: string; input?: { confirmTrust?: boolean } }> = [];
  enableError: HarnessError | null = null;

  list(): unknown[] {
    return [];
  }

  async enable(id: string, input?: { confirmTrust?: boolean }): Promise<void> {
    this.enableCalls.push({ id, ...(input !== undefined ? { input } : {}) });
    if (this.enableError !== null) throw this.enableError;
  }

  async disable(_id: string): Promise<void> {}
  async reload(_id: string): Promise<void> {}
  async uninstall(_id: string, _opts?: { purge?: boolean }): Promise<void> {}
  async rescan(): Promise<{ discovered: string[] }> {
    return { discovered: [] };
  }
  getRoutes(): unknown[] {
    return [];
  }
}

const ADMIN = { authorization: 'Bearer token-admin' };

async function buildApi(): Promise<{ app: FastifyInstance; manager: CaptureManager }> {
  const manager = new CaptureManager();
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: './data' });
  const { app } = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      const deps: ExtensionsApiDeps = {
        checker: async ({ token }) => {
          if (token === 'token-admin') return { role: 'admin' };
          throw err('UNAUTHORIZED', { detail: 'token rejected' });
        },
        manager,
        registry: { list: () => [] },
      };
      registerExtensionRoutes(a, deps);
    },
  });
  return { app, manager };
}

describe('第三方扩展信任确认（REST API 层）', () => {
  it('POST /:id/enable body {confirmTrust:true} → manager.enable 透传 input', async () => {
    const { app, manager } = await buildApi();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/ext-3p/enable',
      headers: ADMIN,
      payload: { confirmTrust: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(manager.enableCalls).toEqual([{ id: 'ext-3p', input: { confirmTrust: true } }]);
  });

  it('POST /:id/enable 无 body → manager.enable 收到 {confirmTrust: undefined}', async () => {
    const { app, manager } = await buildApi();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/ext-3p/enable',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(manager.enableCalls).toEqual([{ id: 'ext-3p', input: { confirmTrust: undefined } }]);
  });

  it('manager 抛 EXT_TRUST_REQUIRED → 403 HARNESS-3012 原样透传（detail 含 confirmHint）', async () => {
    const { app, manager } = await buildApi();
    manager.enableError = err('EXT_TRUST_REQUIRED', {
      detail: {
        id: 'ext-3p',
        permissions: ['http'],
        confirmHint: `POST /api/v1/extensions/ext-3p/enable {"confirmTrust":true}`,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/ext-3p/enable',
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: 'HARNESS-3012',
      message: 'third-party extension requires manual trust confirmation',
      detail: {
        id: 'ext-3p',
        permissions: ['http'],
        confirmHint: `POST /api/v1/extensions/ext-3p/enable {"confirmTrust":true}`,
      },
      retryable: false,
    });
  });

  it('body {confirmTrust:"yes"} → 400 HARNESS-1009 且不触达 manager', async () => {
    const { app, manager } = await buildApi();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/ext-3p/enable',
      headers: ADMIN,
      payload: { confirmTrust: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
    expect(manager.enableCalls).toEqual([]);
  });
});
