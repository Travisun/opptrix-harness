import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { err, HarnessError } from '../src/kernel/errors/HarnessError.js';
import {
  ExtRouteRegistry,
  type ExtDispatchRequest,
  type ExtDispatchResult,
  type ExtRouteDispatcher,
  type ExtRouteEntry,
} from '../src/kernel/extensions/routes.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 与 src/kernel/http/server.ts 同形的错误映射（HarnessError → status/code JSON） */
function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HarnessError) {
      reply.code(error.status).send(error.toJSON());
      return;
    }
    reply.code(500).send({ code: 'HARNESS-9003', message: 'internal error' });
  });
}

interface StubDispatcherOptions {
  /** true：dispatch 返回手工释放的挂起 Promise（并发闸/超时/drain 用） */
  hang?: boolean;
}

/** dispatcher stub：记录全部调用；hang 模式下逐个释放 */
class StubDispatcher implements ExtRouteDispatcher {
  readonly calls: { routeKey: string; request: ExtDispatchRequest; timeoutMs: number }[] = [];
  private readonly gates: ((result: ExtDispatchResult) => void)[] = [];
  private readonly hang: boolean;
  impl: ((routeKey: string, request: ExtDispatchRequest, timeoutMs: number) => Promise<ExtDispatchResult>) | null =
    null;

  constructor(opts: StubDispatcherOptions = {}) {
    this.hang = opts.hang ?? false;
  }

  async dispatch(
    routeKey: string,
    request: ExtDispatchRequest,
    timeoutMs: number,
  ): Promise<ExtDispatchResult> {
    this.calls.push({ routeKey, request, timeoutMs });
    if (this.impl !== null) return this.impl(routeKey, request, timeoutMs);
    if (this.hang) {
      return new Promise<ExtDispatchResult>((resolve) => {
        this.gates.push(resolve);
      });
    }
    return { status: 200, body: { ok: true } };
  }

  /** 释放最早一个挂起的 dispatch */
  release(result: Partial<ExtDispatchResult> = {}): void {
    const resolve = this.gates.shift();
    resolve?.({ status: 200, body: { ok: true }, ...result });
  }

  releaseAll(): void {
    while (this.gates.length > 0) this.release();
  }
}

interface HarnessOptions {
  extId?: string;
  routes?: ExtRouteEntry[];
  /** checker 命中 token 时返回的身份；缺省 normal + 空 scopes */
  identity?: { userId: string; role: 'root' | 'admin' | 'normal'; scopes: string[] };
  dispatcher?: StubDispatcher;
  defaultTimeoutMs?: number;
  maxConcurrentPerExt?: number;
  isExtEnabled?: (extId: string) => boolean;
  counters?: { inc(name: string, tags?: Record<string, string>): void };
}

function buildHarness(opts: HarnessOptions = {}): {
  app: FastifyInstance;
  registry: ExtRouteRegistry;
  dispatcher: StubDispatcher;
  checkerCalls: { token?: string }[];
} {
  const app = Fastify({ logger: false });
  installErrorHandler(app);
  const dispatcher = opts.dispatcher ?? new StubDispatcher();
  const checkerCalls: { token?: string }[] = [];
  const identity = opts.identity ?? { userId: 'u1', role: 'normal', scopes: [] };
  const checker = async (input: { token?: string }) => {
    checkerCalls.push(input);
    if (input.token === undefined || input.token === '') return null;
    return identity;
  };
  const registry = new ExtRouteRegistry({
    app,
    checker,
    dispatcher,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 5_000,
    maxConcurrentPerExt: opts.maxConcurrentPerExt ?? 8,
    isExtEnabled: opts.isExtEnabled ?? (() => true),
    ...(opts.counters ? { counters: opts.counters } : {}),
  });
  if (opts.routes !== undefined) {
    registry.commit(opts.extId ?? 'demo', opts.routes);
  }
  return { app, registry, dispatcher, checkerCalls };
}

/** 快捷构造 demo 扩展的路由条目 */
function r(partial: Partial<ExtRouteEntry> & { path: string }): ExtRouteEntry {
  return { extId: 'demo', method: 'GET', auth: 'public', ...partial };
}

/** 有界轮询等待（drain/并发窗口等异步时点） */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('ExtRouteRegistry（真实 fastify + 通配兜底路由）', () => {
  it('1. 公开路由直达 dispatcher：method/params/query/headers/body/rawBody/requestId 透传', async () => {
    const { app, dispatcher } = buildHarness({
      defaultTimeoutMs: 4_321,
      routes: [r({ path: '/hello' })],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/ext/demo/hello?a=1&b=two',
      headers: { 'x-probe': 'abc' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(dispatcher.calls).toHaveLength(1);
    const call = dispatcher.calls[0]!;
    expect(call.routeKey).toBe('GET /hello');
    expect(call.timeoutMs).toBe(4_321); // defaultTimeoutMs 生效
    expect(call.request.method).toBe('GET');
    expect(call.request.params).toEqual({});
    expect(call.request.query).toEqual({ a: '1', b: 'two' });
    expect(call.request.headers['x-probe']).toBe('abc');
    expect(call.request.body).toBeNull(); // GET 不解析 body
    expect(call.request.rawBody).toBeUndefined();
    expect(typeof call.request.requestId).toBe('string');
    expect(call.request.requestId.length).toBeGreaterThan(0);
  });

  it('2. POST JSON：body 透传 + :param 提取，无 rawBody', async () => {
    const { app, dispatcher } = buildHarness({
      routes: [r({ method: 'POST', path: '/items/:id', auth: 'public' })],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/ext/demo/items/42',
      payload: { name: 'widget' },
    });

    expect(res.statusCode).toBe(200);
    expect(dispatcher.calls[0]!.request.body).toEqual({ name: 'widget' });
    expect(dispatcher.calls[0]!.request.params).toEqual({ id: '42' });
    expect(dispatcher.calls[0]!.request.rawBody).toBeUndefined(); // JSON content-type 不带 rawBody
  });

  it('3. dispatcher 返回 {status,headers,body} 映射到 HTTP 响应', async () => {
    const dispatcher = new StubDispatcher();
    dispatcher.impl = async () => ({
      status: 201,
      headers: { 'x-custom': 'yes', 'x-trace': 't-1' },
      body: { created: true },
    });
    const { app } = buildHarness({ routes: [r({ path: '/make' })], dispatcher });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/make' });

    expect(res.statusCode).toBe(201);
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.headers['x-trace']).toBe('t-1');
    expect(res.json()).toEqual({ created: true });
  });

  it('4. 无此扩展任何路由 → 404 HARNESS-1001（detail.extId），dispatcher 不触达', async () => {
    const { app, dispatcher } = buildHarness({ routes: [r({ path: '/hello' })] });

    const res = await app.inject({ method: 'GET', url: '/ext/ghost/x' });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1001');
    expect(body.detail).toEqual({ extId: 'ghost' });
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('5. 有扩展但无此路径 → 404 HARNESS-1001', async () => {
    const { app } = buildHarness({ routes: [r({ path: '/hello' })] });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('HARNESS-1001');
    expect(res.json().detail.extId).toBe('demo');
  });

  it('6. 路径匹配但方法不匹配 → 404', async () => {
    const { app, dispatcher } = buildHarness({ routes: [r({ method: 'GET', path: '/only-get' })] });

    const res = await app.inject({ method: 'POST', url: '/ext/demo/only-get', payload: {} });

    expect(res.statusCode).toBe(404);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('7. 扩展被禁用（isExtEnabled=false）→ 503 HARNESS-1003，鉴权与 dispatcher 均不触达', async () => {
    const { app, dispatcher, checkerCalls } = buildHarness({
      routes: [r({ path: '/secure', auth: 'user' })],
      isExtEnabled: () => false,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/ext/demo/secure',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('HARNESS-1003');
    expect(res.json().detail).toEqual({ extId: 'demo' });
    expect(checkerCalls).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('8. remove 后原扩展 → 503；从未注册的扩展 → 404', async () => {
    const { app, registry } = buildHarness({ routes: [r({ path: '/hello' })] });

    registry.remove('demo');

    const removed = await app.inject({ method: 'GET', url: '/ext/demo/hello' });
    expect(removed.statusCode).toBe(503);
    expect(removed.json().code).toBe('HARNESS-1003');

    const unknown = await app.inject({ method: 'GET', url: '/ext/ghost/hello' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('HARNESS-1001');
  });

  it('9. public 路由不调 checker', async () => {
    const { app, checkerCalls } = buildHarness({ routes: [r({ path: '/open', auth: 'public' })] });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/open' });

    expect(res.statusCode).toBe(200);
    expect(checkerCalls).toHaveLength(0);
  });

  it('10. user 路由无 token：checker 返回 null → 401 HARNESS-1006', async () => {
    const { app, dispatcher } = buildHarness({ routes: [r({ path: '/secure', auth: 'user' })] });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/secure' });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('11. checker 直接抛 HarnessError(UNAUTHORIZED) 亦可 → 401', async () => {
    const app = Fastify({ logger: false });
    installErrorHandler(app);
    const dispatcher = new StubDispatcher();
    const registry = new ExtRouteRegistry({
      app,
      checker: async () => {
        throw err('UNAUTHORIZED', { detail: 'rejected by provider' });
      },
      dispatcher,
      defaultTimeoutMs: 5_000,
      maxConcurrentPerExt: 8,
      isExtEnabled: () => true,
    });
    registry.commit('demo', [r({ path: '/secure', auth: 'user' })]);

    const res = await app.inject({
      method: 'GET',
      url: '/ext/demo/secure',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('12. admin 路由 normal 角色 → 403 HARNESS-1007', async () => {
    const { app, dispatcher } = buildHarness({
      routes: [r({ path: '/panel', auth: 'admin' })],
      identity: { userId: 'u1', role: 'normal', scopes: [] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/ext/demo/panel',
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('HARNESS-1007');
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('13. admin 路由 admin/root 角色放行', async () => {
    for (const role of ['admin', 'root'] as const) {
      const { app, dispatcher } = buildHarness({
        routes: [r({ path: '/panel', auth: 'admin' })],
        identity: { userId: 'u1', role, scopes: [] },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/ext/demo/panel',
        headers: { authorization: 'Bearer tok' },
      });

      expect(res.statusCode).toBe(200);
      expect(dispatcher.calls).toHaveLength(1);
    }
  });

  it('14. scope 不匹配 → 403；含该 scope 或 ["*"] 放行', async () => {
    const build = (scopes: string[]) =>
      buildHarness({
        routes: [r({ path: '/data', auth: 'user', scope: 'db.write' })],
        identity: { userId: 'u1', role: 'normal', scopes },
      });

    const denied = await build(['db.read']).app.inject({
      method: 'GET',
      url: '/ext/demo/data',
      headers: { authorization: 'Bearer tok' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('HARNESS-1007');
    expect(denied.json().detail).toEqual({ extId: 'demo', route: 'GET /data', scope: 'db.write' });

    const exact = await build(['db.read', 'db.write']).app.inject({
      method: 'GET',
      url: '/ext/demo/data',
      headers: { authorization: 'Bearer tok' },
    });
    expect(exact.statusCode).toBe(200);

    const star = await build(['*']).app.inject({
      method: 'GET',
      url: '/ext/demo/data',
      headers: { authorization: 'Bearer tok' },
    });
    expect(star.statusCode).toBe(200);
  });

  it('15. query.token 通过鉴权（extractToken 提取）', async () => {
    const { app, checkerCalls } = buildHarness({
      routes: [r({ path: '/secure', auth: 'user' })],
    });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/secure?token=q-token' });

    expect(res.statusCode).toBe(200);
    expect(checkerCalls[0]!.token).toBe('q-token');
  });

  it('16. 并发闸：maxConcurrentPerExt=1 时第二请求 429 HARNESS-1011，首请求不受影响', async () => {
    const dispatcher = new StubDispatcher({ hang: true });
    const { app, registry } = buildHarness({
      routes: [r({ path: '/work' })],
      dispatcher,
      maxConcurrentPerExt: 1,
    });

    const first = app.inject({ method: 'GET', url: '/ext/demo/work' });
    await waitFor(() => (registry.stats()[0]?.inflight ?? 0) === 1, 'first request in flight');

    const second = await app.inject({ method: 'GET', url: '/ext/demo/work' });
    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('HARNESS-1011');
    expect(second.json().detail).toEqual({ extId: 'demo', limit: 1 });

    dispatcher.release({ status: 200, body: { done: 1 } });
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.json()).toEqual({ done: 1 });
    await waitFor(() => (registry.stats()[0]?.inflight ?? 1) === 0, 'inflight back to 0');
  });

  it('17. dispatcher 永挂 + entry.timeoutMs=50 → 504 HARNESS-1002', async () => {
    const dispatcher = new StubDispatcher({ hang: true });
    const { app } = buildHarness({
      routes: [r({ path: '/slow', timeoutMs: 50 })],
      dispatcher,
    });

    const res = await app.inject({ method: 'GET', url: '/ext/demo/slow' });

    expect(res.statusCode).toBe(504);
    expect(res.json().code).toBe('HARNESS-1002');
    expect(res.json().retryable).toBe(true);
    expect(res.json().detail.routeKey).toBe('GET /slow');
    expect(dispatcher.calls[0]!.timeoutMs).toBe(50);
    dispatcher.releaseAll(); // 清理挂起 Promise（迟到结果对响应不可见）
  });

  it('18. commit 原子换表：新表生效、旧表失效，getTable 同步反映', async () => {
    const { app, registry, dispatcher } = buildHarness({
      routes: [r({ path: '/a' })],
    });
    expect(registry.getTable()).toEqual([r({ path: '/a' })]);

    registry.commit('demo', [r({ path: '/b' })]);

    expect(registry.getTable()).toEqual([r({ path: '/b' })]);
    const oldRoute = await app.inject({ method: 'GET', url: '/ext/demo/a' });
    expect(oldRoute.statusCode).toBe(404);
    const newRoute = await app.inject({ method: 'GET', url: '/ext/demo/b' });
    expect(newRoute.statusCode).toBe(200);
    expect(dispatcher.calls[dispatcher.calls.length - 1]!.routeKey).toBe('GET /b');
  });

  it('19. drain：在途时 commit 延迟换表（期间 503），drain 完成后新表生效', async () => {
    const dispatcher = new StubDispatcher({ hang: true });
    const { app, registry } = buildHarness({ routes: [r({ path: '/hello' })], dispatcher });

    const inFlight = app.inject({ method: 'GET', url: '/ext/demo/hello' });
    await waitFor(() => (registry.stats()[0]?.inflight ?? 0) === 1, 'request in flight');

    registry.commit('demo', [r({ path: '/next' })]);
    // drain 中：旧表请求 → 503（reloading）
    const duringDrain = await app.inject({ method: 'GET', url: '/ext/demo/hello' });
    expect(duringDrain.statusCode).toBe(503);
    expect(duringDrain.json().code).toBe('HARNESS-1003');

    dispatcher.release();
    const released = await inFlight;
    expect(released.statusCode).toBe(200);

    // 换表后的请求改由即时 dispatcher 承接（挂起模式仅用于制造在途窗口）
    dispatcher.impl = async () => ({ status: 200, body: { ok: true } });

    await waitFor(() => registry.getTable().some((e) => e.path === '/next'), 'table swapped');
    const newRoute = await app.inject({ method: 'GET', url: '/ext/demo/next' });
    expect(newRoute.statusCode).toBe(200);
    const oldRoute = await app.inject({ method: 'GET', url: '/ext/demo/hello' });
    expect(oldRoute.statusCode).toBe(404);
  });

  it('20. :param 提取单段且不跨斜杠', async () => {
    const { app, dispatcher } = buildHarness({
      routes: [r({ path: '/items/:id' })],
    });

    const ok = await app.inject({ method: 'GET', url: '/ext/demo/items/42' });
    expect(ok.statusCode).toBe(200);
    expect(dispatcher.calls[0]!.request.params).toEqual({ id: '42' });

    dispatcher.calls.length = 0;
    const extra = await app.inject({ method: 'GET', url: '/ext/demo/items/42/extra' });
    expect(extra.statusCode).toBe(404);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('21. `*` 尾通配：贪婪多段与空尾（须带尾斜杠），params["*"] 汇总', async () => {
    const { app, dispatcher } = buildHarness({
      routes: [r({ path: '/files/*' })],
    });

    const deep = await app.inject({ method: 'GET', url: '/ext/demo/files/a/b/c.txt' });
    expect(deep.statusCode).toBe(200);
    expect(dispatcher.calls[0]!.request.params['*']).toBe('a/b/c.txt');

    const emptyTail = await app.inject({ method: 'GET', url: '/ext/demo/files/' });
    expect(emptyTail.statusCode).toBe(200);
    expect(dispatcher.calls[1]!.request.params['*']).toBe('');

    const bare = await app.inject({ method: 'GET', url: '/ext/demo/files' });
    expect(bare.statusCode).toBe(404);
  });

  it('22. 大小写敏感：/Ext/ 前缀与路由路径大小写均不匹配', async () => {
    const { app, dispatcher } = buildHarness({ routes: [r({ path: '/hello' })] });

    const prefixCase = await app.inject({ method: 'GET', url: '/Ext/demo/hello' });
    expect(prefixCase.statusCode).toBe(404);

    const pathCase = await app.inject({ method: 'GET', url: '/ext/demo/HELLO' });
    expect(pathCase.statusCode).toBe(404);

    expect(dispatcher.calls).toHaveLength(0);
  });

  it('23. stats()：在途统计随请求收敛，多扩展分别统计', async () => {
    const dispatcher = new StubDispatcher({ hang: true });
    const { app, registry } = buildHarness({ routes: [r({ path: '/work' })], dispatcher });
    registry.commit('other', [{ ...r({ path: '/idle' }), extId: 'other' }]);

    expect(registry.stats()).toEqual([
      { extId: 'demo', inflight: 0 },
      { extId: 'other', inflight: 0 },
    ]);

    const inFlight = app.inject({ method: 'GET', url: '/ext/demo/work' });
    await waitFor(() => (registry.stats().find((s) => s.extId === 'demo')?.inflight ?? 0) === 1, 'inflight=1');

    const demo = registry.stats().find((s) => s.extId === 'demo');
    const other = registry.stats().find((s) => s.extId === 'other');
    expect(demo).toEqual({ extId: 'demo', inflight: 1 });
    expect(other).toEqual({ extId: 'other', inflight: 0 });

    dispatcher.release();
    await inFlight;
    await waitFor(
      () => (registry.stats().find((s) => s.extId === 'demo')?.inflight ?? 1) === 0,
      'inflight back to 0',
    );
  });

  it('24. POST 非 JSON content-type：rawBody 透传原始体字符串', async () => {
    const { app, dispatcher } = buildHarness({
      routes: [r({ method: 'POST', path: '/upload', auth: 'public' })],
    });

    const octet = await app.inject({
      method: 'POST',
      url: '/ext/demo/upload',
      payload: 'BINARY-BYTES-01',
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(octet.statusCode).toBe(200);
    expect(dispatcher.calls[0]!.request.rawBody).toBe('BINARY-BYTES-01');
    expect(dispatcher.calls[0]!.request.body).toBe('BINARY-BYTES-01');

    const text = await app.inject({
      method: 'POST',
      url: '/ext/demo/upload',
      payload: 'plain text body',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(200);
    expect(dispatcher.calls[1]!.request.rawBody).toBe('plain text body');
  });

  it('25. counters：requests/responses 计数与状态码标签', async () => {
    const inc = vi.fn();
    const { app } = buildHarness({
      routes: [r({ path: '/hello' })],
      counters: { inc },
    });

    await app.inject({ method: 'GET', url: '/ext/demo/hello' });
    await app.inject({ method: 'GET', url: '/ext/demo/missing' });

    expect(inc).toHaveBeenCalledWith('ext.route.requests', { extId: 'demo', route: 'GET /hello' });
    expect(inc).toHaveBeenCalledWith('ext.route.responses', {
      extId: 'demo',
      route: 'GET /hello',
      status: '200',
    });
    // 未匹配路径的请求也计响应码（route 未知 → '-'）
    expect(inc).toHaveBeenCalledWith('ext.route.responses', {
      extId: 'demo',
      route: '-',
      status: '404',
    });
  });

  it('26. commit 校验：表内重复路由 → EXT_ROUTE_CONFLICT；非法条目 → EXT_MANIFEST_INVALID', () => {
    const { registry } = buildHarness({ routes: [] });

    let dup: unknown;
    try {
      registry.commit('demo', [r({ path: '/a' }), r({ path: '/a/' })]);
    } catch (e) {
      dup = e;
    }
    expect(dup).toBeInstanceOf(HarnessError);
    expect((dup as HarnessError).code).toBe('HARNESS-3008'); // EXT_ROUTE_CONFLICT

    let bad: unknown;
    try {
      registry.commit('demo', [r({ path: 'no-leading-slash' })]);
    } catch (e) {
      bad = e;
    }
    expect(bad).toBeInstanceOf(HarnessError);
    expect((bad as HarnessError).code).toBe('HARNESS-3001'); // EXT_MANIFEST_INVALID

    let mismatch: unknown;
    try {
      registry.commit('demo', [{ ...r({ path: '/a' }), extId: 'other' }]);
    } catch (e) {
      mismatch = e;
    }
    expect(mismatch).toBeInstanceOf(HarnessError);
    expect((mismatch as HarnessError).code).toBe('HARNESS-3001');
  });

  it('27. getTable 返回快照：修改返回值不影响注册表', () => {
    const { registry } = buildHarness({ routes: [r({ path: '/a' })] });

    const snapshot = registry.getTable();
    snapshot.push(r({ path: '/hacked' }));
    snapshot[0]!.path = '/mutated';

    expect(registry.getTable()).toEqual([r({ path: '/a' })]);
  });
});
