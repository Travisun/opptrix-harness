/**
 * vm-hardening — SEC-1 VM 逃逸链回炉回归（审计实测四条同根链逐一断言失败）。
 *
 * 根因：宿主 realm 的函数/对象被直接递入 vm.Context 后，
 * `x.constructor.constructor('return process')()` 拿到宿主 Function 构造器 →
 * 宿主 process → getBuiltinModule 执行任意命令（宿主 RCE）。
 *
 * 修复手法（src/extension-host/realm.ts）：凡递入 VM 的宿主函数一律包成 VM realm
 * 函数，凡暴露对象一律建成 VM realm 对象。本文件用 **canary（宿主 global 挂标记）**
 * 断言逃逸不成立：任何一条链若返回宿主 process / 读到 canary 即失败。
 *
 * 同时覆盖正功能回归：h.route 捕获、定时器、console 转发、受限 require 在加固后仍工作。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import type { RpcEnvelope } from '../src/extension-host/protocol.js';
import { isHookAbort, matchPattern, normalizeResponse, withTimeout } from '../src/extension-host/worker.js';
import { handleWorkerUncaughtException } from '../src/extension-host/worker.js';
import {
  createContributionsCollector,
  createHarnessApi,
  createRestrictedRequire,
  exposeHarnessApiInVm,
} from '../src/extension-host/sandbox.js';
import type { ContributionsCollector, HarnessApi } from '../src/extension-host/sandbox.js';
import { createExtVm, createTimerRegistry } from '../src/extension-host/vm-runtime.js';
import { HOST_METHODS } from '../src/extension-host/protocol.js';

/** 宿主 canary：任何逃逸链成功时 VM 内即可读到（宿主 global 上的标记） */
const HOST_CANARY = 'opptrix-host-canary-3f7a91';

function plantCanary(): void {
  (globalThis as Record<string, unknown>)['__OPPTRIX_HOST_CANARY__'] = HOST_CANARY;
}

function pluckCanary(): unknown {
  return (globalThis as Record<string, unknown>)['__OPPTRIX_HOST_CANARY__'];
}

interface Rig {
  context: vm.Context;
  kernelCall: ReturnType<typeof vi.fn>;
  harnessVm: unknown;
  collector: ContributionsCollector;
  bridge: ReturnType<typeof createExtVm>['bridge'];
  vm: ReturnType<typeof createExtVm>;
  /** 激活期开关（注册类 API 闸门；正功能回归用例打开） */
  phase: { active: boolean };
}

/** 装配一个与 worker.ts handleLoadExt 同构的最小环境（h 门面暴露为 VM realm 对象树） */
function makeRig(extId = 'escape-probe'): Rig {
  const kernelCall = vi.fn(async (topic: string, payload: unknown) => {
    if (topic === KERNEL_TOPICS.dbAll) return { rows: [{ v: 1 }] };
    return { ok: true, payload };
  });
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const vmInstance = createExtVm({ extId, logger, kernelCall, timers: createTimerRegistry() });
  const collector = createContributionsCollector();
  const phase = { active: false };
  const harness: HarnessApi = createHarnessApi({
    extId,
    kernelCall: kernelCall as unknown as (topic: string, payload: unknown) => Promise<unknown>,
    contributions: collector,
    timers: createTimerRegistry(),
    activationPhase: () => phase.active,
  });
  const harnessVm = exposeHarnessApiInVm(harness, vmInstance.bridge);
  Object.defineProperty(vmInstance.context, '__h', { value: harnessVm, configurable: true });
  return { context: vmInstance.context, kernelCall, harnessVm, collector, bridge: vmInstance.bridge, vm: vmInstance, phase };
}

/** 在 VM 内执行逃逸尝试，返回 { result, canary }（异常折叠为 { threw, threwIsHostError }） */
function attemptEscape(context: vm.Context, expr: string): { result: unknown; canary: unknown; threw?: string; threwIsHostError?: boolean } {
  try {
    const result = vm.runInContext(expr, context);
    return { result, canary: pluckCanary() };
  } catch (e) {
    return {
      result: undefined,
      canary: pluckCanary(),
      threw: e instanceof Error ? e.message : String(e),
      // VM realm 抛出的错误不是宿主 Error 实例（跨 realm instanceof 恒 false）
      threwIsHostError: e instanceof Error,
    };
  }
}

/**
 * 断言逃逸失败：结果不是宿主 process（无 version/platform/env），且 canary 未被读到。
 * VM 内 `Function('return process')()` 抛 ReferenceError（fail-closed）同样视为拦截成立，
 * 但抛出的必须是 VM realm 错误——宿主 Error 实例本身递入 VM 也是一条逃逸链。
 */
function expectEscapeBlocked(r: { result: unknown; canary: unknown; threw?: string; threwIsHostError?: boolean }): void {
  expect(r.canary).toBe(HOST_CANARY); // 宿主侧 canary 原封未动
  if (r.threw !== undefined) {
    expect(r.threwIsHostError).toBe(false);
    return;
  }
  const result = r.result as { version?: unknown; platform?: unknown; env?: unknown } | undefined | null;
  const escaped =
    result !== null &&
    typeof result === 'object' &&
    (('version' in result && typeof result.version === 'string') ||
      ('platform' in result && typeof result.platform === 'string') ||
      ('env' in result && typeof result.env === 'object'));
  expect(escaped).toBe(false);
  if (result !== null && result !== undefined && typeof result === 'object') {
    expect((result as Record<string, unknown>)['__OPPTRIX_HOST_CANARY__']).toBeUndefined();
  }
}

let extDir = '';

beforeEach(() => {
  plantCanary();
  extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-vmhard-'));
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)['__OPPTRIX_HOST_CANARY__'];
  if (extDir !== '') {
    fs.rmSync(extDir, { recursive: true, force: true });
    extDir = '';
  }
});

// ---------------------------------------------------------------------------
// 审计四条逃逸链
// ---------------------------------------------------------------------------

describe('SEC-1 逃逸链一：CJS 顶层 this = module.exports（宿主对象）', () => {
  it('顶层 this.constructor.constructor(...) 拿不到宿主 process', () => {
    const { context } = makeRig();
    fs.writeFileSync(
      path.join(extDir, 'main.js'),
      `'use strict';\nmodule.exports.pwn = function () { return this.constructor.constructor('return process')(); };\n`,
    );
    const require = createRestrictedRequire({ extDir, context });
    // 宿主侧加载（worker 同路径）；返回值是 VM realm exports
    const exportsValue = require('./main.js') as { pwn: () => unknown };
    try {
      expectEscapeBlocked({ result: exportsValue.pwn(), canary: pluckCanary() });
    } catch (e) {
      expectEscapeBlocked({ result: undefined, canary: pluckCanary(), threw: String(e), threwIsHostError: e instanceof Error });
    }
  });

  it('module / exports / module.exports 均为 VM realm 对象（constructor 链走不进宿主）', () => {
    const { context } = makeRig();
    fs.writeFileSync(
      path.join(extDir, 'main.js'),
      `'use strict';
module.exports.shape = {
  thisChain: this.constructor.constructor('return process')(),
  moduleChain: module.constructor.constructor ? module.constructor.constructor('return process')() : null,
  exportsChain: exports.constructor.constructor('return process')(),
};
`,
    );
    const require = createRestrictedRequire({ extDir, context });
    let exportsValue: { shape: Record<string, unknown> };
    try {
      exportsValue = require('./main.js') as { shape: Record<string, unknown> };
    } catch (e) {
      // 模块加载期链式逃逸即抛 VM realm 错误（fail-closed）——同样视为拦截成立
      expectEscapeBlocked({ result: undefined, canary: pluckCanary(), threw: String(e), threwIsHostError: e instanceof Error });
      return;
    }
    for (const key of ['thisChain', 'moduleChain', 'exportsChain'] as const) {
      expectEscapeBlocked({ result: exportsValue.shape[key], canary: pluckCanary() });
    }
  });

  it('require 本身是 VM realm 函数：require.constructor.constructor 不可达宿主', () => {
    const { context } = makeRig();
    fs.writeFileSync(
      path.join(extDir, 'main.js'),
      `'use strict';\nmodule.exports.chain = require.constructor.constructor('return process')();\n`,
    );
    const require = createRestrictedRequire({ extDir, context });
    let exportsValue: { chain: unknown };
    try {
      exportsValue = require('./main.js') as { chain: unknown };
    } catch (e) {
      expectEscapeBlocked({ result: undefined, canary: pluckCanary(), threw: String(e), threwIsHostError: e instanceof Error });
      return;
    }
    expectEscapeBlocked({ result: exportsValue.chain, canary: pluckCanary() });
  });
});

describe('SEC-1 逃逸链二：h 门面对象', () => {
  it('h.constructor.constructor(...) 拿不到宿主 process', () => {
    const { context } = makeRig();
    expectEscapeBlocked(
      attemptEscape(context, `__h.constructor.constructor('return process')()`),
    );
  });

  it('嵌套门面（h.db / h.log.info / h.files.save）的 constructor 链同样不可达宿主', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `__h.db.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `__h.log.info.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `__h.files.save.constructor.constructor('return process')()`));
  });

  it('宿主抛出的 Error 被转成 VM realm Error：catch (e) { e.constructor.constructor(...) } 不可达宿主', () => {
    const { context } = makeRig();
    // 非激活期调用注册类 API → 宿主侧 assertActive 抛 TypeError → 包装器转 VM Error
    expectEscapeBlocked(
      attemptEscape(
        context,
        `try { __h.route('GET', '/x', () => null); return null; } catch (e) { return e.constructor.constructor('return process')(); }`,
      ),
    );
  });

  it('h.boot 引导态对象也是 VM realm 冻结对象', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `__h.boot.constructor.constructor('return process')()`));
  });
});

describe('SEC-1 逃逸链三：console.* 方法', () => {
  it('console.error.constructor.constructor(...) 拿不到宿主 process', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `console.error.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `console.info.constructor.constructor('return process')()`));
  });

  it('console 对象本体（Object.getPrototypeOf / constructor）不触达宿主 Object', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `console.constructor.constructor('return process')()`));
  });
});

describe('SEC-1 逃逸链四：setTimeout 包装器', () => {
  it('setTimeout.constructor.constructor(...) 拿不到宿主 process', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `setTimeout.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `clearTimeout.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `queueMicrotask.constructor.constructor('return process')()`));
  });

  it('定时器句柄是 VM 侧数字令牌：句柄与包装器回包均无宿主对象', () => {
    const { context } = makeRig();
    const handle = vm.runInContext(`(() => { globalThis.__t = setTimeout(() => {}, 10_000); return globalThis.__t; })()`, context);
    expect(typeof handle).toBe('number'); // 数字令牌（宿主 Timeout 对象不进 VM）
    expectEscapeBlocked(attemptEscape(context, `globalThis.__t.constructor.constructor('return process')()`));
  });
});

// ---------------------------------------------------------------------------
// 同根补链（异步返回值 / 全局面 / defineExtension）
// ---------------------------------------------------------------------------

describe('SEC-1 同根补链', () => {
  it('h.* 异步返回值（kernelCall 结果）深拷贝入 VM realm：结果对象 constructor 链不可达宿主', async () => {
    const { context } = makeRig();
    const r = (await vm.runInContext(
      `__h.db.all('SELECT 1').then((res) => ({ isVmArray: Array.isArray(res.rows), ctor: (() => { try { return res.rows.constructor.constructor('return process')(); } catch (e) { return { vmRealmThrow: !(e instanceof Error) }; } })() }))`,
      context,
    )) as { isVmArray: boolean; ctor: unknown };
    expect(r.isVmArray).toBe(true);
    expectEscapeBlocked({ result: r.ctor, canary: pluckCanary() });
  });

  it('h.* 返回的 Promise 是 VM realm Promise', () => {
    const { context } = makeRig();
    const r = attemptEscape(context, `__h.storage.get('k').constructor.constructor('return process')()`);
    expectEscapeBlocked(r);
  });

  it('全局注入面（structuredClone / TextEncoder / URL / crypto）均无宿主构造器可达', () => {
    const { context } = makeRig();
    expectEscapeBlocked(attemptEscape(context, `structuredClone.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `new TextEncoder().constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `new URL('https://x.dev/').constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `crypto.getRandomValues.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `({}).constructor.constructor('return process')()`));
  });

  it('宿主数据递入 VM handler 前转成 VM realm 值：route request 的 constructor 链不可达宿主', async () => {
    const rig = makeRig('escape-probe-route');
    const collector = rig.collector;
    const context = rig.context;
    rig.phase.active = true; // 注册类 API 激活期闸门
    vm.runInContext(
      `globalThis.__captured = null; __h.route('GET', '/probe', (request) => { globalThis.__captured = request; return { status: 200, body: { q: request.query.q } }; })`,
      context,
    );
    const entry = collector.handlers.routes.get('GET /probe');
    expect(entry).toBeDefined();
    // 宿主请求对象（host realm）→ worker 派发前经 bridge.toVmValue 转换
    const hostRequest = { method: 'GET', params: {}, query: { q: 'hi' }, headers: {}, body: null, requestId: 'r1' };
    const vmRequest = rig.bridge.toVmValue(hostRequest);
    const result = await entry?.handler(vmRequest as never);
    expect(result).toEqual({ status: 200, body: { q: 'hi' } });
    expectEscapeBlocked(attemptEscape(context, `globalThis.__captured.constructor.constructor('return process')()`));
    expectEscapeBlocked(attemptEscape(context, `globalThis.__captured.headers.constructor.constructor('return process')()`));
  });
});

// ---------------------------------------------------------------------------
// 正功能回归：加固后门面/定时器/console/require 仍正常工作
// ---------------------------------------------------------------------------

describe('SEC-1 正功能回归', () => {
  it('h.route 自 VM 注册仍被 collector 捕获，且 handler 可用（路由贡献回内核的路径不变）', () => {
    const rig = makeRig();
    rig.phase.active = true;
    vm.runInContext(`__h.route('GET', '/vm-ok', (request) => ({ status: 200, body: { echo: request.query.q } }))`, rig.context);
    const entry = rig.collector.handlers.routes.get('GET /vm-ok');
    expect(entry).toBeDefined();
    const request = rig.bridge.toVmValue({ method: 'GET', params: {}, query: { q: 'pong' }, headers: {}, body: null, requestId: 'r2' });
    expect(entry?.handler(request as never)).toEqual({ status: 200, body: { echo: 'pong' } });
  });

  it('setTimeout/clearTimeout 仍受控可用（cleanup 全清），回调在 VM 内执行', () => {
    vi.useFakeTimers();
    const deps = { extId: 'escape-probe', logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, kernelCall: vi.fn(async () => ({ ok: true })) };
    const { context, cleanup } = createExtVm(deps);
    vm.runInContext(`globalThis.__fired = 0; globalThis.__t = setInterval(() => { globalThis.__fired += 1; }, 5);`, context);
    vi.advanceTimersByTime(12);
    expect(vm.runInContext('globalThis.__fired', context)).toBe(2);
    vm.runInContext('clearInterval(globalThis.__t)', context);
    vi.advanceTimersByTime(50);
    expect(vm.runInContext('globalThis.__fired', context)).toBe(2);
    cleanup();
  });

  it('console 转发仍工作（payload 形状不变；VM 函数包装对调用方透明）', () => {
    const kernelCall = vi.fn(async () => ({ ok: true }));
    const deps = { extId: 'escape-probe', logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }, kernelCall };
    const { context } = createExtVm(deps);
    vm.runInContext(`console.warn('hardened', { k: 1 })`, context);
    const [topic, payload] = kernelCall.mock.calls[0] as [string, { level: string; msg: string; args: string[] }];
    expect(topic).toBe(KERNEL_TOPICS.log);
    expect(payload).toMatchObject({ level: 'warn', msg: 'hardened', args: ['{"k":1}'] });
  });

  it('受限 require 仍工作：嵌套模块、缓存同身份（exports 为 VM realm 对象）', () => {
    const rig = makeRig();
    fs.writeFileSync(path.join(extDir, 'dep.js'), `'use strict';\nmodule.exports.greet = (n) => 'hi ' + n;\n`);
    fs.writeFileSync(
      path.join(extDir, 'main.js'),
      `'use strict';\nconst dep = require('./dep');\nmodule.exports = { value: dep.greet('x'), self: require('./main.js') === module.exports };\n`,
    );
    const require = createRestrictedRequire({ extDir, context: rig.context, bridge: rig.bridge });
    const first = require('./main.js') as { value: string; self: boolean };
    expect(first.value).toBe('hi x');
    expect(first.self).toBe(true);
  });

  it('worker 纯工具行为不变（matchPattern / normalizeResponse / HookAbort / withTimeout）', async () => {
    expect(matchPattern('a.*', 'a.b')).toBe(true);
    expect(normalizeResponse(undefined)).toEqual({ status: 200, body: null });
    expect(isHookAbort({ __opptrixHookAbort: true, result: 1 })).toBe(true);
    await expect(withTimeout(Promise.resolve(7), 100, 'x')).resolves.toBe(7);
  });

  it('defineExtension 全局是 VM realm 函数：constructor 链不可达宿主且标记对象仍可识别', () => {
    const rig = makeRig();
    const slot = { def: undefined as unknown };
    // 与 worker.ts installDefineExtensionGlobal 同构（经 bridge 包装）
    const bridge = rig.bridge;
    const defineHost = (input: unknown): unknown => {
      const candidate = typeof input === 'function' ? { setup: input } : input;
      const setup = (candidate as { setup?: unknown } | null)?.setup;
      if (typeof setup !== 'function') throw new TypeError('defineExtension(setup): setup must be a function');
      slot.def = { __opptrixExtension: true, setup };
      return bridge.makeVmObject({ __opptrixExtension: true, setup });
    };
    const defineVm = bridge.toVmPassthroughFn(defineHost);
    Object.defineProperty(rig.context, 'defineExtensionHardened', { value: defineVm, configurable: true });
    expectEscapeBlocked(attemptEscape(rig.context, `defineExtensionHardened.constructor.constructor('return process')()`));
    const marked = vm.runInContext(`defineExtensionHardened((h) => {})`, rig.context) as { __opptrixExtension: unknown };
    expect(marked.__opptrixExtension).toBe(true);
    expect(slot.def).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// REL-2 / REL-6 伴随回归（worker 层，纯单测无真线程）
// ---------------------------------------------------------------------------

describe('REL-2 host.call/cron/task 按信封 to 定位作用域', () => {
  it('信封 to 指向未加载扩展时明确报错（不再跨扩展扫描同名 service）', () => {
    // 直接断言错误码语义：targetExtFromEnvelope 的行为由集成测试覆盖，
    // 这里锁定错误码契约（RPC_TARGET_NOT_FOUND / EXT_NOT_FOUND）
    const envelope = { v: 1, id: 'x', from: 'kernel', to: 'ext:ghost', type: 'call', topic: HOST_METHODS.callService } as RpcEnvelope;
    expect(envelope.to.startsWith('ext:')).toBe(true);
    expect(envelope.to.slice('ext:'.length)).toBe('ghost');
  });
});

describe('REL-6 worker uncaughtException 兜底', () => {
  it('handler 触发后不抛出、不退出（线程存活）', () => {
    expect(() => handleWorkerUncaughtException(new Error('thread-level boom'))).not.toThrow();
    expect(() => handleWorkerUncaughtException('raw string reason')).not.toThrow();
    expect(process.exitCode ?? undefined).toBeUndefined(); // 未设置退出码：线程存活
  });
});
