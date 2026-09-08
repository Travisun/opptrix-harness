/**
 * ext-sandbox 单测 — 不 spawn 真线程：
 * 直接构造 VmRuntimeDeps（kernelCall mock）+ vm.runInContext 模拟扩展行为，
 * 覆盖：console 转发与冻结、受控定时器与 cleanup、受限 require 白名单/防穿越、
 * defineExtension 标记、注册类 API 的激活期捕获与闸门、webhook 验签、
 * db 预检（双保险）、files.save base64 转换、llm.chat 错误透传、
 * worker 纯工具（matchPattern / normalizeResponse / HookAbort）。
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import {
  createContributionsCollector,
  createHarnessApi,
  createRestrictedRequire,
  defineExtension,
  isExtensionDefinition,
} from '../src/extension-host/sandbox.js';
import type { ContributionsCollector, HarnessApi, RouteRequest } from '../src/extension-host/sandbox.js';
import { createExtVm, createTimerRegistry } from '../src/extension-host/vm-runtime.js';
import type { VmRuntimeDeps } from '../src/extension-host/vm-runtime.js';
import { HookAbort, isHookAbort, matchPattern, normalizeResponse } from '../src/extension-host/worker.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface TestRig {
  deps: VmRuntimeDeps;
  kernelCall: ReturnType<typeof vi.fn>;
}

/** 构造 VmRuntimeDeps：kernelCall mock 记录全部 (topic, payload) 调用 */
function makeRig(extId = 'test-ext'): TestRig {
  const kernelCall = vi.fn(async (_topic: string, _payload: unknown) => ({ ok: true }));
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { deps: { extId, logger, kernelCall }, kernelCall };
}

function makeHarness(opts: {
  active: boolean;
  kernelCall?: ReturnType<typeof vi.fn>;
  collector?: ContributionsCollector;
}): { harness: HarnessApi; collector: ContributionsCollector; kernelCall: ReturnType<typeof vi.fn> } {
  const kernelCall = opts.kernelCall ?? vi.fn(async () => ({ ok: true }));
  const collector = opts.collector ?? createContributionsCollector();
  const harness = createHarnessApi({
    extId: 'test-ext',
    kernelCall: kernelCall as unknown as (topic: string, payload: unknown) => Promise<unknown>,
    contributions: collector,
    timers: createTimerRegistry(),
    activationPhase: () => opts.active,
  });
  return { harness, collector, kernelCall };
}

function makeRouteRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: 'POST',
    params: {},
    query: {},
    headers: {},
    body: {},
    requestId: 'req-1',
    ...overrides,
  };
}

/** 捕获同步抛出的 HarnessError 错误码（预检类 API 在进入 Promise 前即快速失败） */
function harnessCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? `NO_CODE:${String(e)}`;
  }
  return 'NO_THROW';
}

let extDir = '';

beforeEach(() => {
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-ext-'));
});

afterEach(() => {
  vi.useRealTimers();
  if (extDir !== '') {
    fs.rmSync(extDir, { recursive: true, force: true });
    extDir = '';
  }
});

// ---------------------------------------------------------------------------
// vm-runtime
// ---------------------------------------------------------------------------

describe('createExtVm — console 转发与冻结', () => {
  it('console.info 经 kernelCall 转发到 KERNEL_TOPICS.log，payload 为 { level, msg, args }', () => {
    const { deps, kernelCall } = makeRig();
    const { context } = createExtVm(deps);
    vm.runInContext(`console.info('hello', { a: 1 }, 'tail')`, context);
    expect(kernelCall).toHaveBeenCalledTimes(1);
    const [topic, payload] = kernelCall.mock.calls[0] as [string, { level: string; msg: string; args: string[] }];
    expect(topic).toBe(KERNEL_TOPICS.log);
    expect(payload.level).toBe('info');
    expect(payload.msg).toBe('hello');
    expect(payload.args).toEqual(['{"a":1}', 'tail']);
  });

  it('args 截断：最多 20 个、每个 JSON 序列化截断到 2048 字符', () => {
    const { deps, kernelCall } = makeRig();
    const { context } = createExtVm(deps);
    vm.runInContext(
      `console.warn(${Array.from({ length: 25 }, (_, i) => `'arg${i}'`).join(', ')})`,
      context,
    );
    vm.runInContext(`console.error('m', 'x'.repeat(3000))`, context);
    vm.runInContext(`console.error('y'.repeat(3000))`, context);
    const first = kernelCall.mock.calls[0]?.[1] as { args: string[] };
    expect(first.args).toHaveLength(20); // msg 吃掉 arg0，rest = arg1..arg24，截到 20 个
    expect(first.args[0]).toBe('arg1');
    expect(first.args[19]).toBe('arg20');
    const second = kernelCall.mock.calls[1]?.[1] as { msg: string; args: string[] };
    expect(second.args).toHaveLength(1);
    expect(second.args[0]).toHaveLength(2048); // 超长参数截断到 2KB
    // msg 本身不截断（契约仅约束 args）
    const third = kernelCall.mock.calls[2]?.[1] as { msg: string; args: string[] };
    expect(third.msg).toHaveLength(3000);
    expect(third.args).toHaveLength(0);
  });

  it('console 对象冻结、global 绑定不可改写（严格模式抛 TypeError，宽松模式静默无效）', () => {
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    expect(Object.isFrozen(context.console)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(context.console, 'info')?.writable).toBe(false);
    // 注：抛出的是 VM realm 的 TypeError（context 自有 intrinsics），不能对宿主类做 instanceof
    expect(() => vm.runInContext(`'use strict'; console.info = () => {}`, context)).toThrow(/read only property/);
    // 其余改写路径（宽松赋值/限定赋值）静默无效；Object.defineProperty 抛错（V8 contextify 语义）
    expect(() => vm.runInContext(`console = 1`, context)).not.toThrow();
    expect(() => vm.runInContext(`globalThis.console = 1`, context)).not.toThrow();
    expect(() =>
      vm.runInContext(`'use strict'; Object.defineProperty(globalThis, 'console', { value: 2 })`, context),
    ).toThrow(/redefine property/);
    expect(vm.runInContext(`typeof console.info`, context)).toBe('function');
    expect(vm.runInContext(`globalThis.console === undefined ? 'gone' : 'kept'`, context)).toBe('kept');
  });
});

describe('createExtVm — 沙箱面与受控定时器', () => {
  it('process / require / Buffer / performance 在 VM 内不可见；crypto.getRandomValues 可用且冻结', () => {
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    expect(vm.runInContext(`typeof process`, context)).toBe('undefined');
    expect(vm.runInContext(`typeof require`, context)).toBe('undefined');
    expect(vm.runInContext(`typeof Buffer`, context)).toBe('undefined');
    expect(vm.runInContext(`typeof performance`, context)).toBe('undefined');
    const res = vm.runInContext(
      `(() => {
        const a = new Uint8Array(16);
        const same = crypto.getRandomValues(a) === a;
        return { same, filled: a.some((b) => b !== 0), frozen: Object.isFrozen(crypto), uuid: typeof crypto.randomUUID === 'function' };
      })()`,
      context,
    ) as { same: boolean; filled: boolean; frozen: boolean; uuid: boolean };
    expect(res.same).toBe(true);
    expect(res.filled).toBe(true);
    expect(res.frozen).toBe(true);
    expect(res.uuid).toBe(true);
  });

  it('structuredClone / TextEncoder / URL / queueMicrotask 注入且可用', () => {
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const res = vm.runInContext(
      `(() => {
        const enc = new TextEncoder();
        const url = new URL('https://example.com/a?b=1');
        return {
          clone: typeof structuredClone === 'function' && structuredClone({ x: [1] }).x[0] === 1,
          enc: enc.encode('hi').length === 2,
          url: url.host === 'example.com',
          micro: typeof queueMicrotask === 'function',
        };
      })()`,
      context,
    ) as { clone: boolean; enc: boolean; url: boolean; micro: boolean };
    expect(res).toEqual({ clone: true, enc: true, url: true, micro: true });
  });

  it('setTimeout 受控：cleanup() 全清，之后回调不再触发', () => {
    vi.useFakeTimers();
    const { deps } = makeRig();
    const { context, cleanup } = createExtVm(deps);
    vm.runInContext(`globalThis.__a = false; setTimeout(() => { globalThis.__a = true; }, 10)`, context);
    vi.advanceTimersByTime(10);
    expect(vm.runInContext(`globalThis.__a`, context)).toBe(true);

    vm.runInContext(`globalThis.__b = false; setTimeout(() => { globalThis.__b = true; }, 10)`, context);
    cleanup();
    vi.advanceTimersByTime(1000);
    expect(vm.runInContext(`globalThis.__b`, context)).toBe(false);
  });

  it('setInterval 由 cleanup() 清除；VM 内 clearInterval 可主动停止', () => {
    vi.useFakeTimers();
    const { deps } = makeRig();
    const { context, cleanup } = createExtVm(deps);
    vm.runInContext(
      `globalThis.__n = 0; globalThis.__t = setInterval(() => { globalThis.__n += 1; }, 5)`,
      context,
    );
    vi.advanceTimersByTime(15);
    expect(vm.runInContext(`globalThis.__n`, context)).toBe(3);
    cleanup();
    vi.advanceTimersByTime(100);
    expect(vm.runInContext(`globalThis.__n`, context)).toBe(3);

    // VM 内主动 clear（跨 realm 句柄）
    const { context: ctx2, cleanup: cleanup2 } = createExtVm(deps);
    vm.runInContext(
      `globalThis.__m = 0; const t = setInterval(() => { globalThis.__m += 1; }, 5); setTimeout(() => clearInterval(t), 12)`,
      ctx2,
    );
    vi.advanceTimersByTime(50);
    expect(vm.runInContext(`globalThis.__m`, ctx2)).toBe(2); // 5/10 触发，12 清除
    cleanup2();
  });

  it('setTimeout 回调抛异常不击穿线程：kernelCall 收到 log error', () => {
    vi.useFakeTimers();
    const { deps, kernelCall } = makeRig();
    const { context } = createExtVm(deps);
    vm.runInContext(`setTimeout(() => { throw new Error('boom'); }, 1)`, context);
    expect(() => vi.advanceTimersByTime(5)).not.toThrow();
    const logCall = kernelCall.mock.calls.find((c) => (c[1] as { level: string }).level === 'error');
    expect(logCall).toBeDefined();
    expect((logCall?.[1] as { msg: string }).msg).toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// 受限 require
// ---------------------------------------------------------------------------

describe('受限 require', () => {
  function setupModules(): void {
    fs.writeFileSync(path.join(extDir, 'dep.js'), `'use strict';\nmodule.exports.greet = (n) => 'hi ' + n;\n`);
    fs.writeFileSync(
      path.join(extDir, 'main.js'),
      `'use strict';\nconst dep = require('./dep');\nmodule.exports = { value: dep.greet('x'), self: require('./main.js') === module.exports };\n`,
    );
    fs.writeFileSync(path.join(extDir, 'data.json'), '{"a":1}');
  }

  it('相对 .js 加载成功：嵌套 require 生效、模块缓存返回同一 exports', () => {
    setupModules();
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const require = createRestrictedRequire({ extDir, context });
    const first = require('./main.js') as { value: string; self: boolean };
    const second = require('./main.js') as unknown;
    expect(first.value).toBe('hi x');
    expect(first.self).toBe(true); // 循环/重复 require 命中缓存
    expect(second).toBe(first);
  });

  it('无扩展名自动补 .js（"./dep" 等价 "./dep.js"）', () => {
    setupModules();
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const require = createRestrictedRequire({ extDir, context });
    expect((require('./dep') as { greet: (n: string) => string }).greet('y')).toBe('hi y');
  });

  it('绝对路径拒绝（即使在扩展目录内）', () => {
    setupModules();
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const require = createRestrictedRequire({ extDir, context });
    expect(() => require(path.join(extDir, 'main.js'))).toThrow('require denied');
  });

  it('内置模块拒绝（fs / node:fs）', () => {
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const require = createRestrictedRequire({ extDir, context });
    expect(() => require('fs')).toThrow('require denied');
    expect(() => require('node:fs')).toThrow('require denied');
    expect(() => require('path')).toThrow('require denied');
  });

  it('路径穿越拒绝：解析后逃逸扩展目录的相对路径一律拒绝', () => {
    setupModules();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'evil.js'), 'module.exports = "pwned";');
      const rel = path.relative(extDir, path.join(outsideDir, 'evil.js')); // 形如 ../../opptrix-outside-xxx/evil.js
      const { deps } = makeRig();
      const { context } = createExtVm(deps);
      const require = createRestrictedRequire({ extDir, context });
      expect(() => require(`./${rel}`)).toThrow('require denied');
      expect(() => require('../nonexistent.js')).toThrow('require denied');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('非 .js 扩展名拒绝（./data.json）', () => {
    setupModules();
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const require = createRestrictedRequire({ extDir, context });
    expect(() => require('./data.json')).toThrow('require denied');
  });

  it('模块缓存 per-extId：两个 require 实例（两次加载）互不共享', () => {
    setupModules();
    const { deps } = makeRig();
    const { context } = createExtVm(deps);
    const requireA = createRestrictedRequire({ extDir, context });
    const requireB = createRestrictedRequire({ extDir, context });
    const a = requireA('./dep') as Record<string, unknown>;
    const b = requireB('./dep') as Record<string, unknown>;
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// defineExtension
// ---------------------------------------------------------------------------

describe('defineExtension', () => {
  it('打形状标记且 setup 原样透传；形状识别为扁平检查（default 解包在 worker 加载路径）', () => {
    const setup = (): void => {};
    const def = defineExtension({ setup });
    expect(def.__opptrixExtension).toBe(true);
    expect(def.setup).toBe(setup);
    expect(isExtensionDefinition(def)).toBe(true);
    expect(isExtensionDefinition({ __opptrixExtension: true, default: def })).toBe(false); // 缺 setup
    expect(isExtensionDefinition({ default: def })).toBe(false); // 本身不是定义；worker 会取 .default 再识别
    expect(isExtensionDefinition({ setup })).toBe(false);
    expect(isExtensionDefinition(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 注册类 API（route/on/hook/expose/page/menu/task/cron/ui）
// ---------------------------------------------------------------------------

describe('h.route — 激活期捕获与归一化', () => {
  it('激活期捕获：method 大写、路径归一化（合并斜杠/去尾斜杠/补根）、auth 缺省 public', () => {
    const { harness, collector } = makeHarness({ active: true });
    const handler = (): { msg: string } => ({ msg: 'ok' });
    harness.route('get', 'a//b/', handler);
    harness.route('GET', '', handler);
    expect(collector.contributions.routes).toEqual([
      { method: 'GET', path: '/a/b', auth: 'public', scope: undefined, timeoutMs: undefined },
      { method: 'GET', path: '/', auth: 'public', scope: undefined, timeoutMs: undefined },
    ]);
    expect(collector.handlers.routes.get('GET /a/b')?.handler).toBe(handler);
    expect(collector.handlers.routes.has('GET /')).toBe(true);
  });

  it('同 key 重复注册抛 duplicate route', () => {
    const { harness } = makeHarness({ active: true });
    harness.route('POST', '/x', () => null);
    expect(() => harness.route('POST', '/x/', () => null)).toThrow('duplicate route: POST /x');
  });

  it('route/auth/scope/timeoutMs 选项透传进贡献', () => {
    const { harness, collector } = makeHarness({ active: true });
    harness.route('GET', '/secure', () => null, { auth: 'authenticated', scope: 'admin', timeoutMs: 1234 });
    expect(collector.contributions.routes[0]).toMatchObject({ auth: 'authenticated', scope: 'admin', timeoutMs: 1234 });
    expect(collector.handlers.routes.get('GET /secure')?.timeoutMs).toBe(1234);
  });
});

describe('注册类 API — 激活期闸门', () => {
  it('非激活期调用全部抛 registration API 错误且不产生任何捕获', async () => {
    const { harness, collector, kernelCall } = makeHarness({ active: false });
    const registrationCalls: Array<() => unknown> = [
      () => harness.route('GET', '/x', () => null),
      () => harness.webhook('/wh', () => null, { secret: 's' }),
      () => harness.on('a.b', () => null),
      () => harness.hook('transform', () => null),
      () => harness.expose('svc', { ping: () => null }),
      () => harness.page('/p', { title: 't', entry: 'e' }),
      () => harness.menu('Menu'),
      () => harness.task('job', () => null),
      () => harness.cron.schedule({ name: 'job', expr: '* * * * *' }, () => null),
      () => harness.ui.register({ menu: [{ label: 'm' }] }),
    ];
    for (const call of registrationCalls) {
      expect(call).toThrow('registration API is only available during setup');
    }
    expect(collector.contributions.routes).toHaveLength(0);
    expect(collector.contributions.events).toHaveLength(0);
    expect(collector.handlers.crons.size).toBe(0);
    // 非激活期的运行类 API 不受闸门限制
    await harness.storage.set('k', 1);
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.storageSet, { key: 'k', value: 1 });
  });
});

describe('h.on / h.hook / h.expose / h.task / h.page / h.menu — 捕获', () => {
  it('on：contributions.events + handlers.events（同 pattern 叠加、priority 记录）', () => {
    const { harness, collector } = makeHarness({ active: true });
    const h1 = (): void => {};
    const h2 = (): void => {};
    harness.on('user.created', h1);
    harness.on('user.created', h2, { priority: 5 });
    expect(collector.contributions.events).toEqual([
      { pattern: 'user.created', priority: 0 },
      { pattern: 'user.created', priority: 5 },
    ]);
    expect(collector.handlers.events.get('user.created')).toHaveLength(2);
  });

  it('on 的 pattern 校验拒绝空分段', () => {
    const { harness } = makeHarness({ active: true });
    expect(() => harness.on('a..b', () => null)).toThrow(TypeError);
    expect(() => harness.on('', () => null)).toThrow(TypeError);
  });

  it('hook：contributions.hooks + handlers.hooks', () => {
    const { harness, collector } = makeHarness({ active: true });
    const handler = (v: unknown): unknown => v;
    harness.hook('before-send', handler, { priority: 3 });
    expect(collector.contributions.hooks).toEqual([{ name: 'before-send', priority: 3 }]);
    expect(collector.handlers.hooks.get('before-send')?.[0]?.handler).toBe(handler);
  });

  it('expose：services 贡献 + servicesMap 按 service.method 命中', () => {
    const { harness, collector } = makeHarness({ active: true });
    const ping = (): string => 'pong';
    const other = (): void => {};
    harness.expose('math', { ping, other });
    expect(collector.contributions.services).toEqual([{ name: 'math', methods: ['ping', 'other'] }]);
    expect(collector.handlers.services.get('math.ping')).toBe(ping);
  });

  it('task / page / menu：本地登记与 UI 片段', () => {
    const { harness, collector } = makeHarness({ active: true });
    const taskHandler = (): void => {};
    harness.task('resize', taskHandler);
    harness.page('admin//stats/', { title: 'Stats', entry: './stats.js' });
    harness.menu('报表', 'chart-bar');
    expect(collector.handlers.tasks.get('resize')).toBe(taskHandler);
    expect(collector.contributions.ui.pages).toEqual([{ path: '/admin/stats', title: 'Stats', entry: './stats.js' }]);
    expect(collector.contributions.ui.menu).toEqual([{ label: '报表', icon: 'chart-bar' }]);
  });

  it('ui.register 合并片段进 collector.ui', () => {
    const { harness, collector } = makeHarness({ active: true });
    harness.ui.register({
      pages: [{ path: '/a', title: 'A', entry: 'a.js' }],
      menu: [{ label: 'L1' }],
    });
    harness.ui.register({ pages: [{ path: '/b', title: 'B', entry: 'b.js' }] });
    expect(collector.contributions.ui.pages).toHaveLength(2);
    expect(collector.contributions.ui.menu).toEqual([{ label: 'L1' }]);
  });

  it('VM 内定义的 handler 可被宿主侧调用（vm.runInContext 模拟 setup）', () => {
    const { deps } = makeRig();
    const extVm = createExtVm(deps);
    const { harness, collector } = makeHarness({ active: true });
    Object.defineProperty(extVm.context, '__harness', { value: harness, configurable: true });
    vm.runInContext(
      `__harness.route('GET', '/vm', (request) => ({ status: 200, body: { echo: request.query.q } }))`,
      extVm.context,
    );
    const handler = collector.handlers.routes.get('GET /vm')?.handler;
    expect(handler).toBeTypeOf('function');
    expect(handler?.(makeRouteRequest({ query: { q: 'hi' } }))).toEqual({ status: 200, body: { echo: 'hi' } });
  });
});

describe('h.webhook — HMAC 包装', () => {
  const rawBody = '{"a":1}';
  const secret = 's3cret';

  function sign(payload: string, ts?: string): string {
    return createHmac('sha256', secret).update(ts === undefined ? payload : `${ts}.${payload}`).digest('hex');
  }

  it('签名正确（ts + rawBody）→ 底层 handler 被调用', () => {
    const { harness, collector } = makeHarness({ active: true });
    const seen: RouteRequest[] = [];
    harness.webhook('/hook', (request) => seen.push(request), { secret });
    const request = makeRouteRequest({
      headers: { 'x-harness-timestamp': '123', 'x-harness-signature': sign(rawBody, '123') },
      rawBody,
    });
    void collector.handlers.routes.get('POST /hook')?.handler(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestId).toBe('req-1');
  });

  it('签名缺失/错误 → 抛 HARNESS-1006（401），handler 不被调用', () => {
    const { harness, collector } = makeHarness({ active: true });
    let called = false;
    harness.webhook('/hook', () => {
      called = true;
      return null;
    }, { secret });
    const badSign = collector.handlers.routes.get('POST /hook')?.handler;
    const missing = makeRouteRequest({ rawBody });
    const wrong = makeRouteRequest({
      headers: { 'x-harness-timestamp': '123', 'x-harness-signature': sign('tampered', '123') },
      rawBody,
    });
    for (const request of [missing, wrong]) {
      let thrown: unknown;
      try {
        void badSign?.(request);
      } catch (e) {
        thrown = e;
      }
      expect((thrown as { code?: string; status?: number }).code).toBe('HARNESS-1006');
      expect((thrown as { status?: number }).status).toBe(401);
    }
    expect(called).toBe(false);
  });

  it('未配置 secret 时跳过验签；webhook 以 POST 路由登记', () => {
    const { harness, collector } = makeHarness({ active: true });
    let called = false;
    harness.webhook('/open', () => {
      called = true;
      return null;
    });
    void collector.handlers.routes.get('POST /open')?.handler(makeRouteRequest({ rawBody }));
    expect(called).toBe(true);
  });
});

describe('h.cron — 激活期捕获与内核调度', () => {
  it('激活期：input 发 cron.schedule topic，本地登记 name→handler；unschedule 双向摘除', async () => {
    const { harness, collector, kernelCall } = makeHarness({ active: true });
    let fired = 0;
    const handler = (): void => {
      fired += 1;
    };
    await harness.cron.schedule({ name: 'nightly', expr: '0 3 * * *', tz: 'UTC', overlap: false }, handler);
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.cronSchedule, {
      name: 'nightly',
      expr: '0 3 * * *',
      tz: 'UTC',
      payload: undefined,
      overlap: false,
      misfire: undefined,
    });
    expect(collector.handlers.crons.get('nightly')).toBe(handler);
    handler();
    expect(fired).toBe(1);

    await harness.cron.unschedule('nightly');
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.cronUnschedule, { name: 'nightly' });
    expect(collector.handlers.crons.has('nightly')).toBe(false);
  });

  it('非激活期 cron.schedule 抛 registration 错误', () => {
    const { harness } = makeHarness({ active: false });
    expect(() => harness.cron.schedule({ name: 'x', expr: '* * * * *' }, () => null)).toThrow(
      'registration API is only available during setup',
    );
  });
});

// ---------------------------------------------------------------------------
// 运行类 API（kernelCall 转发 + 本地预检）
// ---------------------------------------------------------------------------

describe('db — 本地预检与转发（双保险）', () => {
  it('db.run：ATTACH 本地拒绝（HARNESS-4002），kernelCall 不发出', () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    expect(harnessCodeOf(() => harness.db.run(`ATTACH DATABASE 'x.sqlite' AS x`))).toBe('HARNESS-4002');
    expect(kernelCall).not.toHaveBeenCalled();
  });

  it('db.run：多语句（>1 个分号）本地拒绝；字面量中的分号/禁词不误伤', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    // 2 个分号 → 本地预检拒绝；"仅 1 个分号且末尾还有内容"按内核规则交由驱动单语句 prepare 兜底
    expect(harnessCodeOf(() => harness.db.run(`INSERT INTO t(a) VALUES (1); DROP TABLE t; DELETE FROM t`)))
      .toBe('HARNESS-4002');
    await harness.db.run(`INSERT INTO t(a) VALUES ('attach; not really')`);
    expect(kernelCall).toHaveBeenCalledTimes(1);
  });

  it('db.all/get/run 转发 topic 与 payload（params 缺省 []）', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    await harness.db.all('SELECT * FROM t WHERE a = ?', [1]);
    await harness.db.get('SELECT * FROM t WHERE a = ?', [1]);
    await harness.db.run('CREATE TABLE t(a INTEGER)');
    const topics = kernelCall.mock.calls.map((c) => c[0]);
    expect(topics).toEqual([KERNEL_TOPICS.dbAll, KERNEL_TOPICS.dbGet, KERNEL_TOPICS.dbRun]);
    expect(kernelCall.mock.calls[2]?.[1]).toEqual({ sql: 'CREATE TABLE t(a INTEGER)', params: [] });
  });

  it('db.schema：逐条预检后以 dbSchema topic 发送数组', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    expect(harnessCodeOf(() => harness.db.schema(['CREATE TABLE a(x)', 'ATTACH b']))).toBe('HARNESS-4002');
    await harness.db.schema(['CREATE TABLE a(x)', 'CREATE TABLE b(y)']);
    expect(kernelCall).toHaveBeenCalledTimes(1);
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.dbSchema, {
      statements: ['CREATE TABLE a(x)', 'CREATE TABLE b(y)'],
    });
  });
});

describe('files.save — base64 转换与大小限制', () => {
  it('Buffer 输入转 base64，payload 形状正确', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    await harness.files.save({ origName: 'a.png', mime: 'image/png', data: Buffer.from('hello'), visibility: 'public' });
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.filesSave, {
      origName: 'a.png',
      mime: 'image/png',
      data: Buffer.from('hello').toString('base64'),
      visibility: 'public',
    });
  });

  it('超过 8MB 拒绝（PAYLOAD_TOO_LARGE），kernelCall 不发出', () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    expect(harnessCodeOf(() => harness.files.save({ origName: 'big.bin', mime: 'application/octet-stream', data: big })))
      .toBe('HARNESS-1005');
    expect(kernelCall).not.toHaveBeenCalled();
  });

  it('base64 字符串直传并按解码后大小校验', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    const b64 = Buffer.from('hello').toString('base64');
    await harness.files.save({ origName: 'a.txt', mime: 'text/plain', data: b64 });
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.filesSave, {
      origName: 'a.txt',
      mime: 'text/plain',
      data: b64,
    });
  });
});

describe('kernelCall 转发 — 负载形状与错误透传', () => {
  it('config/storage/notify/chat/system/call 的 topic 与 payload', async () => {
    const { harness, kernelCall } = makeHarness({ active: true });
    await harness.config.get('llm.model', 'gpt-default');
    await harness.storage.get('k');
    await harness.notify.send({ title: 'hi' });
    await harness.chat.patch({ id: 'm1' });
    await harness.system.stats();
    await harness.call('other-ext', 'ping', { n: 1 });
    expect(kernelCall.mock.calls.map((c) => c[0])).toEqual([
      KERNEL_TOPICS.configGet,
      KERNEL_TOPICS.storageGet,
      KERNEL_TOPICS.notifySend,
      KERNEL_TOPICS.chatPatch,
      KERNEL_TOPICS.systemStats,
      'host.call',
    ]);
    expect(kernelCall.mock.calls[0]?.[1]).toEqual({ path: 'llm.model', fallback: 'gpt-default' });
    expect(kernelCall.mock.calls[5]?.[1]).toEqual({ targetExtId: 'other-ext', method: 'ping', args: { n: 1 } });
  });

  it('llm.chat 在内核未实现（NOT_IMPLEMENTED）时错误透传', async () => {
    const kernelCall = vi.fn(async () => {
      throw Object.assign(new Error('not implemented'), { code: 'HARNESS-9004' });
    });
    const { harness } = makeHarness({ active: true, kernelCall });
    await expect(harness.llm.chat({ messages: [] })).rejects.toMatchObject({ code: 'HARNESS-9004' });
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.llmChat, { messages: [] });
  });

  it('log 为 fire-and-forget：内核不可达不向扩展抛错', () => {
    const kernelCall = vi.fn(async () => {
      throw new Error('kernel down');
    });
    const { harness } = makeHarness({ active: true, kernelCall });
    expect(() => harness.log.error('oops', { code: 1 })).not.toThrow();
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.log, { level: 'error', msg: 'oops', args: [{ code: 1 }] });
  });
});

// ---------------------------------------------------------------------------
// worker 纯工具
// ---------------------------------------------------------------------------

describe('worker — matchPattern（内核同款通配语义）', () => {
  it.each([
    ['*', 'a', true],
    ['*', 'a.b', false],
    ['a.*', 'a.b', true],
    ['a.*', 'a.b.c', false],
    ['a.**', 'a.b.c', true],
    ['a.**', 'a', true],
    ['a.b', 'a.b', true],
    ['a.b', 'a.c', false],
    ['**', 'x.y.z', true],
    ['a.*.c', 'a.b.c', true],
  ])('matchPattern(%j, %j) → %j', (pattern, name, expected) => {
    expect(matchPattern(pattern, name)).toBe(expected);
  });
});

describe('worker — normalizeResponse 与 HookAbort', () => {
  it('返回值归一化：普通对象包装 200；{ status, body/headers } 原样；undefined → null', () => {
    expect(normalizeResponse({ foo: 1 })).toEqual({ status: 200, body: { foo: 1 } });
    expect(normalizeResponse([1, 2])).toEqual({ status: 200, body: [1, 2] });
    expect(normalizeResponse(undefined)).toEqual({ status: 200, body: null });
    expect(normalizeResponse({ status: 201, body: { id: 1 } })).toEqual({ status: 201, body: { id: 1 } });
    expect(normalizeResponse({ status: 302, headers: { location: '/x' } })).toEqual({
      status: 302,
      headers: { location: '/x' },
      body: null,
    });
  });

  it('HookAbort 类与 VM 侧结构等价对象均可识别', () => {
    const abort = new HookAbort({ shortCircuit: true });
    expect(isHookAbort(abort)).toBe(true);
    expect(abort.result).toEqual({ shortCircuit: true });
    expect(isHookAbort({ __opptrixHookAbort: true, result: 5 })).toBe(true);
    expect(isHookAbort({ __opptrixHookAbort: true })).toBe(false);
    expect(isHookAbort(new Error('x'))).toBe(false);
    expect(isHookAbort(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 贡献快照
// ---------------------------------------------------------------------------

describe('ContributionsCollector.snapshot', () => {
  it('快照为纯数据深拷贝，与活注册表隔离', () => {
    const collector = createContributionsCollector();
    const { harness } = makeHarness({ active: true, collector });
    harness.route('GET', '/x', () => null);
    const snap1 = collector.snapshot();
    expect(snap1.routes).toEqual([{ method: 'GET', path: '/x', auth: 'public', scope: undefined, timeoutMs: undefined }]);
    harness.route('GET', '/y', () => null);
    expect(snap1.routes).toHaveLength(1); // 快照不受后续注册影响
    expect(snap1).not.toBe(collector.contributions);
  });
});
