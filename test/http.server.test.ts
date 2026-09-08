import { describe, expect, it } from 'vitest';
import pino, { type Logger } from 'pino';
import type { FastifyInstance } from 'fastify';
import type { HarnessConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer, type HttpServerDeps } from '../src/kernel/http/server.js';

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    env: 'test',
    dataDir: './data',
    port: 0,
    host: '127.0.0.1',
    token: '',
    persistRootToken: false,
    corsOrigin: '*',
    trustProxy: false,
    logLevel: 'error',
    timezone: 'UTC',
    taskWorkers: 1,
    rpcTimeoutMs: 30_000,
    routeTimeoutMs: 30_000,
    maxBodyBytes: 1024 * 1024,
    maxUploadBytes: 1024 * 1024,
    maxRpcPayloadBytes: 1024 * 1024,
    maxRoutesPerExt: 100,
    maxConcurrentPerExt: 32,
    sandboxEnabled: false,
    sandboxImage: 'opptrix-sandbox:latest',
    dockerHost: '',
    updateAuto: false,
    updateFeed: '',
    updateChannel: 'stable',
    updateToken: '',
    updateWindow: '0 4 * * *',
    crashLoopWindowMs: 60_000,
    crashLoopMax: 5,
    ...overrides,
  };
}

const logger: Logger = pino({ level: 'silent' });

interface BuildOpts {
  isReady?: () => boolean;
  state?: () => string;
  registerExtra?: (app: FastifyInstance) => void;
}

function buildServer(opts: BuildOpts = {}): { deps: HttpServerDeps } & ReturnType<typeof createHttpServer> {
  const deps: HttpServerDeps = {
    config: makeConfig(),
    logger,
    isReady: opts.isReady ?? (() => false),
    state: opts.state ?? (() => 'booting'),
    ...(opts.registerExtra ? { registerExtra: opts.registerExtra } : {}),
  };
  return { deps, ...createHttpServer(deps) };
}

describe('http server', () => {
  it('GET /health 返回 200 与 state 字段', async () => {
    const { app } = buildServer({ state: () => 'running' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'running' });
  });

  it('GET /readyz 未就绪返回 503，就绪后返回 200', async () => {
    let ready = false;
    const { app } = buildServer({ isReady: () => ready, state: () => 'booting' });

    const notReady = await app.inject({ method: 'GET', url: '/readyz' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ ok: false, state: 'booting' });

    ready = true;
    const ok = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, state: 'booting' });
  });

  it('GET / 返回应急提示 HTML（含 Opptrix Harness OS）', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Opptrix Harness OS');
    expect(res.body).toContain('webui 扩展未启用');
  });

  it('未知路径返回 404 且 code=HARNESS-1001', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/definitely/not/here' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1001');
    expect(body.message).toBe('route not found');
    expect(body.retryable).toBe(false);
  });

  it('路径存在但方法不匹配时映射为 405 METHOD_NOT_ALLOWED', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'POST', url: '/health' });
    expect(res.statusCode).toBe(405);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1010');
    expect(body.retryable).toBe(false);
    expect(String(res.headers.allow)).toContain('GET');
  });

  it('registerExtra 挂载的路由抛 HarnessError 时返回其 code/status/retryable/headers', async () => {
    const { app } = buildServer({
      registerExtra: (a) => {
        a.get('/test/harness-error', async () => {
          throw err('HANDLER_TIMEOUT', {
            detail: { ms: 1234 },
            headers: { 'Retry-After': '5' },
          });
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/test/harness-error' });
    expect(res.statusCode).toBe(504);
    const body = res.json();
    expect(body.code).toBe('HARNESS-1002');
    expect(body.retryable).toBe(true);
    expect(body.detail).toEqual({ ms: 1234 });
    expect(res.headers['retry-after']).toBe('5');
  });

  it('registerExtra 挂载的路由抛普通 Error 时返回 500 且 message 不泄露', async () => {
    const { app } = buildServer({
      registerExtra: (a) => {
        a.get('/test/plain-error', async () => {
          throw new Error('secret internal boom');
        });
      },
    });
    const res = await app.inject({ method: 'GET', url: '/test/plain-error' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.message).toBe('internal error');
    expect(body.code).toBe('HARNESS-9003');
    expect(body.retryable).toBe(false);
    expect(res.body).not.toContain('secret internal boom');
  });

  it('携带 Origin 请求时返回 CORS 头', async () => {
    const { app } = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://example.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('start() 返回实际端口（port=0 随机分配），stop() 优雅关闭', async () => {
    const { app, start, stop } = buildServer();
    const port = await start();
    expect(port).toBeGreaterThan(0);
    expect(app.server.listening).toBe(true);
    await stop();
    expect(app.server.listening).toBe(false);
  });
});
