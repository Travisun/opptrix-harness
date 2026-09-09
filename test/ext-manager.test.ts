/**
 * ExtensionManager 生命周期契约测试（stub worker 回放 load 回执）。
 *
 * 覆盖：发现 + requires 拓扑序 / 环检测（EXT_DEPENDENCY_MISSING）/ 硬依赖缺失隔离 /
 * enable 原子性（非法贡献点回滚 + last_error + enabled=0）/ 权限复核
 * （http 权限、services⊆provides）/ 路由表提交与 onRoutesChanged / disable 逆序摘除
 * （事件退订、hook 摘除、cron unschedule、路由整表移除、host.unload）/ 幂等 /
 * reload（成功换表 + 失败保持 disabled）/ worker 崩溃退避重启 + 拓扑重启用 /
 * crash 熔断（EXT_CRASH_LOOP + 全停 + 人工 enable 恢复）/ uninstall keep|purge /
 * bridgeHandlers 经桥透传 / list() 摘要形状 / hook 回执解包（改写 { value } 与 aborted
 * 短路——真实 worker 应答形状）/ UI 贡献同步（onUiChanged 合并片段 + disable/崩溃摘除）。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';

import { HOST_METHODS, type RpcEnvelope } from '../src/extension-host/protocol.js';
import type { WorkerLike } from '../src/kernel/extensions/bridge.js';
import { ExtensionManager, type ExtRouteTableEntry } from '../src/kernel/extensions/manager.js';
import { err } from '../src/kernel/errors/index.js';
import { loadConfig, type HarnessConfig } from '../src/kernel/config/index.js';
import { extDbPath, openSqlite } from '../src/kernel/storage/db.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { HookManager } from '../src/kernel/hooks/manager.js';

const logger = pino({ level: 'silent' });

/** 等待一个宏任务（stub worker 的自动回执经 setTimeout(0) 投递） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// stub worker：按配置自动回执 host.load / host.unload / host.hook
// ---------------------------------------------------------------------------

interface ManagerWorkerStub extends WorkerLike {
  /** host→worker 全部出站信封 */
  sent: RpcEnvelope[];
  /** host.load 的扩展 id 序列（拓扑序断言用） */
  loads: string[];
  /** host.unload 的扩展 id 序列 */
  unloads: string[];
  /** host.hook 的调用入参序列 */
  hookCalls: Array<{ name: string; value: unknown; ctx: unknown }>;
  /** `${topic} ${extId}` 全序（unload 先于 load 的顺序断言用） */
  calls: string[];
  /** 收到的 dispatch（事件断言用） */
  dispatches: RpcEnvelope[];
  terminated: boolean;
  emitMessage(msg: unknown): void;
  emitExit(code: number): void;
  /** 运行期改布点（reload 测试用） */
  setContributions(extId: string, contributions: unknown): void;
  setFailLoad(extId: string, errShape: { code: string; message: string }): void;
}

interface StubConfig {
  contributions: Record<string, unknown>;
  failLoadFor?: Record<string, { code: string; message: string }>;
  hookErrFor?: Record<string, { code: string; message: string }>;
  hookTransform?: (input: { hook: string; value: unknown; ctx: unknown }) => unknown;
  /** hook 名 → aborted 短路结果（模拟扩展侧抛 HookAbort(result)：回执 { value, aborted: true }） */
  hookAbortFor?: Record<string, unknown>;
}

function createManagerWorkerStub(config: StubConfig): ManagerWorkerStub {
  const listeners = new Set<(msg: unknown) => void>();
  const exitListeners = new Set<(code: number) => void>();
  const stub: ManagerWorkerStub = {
    sent: [],
    loads: [],
    unloads: [],
    hookCalls: [],
    calls: [],
    dispatches: [],
    terminated: false,
    postMessage(msg: unknown) {
      stub.sent.push(msg as RpcEnvelope);
      const env = msg as RpcEnvelope;
      if (env?.type === 'dispatch') stub.dispatches.push(env);
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
        const input = (env.payload ?? {}) as { name: string; value: unknown; ctx: unknown };
        stub.hookCalls.push(input);
        const hookErr = config.hookErrFor?.[input.name];
        if (hookErr) {
          queueReply(() => replyOf(env, false, undefined, hookErr));
          return;
        }
        // 真实 worker 契约（worker.ts handleHookApply）：应答 payload 为 { value, aborted? }
        // 回执（信封 ok:true 由桥结算）——aborted 模拟扩展侧 HookAbort 短路
        const abortedResult = config.hookAbortFor?.[input.name];
        if (abortedResult !== undefined) {
          queueReply(() => replyOf(env, true, { value: abortedResult, aborted: true }));
          return;
        }
        const transformed = config.hookTransform ? config.hookTransform(input) : input.value;
        queueReply(() => replyOf(env, true, { value: transformed }));
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
// manifest / contributions fixtures
// ---------------------------------------------------------------------------

/** 合法 manifest（manifestSchema 默认值之上覆写） */
function manifestOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { api: 1, version: '1.0.0', permissions: [], provides: [], requires: [], ...over };
}

/** 合法贡献点（全空兜底之上覆写） */
function contribsOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { routes: [], crons: [], events: [], hooks: [], services: [], ...over };
}

/** 全贡献扩展（routes/events/hooks/crons 各一，供 disable 逆序摘除断言） */
const FULL_CONTRIBS = contribsOf({
  routes: [{ method: 'GET', path: '/full' }],
  events: [{ pattern: 'chat.message' }],
  hooks: [{ name: 'doc.sanitize' }],
  crons: [{ name: 'tick', expr: '* * * * *' }],
});

// ---------------------------------------------------------------------------
// 测试脚手架
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  extDir: string;
  db: Knex;
  config: HarnessConfig;
  manager: ExtensionManager;
  worker: ManagerWorkerStub;
  eventBus: EventBus;
  hooks: HookManager;
  schedulerCalls: { schedule: unknown[]; unschedule: string[] };
  routesChanged: ExtRouteTableEntry[][];
  restarts: Array<{ attempt: number; delayMs: number; reenabled: string[] }>;
  /** onUiChanged 回调的捕获序列（[extId, ui|null]） */
  uiChanged: Array<[string, unknown]>;
  factoryCalls(): number;
}

interface HarnessOptions {
  dirs?: Record<string, Record<string, unknown>>;
  enabledInDb?: string[];
  contributions?: Record<string, unknown>;
  failLoadFor?: Record<string, { code: string; message: string }>;
  hookTransform?: (input: { hook: string; value: unknown; ctx: unknown }) => unknown;
  hookErrFor?: Record<string, { code: string; message: string }>;
  hookAbortFor?: Record<string, unknown>;
  validateMount?: (mount: string) => boolean;
  bridgeHandlers?: Record<string, (payload: unknown, from: string) => Promise<unknown>>;
  crashLoopMax?: number;
  crashLoopWindowMs?: number;
  maxRoutesPerExt?: number;
  restartBackoffMs?: number[];
}

const harnesses: Harness[] = [];

async function buildHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'harness-ext-mgr-'));
  const dataDir = join(root, 'data');
  const extDir = join(dataDir, 'extensions'); // 运行时扩展目录（purge 的作用范围）
  for (const [id, manifest] of Object.entries(opts.dirs ?? {})) {
    const dir = join(extDir, id);
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
    maxRoutesPerExt: opts.maxRoutesPerExt ?? 100,
  };

  const worker = createManagerWorkerStub({
    contributions: opts.contributions ?? {},
    failLoadFor: opts.failLoadFor,
    hookErrFor: opts.hookErrFor,
    hookTransform: opts.hookTransform,
    hookAbortFor: opts.hookAbortFor,
  });
  let spawned = 0;
  const schedulerCalls = { schedule: [] as unknown[], unschedule: [] as string[] };
  const routesChanged: ExtRouteTableEntry[][] = [];
  const restarts: Array<{ attempt: number; delayMs: number; reenabled: string[] }> = [];
  const uiChanged: Array<[string, unknown]> = [];
  const eventBus = new EventBus();
  const hookManager = new HookManager({ logger });
  const manager = new ExtensionManager({
    config,
    db,
    logger,
    workerFactory: () => {
      spawned += 1;
      return worker;
    },
    bridgeHandlers: opts.bridgeHandlers ?? {},
    scheduler: {
      schedule: async (input) => {
        schedulerCalls.schedule.push(input);
        return { id: `cron-${schedulerCalls.schedule.length}` };
      },
      unschedule: async (id: string) => {
        schedulerCalls.unschedule.push(id);
        return true;
      },
      list: () => [],
    },
    eventBus,
    hooks: hookManager,
    authMounts: opts.validateMount ? { validateMount: opts.validateMount } : undefined,
    extensionsDirs: [extDir],
    onRoutesChanged: (table) => routesChanged.push(table),
    onWorkerRestart: (info) => restarts.push(info),
    onUiChanged: (extId, ui) => uiChanged.push([extId, ui]),
    restartBackoffMs: opts.restartBackoffMs ?? [10, 20, 40],
  });
  const harness: Harness = {
    root,
    extDir,
    db,
    config,
    manager,
    worker,
    eventBus,
    hooks: hookManager,
    schedulerCalls,
    routesChanged,
    restarts,
    uiChanged,
    factoryCalls: () => spawned,
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

/** 深取 extensions 表行 */
function rowOf(harness: Harness, id: string): Promise<{ enabled: number; last_error: string | null } | undefined> {
  return harness.db('extensions').where({ id }).first();
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('ExtensionManager', () => {
  it('发现 + requires 拓扑序：B 依赖 A → A 先 load，二者激活', async () => {
    const h = await buildHarness({
      dirs: {
        b: manifestOf({ id: 'b', requires: ['a'] }),
        a: manifestOf({ id: 'a' }),
      },
      enabledInDb: ['a', 'b'],
      contributions: { a: contribsOf(), b: contribsOf() },
    });
    await h.manager.start();
    expect(h.worker.loads).toEqual(['a', 'b']);
    const summaries = h.manager.list();
    expect(summaries.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(summaries.every((s) => s.enabled)).toBe(true);
  });

  it('环检测：A⇄B 循环依赖 → start fail-fast EXT_DEPENDENCY_MISSING（detail.cycle）', async () => {
    const h = await buildHarness({
      dirs: {
        a: manifestOf({ id: 'a', requires: ['b'] }),
        b: manifestOf({ id: 'b', requires: ['a'] }),
      },
      enabledInDb: ['a', 'b'],
      contributions: { a: contribsOf(), b: contribsOf() },
    });
    await expect(h.manager.start()).rejects.toMatchObject({
      code: err('EXT_DEPENDENCY_MISSING').code,
      detail: { cycle: expect.arrayContaining(['a', 'b']) },
    });
  });

  it('自依赖也是环：EXT_DEPENDENCY_MISSING', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a', requires: ['a'] }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
    });
    await expect(h.manager.start()).rejects.toMatchObject({ code: err('EXT_DEPENDENCY_MISSING').code });
  });

  it('硬依赖缺失：B 拒绝激活并记录 last_error，C 正常激活不受影响', async () => {
    const h = await buildHarness({
      dirs: {
        b: manifestOf({ id: 'b', requires: ['ghost'] }),
        c: manifestOf({ id: 'c' }),
      },
      enabledInDb: ['b', 'c'],
      contributions: { b: contribsOf(), c: contribsOf() },
    });
    await h.manager.start();
    const b = h.manager.list().find((s) => s.id === 'b');
    const c = h.manager.list().find((s) => s.id === 'c');
    expect(b?.enabled).toBe(false);
    expect(b?.lastError).toContain(err('EXT_DEPENDENCY_MISSING').code);
    expect((await rowOf(h, 'b'))?.enabled).toBe(0);
    expect((await rowOf(h, 'b'))?.last_error).toBeTruthy();
    expect(c?.enabled).toBe(true);
  });

  it('start 只启用表中 enabled=1 的扩展；disabled 扩展仅登记不激活', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }), quiet: manifestOf({ id: 'quiet' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf(), quiet: contribsOf() },
    });
    await h.manager.start();
    expect(h.worker.loads).toEqual(['a']);
    expect(h.manager.list().find((s) => s.id === 'quiet')?.enabled).toBe(false);
  });

  it('enable 原子性：load 回执 routes 非法 → EXT_ACTIVATION_FAILED + 无路由 + enabled=0 + last_error', async () => {
    const h = await buildHarness({
      dirs: { bad: manifestOf({ id: 'bad', permissions: ['http'] }) },
      enabledInDb: ['bad'],
      contributions: {
        // path 不以 '/' 开头 → validateContributions 抛 EXT_MANIFEST_INVALID
        bad: contribsOf({ routes: [{ method: 'GET', path: 'no-slash' }] }),
      },
    });
    await h.manager.start();
    const summary = h.manager.list().find((s) => s.id === 'bad');
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastError).toContain(err('EXT_MANIFEST_INVALID').code);
    expect(h.manager.getRoutes()).toEqual([]);
    expect(h.routesChanged).toEqual([]); // 没有提交过任何路由表变更
    expect((await rowOf(h, 'bad'))?.enabled).toBe(0);
    expect(h.schedulerCalls.schedule).toHaveLength(0);
  });

  it('权限复核：无 http 权限却贡献 routes → EXT_PERMISSION_DENIED，激活被拒', async () => {
    const h = await buildHarness({
      dirs: { noauth: manifestOf({ id: 'noauth', permissions: [] }) },
      enabledInDb: ['noauth'],
      contributions: {
        noauth: contribsOf({ routes: [{ method: 'GET', path: '/x' }] }),
      },
    });
    await h.manager.start();
    const summary = h.manager.list().find((s) => s.id === 'noauth');
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastError).toContain(err('EXT_PERMISSION_DENIED').code);
    expect(h.manager.getRoutes()).toEqual([]);
  });

  it('services 提供声明复核：未被 provides 覆盖拒绝，覆盖后激活', async () => {
    const h = await buildHarness({
      dirs: {
        lacking: manifestOf({ id: 'lacking', provides: [] }),
        covered: manifestOf({ id: 'covered', provides: ['ext.covered.parse'] }),
      },
      enabledInDb: ['lacking', 'covered'],
      contributions: {
        lacking: contribsOf({ services: [{ name: 'ext.lacking.parse', methods: ['run'] }] }),
        covered: contribsOf({ services: [{ name: 'ext.covered.parse', methods: ['run'] }] }),
      },
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'lacking')?.enabled).toBe(false);
    expect(h.manager.list().find((s) => s.id === 'covered')?.enabled).toBe(true);
    const lacking = h.manager.list().find((s) => s.id === 'lacking');
    expect(lacking?.lastError).toContain(err('EXT_PERMISSION_DENIED').code);
  });

  it('路由表提交：getRoutes 快照 + onRoutesChanged 回调 + auth 缺省兜底 user + 防御性拷贝', async () => {
    const h = await buildHarness({
      dirs: { r: manifestOf({ id: 'r', permissions: ['http'] }) },
      enabledInDb: ['r'],
      contributions: {
        r: contribsOf({
          routes: [
            { method: 'GET', path: '/hello', auth: 'public', scope: 'doc:read', timeoutMs: 123 },
            { method: 'POST', path: '/bye' },
          ],
        }),
      },
    });
    await h.manager.start();
    expect(h.manager.getRoutes()).toEqual([
      { extId: 'r', method: 'GET', path: '/hello', auth: 'public', scope: 'doc:read', timeoutMs: 123 },
      { extId: 'r', method: 'POST', path: '/bye', auth: 'user' },
    ]);
    expect(h.routesChanged[h.routesChanged.length - 1]).toEqual(h.manager.getRoutes());
    // 快照防御：改写返回值不影响内核表
    const snapshot = h.manager.getRoutes();
    snapshot.length = 0;
    expect(h.manager.getRoutes()).toHaveLength(2);
  });

  it('全贡献扩展激活后：事件分发 / hook RPC 转换 / cron 注册', async () => {
    const h = await buildHarness({
      dirs: { full: manifestOf({ id: 'full', permissions: ['http', 'events', 'hooks', 'cron'] }) },
      enabledInDb: ['full'],
      contributions: { full: FULL_CONTRIBS },
      hookTransform: (input) => (typeof input.value === 'string' ? input.value.toUpperCase() : input.value),
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'full')?.enabled).toBe(true);

    // 事件 → dispatchToExt（topic 固定 host.event，payload { name, payload, source }）
    await h.eventBus.emit('chat.message', { text: 'yo' }, { source: 'ext:test' });
    const dispatch = h.worker.dispatches.find((d) => d.topic === HOST_METHODS.eventDispatch);
    expect(dispatch?.to).toBe('ext:full');
    expect(dispatch?.id.startsWith('evt-')).toBe(true);
    expect(dispatch?.payload).toEqual({ name: 'chat.message', payload: { text: 'yo' }, source: 'kernel' });

    // hook → host.hook RPC（默认 30s 预算），返回值即转换结果
    const applied = await h.hooks.apply('doc.sanitize', 'hello');
    expect(applied).toBe('HELLO');
    expect(h.worker.hookCalls[0]?.name).toBe('doc.sanitize');
    expect(h.worker.hookCalls[0]?.value).toBe('hello');

    // cron → scheduler.schedule(extId='full')；disable 时逆序 unschedule
    expect(h.schedulerCalls.schedule).toEqual([
      expect.objectContaining({ extId: 'full', name: 'tick', expr: '* * * * *' }),
    ]);
  });

  it('hook 失败按 hook 语义上抛（worker err → HookManager 包装 INTERNAL）', async () => {
    const h = await buildHarness({
      dirs: { full: manifestOf({ id: 'full', permissions: ['hooks'] }) },
      enabledInDb: ['full'],
      contributions: { full: contribsOf({ hooks: [{ name: 'doc.sanitize' }] }) },
      hookErrFor: { 'doc.sanitize': { code: 'EXT_CUSTOM', message: 'hook exploded' } },
    });
    await h.manager.start();
    await expect(h.hooks.apply('doc.sanitize', 'x')).rejects.toMatchObject({
      code: err('INTERNAL').code,
      message: '[hook:doc.sanitize] handler failed',
    });
  });

  it('hook 回执解包（改写型）：host.hook 应答 { value } 信封 → filter 链取 value 而非整个信封', async () => {
    // 回归（P0-4）：manager 曾把整个应答信封当 filter 链下一值——改写 chat.beforeSend
    // 会把 { value } 包装物当消息透传，chat 消息被误判 blocked。修复后链上流动的是
    // 回执内的 value。
    const h = await buildHarness({
      dirs: { rewriter: manifestOf({ id: 'rewriter', permissions: ['hooks'] }) },
      enabledInDb: ['rewriter'],
      contributions: { rewriter: contribsOf({ hooks: [{ name: 'chat.beforeSend' }] }) },
      hookTransform: (input) => {
        const msg = input.value as { content?: { text?: string } } | null;
        if (msg !== null && typeof msg === 'object' && typeof msg.content?.text === 'string') {
          return { ...msg, content: { ...msg.content, text: `${msg.content.text} [ok]` } };
        }
        return input.value;
      },
    });
    await h.manager.start();
    const draft = {
      id: 'm1',
      channelId: 'c1',
      channelSlug: 'general',
      senderType: 'webhook',
      senderId: 'hook',
      content: { type: 'text', text: 'hello' },
      attachments: null,
      createdAt: Date.now(),
    };
    const applied = (await h.hooks.apply('chat.beforeSend', draft)) as typeof draft;
    // 改写生效：内容带标记（若信封漏透，applied 将是 { value: {...} } 包装物，形状断言即失败）
    expect(applied.content).toEqual({ type: 'text', text: 'hello [ok]' });
    expect(applied).not.toHaveProperty('value');
  });

  it('hook 回执解包（短路）：aborted:true → HookAbort 短路返回 result，后续 handler 不执行', async () => {
    const h = await buildHarness({
      dirs: { guard: manifestOf({ id: 'guard', permissions: ['hooks'] }) },
      enabledInDb: ['guard'],
      contributions: { guard: contribsOf({ hooks: [{ name: 'chat.beforeSend' }] }) },
      hookAbortFor: { 'chat.beforeSend': 'blocked: banned word' },
    });
    await h.manager.start();
    // 低优先级内核侧 handler：若被执行则记位（短路后不得触达）
    let downstream = false;
    h.hooks.add(
      'chat.beforeSend',
      () => {
        downstream = true;
        return undefined;
      },
      { priority: -100 },
    );
    const result = await h.hooks.apply('chat.beforeSend', { content: { text: 'x' } });
    expect(result).toBe('blocked: banned word'); // HookAbort(result) 短路语义
    expect(downstream).toBe(false);
  });

  it('UI 贡献同步：enable 后 onUiChanged 收到 manifest.ui ∪ 贡献点 ui 合并片段；disable 摘除', async () => {
    const h = await buildHarness({
      dirs: {
        uier: manifestOf({
          id: 'uier',
          ui: { menu: { label: 'Manifest' }, pages: [{ path: '/m', title: 'M', entry: 'm.html' }] },
        }),
      },
      enabledInDb: ['uier'],
      contributions: {
        // worker 线格式：menu 为数组（h.menu 每次调用追加一项）
        uier: contribsOf({
          ui: { menu: [{ label: 'Runtime' }], pages: [{ path: '/r', title: 'R', entry: 'r.html' }] },
        }),
      },
    });
    await h.manager.start();

    // enable 提交后同步一次合并片段：menu 单值（运行期数组取最后项）、pages 追加不覆盖
    expect(h.uiChanged).toEqual([
      [
        'uier',
        {
          menu: { label: 'Runtime' },
          pages: [
            { path: '/m', title: 'M', entry: 'm.html' },
            { path: '/r', title: 'R', entry: 'r.html' },
          ],
          widgets: [],
          renderers: [],
        },
      ],
    ]);

    // disable：整扩展摘除（ui = null）
    await h.manager.disable('uier');
    expect(h.uiChanged.at(-1)).toEqual(['uier', null]);

    // 空 UI（两通道均无声明）→ 不产生登记
    const h2 = await buildHarness({
      dirs: { plain: manifestOf({ id: 'plain' }) },
      enabledInDb: ['plain'],
      contributions: { plain: contribsOf() },
    });
    await h2.manager.start();
    expect(h2.uiChanged).toEqual([]);
  });

  it('worker 崩溃本地摘除：onUiChanged 收 (extId, null)（与 disable 同语义）', async () => {
    const h = await buildHarness({
      dirs: { uier: manifestOf({ id: 'uier', ui: { menu: { label: 'M' } } }) },
      enabledInDb: ['uier'],
      contributions: { uier: contribsOf() },
      restartBackoffMs: [10],
    });
    await h.manager.start();
    expect(h.uiChanged.at(-1)?.[0]).toBe('uier');
    h.worker.emitExit(1); // worker 崩溃 → 本地全量摘除（ui = null）→ 退避重启
    await new Promise((r) => setTimeout(r, 60));
    const nullEvents = h.uiChanged.filter(([extId, ui]) => extId === 'uier' && ui === null);
    expect(nullEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('disable 逆序摘除：路由清空 + 事件退订 + hook 摘除 + cron unschedule + host.unload + enabled=0；幂等', async () => {
    const h = await buildHarness({
      dirs: { full: manifestOf({ id: 'full', permissions: ['http', 'events', 'hooks', 'cron'] }) },
      enabledInDb: ['full'],
      contributions: { full: FULL_CONTRIBS },
    });
    await h.manager.start();
    expect(h.manager.getRoutes()).toHaveLength(1);
    expect(h.eventBus.listenerCount('chat.message')).toBe(1);
    expect(h.hooks.handlerCount()).toBe(1);

    await h.manager.disable('full');

    expect(h.manager.getRoutes()).toEqual([]);
    expect(h.routesChanged[h.routesChanged.length - 1]).toEqual([]);
    expect(h.eventBus.listenerCount('chat.message')).toBe(0);
    expect(h.hooks.handlerCount()).toBe(0);
    expect(h.schedulerCalls.unschedule).toEqual(['cron-1']);
    expect(h.worker.unloads).toEqual(['full']);
    expect((await rowOf(h, 'full'))?.enabled).toBe(0);

    // 摘除后事件不再投递到 worker
    const before = h.worker.dispatches.length;
    await h.eventBus.emit('chat.message', { late: true });
    expect(h.worker.dispatches.length).toBe(before);

    // 幂等：重复 disable 不再发 unload、不报错
    await h.manager.disable('full');
    expect(h.worker.unloads).toEqual(['full']);
  });

  it('reload：unload → load 换新贡献点（路由表随之更新）', async () => {
    const h = await buildHarness({
      dirs: { r: manifestOf({ id: 'r', permissions: ['http'] }) },
      enabledInDb: ['r'],
      contributions: { r: contribsOf({ routes: [{ method: 'GET', path: '/v1' }] }) },
    });
    await h.manager.start();
    h.worker.setContributions('r', contribsOf({ routes: [{ method: 'GET', path: '/v2' }] }));
    await h.manager.reload('r');
    const unloadAt = h.worker.calls.indexOf(`${HOST_METHODS.unloadExt} r`);
    const reloadLoadAt = h.worker.calls.indexOf(`${HOST_METHODS.loadExt} r`, unloadAt);
    expect(unloadAt).toBeGreaterThanOrEqual(0);
    expect(reloadLoadAt).toBeGreaterThan(unloadAt);
    expect(h.manager.getRoutes().map((r) => r.path)).toEqual(['/v2']);
  });

  it('reload 失败：保持 disabled（无路由、无订阅、last_error 记录）', async () => {
    const h = await buildHarness({
      dirs: { r: manifestOf({ id: 'r', permissions: ['http', 'events'] }) },
      enabledInDb: ['r'],
      contributions: { r: contribsOf({ events: [{ pattern: 'x.y' }] }) },
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'r')?.enabled).toBe(true);
    h.worker.setFailLoad('r', { code: 'ERR_BROKEN_BUILD', message: 'syntax error in main.js' });

    await expect(h.manager.reload('r')).rejects.toMatchObject({
      code: err('EXT_ACTIVATION_FAILED').code,
      detail: { id: 'r' },
    });
    const summary = h.manager.list().find((s) => s.id === 'r');
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastError).toContain('syntax error in main.js');
    expect(h.manager.getRoutes()).toEqual([]);
    expect(h.eventBus.listenerCount('x.y')).toBe(0);
    expect((await rowOf(h, 'r'))?.enabled).toBe(0);
  });

  it('reload 语义：disabled 扩展 reload → no-op（保持 disabled，不 load、不激活、不隐式启用）', async () => {
    const h = await buildHarness({
      dirs: { r: manifestOf({ id: 'r', permissions: ['http'] }) },
      enabledInDb: [],
      contributions: { r: contribsOf({ routes: [{ method: 'GET', path: '/v1' }] }) },
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'r')?.enabled).toBe(false);

    await h.manager.reload('r'); // 对 disabled 扩展重载必须是 no-op，而非「disable→enable」的隐式启用

    const summary = h.manager.list().find((s) => s.id === 'r');
    expect(summary?.enabled).toBe(false);
    expect(h.worker.loads).toEqual([]); // 扩展从未被激活（无 load RPC）
    expect(h.worker.unloads).toEqual([]);
    expect(h.manager.getRoutes()).toEqual([]);
    expect((await rowOf(h, 'r'))?.enabled).toBe(0);
  });

  it('reload 语义：enable → disable → reload → 仍为 disabled（用户报告的「重载即启用」回归）', async () => {
    const h = await buildHarness({
      dirs: { r: manifestOf({ id: 'r', permissions: ['http'] }) },
      enabledInDb: ['r'],
      contributions: { r: contribsOf({ routes: [{ method: 'GET', path: '/v1' }] }) },
    });
    await h.manager.start();
    expect(h.manager.list().find((s) => s.id === 'r')?.enabled).toBe(true);
    await h.manager.disable('r');
    expect(h.manager.list().find((s) => s.id === 'r')?.enabled).toBe(false);

    await h.manager.reload('r');

    const summary = h.manager.list().find((s) => s.id === 'r');
    expect(summary?.enabled).toBe(false);
    expect(h.manager.getRoutes()).toEqual([]);
    // reload 之前恰好一次 unload（disable 产生），之后不得再出现新的 load
    const unloadCount = h.worker.unloads.filter((id) => id === 'r').length;
    expect(unloadCount).toBe(1);
    expect(h.worker.loads).toEqual(['r']);
    expect((await rowOf(h, 'r'))?.enabled).toBe(0);
  });

  it('worker 崩溃：指数退避重启 worker + 按拓扑重启用原 enabled 扩展 + onWorkerRestart 回调', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
      restartBackoffMs: [10, 20],
    });
    await h.manager.start();
    expect(h.worker.loads).toEqual(['a']);

    await h.manager.handleWorkerExit();

    expect(h.factoryCalls()).toBe(2); // 退避 10ms 后重启了 worker
    expect(h.worker.loads).toEqual(['a', 'a']); // 拓扑重启用
    expect(h.restarts).toEqual([{ attempt: 1, delayMs: 10, reenabled: ['a'] }]);
    expect(h.manager.list().find((s) => s.id === 'a')?.enabled).toBe(true);
    expect(h.manager.getRoutes()).toEqual([]); // a 无路由贡献，表保持为空但桥已可用
  });

  it('crash 熔断：窗口内超过 crashLoopMax → 全部停用 + EXT_CRASH_LOOP 记 last_error + 不再重启', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
      crashLoopMax: 2,
      crashLoopWindowMs: 60_000,
      restartBackoffMs: [5, 5, 5],
    });
    await h.manager.start();
    await h.manager.handleWorkerExit(); // 崩溃 1：退避重启
    await h.manager.handleWorkerExit(); // 崩溃 2：退避重启
    await h.manager.handleWorkerExit(); // 崩溃 3（>2）：熔断

    expect(h.factoryCalls()).toBe(3); // 只重启两次，第 3 次不再重启
    expect(h.restarts).toHaveLength(2);
    expect(h.worker.loads).toEqual(['a', 'a', 'a']);
    const summary = h.manager.list().find((s) => s.id === 'a');
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastError).toContain(err('EXT_CRASH_LOOP').code);
    expect((await rowOf(h, 'a'))?.enabled).toBe(0);
    expect((await rowOf(h, 'a'))?.last_error).toContain(err('EXT_CRASH_LOOP').code);
  });

  it('熔断后人工 enable：清熔断、起新 worker、激活成功（crashCount 归零）', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
      crashLoopMax: 1,
      restartBackoffMs: [5, 5],
    });
    await h.manager.start();
    await h.manager.handleWorkerExit(); // 崩溃 1：重启
    await h.manager.handleWorkerExit(); // 崩溃 2（>1）：熔断
    expect(h.manager.list().find((s) => s.id === 'a')?.enabled).toBe(false);

    await h.manager.enable('a');

    expect(h.factoryCalls()).toBe(3); // 人工 enable 起新 worker
    expect(h.worker.loads).toEqual(['a', 'a', 'a']);
    expect(h.manager.list().find((s) => s.id === 'a')?.enabled).toBe(true);
    expect(h.manager.list().find((s) => s.id === 'a')?.crashCount).toBe(0);
  });

  it('bridgeHandlers 经桥透传：worker→host call 由内核服务处理器应答', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
      bridgeHandlers: {
        'test.echo': async (payload, from) => ({ echoed: payload, from }),
      },
    });
    await h.manager.start();
    h.worker.emitMessage({
      v: 1,
      id: 'svc-1',
      from: 'ext:a',
      to: 'kernel',
      type: 'call',
      topic: 'test.echo',
      payload: 'ping',
    });
    await flush();
    const reply = h.worker.sent.find((e) => e.type === 'reply' && e.id === 'svc-1');
    expect(reply?.ok).toBe(true);
    expect(reply?.payload).toEqual({ echoed: 'ping', from: 'a' });
  });

  it('uninstall keep：表记录删除，sqlite 与源目录保留', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
    });
    await h.manager.start();
    const dbFile = extDbPath(h.config, 'a'); // 仅为测试制造扩展库文件
    writeFileSync(dbFile, 'placeholder');

    await h.manager.uninstall('a');

    expect(await rowOf(h, 'a')).toBeUndefined();
    expect(h.manager.list().find((s) => s.id === 'a')).toBeUndefined();
    expect(existsSync(dbFile)).toBe(true);
    expect(existsSync(join(h.extDir, 'a'))).toBe(true);
  });

  it('uninstall purge：删除扩展 sqlite（含 wal）与运行时目录，表记录删除', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
    });
    await h.manager.start();
    const dbFile = extDbPath(h.config, 'a');
    writeFileSync(dbFile, 'placeholder');
    writeFileSync(`${dbFile}-wal`, 'wal');

    await h.manager.uninstall('a', { purge: true });

    expect(await rowOf(h, 'a')).toBeUndefined();
    expect(existsSync(dbFile)).toBe(false);
    expect(existsSync(`${dbFile}-wal`)).toBe(false);
    expect(existsSync(join(h.extDir, 'a'))).toBe(false);
  });

  it('list() 摘要：version/builtin/mount/crashCount/manifest/贡献点计数', async () => {
    const h = await buildHarness({
      dirs: {
        full: manifestOf({ id: 'full', version: '2.3.4', builtin: true, mount: 'webui', permissions: ['http', 'events'] }),
      },
      enabledInDb: ['full'],
      contributions: {
        full: contribsOf({ routes: [{ method: 'GET', path: '/a' }], events: [{ pattern: 'e.f' }, { pattern: 'g.h' }] }),
      },
      // SEC-3：builtin/mount 声明需过受信闸——本用例关注摘要形状，注入受信 stub
      validateMount: () => true,
    });
    await h.manager.start();
    const summary = h.manager.list().find((s) => s.id === 'full');
    expect(summary).toMatchObject({
      id: 'full',
      version: '2.3.4',
      enabled: true,
      builtin: true,
      mount: 'webui',
      crashCount: 0,
      lastError: null,
    });
    expect(summary?.manifest?.version).toBe('2.3.4');
    expect(summary?.contributions).toEqual({ routes: 1, crons: 0, events: 2, hooks: 0, services: 0 });
  });

  it('对未知扩展 enable → EXT_NOT_FOUND；stop 后（桥为 null）enable → KERNEL_NOT_READY', async () => {
    const h = await buildHarness({ dirs: {} });
    await h.manager.start();
    await expect(h.manager.enable('ghost')).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });

    const h2 = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      enabledInDb: ['a'],
      contributions: { a: contribsOf() },
    });
    await h2.manager.start();
    await h2.manager.stop();
    await expect(h2.manager.enable('a')).rejects.toMatchObject({
      code: err('KERNEL_NOT_READY').code,
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-3：builtin/mount 受信闸（fail-closed）
// ---------------------------------------------------------------------------

describe('SEC-3：builtin/mount 声明的受信闸', () => {
  it('未注入 authMounts（fail-closed）：自声明 builtin+mount 的扩展 enable → EXT_PERMISSION_DENIED 且 enabled=0', async () => {
    const h = await buildHarness({
      dirs: { rogue: manifestOf({ id: 'rogue', builtin: true, mount: 'auth' }) },
      enabledInDb: ['rogue'],
      contributions: { rogue: contribsOf() },
    });
    await h.manager.start();
    // start 时按同规则拒绝激活（迁移既有残留行的防线）
    const summary = h.manager.list().find((s) => s.id === 'rogue');
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastError).toContain('HARNESS-3002');

    await expect(h.manager.enable('rogue')).rejects.toMatchObject({
      code: err('EXT_PERMISSION_DENIED').code,
      detail: { reason: 'builtin/mount reserved for trusted first-party extensions' },
    });
    expect(h.worker.loads).not.toContain('rogue');
  });

  it('仅 mount 声明（非 builtin）同样过闸；受信 stub 放行后正常激活', async () => {
    const untrusted = await buildHarness({
      dirs: { m: manifestOf({ id: 'm', mount: 'auth' }) },
      enabledInDb: ['m'],
      contributions: { m: contribsOf() },
    });
    await untrusted.manager.start();
    await expect(untrusted.manager.enable('m')).rejects.toMatchObject({
      code: err('EXT_PERMISSION_DENIED').code,
    });

    const trusted = await buildHarness({
      dirs: { m: manifestOf({ id: 'm', builtin: true, mount: 'auth' }) },
      enabledInDb: ['m'],
      contributions: { m: contribsOf() },
      validateMount: () => true, // 受信目录（Kernel 接线按 repoRoot/extensions 裁决）
    });
    await trusted.manager.start();
    expect(trusted.manager.list().find((s) => s.id === 'm')?.enabled).toBe(true);
    expect(trusted.worker.loads).toContain('m');
  });
});

// ---------------------------------------------------------------------------
// REL-3：#restarting 窗口死桥自愈
// ---------------------------------------------------------------------------

describe('REL-3：restarting 窗口内的第二次 exit 不再吞掉', () => {
  it('连续两次 exit（第二次落在 restarting 窗口）→ 排队补处理，enable 仍成功', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a', permissions: ['http', 'cron', 'events', 'hooks'] }) },
      enabledInDb: ['a'],
      contributions: { a: FULL_CONTRIBS },
      restartBackoffMs: [5, 10, 20],
    });
    await h.manager.start();
    expect(h.worker.loads.length).toBe(1);

    // 第一次 exit 触发自愈；第二次 exit 紧随其后（落在 #restarting 窗口内）
    h.worker.emitExit(1);
    h.worker.emitExit(1);

    // 两个自愈周期完成后：worker 至少 3 次 load（初始 + 周期1重启用 + 周期2重启用）
    await vi.waitFor(() => {
      expect(h.worker.loads.length).toBeGreaterThanOrEqual(3);
    }, { timeout: 2_000 });

    // 人工 enable 不再出现死桥 EXT_ACTIVATION_FAILED：幂等 no-op 或重建后激活均成功
    await expect(h.manager.enable('a')).resolves.toBeUndefined();
    expect(h.manager.bridge).not.toBeNull();
    expect(h.manager.getRoutes().some((r) => r.extId === 'a')).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// REL-7：rescan 免重启发现新扩展目录
// ---------------------------------------------------------------------------

describe('REL-7：manager.rescan() 运行中重扫目录', () => {
  it('新目录插表 enabled=0 并可立即 enable（免重启）；重复 rescan 幂等', async () => {
    const h = await buildHarness({
      dirs: { a: manifestOf({ id: 'a' }) },
      contributions: { a: contribsOf() },
    });
    await h.manager.start();

    // 运行中新增扩展目录（make 场景）
    mkdirSync(join(h.extDir, 'late'), { recursive: true });
    writeFileSync(join(h.extDir, 'late', 'manifest.json'), JSON.stringify(manifestOf({ id: 'late', version: '2.0.0' })));

    const first = await h.manager.rescan();
    expect(first.discovered).toEqual(['late']);
    const row = h.manager.list().find((s) => s.id === 'late');
    expect(row?.enabled).toBe(false); // 插表 enabled=0，不自动激活
    expect(row?.manifest?.version).toBe('2.0.0');

    await h.manager.enable('late'); // 免重启激活
    expect(h.worker.loads).toContain('late');
    expect(h.manager.list().find((s) => s.id === 'late')?.enabled).toBe(true);

    const second = await h.manager.rescan();
    expect(second.discovered).toEqual([]); // 已有目录跳过（幂等）
  });
});
