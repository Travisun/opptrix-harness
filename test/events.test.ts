import { afterEach, describe, expect, it, vi } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  EventBus,
  type EventMeta,
  type EventHandler,
} from '../src/kernel/events/index.js';

/** 屏蔽 process.emitWarning 并记录调用（超限告警用例用） */
function spyEmitWarning() {
  return vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventBus 匹配语义', () => {
  it('精确投递：同名 pattern 命中一次，payload 原样透传', async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('chat.message.created', (p) => {
      seen.push(p);
    });
    const r = await bus.emit('chat.message.created', { id: 1 });
    expect(seen).toEqual([{ id: 1 }]);
    expect(r.delivered).toBe(1);
    expect(r.errors).toEqual([]);
  });

  it("'*' 匹配任意单段：段数一致才命中", async () => {
    const bus = new EventBus();
    let n = 0;
    bus.on('chat.*', () => {
      n++;
    });
    expect((await bus.emit('chat.message')).delivered).toBe(1);
    expect((await bus.emit('chat.message.created')).delivered).toBe(0); // 3 段 vs 2 段
    expect((await bus.emit('chat')).delivered).toBe(0); // 1 段 vs 2 段
    expect((await bus.emit('other.message')).delivered).toBe(0); // 字面不符
    expect(n).toBe(1);
  });

  it("'**'（末段）匹配剩余全部段，含 0 段（glob/MQTT 语义）", async () => {
    const bus = new EventBus();
    let n = 0;
    bus.on('chat.**', () => {
      n++;
    });
    expect((await bus.emit('chat.message.created')).delivered).toBe(1);
    expect((await bus.emit('chat.a.b.c')).delivered).toBe(1);
    expect((await bus.emit('chat')).delivered).toBe(1); // 剩余 0 段也命中
    expect((await bus.emit('other')).delivered).toBe(0);
    expect(n).toBe(3);
  });

  it("裸 '**' 命中任意事件名（含任意段数）", async () => {
    const bus = new EventBus();
    let n = 0;
    bus.on('**', () => {
      n++;
    });
    expect((await bus.emit('a')).delivered).toBe(1);
    expect((await bus.emit('a.b.c.d')).delivered).toBe(1);
    expect(n).toBe(2);
  });

  it("中间位置的 '**' 按字面量处理（仅末段 ** 生效）", async () => {
    const bus = new EventBus();
    bus.on('a.**.b', () => {});
    expect((await bus.emit('a.x.b')).delivered).toBe(0);
    expect((await bus.emit('a.**.b')).delivered).toBe(1); // 字面量命中
  });

  it('段数不符不命中（无通配兜底时模式段数必须与事件名段数一致）', async () => {
    const bus = new EventBus();
    bus.on('a.b', () => {});
    expect((await bus.emit('a.b.c')).delivered).toBe(0);
    expect((await bus.emit('a')).delivered).toBe(0);
    expect((await bus.emit('a.b')).delivered).toBe(1);
  });

  it('同一事件命中多模式：每模式各投递一次，按订阅序', async () => {
    const bus = new EventBus();
    const calls: string[] = [];
    bus.on('chat.*', () => {
      calls.push('star');
    });
    bus.on('chat.**', () => {
      calls.push('doublestar');
    });
    bus.on('chat.message', () => {
      calls.push('exact');
    });
    const r = await bus.emit('chat.message');
    expect(r.delivered).toBe(3);
    expect(calls).toEqual(['star', 'doublestar', 'exact']); // 同优先级：全局订阅序
  });

  it('同一 handler 经多模式命中会被调用多次（delivered 按模式计）', async () => {
    const bus = new EventBus();
    let n = 0;
    const h: EventHandler = () => {
      n++;
    };
    bus.on('x.*', h);
    bus.on('x.**', h);
    const r = await bus.emit('x.y');
    expect(n).toBe(2);
    expect(r.delivered).toBe(2);
  });
});

describe('EventBus 投递顺序', () => {
  it('priority 降序投递（默认 0）', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('e', () => order.push('default'));
    bus.on('e', () => order.push('high'), { priority: 5 });
    bus.on('e', () => order.push('low'), { priority: -1 });
    bus.on('e', () => order.push('higher'), { priority: 10 });
    await bus.emit('e');
    expect(order).toEqual(['higher', 'high', 'default', 'low']);
  });

  it('同优先级按订阅序（含跨模式）', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('chat.**', () => order.push('doublestar-first')); // 先订阅
    bus.on('chat.*', () => order.push('star-second'), { priority: 0 });
    bus.on('chat.message', () => order.push('exact-third'));
    await bus.emit('chat.message');
    expect(order).toEqual(['doublestar-first', 'star-second', 'exact-third']);
  });

  it('async 监听器顺序 await：前一个完成才投递下一个', async () => {
    const bus = new EventBus();
    const trace: string[] = [];
    bus.on('t', async () => {
      trace.push('a:start');
      await new Promise((r) => setTimeout(r, 20));
      trace.push('a:end');
    });
    bus.on('t', async () => {
      trace.push('b:start');
      await new Promise((r) => setTimeout(r, 1));
      trace.push('b:end');
    });
    await bus.emit('t');
    // 若并行投递，b:start 会出现在 a:end 之前
    expect(trace).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});

describe('EventBus once / off / 退订', () => {
  it('once 触发后自动移除，第二次 emit 不再投递', async () => {
    const bus = new EventBus();
    let n = 0;
    bus.once('e', () => {
      n++;
    });
    expect(bus.listenerCount('e')).toBe(1);
    await bus.emit('e');
    await bus.emit('e');
    expect(n).toBe(1);
    expect(bus.listenerCount('e')).toBe(0);
  });

  it("on() + { once: true } 等价于 once()", async () => {
    const bus = new EventBus();
    let n = 0;
    bus.on('e', () => {
      n++;
    }, { once: true });
    await bus.emit('e');
    await bus.emit('e');
    expect(n).toBe(1);
    expect(bus.listenerCount('e')).toBe(0);
  });

  it('once 监听器抛错同样视为已触发并移除', async () => {
    const bus = new EventBus();
    bus.once('e', () => {
      throw new Error('once boom');
    });
    const r1 = await bus.emit('e');
    const r2 = await bus.emit('e');
    expect(r1.errors).toHaveLength(1);
    expect(r2.delivered).toBe(0);
    expect(r2.errors).toEqual([]);
  });

  it('on() 返回的取消函数生效且幂等', async () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.on('e', () => {
      n++;
    });
    off();
    off(); // 幂等
    const r = await bus.emit('e');
    expect(n).toBe(0);
    expect(r.delivered).toBe(0);
    expect(bus.listenerCount('e')).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });

  it('off(pattern, handler) 移除该 handler 在该模式下的全部订阅', async () => {
    const bus = new EventBus();
    let n = 0;
    const h: EventHandler = () => {
      n++;
    };
    bus.on('e', h);
    bus.on('e', h); // 重复订阅同一 handler
    bus.on('e', () => {
      n += 10;
    });
    bus.off('e', h);
    expect(bus.listenerCount('e')).toBe(1);
    await bus.emit('e');
    expect(n).toBe(10);
  });

  it('off 不存在的 pattern/handler 为安全 no-op', () => {
    const bus = new EventBus();
    const h: EventHandler = () => {};
    bus.on('e', h);
    expect(() => bus.off('nope', h)).not.toThrow();
    expect(() => bus.off('e', () => {})).not.toThrow();
    expect(bus.listenerCount('e')).toBe(1);
  });
});

describe('EventBus 错误隔离', () => {
  it('中间监听器抛错：前后都执行、errors 收集、emit 不 reject、delivered 含抛错者', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    const boom = new Error('listener boom');
    bus.on('e', () => order.push('before'));
    bus.on('e', () => {
      order.push('middle');
      throw boom;
    });
    bus.on('e', () => order.push('after'));
    const r = await bus.emit('e'); // 不抛出
    expect(order).toEqual(['before', 'middle', 'after']);
    expect(r.delivered).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.error).toBe(boom);
    expect(r.errors[0]?.handler).toBe('anonymous#1'); // 匿名 handler + 订阅序号
  });

  it('async 监听器 reject 同样被隔离，不中断后续投递', async () => {
    const bus = new EventBus();
    const boom = new Error('async boom');
    bus.on('e', async () => {
      throw boom;
    });
    let after = false;
    bus.on('e', () => {
      after = true;
    });
    const r = await bus.emit('e');
    expect(after).toBe(true);
    expect(r.delivered).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.error).toBe(boom);
  });

  it('错误报告用 handler.name；提供 logger 时经 logger.error 记录', async () => {
    const error = vi.fn();
    const fakeLogger = { error } as unknown as import('pino').Logger;
    const bus = new EventBus({ logger: fakeLogger });
    function myHandler(_p: unknown, _m: EventMeta): void {
      throw new Error('named boom');
    }
    bus.on('e', myHandler);
    const r = await bus.emit('e');
    expect(r.errors[0]?.handler).toBe('myHandler');
    expect(error).toHaveBeenCalledTimes(1);
    const [obj, msg] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect(obj.event).toBe('e');
    expect(obj.pattern).toBe('e');
    expect(obj.handler).toBe('myHandler');
    expect(obj.err).toBeInstanceOf(Error);
    expect(String(msg)).toContain('e');
  });

  it('匿名 handler 的错误报告名为 anonymous#<订阅序号>', async () => {
    const bus = new EventBus();
    bus.on('e', () => {}); // seq 0，不抛错
    bus.on('e', () => {
      throw new Error('boom');
    }); // seq 1
    const r = await bus.emit('e');
    expect(r.errors[0]?.handler).toBe('anonymous#1');
  });
});

describe('EventBus payload / meta 透传', () => {
  it('meta.name 与 meta.source 透传，source 默认 kernel', async () => {
    const bus = new EventBus();
    const metas: EventMeta[] = [];
    bus.on('chat.message.created', (_p, m) => {
      metas.push({ ...m });
    });
    await bus.emit('chat.message.created', { text: 'hi' });
    expect(metas).toEqual([{ name: 'chat.message.created', source: 'kernel' }]);
  });

  it('自定义 source 透传', async () => {
    const bus = new EventBus();
    const metas: EventMeta[] = [];
    bus.on('**', (_p, m) => {
      metas.push({ ...m });
    });
    await bus.emit('ext.echo.handled', null, { source: 'ext:echo' });
    expect(metas).toEqual([{ name: 'ext.echo.handled', source: 'ext:echo' }]);
  });

  it('payload 可为任意值（null / 原始值），缺省为 undefined', async () => {
    const bus = new EventBus();
    const payloads: unknown[] = [];
    bus.on('**', (p) => payloads.push(p));
    await bus.emit('a', null);
    await bus.emit('b', 42);
    await bus.emit('c');
    expect(payloads).toEqual([null, 42, undefined]);
  });
});

describe('EventBus listenerCount', () => {
  it('带参统计该 pattern（精确字符串）数量，不带参统计全部', () => {
    const bus = new EventBus();
    expect(bus.listenerCount()).toBe(0);
    const off1 = bus.on('a', () => {});
    bus.on('a', () => {});
    bus.on('b.*', () => {});
    expect(bus.listenerCount('a')).toBe(2);
    expect(bus.listenerCount('b.*')).toBe(1);
    expect(bus.listenerCount()).toBe(3);
    expect(bus.listenerCount('missing')).toBe(0);
    expect(bus.listenerCount('a.*')).toBe(0); // 精确匹配，不做通配统计
    off1();
    expect(bus.listenerCount('a')).toBe(1);
    expect(bus.listenerCount()).toBe(2);
  });
});

describe('EventBus maxListenersPerPattern', () => {
  it('超限：process.emitWarning 一次并忽略新订阅（no-op 退订函数）', async () => {
    const warn = spyEmitWarning();
    const bus = new EventBus({ maxListenersPerPattern: 2 });
    const hits: string[] = [];
    bus.on('e', () => hits.push('h1'));
    bus.on('e', () => hits.push('h2'));
    const noop = bus.on('e', () => hits.push('h3')); // 超限，被忽略
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"e"');
    expect(bus.listenerCount('e')).toBe(2);
    expect(() => noop()).not.toThrow();
    bus.on('e', () => hits.push('h4')); // 再次超限：不重复警告
    expect(warn).toHaveBeenCalledTimes(1);
    const r = await bus.emit('e');
    expect(hits).toEqual(['h1', 'h2']);
    expect(r.delivered).toBe(2);
  });

  it('不同 pattern 各自警告一次；其他 pattern 不受影响', () => {
    const warn = spyEmitWarning();
    const bus = new EventBus({ maxListenersPerPattern: 1 });
    bus.on('a', () => {});
    bus.on('a', () => {}); // a 超限 → 警告一次
    bus.on('b', () => {}); // b 正常
    bus.on('b', () => {}); // b 超限 → 再警告一次
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"a"');
    expect(String(warn.mock.calls[1]?.[0])).toContain('"b"');
    expect(bus.listenerCount('b')).toBe(1);
  });

  it('默认上限 500', () => {
    const warn = spyEmitWarning();
    const bus = new EventBus();
    const h: EventHandler = () => {};
    for (let i = 0; i < 500; i++) bus.on('e', h);
    expect(warn).not.toHaveBeenCalled();
    expect(bus.listenerCount('e')).toBe(500);
    bus.on('e', h); // 第 501 个：超限
    expect(warn).toHaveBeenCalledTimes(1);
    expect(bus.listenerCount('e')).toBe(500);
  });

  it('clear() 重置超限告警状态：同 pattern 重新订阅可再次触发一次警告', () => {
    const warn = spyEmitWarning();
    const bus = new EventBus({ maxListenersPerPattern: 1 });
    bus.on('a', () => {});
    bus.on('a', () => {}); // 警告一次
    bus.clear();
    bus.on('a', () => {});
    bus.on('a', () => {}); // 重新计数后再警告一次
    expect(warn).toHaveBeenCalledTimes(2);
    expect(bus.listenerCount('a')).toBe(1);
  });
});

describe('EventBus clear / 入参校验', () => {
  it('clear() 清空全部订阅，emit 无投递', async () => {
    const bus = new EventBus();
    let n = 0;
    const h: EventHandler = () => {
      n++;
    };
    bus.on('a', h);
    bus.on('a.b', h);
    expect(bus.listenerCount()).toBe(2);
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
    const r = await bus.emit('a');
    expect(n).toBe(0);
    expect(r.delivered).toBe(0);
    expect(r.errors).toEqual([]);
  });

  it('入参校验：空 pattern / 空分段 / 非函数 handler / 坏 name / 坏 source → HarnessError(INTERNAL)', async () => {
    const bus = new EventBus();
    expect(() => bus.on('', () => {})).toThrowError(HarnessError);
    expect(() => bus.on('a..b', () => {})).toThrowError(HarnessError);
    expect(() => bus.on('.a', () => {})).toThrowError(HarnessError);
    expect(() => bus.on('a', undefined as unknown as EventHandler)).toThrowError(HarnessError);
    // 运行时防御（TS 类型在编译期已拦截，这里验证 fail-fast 兜底）
    expect(() => bus.on(42 as unknown as string, () => {})).toThrowError(HarnessError);
    expect(() => bus.on('a', () => {}, { priority: 'high' as unknown as number })).toThrowError(HarnessError);
    expect(() => bus.off('a', 'nope' as unknown as EventHandler)).toThrowError(HarnessError);
    await expect(bus.emit('')).rejects.toBeInstanceOf(HarnessError);
    await expect(bus.emit('a..b')).rejects.toBeInstanceOf(HarnessError);
    await expect(bus.emit('ok', null, { source: '' })).rejects.toBeInstanceOf(HarnessError);
    // 错误码为 INTERNAL（HARNESS-9003），message 带 [events] 前缀
    const caught = await bus.emit('a..b').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HarnessError);
    expect((caught as HarnessError).code).toBe('HARNESS-9003');
    expect((caught as HarnessError).message).toContain('[events]');
  });
});
