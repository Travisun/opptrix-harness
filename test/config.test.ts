import { afterAll, describe, expect, it } from 'vitest';

import { configGet, loadConfig, loadDotenv } from '../src/kernel/config/index.js';
import { HarnessError } from '../src/kernel/errors/index.js';
import { detectRuntimeProfile } from '../src/kernel/runtime-profile.js';

describe('loadConfig 默认值', () => {
  it('空 env → 全部默认值', () => {
    expect(loadConfig({})).toEqual({
      env: 'development',
      dataDir: './data',
      port: 3000,
      host: '0.0.0.0',
      token: '',
      persistRootToken: true,
      corsOrigin: '*',
      trustProxy: false,
      logLevel: 'info',
      timezone: 'UTC',
      // 缺省 = 运行时画像（按宿主机核数自适应，见 runtime-profile.ts），非固定 1
      taskWorkers: detectRuntimeProfile().taskWorkers,
      rpcTimeoutMs: 30_000,
      routeTimeoutMs: 30_000,
      maxBodyBytes: 2 * 1024 * 1024,
      maxUploadBytes: 100 * 1024 * 1024,
      maxRpcPayloadBytes: 8 * 1024 * 1024,
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
    });
  });

  it('空字符串视为未设置 → 使用默认值', () => {
    const cfg = loadConfig({ HARNESS_PORT: '', HARNESS_TIMEZONE: '', NODE_ENV: '' });
    expect(cfg.port).toBe(3000);
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.env).toBe('development');
  });
});

describe('loadConfig env 覆盖', () => {
  it('HARNESS_* 覆盖对应字段', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      HARNESS_DATA_DIR: '/var/lib/opptrix',
      HARNESS_PORT: '8080',
      HARNESS_HOST: '127.0.0.1',
      HARNESS_LOG_LEVEL: 'debug',
      HARNESS_TIMEZONE: 'Asia/Shanghai',
      HARNESS_TASK_WORKERS: '4',
      HARNESS_UPDATE_CHANNEL: 'beta',
    });
    expect(cfg.env).toBe('production');
    expect(cfg.dataDir).toBe('/var/lib/opptrix');
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.timezone).toBe('Asia/Shanghai');
    expect(cfg.taskWorkers).toBe(4);
    expect(cfg.updateChannel).toBe('beta');
  });

  it('枚举大小写不敏感（NODE_ENV=Production → production）', () => {
    expect(loadConfig({ NODE_ENV: 'Production' }).env).toBe('production');
    expect(loadConfig({ HARNESS_LOG_LEVEL: 'WARN' }).logLevel).toBe('warn');
  });
});

describe('布尔解析：0/false/off/no 为 false，1/true/yes/on 为 true', () => {
  it('"0" → false（覆盖默认 true）', () => {
    expect(loadConfig({ HARNESS_PERSIST_ROOT_TOKEN: '0' }).persistRootToken).toBe(false);
  });

  it('"1" → true（覆盖默认 false）', () => {
    expect(loadConfig({ HARNESS_SANDBOX_ENABLED: '1' }).sandboxEnabled).toBe(true);
  });

  it('显式真/假词表（大小写不敏感）', () => {
    for (const v of ['true', 'TRUE', 'yes', 'Yes', 'on', 'ON']) {
      expect(loadConfig({ HARNESS_UPDATE_AUTO: v }).updateAuto, `updateAuto=${v}`).toBe(true);
    }
    for (const v of ['false', 'FALSE', 'off', 'Off', 'no', 'No']) {
      expect(loadConfig({ HARNESS_UPDATE_AUTO: v }).updateAuto, `updateAuto=${v}`).toBe(false);
      expect(loadConfig({ HARNESS_PERSIST_ROOT_TOKEN: v }).persistRootToken, `persist=${v}`).toBe(false);
    }
  });

  it('未设置 → 默认值', () => {
    expect(loadConfig({}).persistRootToken).toBe(true);
    expect(loadConfig({}).sandboxEnabled).toBe(false);
    expect(loadConfig({}).trustProxy).toBe(false);
  });

  it('HARNESS_TRUST_PROXY：1 → true（反代部署信任 X-Forwarded-*）', () => {
    expect(loadConfig({ HARNESS_TRUST_PROXY: '1' }).trustProxy).toBe(true);
    expect(loadConfig({ HARNESS_TRUST_PROXY: 'off' }).trustProxy).toBe(false);
  });

  it('非法布尔值 fail-fast（VALIDATION_FAILED，信息含变量名）', () => {
    try {
      loadConfig({ HARNESS_SANDBOX_ENABLED: 'maybe' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      const he = e as HarnessError;
      expect(he.code).toBe('HARNESS-1009');
      expect(he.message).toContain('HARNESS_SANDBOX_ENABLED');
    }
  });
});

describe('fail-fast 校验', () => {
  it('非法端口（越界）→ HarnessError，信息可操作', () => {
    expect(() => loadConfig({ HARNESS_PORT: '70000' })).toThrowError(HarnessError);
    try {
      loadConfig({ HARNESS_PORT: '70000' });
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he.code).toBe('HARNESS-1009');
      expect(he.message).toContain('HARNESS_PORT');
      expect(he.message).toContain('[1, 65535]');
    }
  });

  it('非整数端口 → HarnessError', () => {
    expect(() => loadConfig({ HARNESS_PORT: 'abc' })).toThrowError(HarnessError);
    expect(() => loadConfig({ HARNESS_PORT: '80.5' })).toThrowError(/HARNESS_PORT/);
  });

  it('整数越界（低于下界）→ 信息含变量名、合法区间与修复指引', () => {
    try {
      loadConfig({ HARNESS_RPC_TIMEOUT_MS: '500' });
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he).toBeInstanceOf(HarnessError);
      expect(he.message).toContain('HARNESS_RPC_TIMEOUT_MS');
      expect(he.message).toContain('[1000, 600000]');
      expect(he.message).toContain('500');
    }
  });

  it('非法时区 → HarnessError，信息含变量名与示例', () => {
    expect(() => loadConfig({ HARNESS_TIMEZONE: 'Mars/Olympus_Mons' })).toThrowError(HarnessError);
    try {
      loadConfig({ HARNESS_TIMEZONE: 'Not/AZone' });
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he.message).toContain('HARNESS_TIMEZONE');
      expect(he.message).toContain('Not/AZone');
      expect(he.message).toMatch(/UTC|IANA/i);
    }
  });

  it('合法 IANA 时区通过（Asia/Shanghai）', () => {
    expect(loadConfig({ HARNESS_TIMEZONE: 'Asia/Shanghai' }).timezone).toBe('Asia/Shanghai');
  });

  it('非法枚举 → HarnessError（logLevel / NODE_ENV / updateChannel）', () => {
    expect(() => loadConfig({ HARNESS_LOG_LEVEL: 'loud' })).toThrowError(/HARNESS_LOG_LEVEL/);
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrowError(/NODE_ENV/);
    expect(() => loadConfig({ HARNESS_UPDATE_CHANNEL: 'dev' })).toThrowError(/HARNESS_UPDATE_CHANNEL/);
  });
});

describe('configGet：点号风格', () => {
  const cfg = loadConfig({});

  it('单段路径取值', () => {
    expect(configGet(cfg, 'port')).toBe(3000);
    expect(configGet(cfg, 'logLevel')).toBe('info');
    expect(configGet(cfg, 'dataDir')).toBe('./data');
  });

  it('路径存在时忽略 fallback', () => {
    expect(configGet(cfg, 'port', 1)).toBe(3000);
    expect(configGet(cfg, 'port', 'not-this')).toBe(3000);
  });

  it('路径不存在 → fallback；未给 fallback → undefined', () => {
    expect(configGet(cfg, 'nope.deep', 'fallback-value')).toBe('fallback-value');
    expect(configGet(cfg, 'port.sub.deep', 42)).toBe(42);
    expect(configGet(cfg, 'nope')).toBeUndefined();
    expect(configGet(cfg, 'nope.deep')).toBeUndefined();
  });

  it('空路径 → fallback', () => {
    expect(configGet(cfg, '', 'empty-path')).toBe('empty-path');
  });
});

describe('loadDotenv', () => {
  const PREV_PORT = process.env.HARNESS_PORT;

  afterAll(() => {
    if (PREV_PORT === undefined) delete process.env.HARNESS_PORT;
    else process.env.HARNESS_PORT = PREV_PORT;
  });

  it('幂等、不覆盖已有环境变量、.env 缺失不致命', async () => {
    process.env.HARNESS_PORT = '47654';
    await expect(loadDotenv()).resolves.toBeUndefined();
    await expect(loadDotenv()).resolves.toBeUndefined(); // 第二次调用直接返回
    expect(process.env.HARNESS_PORT).toBe('47654');
  });
});
