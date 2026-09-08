import { describe, expect, it, vi } from 'vitest';
import { Container } from '../src/kernel/Container.js';
import { ServiceProvider } from '../src/kernel/ServiceProvider.js';
import { HarnessError } from '../src/kernel/errors/index.js';

/** 断言 fn 抛出 HarnessError 并返回该错误（供逐条 message 断言复用）。 */
function expectHarnessError(fn: () => unknown): HarnessError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    return e as HarnessError;
  }
  expect.unreachable('expected fn to throw a HarnessError');
}

describe('Container: bind（瞬态）', () => {
  it('bind 每次返回新实例', () => {
    const c = new Container();
    let n = 0;
    c.bind('svc', () => ({ id: ++n }));

    const a = c.resolve<{ id: number }>('svc');
    const b = c.resolve<{ id: number }>('svc');

    expect(a).not.toBe(b);
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });
});

describe('Container: singleton', () => {
  it('缓存同一实例，工厂只调用一次', () => {
    const c = new Container();
    const factory = vi.fn(() => ({ id: 1 }));
    c.singleton('svc', factory);

    const a = c.resolve('svc');
    const b = c.resolve('svc');

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('工厂抛错不缓存失败结果，且解析栈不残留', () => {
    const c = new Container();
    let attempts = 0;
    c.singleton('flaky', () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return { ok: true };
    });

    expect(() => c.resolve('flaky')).toThrow('boom');
    // 失败未缓存：再次解析重新调用工厂并成功
    expect(c.resolve('flaky')).toEqual({ ok: true });
    // 栈未残留：后续自引用类环检测仍然正确
    expect(c.has('flaky')).toBe(true);
  });
});

describe('Container: instance', () => {
  it('直取登记的原始值（引用相等）', () => {
    const c = new Container();
    const config = { port: 3000 };
    c.instance('config', config);

    expect(c.resolve('config')).toBe(config);
    expect(c.has('config')).toBe(true);
  });
});

describe('Container: alias', () => {
  it('链式跟随：resolve(a) 委托到真实绑定', () => {
    const c = new Container();
    const svc = { ready: true };
    c.singleton('real', () => svc);
    c.alias('mid', 'real');
    c.alias('top', 'mid');

    expect(c.resolve('top')).toBe(svc);
    expect(c.resolve('mid')).toBe(svc);
    expect(c.has('top')).toBe(true);
  });

  it('别名解析结果与单例缓存一致（同一实例）', () => {
    const c = new Container();
    c.singleton('real', () => ({}));
    c.alias('a', 'real');

    const viaReal = c.resolve('real');
    const viaAlias = c.resolve('a');
    expect(viaAlias).toBe(viaReal);
  });

  it('环检测：alias 登记即抛错并回滚', () => {
    const c = new Container();
    c.alias('a', 'b');

    const e = expectHarnessError(() => c.alias('b', 'a'));
    expect(e.message).toContain('circular alias');
    // 回滚：环登记未生效，b 仍可正常注册
    c.bind('b', () => 'ok');
    expect(c.resolve('a')).toBe('ok');
  });

  it('自别名（from === to）直接抛错', () => {
    const c = new Container();
    expectHarnessError(() => c.alias('x', 'x'));
  });

  it('别名链最大深度 10：10 跳可用，11 跳报错', () => {
    const c = new Container();
    c.bind('target', () => 'ok');
    // a1 -> a2 -> ... -> a10 -> target，共 10 跳别名
    for (let i = 1; i <= 10; i++) {
      c.alias(`a${i}`, i === 10 ? 'target' : `a${i + 1}`);
    }
    expect(c.resolve('a1')).toBe('ok');

    // 第 11 跳：登记 a0 -> a1 时 fail-fast，且 a0 登记被回滚
    const e = expectHarnessError(() => c.alias('a0', 'a1'));
    expect(e.message).toContain('alias chain too deep');
    expect(c.has('a0')).toBe(false);
  });
});

describe('Container: resolve 未知 key', () => {
  it('抛 INTERNAL 且 message 含 key 名', () => {
    const c = new Container();
    const e = expectHarnessError(() => c.resolve('no.such.service'));
    expect(e.message).toContain('not registered');
    expect(e.message).toContain('no.such.service');
    expect(e.code).toMatch(/^HARNESS-/);
  });

  it('别名指向未注册目标：报错含原始 key 名', () => {
    const c = new Container();
    c.alias('ghost', 'missing.target');
    const e = expectHarnessError(() => c.resolve('ghost'));
    expect(e.message).toContain('ghost');
    expect(e.message).toContain('not registered');
  });
});

describe('Container: forget', () => {
  it('forget 清单例缓存，重新注册后生效', () => {
    const c = new Container();
    c.singleton('svc', () => ({ v: 1 }));
    expect(c.resolve('svc').v).toBe(1);
    expect(c.has('svc')).toBe(true);

    c.forget('svc');
    expect(c.has('svc')).toBe(false);

    c.singleton('svc', () => ({ v: 2 }));
    expect(c.resolve('svc').v).toBe(2);
  });

  it('forget 同样清除 instance 与 alias 登记', () => {
    const c = new Container();
    const val = { n: 1 };
    c.instance('inst', val);
    c.alias('nick', 'inst');
    expect(c.resolve('nick')).toBe(val);

    c.forget('inst');
    expect(c.has('inst')).toBe(false);
    expectHarnessError(() => c.resolve('inst'));

    c.forget('nick');
    expect(c.has('nick')).toBe(false);
  });
});

describe('Container: 循环依赖检测', () => {
  it('a -> b -> a：message 含完整链路', () => {
    const c = new Container();
    c.singleton('a', (cc) => ({ b: cc.resolve('b') }));
    c.singleton('b', (cc) => ({ a: cc.resolve('a') }));

    const e = expectHarnessError(() => c.resolve('a'));
    expect(e.message).toContain('circular dependency');
    expect(e.message).toContain('a -> b -> a');
  });

  it('自引用依赖：message 含 x -> x', () => {
    const c = new Container();
    c.bind('x', (cc) => ({ self: cc.resolve('x') }));

    const e = expectHarnessError(() => c.resolve('x'));
    expect(e.message).toContain('circular dependency');
    expect(e.message).toContain('x -> x');
  });

  it('循环依赖经过别名同样被检测', () => {
    const c = new Container();
    c.singleton('p', (cc) => ({ q: cc.resolve('q') }));
    c.singleton('q', (cc) => ({ p: cc.resolve('alias-p') }));
    c.alias('alias-p', 'p');

    const e = expectHarnessError(() => c.resolve('p'));
    expect(e.message).toContain('circular dependency');
  });
});

describe('ServiceProvider', () => {
  class RepoProvider extends ServiceProvider {
    booted = false;
    stopped = false;
    register(c: Container): void {
      c.singleton('repo', () => ({ find: () => 'row' }));
    }
    override async boot(): Promise<void> {
      this.booted = true;
    }
    override async stop(): Promise<void> {
      this.stopped = true;
    }
  }

  it('register 登记绑定，boot/stop 生命周期可覆写', async () => {
    const c = new Container();
    const p = new RepoProvider();

    await p.register(c);
    expect(c.resolve('repo').find()).toBe('row');

    await p.boot(c);
    expect(p.booted).toBe(true);

    await p.stop(c);
    expect(p.stopped).toBe(true);
  });

  it('boot/stop 默认空实现可直接调用', async () => {
    class PlainProvider extends ServiceProvider {
      register(): void {}
    }
    const c = new Container();
    const p = new PlainProvider();
    await expect(p.boot(c)).resolves.toBeUndefined();
    await expect(p.stop(c)).resolves.toBeUndefined();
  });
});
