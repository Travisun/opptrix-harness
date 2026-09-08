import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  EVENT_NS,
  HOOK_POINTS,
  HookAbort,
  HookManager,
  type HookContext,
} from '../src/kernel/hooks/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('HookManager.apply — filter 链语义', () => {
  it('无 handler：apply 原值返回，has 为 false', async () => {
    const hm = new HookManager();
    expect(hm.has('nobody')).toBe(false);
    expect(await hm.apply('nobody', 'untouched')).toBe('untouched');
    expect(await hm.apply('nobody', 42)).toBe(42);
  });

  it('单 handler 同步改写值', async () => {
    const hm = new HookManager();
    hm.add(HOOK_POINTS.chatBeforeSend, (v: string) => v.trim());
    expect(await hm.apply(HOOK_POINTS.chatBeforeSend, '  hi  ')).toBe('hi');
  });

  it('priority 降序执行：10 → 5 → 0 → -1，逐层传递返回值', async () => {
    const hm = new HookManager();
    const order: number[] = [];
    hm.add('p', (v: string) => { order.push(10); return `${v}A`; }, { priority: 10 });
    hm.add('p', (v: string) => { order.push(-1); return `${v}D`; }, { priority: -1 });
    hm.add('p', (v: string) => { order.push(0); return `${v}C`; }, { priority: 0 });
    hm.add('p', (v: string) => { order.push(5); return `${v}B`; }, { priority: 5 });

    const out = await hm.apply('p', '');
    expect(order).toEqual([10, 5, 0, -1]);
    expect(out).toBe('ABCD');
  });

  it('priority 相同按添加顺序执行（默认 priority=0 亦然）', async () => {
    const hm = new HookManager();
    const order: string[] = [];
    hm.add('tie', (v: string) => { order.push('first'); return `${v}1`; });
    hm.add('tie', (v: string) => { order.push('second'); return `${v}2`; });
    hm.add('tie', (v: string) => { order.push('third'); return `${v}3`; }, { priority: 0 });

    const out = await hm.apply('tie', '');
    expect(order).toEqual(['first', 'second', 'third']);
    expect(out).toBe('123');
  });

  it('handler 返回 undefined 时保值（防御性），falsy 但非 undefined 的值正常生效', async () => {
    const hm = new HookManager();
    // 层1 返回 undefined → 初始值保值；层2 返回 0（falsy）必须生效；层3 返回 undefined → 保住 0
    hm.add('u', () => undefined, { priority: 10 });
    hm.add('u', () => 0, { priority: 5 });
    hm.add('u', () => undefined, { priority: 0 });
    expect(await hm.apply('u', 1)).toBe(0);

    const hm2 = new HookManager();
    hm2.add('u2', async () => undefined, { priority: 10 }); // async 返回 Promise<undefined> 同样保值
    hm2.add('u2', (v: string) => `${v}!`, { priority: 0 });
    expect(await hm2.apply('u2', 'base')).toBe('base!');
  });

  it('async handler 按序 await：高优先级完成后低优先级才拿到其结果', async () => {
    const hm = new HookManager();
    const events: string[] = [];
    hm.add('seq', async (v: number) => {
      await sleep(25);
      events.push('hi-done');
      return v + 1;
    }, { priority: 10 });
    hm.add('seq', async (v: number) => {
      events.push('lo-called'); // 若未 await 上层，此条会先于 hi-done 出现
      return v * 100;
    }, { priority: 0 });

    const out = await hm.apply('seq', 1);
    expect(events).toEqual(['hi-done', 'lo-called']);
    expect(out).toBe(200);
  });

  it('sync 与 async 混排仍按 priority 顺序逐层 await', async () => {
    const hm = new HookManager();
    hm.add('mix', async (v: number) => { await sleep(5); return v + 1; }, { priority: 10 }); // async
    hm.add('mix', (v: number) => v * 10, { priority: 5 }); // sync
    hm.add('mix', async (v: number) => v + 100, { priority: 0 }); // async
    expect(await hm.apply('mix', 1)).toBe(120); // (1+1)*10+100
  });
});

describe('HookAbort 短路', () => {
  it('抛 HookAbort(result) → apply 返回 result，后续 handler 不执行，不抛出', async () => {
    const hm = new HookManager();
    let later = 0;
    hm.add('gate', () => { throw new HookAbort({ blocked: true }); }, { priority: 10 });
    hm.add('gate', (v: string) => { later += 1; return `${v}!`; }, { priority: 0 });

    const out = await hm.apply('gate', 'in');
    expect(out).toEqual({ blocked: true });
    expect(later).toBe(0);
  });

  it('async handler 中（rejected promise）抛 HookAbort 同样短路', async () => {
    const hm = new HookManager();
    let later = 0;
    hm.add('async-gate', async () => {
      await sleep(5);
      throw new HookAbort('short');
    }, { priority: 5 });
    hm.add('async-gate', () => { later += 1; return 'x'; }, { priority: 0 });

    expect(await hm.apply('async-gate', 'in')).toBe('short');
    expect(later).toBe(0);
  });

  it('HookAbort(undefined) → apply 返回 undefined', async () => {
    const hm = new HookManager();
    hm.add('void', () => { throw new HookAbort(undefined); });
    expect(await hm.apply('void', 'v')).toBeUndefined();
  });

  it('HookAbort 是 Error 子类（供 handler 内部 throw 使用）', () => {
    const a = new HookAbort(1);
    expect(a).toBeInstanceOf(Error);
    expect(a.name).toBe('HookAbort');
    expect(a.result).toBe(1);
  });
});

describe('异常包装（hook 是内核契约，失败即 bug）', () => {
  it('handler 抛普通异常 → HarnessError/HARNESS-9003，message 含 hook 名，cause 保留', async () => {
    const hm = new HookManager();
    const boom = new Error('boom');
    let later = 0;
    hm.add(HOOK_POINTS.fileBeforeStore, () => { throw boom; }, { priority: 10 });
    hm.add(HOOK_POINTS.fileBeforeStore, () => { later += 1; return 'x'; }, { priority: 0 });

    let caught: unknown;
    try {
      await hm.apply(HOOK_POINTS.fileBeforeStore, 'v');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HarnessError);
    const he = caught as HarnessError;
    expect(he.code).toBe('HARNESS-9003');
    expect(he.message).toBe('[hook:file.beforeStore] handler failed');
    expect(he.cause).toBe(boom);
    expect(he.status).toBe(500);
    expect(later).toBe(0); // 异常即中断，后续 handler 不执行
  });

  it('async handler 抛异常同样包装上抛', async () => {
    const hm = new HookManager();
    hm.add('async-fail', async () => { throw new Error('async boom'); });
    await expect(hm.apply('async-fail', 'v')).rejects.toThrow('[hook:async-fail] handler failed');
  });

  it('注入 logger 时短路/失败路径可用，且不影响返回值语义', async () => {
    const hm = new HookManager({ logger: pino({ level: 'silent' }) });
    hm.add('logged', () => { throw new HookAbort('ok'); }, { priority: 10 });
    hm.add('logged', () => 'never', { priority: 0 });
    await expect(hm.apply('logged', 'v')).resolves.toBe('ok');
    hm.add('logged-fail', () => { throw new Error('kaboom'); });
    await expect(hm.apply('logged-fail', 'v')).rejects.toBeInstanceOf(HarnessError);
  });
});

describe('HookContext：透传与冻结', () => {
  it('ctx.name 正确，meta 以同一引用透传，ctx 与 meta 均被冻结', async () => {
    const hm = new HookManager();
    const seen: HookContext[] = [];
    hm.add('ctx', (_v: string, ctx) => { seen.push(ctx); return undefined; }, { priority: 10 });
    hm.add('ctx', (_v: string, ctx) => { seen.push(ctx); return undefined; }, { priority: 0 });

    const meta = { traceId: 't-1', source: 'test' };
    await hm.apply('ctx', 'v', { meta });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]!.name).toBe('ctx');
    expect(seen[0]!.meta).toBe(meta); // 同一引用透传
    expect(seen[0]!.meta).toEqual({ traceId: 't-1', source: 'test' });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]!.meta && Object.isFrozen(seen[0]!.meta)).toBe(true);
    // 每个 handler 收到同一个 ctx 实例
    expect(seen[0]).toBe(seen[1]);
  });

  it('未提供 meta → ctx.meta 为 undefined；不传 ctx 参数亦可用', async () => {
    const hm = new HookManager();
    let captured: HookContext | undefined;
    hm.add('bare', (_v: string, ctx) => { captured = ctx; return undefined; });
    await hm.apply('bare', 'v');
    expect(captured).toBeDefined();
    expect(captured!.name).toBe('bare');
    expect(captured!.meta).toBeUndefined();
    expect(Object.isFrozen(captured)).toBe(true);
  });
});

describe('注册管理：has / handlerCount / clear / 取消 / remove', () => {
  it('has / handlerCount(name) / handlerCount() 总数 / clear', async () => {
    const hm = new HookManager();
    expect(hm.has('a')).toBe(false);
    expect(hm.handlerCount('a')).toBe(0);
    expect(hm.handlerCount()).toBe(0);

    hm.add('a', () => undefined);
    hm.add('a', () => undefined, { priority: 5 });
    hm.add('b', () => undefined);
    expect(hm.has('a')).toBe(true);
    expect(hm.handlerCount('a')).toBe(2);
    expect(hm.handlerCount('b')).toBe(1);
    expect(hm.handlerCount('missing')).toBe(0);
    expect(hm.handlerCount()).toBe(3);

    hm.clear();
    expect(hm.has('a')).toBe(false);
    expect(hm.has('b')).toBe(false);
    expect(hm.handlerCount()).toBe(0);
    expect(await hm.apply('a', 'v')).toBe('v'); // clear 后 apply 原值返回
  });

  it('add 返回取消函数：调用后不再执行且 has 变 false，重复调用幂等', async () => {
    const hm = new HookManager();
    let n = 0;
    const off = hm.add('k', () => { n += 1; return undefined; });
    expect(hm.has('k')).toBe(true);

    off();
    expect(hm.has('k')).toBe(false);
    off(); // 幂等，不抛错

    await hm.apply('k', 1);
    expect(n).toBe(0);
  });

  it('remove(name, handler) 按引用移除；未注册的 remove 静默', async () => {
    const hm = new HookManager();
    const handler = (v: string) => `${v}x`;
    hm.add('r', handler);
    expect(hm.handlerCount('r')).toBe(1);

    hm.remove('r', handler);
    expect(hm.has('r')).toBe(false);

    expect(() => hm.remove('r', handler)).not.toThrow(); // 已不存在，静默
    expect(() => hm.remove('never-registered', handler)).not.toThrow();
  });

  it('同名多个 handler：取消函数只摘除自己那一条', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    const offA = hm.add('multi', () => { calls.push('a'); return undefined; }, { priority: 10 });
    hm.add('multi', () => { calls.push('b'); return undefined; }, { priority: 0 });

    offA();
    await hm.apply('multi', 'v');
    expect(calls).toEqual(['b']);
    expect(hm.handlerCount('multi')).toBe(1);
  });
});

describe('快照语义', () => {
  it('apply 进行中 remove 尚未执行的 handler 不影响本次链，只影响下一次', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    const offC = hm.add('snap', () => { calls.push('c'); return undefined; }, { priority: 0 });
    hm.add('snap', () => { calls.push('b'); offC(); return undefined; }, { priority: 10 });

    await hm.apply('snap', 'x');
    expect(calls).toEqual(['b', 'c']); // c 仍在本次快照中执行

    calls.length = 0;
    await hm.apply('snap', 'x');
    expect(calls).toEqual(['b']); // 下一次起 c 已移除
  });
});

describe('HOOK_POINTS / EVENT_NS 常量（单一事实来源）', () => {
  it('埋点常量与约定的 <domain>.<event> 字符串一致', () => {
    expect(HOOK_POINTS.kernelBoot).toBe('kernel.boot');
    expect(HOOK_POINTS.kernelReady).toBe('kernel.ready');
    expect(HOOK_POINTS.kernelShutdown).toBe('kernel.shutdown');
    expect(HOOK_POINTS.httpBeforeRoute).toBe('http.beforeRoute');
    expect(HOOK_POINTS.httpAfterRoute).toBe('http.afterRoute');
    expect(HOOK_POINTS.chatBeforeSend).toBe('chat.beforeSend');
    expect(HOOK_POINTS.fileBeforeStore).toBe('file.beforeStore');
    expect(HOOK_POINTS.fileAfterStore).toBe('file.afterStore');
    expect(HOOK_POINTS.taskBeforeRun).toBe('task.beforeRun');
    expect(HOOK_POINTS.taskAfterRun).toBe('task.afterRun');
    expect(HOOK_POINTS.taskOnError).toBe('task.onError');
    expect(HOOK_POINTS.cronBeforeRun).toBe('cron.beforeRun');
    expect(HOOK_POINTS.cronAfterRun).toBe('cron.afterRun');
    expect(HOOK_POINTS.cronOnError).toBe('cron.onError');
    expect(HOOK_POINTS.extensionInstalling).toBe('extension.installing');
    expect(HOOK_POINTS.extensionInstalled).toBe('extension.installed');
    expect(HOOK_POINTS.extensionBeforeDisable).toBe('extension.beforeDisable');
    expect(HOOK_POINTS.extensionDisabled).toBe('extension.disabled');
    expect(HOOK_POINTS.extensionEnabled).toBe('extension.enabled');
    expect(HOOK_POINTS.extensionUninstalled).toBe('extension.uninstalled');
  });

  it('全部埋点值形如 domain.event 且互不重复', () => {
    const values = Object.values(HOOK_POINTS);
    expect(values.length).toBe(21); // 20 既有埋点 + notificationBeforeSend 收编（HOOK_POINTS 单一事实来源）
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
  });

  it('EVENT_NS 基础命名空间与 ext(id) 前缀生成', () => {
    expect(EVENT_NS.kernel).toBe('kernel');
    expect(EVENT_NS.file).toBe('file');
    expect(EVENT_NS.task).toBe('task');
    expect(EVENT_NS.chat).toBe('chat');
    expect(EVENT_NS.ext('auth')).toBe('ext.auth');
    expect(EVENT_NS.ext('hello-world')).toBe('ext.hello-world');
  });
});
