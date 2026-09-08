/**
 * Facades 单测。
 *
 * 构造真 Kernel（不 boot：不启动 HTTP、不开数据库），手工向容器登记三个最小 stub
 * （满足 EventBus / HookManager / CronScheduler 契约形状），验证门面的转发与错误语义：
 * - 未绑定 getFacadeKernel 抛 INTERNAL（message 指引 bindFacadeKernel）
 * - 重复绑定 process.emitWarning 一次并覆盖
 * - Config/Log/Event/Hook/Cron 全部延迟 resolve、按契约转发
 * - 服务未登记统一抛 KERNEL_NOT_READY（detail.service = key）
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { loadConfig } from '../src/kernel/config/index.js';
import type { HarnessConfig } from '../src/kernel/config/index.js';
import { Kernel } from '../src/kernel/Kernel.js';
import { HarnessError } from '../src/kernel/errors/HarnessError.js';
import {
  App,
  Config,
  Cron,
  Event,
  Hook,
  Log,
  bindFacadeKernel,
  getFacadeKernel,
  FACADE_CONTAINER_KEYS,
} from '../src/kernel/Facades.js';

// ---------------------------------------------------------------------------
// stubs：最小契约对象（vi.fn 自动记录调用，供转发断言）
// ---------------------------------------------------------------------------

function makeEventBusStub() {
  return {
    on: vi.fn((_pattern: string, _handler: unknown, _opts?: unknown) => () => {}),
    once: vi.fn((_pattern: string, _handler: unknown, _opts?: unknown) => () => {}),
    off: vi.fn((_pattern: string, _handler: unknown) => {}),
    emit: vi.fn(async (_name: string, _payload: unknown, _opts?: unknown) => ({ delivered: 1, errors: [] })),
    listenerCount: vi.fn((_pattern?: string) => 0),
  };
}

function makeHookStub() {
  return {
    add: vi.fn((_name: string, _handler: unknown, _opts?: unknown) => () => {}),
    remove: vi.fn((_name: string, _handler: unknown) => {}),
    apply: vi.fn(async (_name: string, value: unknown, _ctx?: unknown) => ({ handled: value })),
    has: vi.fn((_name: string) => false),
    handlerCount: vi.fn((_name?: string) => 0),
  };
}

/** 满足 Cron 契约返回形状的最小任务记录 */
const cronRecord = Object.freeze({
  id: 'cron-1',
  extId: null,
  name: 'tick',
  expr: '* * * * *',
  tz: 'UTC',
  payload: null,
  enabled: true,
  overlap: false,
});

function makeCronStub() {
  return {
    schedule: vi.fn(async (input: Record<string, unknown>) => ({ ...cronRecord, ...input })),
    unschedule: vi.fn(async (_id: string) => true),
    setEnabled: vi.fn(async (id: string, enabled: boolean) => ({ ...cronRecord, id, enabled })),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ ...cronRecord, id, ...patch })),
    list: vi.fn((_opts?: { extId?: string }) => [cronRecord]),
    get: vi.fn((id: string) => (id === cronRecord.id ? cronRecord : null)),
    runNow: vi.fn(async (_id: string) => {}),
  };
}

type EventBusStub = ReturnType<typeof makeEventBusStub>;
type HookStub = ReturnType<typeof makeHookStub>;
type CronStub = ReturnType<typeof makeCronStub>;

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

let TEST_DATA_DIR = './data';
let kernel: Kernel;
let eventBusStub: EventBusStub;
let hookStub: HookStub;
let cronStub: CronStub;
let emitWarningSpy: MockInstance;

/** 构造内核配置（真实 loadConfig 校验链）；额外挂一层嵌套对象用于点号路径取值断言 */
function makeConfig(): HarnessConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      HARNESS_DATA_DIR: TEST_DATA_DIR,
      HARNESS_PERSIST_ROOT_TOKEN: '0',
    }),
    port: 3457,
    logLevel: 'silent', // 静音：测试不关心日志输出（spy 仍会记录调用）
    // 模拟嵌套配置段：configGet 点号遍历的真实命中路径（HarnessConfig 本体是平的）
    features: { limits: { max: 7 }, enabled: true },
  } as HarnessConfig;
}

/**
 * 创建内核 + 登记三个 stub 服务 + 绑定门面。
 * 刻意不在 beforeEach 里绑定：让"未绑定抛错"用例能观察初始状态。
 */
function bindTestKernel(): Kernel {
  const k = new Kernel({ config: makeConfig() });
  eventBusStub = makeEventBusStub();
  hookStub = makeHookStub();
  cronStub = makeCronStub();
  k.container.instance(FACADE_CONTAINER_KEYS.eventBus, eventBusStub);
  k.container.instance(FACADE_CONTAINER_KEYS.hookManager, hookStub);
  k.container.instance(FACADE_CONTAINER_KEYS.cronScheduler, cronStub);
  bindFacadeKernel(k);
  kernel = k; // 供"未登记→KERNEL_NOT_READY"类用例对容器做 forget/重登记
  return k;
}

beforeEach(async () => {
  TEST_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'harness-facades-'));
  // 静音重复绑定警告（真实断言在 rebind 用例中做）
  emitWarningSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function expectHarnessError(fn: () => unknown, code: string, detail?: unknown): HarnessError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(HarnessError);
  const e = caught as HarnessError;
  expect(e.code).toBe(code);
  if (detail !== undefined) expect(e.detail).toEqual(detail);
  return e;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('facades kernel binding', () => {
  it('未绑定时（模块隔离）getFacadeKernel 抛 INTERNAL，message 指引 bindFacadeKernel', async () => {
    vi.resetModules();
    const freshFacades = await import('../src/kernel/Facades.js');
    const freshErrors = await import('../src/kernel/errors/HarnessError.js');
    let caught: unknown;
    try {
      freshFacades.getFacadeKernel();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(freshErrors.HarnessError);
    const e = caught as InstanceType<typeof freshErrors.HarnessError>;
    expect(e.message).toBe('[facades] kernel not bound; call bindFacadeKernel(kernel) at boot');
    expect(() => freshFacades.App.has('config')).toThrow(freshErrors.HarnessError);
  });

  it('重复绑定 emitWarning 一次并覆盖为新内核', () => {
    // 预热绑定（Kernel 构造即绑定门面；进入本用例时进程内已有绑定，状态未知）
    bindTestKernel();
    emitWarningSpy.mockClear();
    const first = getFacadeKernel();
    expect(emitWarningSpy).not.toHaveBeenCalled(); // 稳定态不再告警

    // 注意：new Kernel() 构造本身就会绑定门面（内核集成语义），随后显式 bind 再覆盖一次
    const second = new Kernel({ config: makeConfig() });
    bindFacadeKernel(second);
    expect(emitWarningSpy).toHaveBeenCalledTimes(2); // 每次重绑恰好各警告一次
    expect(emitWarningSpy.mock.calls.at(-1)?.[0]).toContain('already bound');
    expect(getFacadeKernel()).toBe(second); // 覆盖语义：门面跟随最新内核
    expect(App.container).toBe(second.container);
    void first;
  });
});

describe('App facade', () => {
  it('resolve 未知 key 抛 KERNEL_NOT_READY，detail.service = key', () => {
    bindTestKernel();
    const e = expectHarnessError(() => App.resolve('no.such.service'), 'HARNESS-9001', {
      service: 'no.such.service',
    });
    expect(e.message).toContain('no.such.service');
    expect(e.retryable).toBe(true);
  });

  it('resolve/has/container 转发当前内核容器', () => {
    const k = bindTestKernel();
    expect(App.has('config')).toBe(true);
    expect(App.has('nope')).toBe(false);
    expect(App.resolve<HarnessConfig>('config')).toBe(k.config);
    expect(App.container).toBe(k.container);
  });
});

describe('Config facade', () => {
  it('点号路径命中与 fallback 兜底', () => {
    const k = bindTestKernel();
    expect(Config.get('port')).toBe(3457);
    expect(Config.get('dataDir')).toBe(k.config.dataDir);
    expect(Config.get<number>('features.limits.max')).toBe(7); // 点号嵌套命中
    expect(Config.get('features.enabled')).toBe(true);
    expect(Config.get('missing.path', 'fb')).toBe('fb'); // 断链路径回退 fallback
    expect(Config.get('missing.path')).toBeUndefined(); // 未给 fallback 则 undefined
  });
});

describe('Log facade', () => {
  it('child 返回带 scope 绑定的 pino child logger', () => {
    bindTestKernel();
    const child = Log.child('facades-test');
    expect((child.bindings() as { scope?: string }).scope).toBe('facades-test');
  });

  it('debug/info/warn/error 转发 kernel.logger（msg 与 obj 顺序正确）', () => {
    const k = bindTestKernel();
    const debugSpy = vi.spyOn(k.logger, 'debug');
    const infoSpy = vi.spyOn(k.logger, 'info');
    const warnSpy = vi.spyOn(k.logger, 'warn');
    const errorSpy = vi.spyOn(k.logger, 'error');

    Log.debug('debug-msg', { a: 1 });
    Log.info('info-msg');
    Log.warn('warn-msg', { b: 2 });
    Log.error('error-msg');

    expect(debugSpy).toHaveBeenCalledWith({ a: 1 }, 'debug-msg');
    expect(infoSpy).toHaveBeenCalledWith('info-msg');
    expect(warnSpy).toHaveBeenCalledWith({ b: 2 }, 'warn-msg');
    expect(errorSpy).toHaveBeenCalledWith('error-msg');
  });
});

describe('Event facade', () => {
  it('emit/on/once/off/listenerCount 转发到容器内 eventBus（记录调用）', async () => {
    bindTestKernel();
    const handler = () => {};

    const off = Event.on('user.*', handler, { once: false });
    expect(typeof off).toBe('function');
    expect(eventBusStub.on).toHaveBeenCalledWith('user.*', handler, { once: false });

    Event.once('user.created', handler);
    expect(eventBusStub.once).toHaveBeenCalledWith('user.created', handler, undefined);

    Event.off('user.*', handler);
    expect(eventBusStub.off).toHaveBeenCalledWith('user.*', handler);

    const result = await Event.emit('user.created', { id: 1 }, { async: true });
    expect(eventBusStub.emit).toHaveBeenCalledWith('user.created', { id: 1 }, { async: true });
    expect(result).toEqual({ delivered: 1, errors: [] });

    expect(Event.listenerCount('user.*')).toBe(0);
    expect(eventBusStub.listenerCount).toHaveBeenCalledWith('user.*');
  });

  it('events.bus 未登记抛 KERNEL_NOT_READY；登记后（延迟 resolve）立即恢复', async () => {
    bindTestKernel();
    kernel.container.forget(FACADE_CONTAINER_KEYS.eventBus);

    const e = expectHarnessError(() => Event.on('a', () => {}), 'HARNESS-9001', {
      service: FACADE_CONTAINER_KEYS.eventBus,
    });
    expect(e.message).toContain('events.bus');
    await expect(Event.emit('a', {})).rejects.toMatchObject({ code: 'HARNESS-9001' });

    // 延迟 resolve 契约：服务事后登记即可用，无需重新绑定/重新 import
    kernel.container.instance(FACADE_CONTAINER_KEYS.eventBus, eventBusStub);
    await expect(Event.emit('a', { ok: true })).resolves.toEqual({ delivered: 1, errors: [] });
  });
});

describe('Hook facade', () => {
  it('apply 转发并返回管道值；add/remove/has/handlerCount 转发', async () => {
    bindTestKernel();
    const handler = (value: unknown) => value;

    const off = Hook.add('user.created', handler, { priority: 1 });
    expect(typeof off).toBe('function');
    expect(hookStub.add).toHaveBeenCalledWith('user.created', handler, { priority: 1 });

    Hook.remove('user.created', handler);
    expect(hookStub.remove).toHaveBeenCalledWith('user.created', handler);

    const result = await Hook.apply<{ handled: unknown }>('user.created', 'v', { traceId: 't1' });
    expect(hookStub.apply).toHaveBeenCalledWith('user.created', 'v', { traceId: 't1' });
    expect(result).toEqual({ handled: 'v' });

    expect(Hook.has('user.created')).toBe(false);
    expect(hookStub.has).toHaveBeenCalledWith('user.created');
    expect(Hook.handlerCount('user.created')).toBe(0);
    expect(hookStub.handlerCount).toHaveBeenCalledWith('user.created');
  });

  it('hooks.manager 未登记抛 KERNEL_NOT_READY', async () => {
    bindTestKernel();
    kernel.container.forget(FACADE_CONTAINER_KEYS.hookManager);
    expectHarnessError(() => Hook.has('any'), 'HARNESS-9001', { service: FACADE_CONTAINER_KEYS.hookManager });
    // apply 是 async 门面：服务缺失以 rejected promise 表达（不同步抛），可安全 .catch
    await expect(Hook.apply('any', null)).rejects.toMatchObject({ code: 'HARNESS-9001' });
  });
});

describe('Cron facade', () => {
  it('schedule 转发并返回 stub 记录；enable/disable 转发 setEnabled', async () => {
    bindTestKernel();

    const rec = await Cron.schedule({ name: 'tick', expr: '* * * * *', tz: 'UTC', enabled: true });
    expect(cronStub.schedule).toHaveBeenCalledWith({ name: 'tick', expr: '* * * * *', tz: 'UTC', enabled: true });
    expect(rec).toMatchObject({ id: 'cron-1', name: 'tick', expr: '* * * * *' });

    await Cron.enable('cron-1');
    expect(cronStub.setEnabled).toHaveBeenCalledWith('cron-1', true);

    await Cron.disable('cron-1');
    expect(cronStub.setEnabled).toHaveBeenLastCalledWith('cron-1', false);

    const disabled = await Cron.disable('cron-1');
    expect(disabled).toMatchObject({ id: 'cron-1', enabled: false });
  });

  it('update/list/get/runNow/unschedule 转发', async () => {
    bindTestKernel();

    await Cron.update('cron-1', { expr: '0 4 * * *' });
    expect(cronStub.update).toHaveBeenCalledWith('cron-1', { expr: '0 4 * * *' });

    expect(Cron.list()).toEqual([cronRecord]);
    expect(Cron.list({ extId: 'ext-a' })).toEqual([cronRecord]);
    expect(cronStub.list).toHaveBeenLastCalledWith({ extId: 'ext-a' });

    expect(Cron.get('cron-1')).toEqual(cronRecord);
    expect(Cron.get('missing')).toBeNull();

    await Cron.runNow('cron-1');
    expect(cronStub.runNow).toHaveBeenCalledWith('cron-1');

    await expect(Cron.unschedule('cron-1')).resolves.toBe(true);
    expect(cronStub.unschedule).toHaveBeenCalledWith('cron-1');
  });

  it('cron.scheduler 未登记抛 KERNEL_NOT_READY', () => {
    bindTestKernel();
    kernel.container.forget(FACADE_CONTAINER_KEYS.cronScheduler);
    expectHarnessError(() => Cron.list(), 'HARNESS-9001', { service: FACADE_CONTAINER_KEYS.cronScheduler });
    expect(() => Cron.get('cron-1')).toThrow(HarnessError);
  });
});
