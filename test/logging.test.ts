import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/kernel/config/index.js';
import { createLogger, scoped } from '../src/kernel/logging/index.js';

/** 收集 pino 每行 JSON 输出的内存流 */
function captureStream(sink: string[]): Writable {
  return new Writable({
    write(chunk: unknown, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
      sink.push(String(chunk));
      cb();
    },
  });
}

/** 等待流的异步落盘（Writable._write 经 nextTick 调度） */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

let sink: string[] = [];
let logger = createLogger(loadConfig({ HARNESS_LOG_LEVEL: 'info' }), captureStream(sink));

afterEach(async () => {
  await flush();
  sink = [];
  logger = createLogger(loadConfig({ HARNESS_LOG_LEVEL: 'info' }), captureStream(sink));
});

describe('createLogger', () => {
  it('redact：token/authorization/password/secret/apiKey 各层级均不泄露', async () => {
    logger.info(
      {
        token: 'super-secret-token',
        password: 'hunter2',
        authorization: 'Bearer abc.def.ghi',
        apiKey: 'key-123',
        api_key: 'snake-key',
        nested: { secret: 'nested-secret', token: 'nested-token' },
        deep: { level1: { level2: { apiKey: 'deep-key' } } },
        keep: 'visible-value',
      },
      'login attempt',
    );
    await flush();

    expect(sink).toHaveLength(1);
    const row = JSON.parse(sink[0] ?? '{}') as Record<string, unknown>;
    const nested = row.nested as Record<string, unknown>;
    const level2 = (row.deep as Record<string, unknown>).level1 as Record<string, unknown>;
    const deep = (level2.level2 as Record<string, unknown>);

    expect(row.token).toBe('[REDACTED]');
    expect(row.password).toBe('[REDACTED]');
    expect(row.authorization).toBe('[REDACTED]');
    expect(row.apiKey).toBe('[REDACTED]');
    expect(row.api_key).toBe('[REDACTED]');
    expect(nested.secret).toBe('[REDACTED]');
    expect(nested.token).toBe('[REDACTED]');
    expect(deep.apiKey).toBe('[REDACTED]');
    expect(row.keep).toBe('visible-value');

    const raw = sink.join('');
    for (const leak of ['super-secret-token', 'hunter2', 'Bearer abc.def.ghi', 'key-123', 'snake-key', 'nested-secret', 'deep-key']) {
      expect(raw, `must not leak: ${leak}`).not.toContain(leak);
    }
  });

  it('时间戳为 epoch ms（数值型 time 字段）', async () => {
    const before = Date.now();
    logger.info('epoch check');
    await flush();

    const row = JSON.parse(sink[0] ?? '{}') as { time?: unknown; msg?: string };
    expect(typeof row.time).toBe('number');
    expect(row.time as number).toBeGreaterThanOrEqual(before);
    expect(row.time as number).toBeLessThanOrEqual(Date.now());
    expect(row.msg).toBe('epoch check');
  });

  it('level 来自 cfg.logLevel：低于级别的日志被丢弃', async () => {
    const lines: string[] = [];
    const quiet = createLogger(loadConfig({ HARNESS_LOG_LEVEL: 'error' }), captureStream(lines));
    quiet.info('should be dropped');
    quiet.error('should be kept');
    await flush();

    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as { msg?: string }).msg).toBe('should be kept');
  });
});

describe('scoped', () => {
  it('child 带 scope 字段，其余字段原样保留', async () => {
    const child = scoped(logger, 'rpc.server');
    child.warn({ attempt: 2 }, 'retrying');
    await flush();

    expect(sink).toHaveLength(1);
    const row = JSON.parse(sink[0] ?? '{}') as Record<string, unknown>;
    expect(row.scope).toBe('rpc.server');
    expect(row.attempt).toBe(2);
    expect(row.msg).toBe('retrying');
    expect(row.level).toBe(40); // pino: warn=40
  });

  it('child 继承 redact（密钥仍打码）', async () => {
    scoped(logger, 'auth').info({ token: 'child-secret' }, 'scoped redaction');
    await flush();

    const row = JSON.parse(sink[0] ?? '{}') as Record<string, unknown>;
    expect(row.scope).toBe('auth');
    expect(row.token).toBe('[REDACTED]');
    expect(sink.join('')).not.toContain('child-secret');
  });

  it('不同 scope 互不影响（每次生成独立 child）', async () => {
    const a = scoped(logger, 'a');
    const b = scoped(logger, 'b');
    a.info('from a');
    b.info('from b');
    await flush();

    expect(sink).toHaveLength(2);
    expect((JSON.parse(sink[0] ?? '{}') as { scope?: string }).scope).toBe('a');
    expect((JSON.parse(sink[1] ?? '{}') as { scope?: string }).scope).toBe('b');
  });
});
