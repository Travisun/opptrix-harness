/**
 * 扩展双池化（方案 B）契约测试：内置池（builtin）/ 社区池（community）按信任来源分池。
 *
 * 双池化动机（审计实证）：共享线程下第三方扩展崩溃循环会把 auth/webui 陪葬成 401、
 * 5 次崩溃把全系统扩展打成禁用、busy-loop 饿死线程使登录延迟恶化。本文件锁定分池语义：
 * - 放置规则：builtin 声明 + 受信目录 → builtin 池；其余 → community 池；
 * - community 池维持现状（crash 滑动窗口 → 熔断 → 人工 enable 恢复）；
 * - builtin 池永不自动禁用：无限次退避重启 + 池内拓扑重注册 + 节流通知；
 * - 两池崩溃互不传染（路由表按池摘除/恢复）；
 * - 池内独立拓扑排序；跨池硬依赖（社区扩展依赖内置扩展）仍成立；
 * - disable/reload/uninstall/rescan 按池路由；stop() 两池都停。
 *
 * 桩手法与 ext-manager.test.ts 同款（内存 stub worker 双向手动泵），差异：
 * workerFactory 按池别（'builtin' | 'community'）分发独立 stub，双池互不串味。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';

import { HOST_METHODS, type RpcEnvelope } from '../src/extension-host/protocol.js';
import type { WorkerLike } from '../src/kernel/extensions/bridge.js';
import {
  ExtensionManager,
  type ExtRouteTableEntry,
  type HostKind,
} from '../src/kernel/extensions/manager.js';
import { err } from '../src/kernel/errors/index.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { HookManager } from '../src/kernel/hooks/manager.js';

const logger = pino({ level: 'silent' });

/** 等待一个宏任务（stub worker 的自动回执经 setTimeout(0) 投递） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// stub worker：与 ext-manager.test.ts 同款，另支持 routeRequest 回执
// ---------------------------------------------------------------------------

interface PoolWorkerStub extends WorkerLike {
  sent: RpcEnvelope[];
  /** host.load 的扩展 id 序列（拓扑序断言用） */
  loads: string[];
  /** host.unload 的扩展 id 序列 */
  unloads: string[];
  /** `${topic} ${extId}` 全序（unload → load 顺序断言用） */
  calls: string[];
  terminated: boolean;
  emitMessage(msg: unknown): void;
  emitExit(code: number): void;
  setContributions(extId: string, contributions: unknown): void;
  setFailLoad(extId: string, errShape: { code: string; message: string }): void;
}

interface StubConfig {
  contributions: Record<string, unknown>;
  failLoadFor?: Record<string, { code: string; message: string }>;
}

function createPoolWorkerStub(config: StubConfig): PoolWorkerStub {
  const listeners = new Set<(msg: unknown) => void>();
  const exitListeners = new Set<(code: number) => void>();
  const stub: PoolWorkerStub = {
    sent: [],
    loads: [],
    unloads: [],
    calls: [],
    terminated: false,
    postMessage(msg: unknown) {
      stub.sent.push(msg as RpcEnvelope);
      const env = msg as RpcEnvelope;
      if (env?.type !== 'call' || typeof env.to !== 'string' || !env.to.startsWith('ext:')) return;
      const extId = env.to.slice('ext:'.length);
      stub.calls.push(`${env.topic} ${extId}`);
      if (env.topic === HOST_METHODS.loadExt) {
        stub.loads.push(extId);
        const fail = config.failLoadFor?.[extId];
        queueReply(() =>
          fail
            ? replyOf(env, false, undefined, fail)
            : replyOf(env, true, { contributions: config.contributions[extId] ?? {} }),
        );
        return;
      }
      if (env.topic === HOST_METHODS.unloadExt) {
        stub.unloads.push(extId);
        queueReply(() => replyOf(env, true, {}));
        return;
      }
      if (env.topic === HOST_METHODS.hookApply) {
        const input = (env.payload ?? {}) as { name: string; value: unknown };
        queueReply(() => replyOf(env, true, { value: `${String(input.value)}@${extId}` }));
        return;
      }
      if (env.topic === HOST_METHODS.routeRequest) {
        // worker 契约：应答 { status, headers?, body }（normalizeResponse 产物）
        queueReply(() => replyOf(env, true, { status: 200, body: { servedBy: extId } }));
        return;
      }
    },
    on(type, fn) {
      (type === 'exit' ? exitListeners : listeners).add(fn);
    },
    off(type, fn) {
      (type === 'exit' ? exitListeners : listeners).delete(fn);
    },
    async terminate() {
      stub.terminated = true;
      return 0;
    },
    emitMessage(msg: unknown) {
      for (const fn of [...listeners]) fn(msg);
    },
    emitExit(code: number) {
      for (const fn of [...exitListeners]) fn(code);
    },
    setContributions(extId: string, contributions: unknown) {
      config.contributions[extId] = contributions;
    },
    setFailLoad(extId: string, errShape: { code: string; message: string }) {
      config.failLoadFor = { ...config.failLoadFor, [extId]: errShape };
    },
  };
  return stub;

  function queueReply(build: () => RpcEnvelope): void {
    setTimeout(() => {
      for (const fn of [...listeners]) fn(build());
    }, 0);
  }
}

/** 构造 worker→host 方向的 reply 信封 */
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
        err: errShape ? { code: errShape.code, message: errShape.message } : undefined,
      };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** 合法 manifest（manifestSchema 默认值之上覆写） */
function manifestOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { api: 1, version: '1.0.0', permissions: [], provides: [], requires: [], ...over };
}

/** 合法贡献点（全空兜底之上覆写） */
function contribsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { routes: [], crons: [], events: [], hooks: [], services: [], ...over };
}

// ---------------------------------------------------------------------------
// 测试脚手架：双目录（受信第一方 / 非受信第三方）+ 按池分发的 stub worker
// ---------------------------------------------------------------------------

interface DirSpec {
  manifest: Record<string, unknown>;
  /** true = 放入受信第一方目录（repo-extensions）；缺省 = 非受信第三方目录（data/extensions） */
  trusted?: boolean;
}

interface Harness {
  root: string;
  trustedDir: string;
  untrustedDir: string;
  db: Knex;
  config: HarnessConfig;
  manager: ExtensionManager;
  eventBus: EventBus;
  hooks: HookManager;
  /** 指定池当前 worker stub（respawn 后为新实例；null = 该池未 spawn） */
  workerOf(kind: HostKind): PoolWorkerStub | null;
  /** worker spawn 记录（池别全序） */
  spawnLog: HostKind[];
  spawnCount(): number;
  /** 内置池通知 spy 捕获序列 */
  notifications: Array<{ title: string; body: string; level?: string }>;
  restarts: Array<{ attempt: number; delayMs: number; reenabled: string[] }>;
  /** 让 stub 的异步回执与退避重启落定 */
  settle(): Promise<void>;
}

interface HarnessOptions {
  dirs?: Record<string, DirSpec | Record<string, unknown>>;
  /** 预插 enabled=1 的行（community 扩展用；builtin 扩展默认启用无需预插） */
  enabledInDb?: string[];
  contributions?: Record<string, unknown>;
  crashLoopMax?: number;
  crashLoopWindowMs?: number;
  restartBackoffMs?: number[];
}

const harnesses: Harness[] = [];

async function buildHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'harness-ext-dual-'));
  const dataDir = join(root, 'data');
  const untrustedDir = join(dataDir, 'extensions');
  const trustedDir = join(root, 'repo-extensions');
  const contributions = { ...(opts.contributions ?? {}) };
  for (const [id, spec] of Object.entries(opts.dirs ?? {})) {
    const dirSpec = spec as DirSpec;
    const manifest = 'manifest' in dirSpec && typeof dirSpec.manifest === 'object'
      ? (dirSpec.manifest as Record<string, unknown>)
      : (spec as Record<string, unknown>);
    const trusted = (dirSpec as DirSpec).trusted === true;
    const base = trusted ? trustedDir : untrustedDir;
    const dir = join(base, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'index.js'), 'export {};\n');
  }
  const db = await openSqlite(join(dataDir, 'db', 'kernel.sqlite'));
  await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
  for (const id of opts.enabledInDb ?? []) {
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
      // 预授信（trusted_at 落库）：本套件注入了 isTrustedExtDir，社区池扩展启用前须过信任闸——
      // 这里模拟管理员既往授信过的第三方扩展，跨内核重启免确认
      trusted_at: now,
      trusted_by: 'admin',
    });
  }

  const config: HarnessConfig = {
    ...loadConfig({}),
    env: 'test',
    dataDir,
    rpcTimeoutMs: 500,
    maxRpcPayloadBytes: 64 * 1024,
    crashLoopWindowMs: opts.crashLoopWindowMs ?? 60_000,
    crashLoopMax: opts.crashLoopMax ?? 5,
    maxRoutesPerExt: 100,
  };

  // 池别 → 当前 stub（respawn 覆盖）；所有 stub 共享同一份 contributions 配置
  const current = new Map<HostKind, PoolWorkerStub>();
  const spawnLog: HostKind[] = [];
  const stubConfig: StubConfig = { contributions };
  const notifications: Array<{ title: string; body: string; level?: string }> = [];
  const restarts: Array<{ attempt: number; delayMs: number; reenabled: string[] }> = [];
  const eventBus = new EventBus();
  const hookManager = new HookManager({ logger });
  const manager = new ExtensionManager({
    config,
    db,
    logger,
    workerFactory: (pool) => {
      const kind = pool === 'builtin' ? 'builtin' : 'community';
      const worker = createPoolWorkerStub(stubConfig);
      current.set(kind, worker);
      spawnLog.push(kind);
      return worker;
    },
    bridgeHandlers: {},
    scheduler: {
      schedule: async () => ({ id: 'cron-1' }),
      unschedule: async () => true,
      list: () => [],
    },
    eventBus,
    hooks: hookManager,
    // 受信目录裁决 + SEC-3 mount 闸同款谓词：repo-extensions 之下受信
    isTrustedExtDir: (dir) => dir === trustedDir || dir.startsWith(`${trustedDir}/`),
    authMounts: {
      validateMount: (_manifest, dir) => dir === trustedDir || dir.startsWith(`${trustedDir}/`),
    },
    extensionsDirs: [untrustedDir, trustedDir],
    onWorkerRestart: (info) => restarts.push(info),
    notifier: {
      send: async (input) => {
        notifications.push(input);
        return { ok: true };
      },
    },
    restartBackoffMs: opts.restartBackoffMs ?? [5],
  });
  const harness: Harness = {
    root,
    trustedDir,
    untrustedDir,
    db,
    config,
    manager,
    eventBus,
    hooks: hookManager,
    workerOf: (kind) => current.get(kind) ?? null,
    spawnLog,
    spawnCount: () => spawnLog.length,
    notifications,
    restarts,
    settle: async () => {
      await new Promise((r) => setTimeout(r, 40));
    },
  };
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

function rowOf(h: Harness, id: string): Promise<{ enabled: number; last_error: string | null } | undefined> {
  return h.db('extensions').where({ id }).first();
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('扩展双池化（方案 B）', () => {
  it('放置：受信目录 builtin 声明 → builtin 池；非 builtin → community 池（各自 spawn 独立线程）', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true, permissions: ['http'] }), trusted: true },
        app: manifestOf({ id: 'app', permissions: ['http'] }),
      },
      enabledInDb: ['app'],
      contributions: {
        authx: contribsOf({ routes: [{ method: 'GET', path: '/authx' }] }),
        app: contribsOf({ routes: [{ method: 'GET', path: '/app' }] }),
      },
    });
    await h.manager.start();

    // 各池 spawn 自己的线程，扩展落在各自池的 worker
    expect(h.spawnLog).toEqual(['builtin', 'community']);
    expect(h.workerOf('builtin')?.loads).toEqual(['authx']);
    expect(h.workerOf('community')?.loads).toEqual(['app']);
    // 摘要 host 字段按池透传
    const summaries = h.manager.list();
    expect(summaries.find((s) => s.id === 'authx')?.host).toBe('builtin');
    expect(summaries.find((s) => s.id === 'app')?.host).toBe('community');
    // 每池独立桥：bridgeFor 按扩展归属池取桥
    const builtinBridge = h.manager.bridgeFor('authx');
    const communityBridge = h.manager.bridgeFor('app');
    expect(builtinBridge).not.toBeNull();
    expect(communityBridge).not.toBeNull();
    expect(builtinBridge).not.toBe(communityBridge);
  });

  it('放置：非受信目录的 builtin 自声明 → community 池（放置只对已过受信闸的声明生效）', async () => {
    const h = await buildHarness({
      dirs: {
        rogue: manifestOf({ id: 'rogue', builtin: true }),
      },
      contributions: { rogue: contribsOf() },
    });
    await h.manager.start();
    // 池归属是 community（SEC-3 激活闸另行拒绝该声明——双保险分层）
    expect(h.manager.list().find((s) => s.id === 'rogue')?.host).toBe('community');
    // 未启用（builtin 默认启用只对放置进 builtin 池的扩展生效）
    expect(h.workerOf('builtin')).toBeNull();
    expect(h.workerOf('community')?.loads ?? []).not.toContain('rogue');
  });

  it('关键用例：community 池熔断期间与之后 → builtin 池扩展保持 enabled、路由在表、dispatch 正常', async () => {
    const h = await buildHarness({
      dirs: {
        authx: {
          manifest: manifestOf({ id: 'authx', builtin: true, permissions: ['http', 'hooks'] }),
          trusted: true,
        },
        app: manifestOf({ id: 'app', permissions: ['http'] }),
      },
      enabledInDb: ['app'],
      contributions: {
        authx: contribsOf({
          routes: [{ method: 'GET', path: '/authx' }],
          hooks: [{ name: 'doc.sanitize' }],
        }),
        app: contribsOf({ routes: [{ method: 'GET', path: '/app' }] }),
      },
      crashLoopMax: 1,
      restartBackoffMs: [5],
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'app')?.enabled).toBe(true);

    // 第三方扩展崩溃循环：崩溃 1 → 退避重启；崩溃 2（>1）→ 熔断（走真实桥 exit 接线）
    h.workerOf('community')?.emitExit(1);
    await h.settle();
    h.workerOf('community')?.emitExit(1);
    await h.settle();

    // community 池：扩展全停用 + EXT_CRASH_LOOP
    const app = h.manager.list().find((s) => s.id === 'app');
    expect(app?.enabled).toBe(false);
    expect(app?.lastError).toContain(err('EXT_CRASH_LOOP').code);
    expect((await rowOf(h, 'app'))?.enabled).toBe(0);

    // builtin 池完全不受影响：enabled、路由仍在表中、行仍 enabled=1
    const authx = h.manager.list().find((s) => s.id === 'authx');
    expect(authx?.enabled).toBe(true);
    expect(authx?.crashCount).toBe(0); // builtin 池崩溃窗口为空
    expect(h.manager.getRoutes().some((r) => r.extId === 'authx')).toBe(true);
    expect((await rowOf(h, 'authx'))?.enabled).toBe(1);
    // builtin 池的 worker 从未被误摘（无 unload RPC）
    expect(h.workerOf('builtin')?.unloads).toEqual([]);

    // builtin 池路由 dispatch 正常（经 bridgeFor 走 builtin 桥的 RPC 通路）
    const bridge = h.manager.bridgeFor('authx');
    expect(bridge).not.toBeNull();
    const dispatched = (await bridge?.callToWorker('authx', HOST_METHODS.routeRequest, {
      routeKey: 'GET /authx',
    })) as { status?: number; body?: { servedBy?: string } } | undefined;
    expect(dispatched?.status).toBe(200);
    expect(dispatched?.body?.servedBy).toBe('authx');

    // builtin 池 hook RPC 同样正常（分池后 auth/webui 语义不受第三方崩溃影响）
    expect(await h.hooks.apply('doc.sanitize', 'x')).toBe('x@authx');
  });

  it('community 熔断后人工 enable：仅清 community 池并 respawn community 线程，builtin 不动', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true }), trusted: true },
        app: manifestOf({ id: 'app' }),
      },
      enabledInDb: ['app'],
      contributions: { authx: contribsOf(), app: contribsOf() },
      crashLoopMax: 1,
      restartBackoffMs: [5],
    });
    await h.manager.start();
    const loadsBefore = h.workerOf('builtin')?.loads.length ?? 0;
    const spawnsBefore = h.spawnCount();

    await h.manager.handleWorkerExit('community'); // 崩溃 1 → 重启
    await h.manager.handleWorkerExit('community'); // 崩溃 2 → 熔断
    expect(h.manager.list().find((s) => s.id === 'app')?.enabled).toBe(false);

    await h.manager.enable('app'); // 人工恢复出口

    expect(h.manager.list().find((s) => s.id === 'app')?.enabled).toBe(true);
    expect(h.manager.list().find((s) => s.id === 'app')?.crashCount).toBe(0);
    // 崩溃 1 退避重启 + 人工 enable 各 respawn 一次 community 线程；builtin 零 respawn
    expect(h.spawnCount()).toBe(spawnsBefore + 2);
    expect(h.spawnLog.slice(spawnsBefore)).toEqual(['community', 'community']);
    expect(h.workerOf('builtin')?.loads.length).toBe(loadsBefore); // builtin 零扰动
  });

  it('builtin worker 崩溃 10 次（远超 community 熔断阈值）→ 从不进入 disabled，路由每次恢复；通知节流', async () => {
    const h = await buildHarness({
      dirs: {
        authx: {
          manifest: manifestOf({ id: 'authx', builtin: true, permissions: ['http'] }),
          trusted: true,
        },
        app: manifestOf({ id: 'app', permissions: ['http'] }),
      },
      enabledInDb: ['app'],
      contributions: {
        authx: contribsOf({ routes: [{ method: 'GET', path: '/authx' }] }),
        app: contribsOf({ routes: [{ method: 'GET', path: '/app' }] }),
      },
      crashLoopMax: 1, // 该阈值若作用于 builtin 池早就熔断
      restartBackoffMs: [5],
    });
    await h.manager.start();

    for (let i = 0; i < 10; i++) {
      await h.manager.handleWorkerExit('builtin');
      const authx = h.manager.list().find((s) => s.id === 'authx');
      expect(authx?.enabled).toBe(true); // 每次重启后仍 enabled，永不自动禁用
      expect(h.manager.getRoutes().some((r) => r.extId === 'authx')).toBe(true);
    }

    // 每次崩溃都 respawn 一个新 worker（stub 随之换新），重注册的 load 落在最新 stub 上
    expect(h.spawnCount()).toBe(12); // 初始两池 + 10 次 builtin 退避重启
    expect(h.spawnLog.slice(0, 2)).toEqual(['builtin', 'community']);
    expect(h.spawnLog.slice(2).every((k) => k === 'builtin')).toBe(true); // 自愈只发生在 builtin 池
    expect(h.workerOf('builtin')?.loads).toEqual(['authx']); // 第 10 次重启后的重注册
    expect((await rowOf(h, 'authx'))?.enabled).toBe(1);
    expect((await rowOf(h, 'authx'))?.last_error).toBeNull();

    // 通知节流：重启风暴合并为一条（首条 warn；后续 5 分钟内不重发）
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.level).toBe('warn');
    expect(h.notifications[0]?.title).toBe('内置扩展宿主重启');
  });

  it('反向隔离：builtin 池崩溃 → community 池扩展路由完全不受影响', async () => {
    const h = await buildHarness({
      dirs: {
        authx: {
          manifest: manifestOf({ id: 'authx', builtin: true, permissions: ['http'] }),
          trusted: true,
        },
        app: manifestOf({ id: 'app', permissions: ['http'] }),
      },
      enabledInDb: ['app'],
      contributions: {
        authx: contribsOf({ routes: [{ method: 'GET', path: '/authx' }] }),
        app: contribsOf({ routes: [{ method: 'GET', path: '/app' }] }),
      },
      restartBackoffMs: [5],
    });
    await h.manager.start();
    const communityLoadsBefore = h.workerOf('community')?.loads.length ?? 0;

    await h.manager.handleWorkerExit('builtin'); // 内置池崩溃 + 自愈

    // community 池零扰动：仍 enabled、路由在表、worker 无 unload、无重复 load
    expect(h.manager.list().find((s) => s.id === 'app')?.enabled).toBe(true);
    expect(h.manager.getRoutes().some((r) => r.extId === 'app')).toBe(true);
    expect(h.workerOf('community')?.unloads).toEqual([]);
    expect(h.workerOf('community')?.loads.length).toBe(communityLoadsBefore);
    // builtin 池自愈完成后路由恢复，onWorkerRestart 仅报 builtin 扩展
    expect(h.manager.getRoutes().some((r) => r.extId === 'authx')).toBe(true);
    expect(h.restarts.at(-1)).toEqual({ attempt: 1, delayMs: 5, reenabled: ['authx'] });
  });

  it('各池独立拓扑：builtin 池内 B requires A → A 先启；community 池硬依赖缺失仅该池受影响', async () => {
    const h = await buildHarness({
      dirs: {
        b1: { manifest: manifestOf({ id: 'b1', builtin: true, requires: ['a1'] }), trusted: true },
        a1: { manifest: manifestOf({ id: 'a1', builtin: true }), trusted: true },
        c1: manifestOf({ id: 'c1', requires: ['ghost'] }),
        e1: manifestOf({ id: 'e1' }),
      },
      enabledInDb: ['c1', 'e1'],
      contributions: { a1: contribsOf(), b1: contribsOf(), c1: contribsOf(), e1: contribsOf() },
    });
    await h.manager.start();

    // builtin 池内拓扑序：a1 先于 b1
    expect(h.workerOf('builtin')?.loads).toEqual(['a1', 'b1']);
    // community 池独立排序：c1 硬依赖缺失仅自身被拒，e1 正常激活
    const c1 = h.manager.list().find((s) => s.id === 'c1');
    const e1 = h.manager.list().find((s) => s.id === 'e1');
    expect(c1?.enabled).toBe(false);
    expect(c1?.lastError).toContain(err('EXT_DEPENDENCY_MISSING').code);
    expect(e1?.enabled).toBe(true);
    expect(h.workerOf('community')?.loads).toEqual(['e1']);
  });

  it('跨池硬依赖成立：community 扩展 requires builtin 扩展（已启用）→ 正常激活', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true }), trusted: true },
        client: manifestOf({ id: 'client', requires: ['authx'] }),
      },
      enabledInDb: ['client'],
      contributions: { authx: contribsOf(), client: contribsOf() },
    });
    await h.manager.start();
    // builtin 池先启（计划序 builtin → community），client 的硬依赖跨池可满足
    expect(h.manager.list().find((s) => s.id === 'client')?.enabled).toBe(true);
    expect(h.workerOf('community')?.loads).toEqual(['client']);
  });

  it('disable / reload / uninstall 按池路由：unload RPC 只落在扩展所在的池', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true }), trusted: true },
        app: manifestOf({ id: 'app' }),
      },
      enabledInDb: ['app'],
      contributions: { authx: contribsOf(), app: contribsOf() },
    });
    await h.manager.start();

    await h.manager.disable('authx');
    expect(h.workerOf('builtin')?.unloads).toEqual(['authx']);
    expect(h.workerOf('community')?.unloads).toEqual([]);
    expect(h.manager.list().find((s) => s.id === 'authx')?.enabled).toBe(false);

    await h.manager.enable('authx'); // 复活，为 reload 做准备
    await h.manager.reload('authx');
    const calls = h.workerOf('builtin')?.calls ?? [];
    const unloadAt = calls.indexOf(`${HOST_METHODS.unloadExt} authx`);
    const reloadLoadAt = calls.indexOf(`${HOST_METHODS.loadExt} authx`, unloadAt);
    expect(unloadAt).toBeGreaterThanOrEqual(0);
    expect(reloadLoadAt).toBeGreaterThan(unloadAt);
    expect(h.workerOf('community')?.unloads).toEqual([]); // community 池全程无扰动

    await h.manager.uninstall('app');
    expect(await rowOf(h, 'app')).toBeUndefined();
    expect(h.workerOf('community')?.unloads).toEqual(['app']);
    expect(h.workerOf('builtin')?.unloads).toEqual(['authx', 'authx']); // reload 的一次 + 复活前的那次
  });

  it('rescan：运行中新增非受信目录 → community 池候选（host=community），enable 落 community 线程', async () => {
    const h = await buildHarness({
      dirs: { app: manifestOf({ id: 'app' }) },
      enabledInDb: ['app'],
      contributions: { app: contribsOf() },
    });
    await h.manager.start();

    mkdirSync(join(h.untrustedDir, 'late'), { recursive: true });
    writeFileSync(join(h.untrustedDir, 'late', 'manifest.json'), JSON.stringify(manifestOf({ id: 'late' })));

    const { discovered } = await h.manager.rescan();
    expect(discovered).toEqual(['late']);
    const late = h.manager.list().find((s) => s.id === 'late');
    expect(late?.host).toBe('community');
    expect(late?.enabled).toBe(false); // 候选不入池，直到 enable

    // 新发现的第三方目录首次启用需人工授信（信任闸），授信后落入 community 池线程
    await expect(h.manager.enable('late')).rejects.toMatchObject({
      code: err('EXT_TRUST_REQUIRED').code,
    });
    await h.manager.enable('late', { confirmTrust: true });
    expect(h.workerOf('community')?.loads).toContain('late');
    expect(h.manager.list().find((s) => s.id === 'late')?.enabled).toBe(true);
  });

  it('stop()：两池都停（worker terminate、桥拒绝新调用）；幂等', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true }), trusted: true },
        app: manifestOf({ id: 'app' }),
      },
      enabledInDb: ['app'],
      contributions: { authx: contribsOf(), app: contribsOf() },
    });
    await h.manager.start();
    expect(h.workerOf('builtin')?.terminated).toBe(false);
    expect(h.workerOf('community')?.terminated).toBe(false);
    const communityBridge = h.manager.bridgeFor('app');
    expect(communityBridge).not.toBeNull();

    await h.manager.stop();
    expect(h.workerOf('builtin')?.terminated).toBe(true);
    expect(h.workerOf('community')?.terminated).toBe(true);
    // 停止后的旧桥拒绝新调用（池桥已从 manager 摘除，bridgeFor 返回 null）
    expect(h.manager.bridgeFor('app')).toBeNull();
    await expect(communityBridge!.callToWorker('app', HOST_METHODS.routeRequest, {})).rejects.toMatchObject({
      code: err('SERVICE_UNAVAILABLE').code,
    });

    await h.manager.stop(); // 幂等：不抛错
    expect(h.manager.list().find((s) => s.id === 'authx')?.enabled).toBe(true); // 表状态不受 stop 影响
  });

  it('crashCount 按池计：builtin 崩溃只计入 builtin 池扩展的摘要', async () => {
    const h = await buildHarness({
      dirs: {
        authx: { manifest: manifestOf({ id: 'authx', builtin: true }), trusted: true },
        app: manifestOf({ id: 'app' }),
      },
      enabledInDb: ['app'],
      contributions: { authx: contribsOf(), app: contribsOf() },
      restartBackoffMs: [5],
    });
    await h.manager.start();
    await h.manager.handleWorkerExit('builtin');
    await h.manager.handleWorkerExit('builtin');

    expect(h.manager.list().find((s) => s.id === 'authx')?.crashCount).toBe(2);
    expect(h.manager.list().find((s) => s.id === 'app')?.crashCount).toBe(0);
  });

  it('notify 缺失时 builtin 崩溃自愈静默完成（deps.notifier 未注入不炸）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ext-nonotify-'));
    try {
      const dataDir = join(root, 'data');
      const untrustedDir = join(dataDir, 'extensions');
      const trustedDir = join(root, 'repo-extensions');
      const dir = join(trustedDir, 'authx');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifestOf({ id: 'authx', builtin: true })));
      writeFileSync(join(dir, 'index.js'), 'export {};\n');
      const db = await openSqlite(join(dataDir, 'db', 'kernel.sqlite'));
      await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
      const manager = new ExtensionManager({
        config: {
          ...loadConfig({}),
          env: 'test',
          dataDir,
          rpcTimeoutMs: 500,
          maxRpcPayloadBytes: 64 * 1024,
          crashLoopWindowMs: 60_000,
          crashLoopMax: 5,
          maxRoutesPerExt: 100,
        },
        db,
        logger,
        workerFactory: () => createPoolWorkerStub({ contributions: { authx: contribsOf() } }),
        bridgeHandlers: {},
        scheduler: { schedule: async () => ({ id: 'c1' }), unschedule: async () => true, list: () => [] },
        eventBus: new EventBus(),
        hooks: new HookManager({ logger }),
        isTrustedExtDir: (d) => d === trustedDir || d.startsWith(`${trustedDir}/`),
        authMounts: { validateMount: (_m, d) => d === trustedDir || d.startsWith(`${trustedDir}/`) },
        extensionsDirs: [untrustedDir, trustedDir],
        restartBackoffMs: [5],
        // 未注入 notifier
      });
      await manager.start();
      await manager.handleWorkerExit('builtin');
      expect(manager.list().find((s) => s.id === 'authx')?.enabled).toBe(true);
      await manager.stop();
      await db.destroy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
