/**
 * ExtensionServiceRegistry 单测 — 注册目录 / 热插拔语义 / 权限门 / 超时 / dispatcher 契约。
 *
 * 覆盖：register 原子校验与覆盖语义、list 目录（排序 + 防御性拷贝）、suspend/activate/remove
 * 热插拔（调用侧 fail-fast SERVICE_UNAVAILABLE）、method 未注册 RPC_TARGET_NOT_FOUND、
 * 权限（无 rpc:call 403 / rpc:call:<target> 定向 / rpc:call 全量 / 自调用豁免契约）、
 * 超时（dispatcher 永挂 → RPC_TIMEOUT）、dispatcher 收到参数正确、异常规整。
 */
import { describe, expect, it } from 'vitest';

import {
  ExtensionServiceRegistry,
  type ExposedService,
  type ExtCallDispatcher,
  type ServiceEntry,
} from '../src/kernel/extensions/registry.js';
import { HarnessError } from '../src/kernel/errors/index.js';

// ---------------------------------------------------------------------------
// stub 与辅助
// ---------------------------------------------------------------------------

/** dispatcher 收到的单次调用（透传参数快照） */
interface Call {
  targetExtId: string;
  service: string;
  method: string;
  args: unknown;
  timeoutMs: number;
}

/** 可断言的 dispatcher stub：记录全部调用；无 impl 时回显 { ok, method } */
class DispatcherStub implements ExtCallDispatcher {
  readonly calls: Call[] = [];

  constructor(private readonly impl?: (call: Call) => unknown) {}

  callService(
    targetExtId: string,
    service: string,
    method: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const call: Call = { targetExtId, service, method, args, timeoutMs };
    this.calls.push(call);
    if (this.impl === undefined) return Promise.resolve({ ok: true, method });
    return Promise.resolve(this.impl(call));
  }
}

/** 永挂 dispatcher（超时测试用：既不 resolve 也不 reject） */
function hangingDispatcher(): ExtCallDispatcher & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    callService: (targetExtId, service, method, args, timeoutMs) => {
      calls.push({ targetExtId, service, method, args, timeoutMs });
      return new Promise<never>(() => {});
    },
  };
}

/** 抛错 dispatcher */
function failingDispatcher(error: unknown): ExtCallDispatcher {
  return { callService: () => Promise.reject(error) };
}

/** 捕获 Promise 拒绝值（约定为 HarnessError） */
async function captureRejection(p: Promise<unknown>): Promise<HarnessError> {
  try {
    await p;
  } catch (e) {
    return e as HarnessError;
  }
  throw new Error('expected the promise to reject');
}

function makeRegistry(
  dispatcher: ExtCallDispatcher,
  timeoutMs?: number,
): ExtensionServiceRegistry {
  return new ExtensionServiceRegistry(
    timeoutMs === undefined ? { dispatcher } : { dispatcher, timeoutMs },
  );
}

/** 预置 doc(parse/parseFile) + hello(greet) 两个扩展的注册中心 */
function seedRegistry(dispatcher: ExtCallDispatcher, timeoutMs?: number): ExtensionServiceRegistry {
  const registry = makeRegistry(dispatcher, timeoutMs);
  registry.register('doc', [{ name: 'parse', methods: ['parse', 'parseFile'] }]);
  registry.register('hello', [{ name: 'greet', methods: ['greet'] }]);
  return registry;
}

const ALL_ACTIVE: ServiceEntry[] = [
  { extId: 'doc', service: 'ext.doc.parse', methods: ['parse', 'parseFile'], status: 'active' },
  { extId: 'hello', service: 'ext.hello.greet', methods: ['greet'], status: 'active' },
];

// ---------------------------------------------------------------------------
// register / list 目录
// ---------------------------------------------------------------------------

describe('register / list 目录', () => {
  it('register 后 list 输出目录：service 全名 ext.{extId}.{name}、methods、status active（按服务名稳定排序）', () => {
    const registry = seedRegistry(new DispatcherStub());
    expect(registry.list()).toEqual(ALL_ACTIVE);
  });

  it('同一扩展多服务：一次 register 登记多个服务，各自可解析调用', async () => {
    const dispatcher = new DispatcherStub();
    const registry = makeRegistry(dispatcher);
    registry.register('doc', [
      { name: 'parse', methods: ['parse'] },
      { name: 'render', methods: ['render'] },
    ]);
    const entries = registry.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.service)).toEqual(['ext.doc.parse', 'ext.doc.render']);

    const call = registry.resolveCaller('doc', ['rpc:call']);
    await expect(call('ext.doc.render', 'render', { page: 1 })).resolves.toEqual({ ok: true, method: 'render' });
    expect(dispatcher.calls[0]).toMatchObject({ service: 'ext.doc.render', method: 'render' });
  });

  it('重复注册 = 整扩展覆盖：旧服务连同目标一起消失（SERVICE_UNAVAILABLE），新服务生效', async () => {
    const dispatcher = new DispatcherStub();
    const registry = makeRegistry(dispatcher);
    registry.register('doc', [{ name: 'parse', methods: ['parse', 'parseFile'] }]);
    registry.register('doc', [{ name: 'render', methods: ['render'] }]);

    expect(registry.list()).toEqual([
      { extId: 'doc', service: 'ext.doc.render', methods: ['render'], status: 'active' },
    ]);
    const call = registry.resolveCaller('caller', ['rpc:call']);
    const e = await captureRejection(call('ext.doc.parse', 'parse', null));
    expect(e.code).toBe('HARNESS-1003'); // 目标服务已被覆盖摘除 → SERVICE_UNAVAILABLE
    await expect(call('ext.doc.render', 'render', null)).resolves.toEqual({ ok: true, method: 'render' });
  });

  it('list 返回防御性副本：外部修改不污染内部状态', () => {
    const registry = seedRegistry(new DispatcherStub());
    const entries = registry.list();
    entries[0]!.methods.push('injected');
    entries.pop();
    expect(registry.list()).toEqual(ALL_ACTIVE);
  });

  it('原子校验：任一服务/方法非法 → EXT_MANIFEST_INVALID，整体不生效（不产生半套登记）', () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const before = registry.list();

    const bad: ExposedService[] = [
      { name: 'ok', methods: ['fine'] },
      { name: 'bad name', methods: ['m'] },
    ];
    expect(() => registry.register('doc', bad)).toThrowError(HarnessError);
    const e = captureRejectionSync(() => registry.register('doc', bad));
    expect(e.code).toBe('HARNESS-3001'); // EXT_MANIFEST_INVALID
    expect(e.status).toBe(400);
    expect(registry.list()).toEqual(before); // 原有登记原封不动
  });

  it.each([
    ['服务名空串', [{ name: '', methods: ['m'] }]],
    ['服务名含连字符', [{ name: 'parse-v2', methods: ['m'] }]],
    ['方法名以数字开头', [{ name: 'svc', methods: ['9lives'] }]],
    ['methods 为空数组', [{ name: 'svc', methods: [] }]],
    ['方法名重复', [{ name: 'svc', methods: ['run', 'run'] }]],
  ])('非法登记（%s）→ EXT_MANIFEST_INVALID 且 message 可操作', (_label, services) => {
    const registry = makeRegistry(new DispatcherStub());
    let caught: HarnessError | undefined;
    try {
      registry.register('doc', services);
    } catch (e) {
      caught = e as HarnessError;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    expect(caught!.code).toBe('HARNESS-3001');
    expect(caught!.message).toContain('[extensions] register("doc")');
    expect(registry.list()).toEqual([]);
  });

  it('suspend 后重复注册（自愈/重载重注册）：status 重置 active', async () => {
    const dispatcher = new DispatcherStub();
    const registry = makeRegistry(dispatcher);
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    registry.suspend('doc');
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    expect(registry.list()[0]!.status).toBe('active');
    const call = registry.resolveCaller('doc', []);
    await expect(call('ext.doc.parse', 'parse', null)).resolves.toEqual({ ok: true, method: 'parse' });
  });
});

// ---------------------------------------------------------------------------
// 热插拔语义
// ---------------------------------------------------------------------------

describe('热插拔语义（suspend / activate / remove）', () => {
  it('suspend → 调用 fail-fast SERVICE_UNAVAILABLE（503 HARNESS-1003），不触达 dispatcher', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    registry.suspend('doc');

    const call = registry.resolveCaller('caller', ['rpc:call']);
    const e = await captureRejection(call('ext.doc.parse', 'parse', { x: 1 }));
    expect(e).toBeInstanceOf(HarnessError);
    expect(e.code).toBe('HARNESS-1003');
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
    expect(e.detail).toEqual({ service: 'ext.doc.parse' });
    expect(dispatcher.calls).toEqual([]); // 摘除即拒之门外
    expect(registry.list().find((s) => s.service === 'ext.doc.parse')!.status).toBe('suspended');
  });

  it('activate → 恢复可调用', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    registry.suspend('doc');
    registry.activate('doc');
    expect(registry.list().find((s) => s.service === 'ext.doc.parse')!.status).toBe('active');

    const call = registry.resolveCaller('caller', ['rpc:call']);
    await expect(call('ext.doc.parse', 'parse', null)).resolves.toEqual({ ok: true, method: 'parse' });
  });

  it('remove → SERVICE_UNAVAILABLE；list 中条目消失', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    registry.remove('doc');
    expect(registry.list().some((s) => s.extId === 'doc')).toBe(false);

    const call = registry.resolveCaller('caller', ['rpc:call']);
    const e = await captureRejection(call('ext.doc.parse', 'parse', null));
    expect(e.code).toBe('HARNESS-1003');
  });

  it('suspend / activate / remove 对未知 extId 幂等 no-op 不抛错', () => {
    const registry = seedRegistry(new DispatcherStub());
    expect(() => registry.suspend('ghost')).not.toThrow();
    expect(() => registry.activate('ghost')).not.toThrow();
    expect(() => registry.remove('ghost')).not.toThrow();
    expect(registry.list()).toEqual(ALL_ACTIVE);
  });
});

// ---------------------------------------------------------------------------
// 目标解析与 dispatcher 契约
// ---------------------------------------------------------------------------

describe('目标解析与 dispatcher 契约', () => {
  it('dispatcher 收到参数正确（targetExtId/service/method/args/timeoutMs），返回值透传', async () => {
    const dispatcher = new DispatcherStub(() => ({ rows: [1, 2, 3] }));
    const registry = makeRegistry(dispatcher, 1234);
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);

    const call = registry.resolveCaller('doc', ['rpc:call']);
    const result = await call('ext.doc.parse', 'parse', { file: 'a.txt' });
    expect(result).toEqual({ rows: [1, 2, 3] });
    expect(dispatcher.calls).toEqual([
      {
        targetExtId: 'doc',
        service: 'ext.doc.parse',
        method: 'parse',
        args: { file: 'a.txt' },
        timeoutMs: 1234,
      },
    ]);
  });

  it('timeoutMs 缺省 30_000 透传给 dispatcher', async () => {
    const dispatcher = new DispatcherStub();
    const registry = new ExtensionServiceRegistry({ dispatcher });
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    await registry.resolveCaller('doc', ['rpc:call'])('ext.doc.parse', 'parse', null);
    expect(dispatcher.calls[0]!.timeoutMs).toBe(30_000);
  });

  it('method 不在 methods 清单 → RPC_TARGET_NOT_FOUND（404 HARNESS-2002），不触达 dispatcher', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const call = registry.resolveCaller('caller', ['rpc:call']);
    const e = await captureRejection(call('ext.doc.parse', 'nonexistent', null));
    expect(e.code).toBe('HARNESS-2002');
    expect(e.status).toBe(404);
    expect(e.detail).toEqual({ service: 'ext.doc.parse', method: 'nonexistent' });
    expect(dispatcher.calls).toEqual([]);
  });

  it('目标服务名不符合 ext.{extId}.{service} 约定 → SERVICE_UNAVAILABLE', async () => {
    const registry = seedRegistry(new DispatcherStub());
    const call = registry.resolveCaller('caller', ['rpc:call']);
    for (const bad of ['doc.parse', 'ext.doc', 'ext.', 'ext.doc.parse.v2', '']) {
      const e = await captureRejection(call(bad, 'parse', null));
      expect(e.code, `service="${bad}" 应为 SERVICE_UNAVAILABLE`).toBe('HARNESS-1003');
    }
  });

  it('dispatcher 抛非 HarnessError → 规整为 RPC_HANDLER_ERROR（HARNESS-2005）', async () => {
    const registry = makeRegistry(failingDispatcher(new Error('boom in worker vm')));
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    const e = await captureRejection(registry.resolveCaller('doc', [])('ext.doc.parse', 'parse', null));
    expect(e.code).toBe('HARNESS-2005');
    expect(e.status).toBe(500);
    expect(e.message).toBe('boom in worker vm'); // 服务端定位信息保留
  });

  it('dispatcher 抛 HarnessError → 原样透传（不二次包装）', async () => {
    const original = new HarnessError('RPC_HANDLER_ERROR', { detail: { vm: 'doc' } });
    const registry = makeRegistry(failingDispatcher(original));
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    const e = await captureRejection(registry.resolveCaller('doc', [])('ext.doc.parse', 'parse', null));
    expect(e).toBe(original);
  });

  it('构造参数非法（timeoutMs 非正 / dispatcher 缺 callService）→ INTERNAL fail-fast', () => {
    expect(() => makeRegistry(new DispatcherStub(), 0)).toThrowError(HarnessError);
    expect(() => makeRegistry(new DispatcherStub(), -1)).toThrowError(HarnessError);
    expect(() => new ExtensionServiceRegistry({ dispatcher: {} as ExtCallDispatcher })).toThrowError(HarnessError);
  });
});

// ---------------------------------------------------------------------------
// 权限门
// ---------------------------------------------------------------------------

describe('权限门', () => {
  it('无 rpc:call 权限 → RPC_PERMISSION_DENIED（403 HARNESS-2003，detail.target），不触达 dispatcher', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const call = registry.resolveCaller('caller', []);
    const e = await captureRejection(call('ext.doc.parse', 'parse', null));
    expect(e.code).toBe('HARNESS-2003');
    expect(e.status).toBe(403);
    expect(e.retryable).toBe(false);
    expect(e.detail).toEqual({ target: 'ext.doc.parse' });
    expect(dispatcher.calls).toEqual([]);
  });

  it("'rpc:call:<target>' 定向放行该 target；其他 target 仍 403", async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const call = registry.resolveCaller('caller', ['rpc:call:doc']);
    await expect(call('ext.doc.parse', 'parse', null)).resolves.toEqual({ ok: true, method: 'parse' });
    const e = await captureRejection(call('ext.hello.greet', 'greet', null));
    expect(e.code).toBe('HARNESS-2003');
  });

  it("'rpc:call' 全量放行任意 target", async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const call = registry.resolveCaller('caller', ['something-else', 'rpc:call']);
    await expect(call('ext.doc.parse', 'parse', null)).resolves.toEqual({ ok: true, method: 'parse' });
    await expect(call('ext.hello.greet', 'greet', null)).resolves.toEqual({ ok: true, method: 'greet' });
  });

  it('自调用豁免（契约）：caller === targetExtId 无需任何权限即可调用自己暴露的服务', async () => {
    const dispatcher = new DispatcherStub();
    const registry = seedRegistry(dispatcher);
    const selfCall = registry.resolveCaller('doc', []); // 空 permissions
    await expect(selfCall('ext.doc.parse', 'parse', { q: 1 })).resolves.toEqual({ ok: true, method: 'parse' });
    // 豁免仅限自身：自调用者调别人的服务仍要权限
    const e = await captureRejection(selfCall('ext.hello.greet', 'greet', null));
    expect(e.code).toBe('HARNESS-2003');
  });

  it('自调用豁免不免除目标状态：目标 suspended 时自调用同样 SERVICE_UNAVAILABLE', async () => {
    const registry = seedRegistry(new DispatcherStub());
    registry.suspend('doc');
    const selfCall = registry.resolveCaller('doc', []);
    const e = await captureRejection(selfCall('ext.doc.parse', 'parse', null));
    expect(e.code).toBe('HARNESS-1003');
  });
});

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

describe('超时（破坏性路径显式用例）', () => {
  it('dispatcher 永挂 → RPC_TIMEOUT（504 HARNESS-2001），不悬挂', async () => {
    const dispatcher = hangingDispatcher();
    const registry = makeRegistry(dispatcher, 20);
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);

    const startedAt = Date.now();
    const e = await captureRejection(
      registry.resolveCaller('caller', ['rpc:call'])('ext.doc.parse', 'parse', { big: true }),
    );
    expect(e.code).toBe('HARNESS-2001');
    expect(e.status).toBe(504);
    expect(e.retryable).toBe(true);
    expect(e.detail).toEqual({ service: 'ext.doc.parse', method: 'parse', timeoutMs: 20 });
    expect(Date.now() - startedAt).toBeLessThan(2000); // fail-fast，不悬挂
    expect(dispatcher.calls).toHaveLength(1); // 调用已发出，只是未按时返回
  });

  it('正常返回不受超时竞速影响（定时器被清理，无泄漏）', async () => {
    const dispatcher = new DispatcherStub();
    const registry = makeRegistry(dispatcher, 50);
    registry.register('doc', [{ name: 'parse', methods: ['parse'] }]);
    const call = registry.resolveCaller('doc', ['rpc:call']);
    for (let i = 0; i < 5; i += 1) {
      await expect(call('ext.doc.parse', 'parse', { i })).resolves.toEqual({ ok: true, method: 'parse' });
    }
  });
});

/** 同步版 HarnessError 捕获（register 为同步 API） */
function captureRejectionSync(fn: () => void): HarnessError {
  try {
    fn();
  } catch (e) {
    return e as HarnessError;
  }
  throw new Error('expected fn to throw');
}
