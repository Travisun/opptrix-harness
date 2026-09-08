/**
 * Kernel 生命周期单测。
 *
 * HTTP 服务器一律通过 serverFactory 注入轻量 stub（HttpServerLike），不启动真实端口、
 * 不依赖 createHttpServer 的实现细节 —— 见 KernelOptions.serverFactory 契约。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/kernel/config/index.js';
import type { HarnessConfig } from '../src/kernel/config/index.js';
import { ServiceProvider } from '../src/kernel/ServiceProvider.js';
import type { Container } from '../src/kernel/Container.js';
import { AuthProviderRegistry } from '../src/kernel/auth/AuthProviderRegistry.js';
import {
  CONTAINER_KEYS,
  Kernel,
  type HttpServerLike,
  type KernelOptions,
  type ServerFactory,
} from '../src/kernel/Kernel.js';

/**
 * 每个测试独立的临时 dataDir：boot 现在会真实打开 kernel.sqlite 并执行迁移，
 * 不允许污染仓库目录 ./data。
 */
let TEST_DATA_DIR = './data';
beforeEach(async () => {
  TEST_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'harness-kernel-'));
});
afterEach(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      HARNESS_LOG_LEVEL: 'error', // 静音：测试不关心日志输出
      HARNESS_PORT: '3457',
      HARNESS_DATA_DIR: TEST_DATA_DIR,
      HARNESS_PERSIST_ROOT_TOKEN: '0',
    }),
    ...overrides,
  };
}

/** 记录生命周期调用顺序的测试 provider；failOn 指定在哪个阶段抛错 */
class RecordingProvider extends ServiceProvider {
  constructor(
    private readonly name: string,
    private readonly calls: string[],
    private readonly failOn: 'register' | 'boot' | null = null,
  ) {
    super();
  }

  override register(): void {
    this.calls.push(`${this.name}:register`);
    if (this.failOn === 'register') throw new Error(`boom-register-${this.name}`);
  }

  override async boot(): Promise<void> {
    this.calls.push(`${this.name}:boot`);
    if (this.failOn === 'boot') throw new Error(`boom-boot-${this.name}`);
  }

  override async stop(): Promise<void> {
    this.calls.push(`${this.name}:stop`);
  }
}

/** 记录 create/start/stop 调用顺序的 stub server 工厂 */
function stubServerFactory(calls: string[], port = 3457): ServerFactory {
  return (deps) => {
    calls.push(`http:create:${deps.config.port}`);
    const server: HttpServerLike = {
      app: undefined,
      start: async () => {
        calls.push(`http:start:${deps.config.port}`);
        return port;
      },
      stop: async () => {
        calls.push('http:stop');
      },
    };
    return server;
  };
}

function makeKernel(calls: string[], overrides: Partial<KernelOptions> = {}): Kernel {
  return new Kernel({
    config: makeConfig(),
    serverFactory: stubServerFactory(calls),
    ...overrides,
  });
}

describe('Kernel boot', () => {
  it('boot 后 state=ready，register 全部完成后才依次 boot，http server 创建并启动', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    kernel.useProvider(new RecordingProvider('b', calls));

    await kernel.boot();

    expect(kernel.state()).toBe('ready');
    expect(kernel.isReady()).toBe(true);
    // 顺序契约：所有 register → 所有 boot → 创建 http → start
    expect(calls).toEqual([
      'a:register',
      'b:register',
      'a:boot',
      'b:boot',
      'http:create:3457',
      'http:start:3457',
    ]);
  });

  it('boot 后 container 注入 config/logger/http 单例，getConfig/getLogger 等价', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);

    await kernel.boot();

    expect(kernel.container.has('http')).toBe(true);
    expect(kernel.container.resolve('http')).toBeDefined();
    expect(kernel.container.resolve<HarnessConfig>('config')).toBe(kernel.config);
    expect(kernel.container.resolve('logger')).toBe(kernel.logger);
    expect(kernel.getConfig()).toBe(kernel.config);
    expect(kernel.getLogger()).toBe(kernel.logger);
  });

  it('provider boot 抛错：优雅中止（已 boot 的 provider stop 被调用），原始错误 rethrow，state=stopped', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    kernel.useProvider(new RecordingProvider('b', calls, 'boot'));
    kernel.useProvider(new RecordingProvider('c', calls));

    await expect(kernel.boot()).rejects.toThrow('boom-boot-b');

    expect(kernel.state()).toBe('stopped');
    expect(kernel.isReady()).toBe(false);
    expect(calls).toEqual([
      'a:register',
      'b:register',
      'c:register',
      'a:boot',
      'b:boot', // 抛错点（事件已记录）
      'a:stop', // 只有已 boot 的 a 被 stop；b/c 未 boot 不 stop
    ]);
    expect(calls).not.toContain('b:stop');
    expect(calls).not.toContain('c:stop');
    expect(calls).not.toContain('http:create:3457');
    expect(kernel.container.has('http')).toBe(false);
  });

  it('重复 boot 抛错；boot 后 useProvider 抛错', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    await kernel.boot();

    await expect(kernel.boot()).rejects.toThrow(/once/);
    expect(() => kernel.useProvider(new RecordingProvider('late', calls))).toThrow(/useProvider/);
  });

  it('provider register 阶段即可 resolve auth.registry 并注册 AuthProvider（挂点前移契约）', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    let registryAtRegister: AuthProviderRegistry | undefined;
    let checkerAtBoot: unknown;
    class AuthConsumerProvider extends ServiceProvider {
      override register(c: Container): void {
        calls.push('p:register');
        // 前移契约：register 阶段 auth.registry 已登记
        expect(c.has(CONTAINER_KEYS.authRegistry)).toBe(true);
        registryAtRegister = c.resolve<AuthProviderRegistry>(CONTAINER_KEYS.authRegistry);
        registryAtRegister.register({
          name: 'test-provider',
          verify: async () => ({ userId: 'u1', role: 'normal', scopes: ['s1'] }),
        });
      }

      override async boot(c: Container): Promise<void> {
        calls.push('p:boot');
        checkerAtBoot = c.resolve(CONTAINER_KEYS.authChecker);
      }
    }
    kernel.useProvider(new AuthConsumerProvider());
    await kernel.boot();

    expect(registryAtRegister).toBeInstanceOf(AuthProviderRegistry);
    expect(calls).toEqual(['p:register', 'p:boot', 'http:create:3457', 'http:start:3457']);
    // provider 注册的身份可通过内核 checker 验证（root 随机令牌不匹配 'user-token'）
    const verify = checkerAtBoot as (input: unknown) => Promise<unknown>;
    await expect(verify({ token: 'user-token', headers: {} })).resolves.toEqual({
      userId: 'u1',
      role: 'normal',
      scopes: ['s1'],
    });
    // 其余鉴权挂点均已登记
    expect(kernel.container.has(CONTAINER_KEYS.authIdentity)).toBe(true);
    expect(kernel.container.has(CONTAINER_KEYS.authChecker)).toBe(true);
    expect(kernel.container.has(CONTAINER_KEYS.sseHub)).toBe(true);
  });

  it('生成 root token 时以 bootRootToken 字段 warn 一次（该字段不在脱敏列表）', async () => {
    const calls: string[] = [];
    const dataDir = await mkdtemp(path.join(tmpdir(), 'harness-kernel-boot-'));
    try {
      // persistRootToken=false：确保每次都走 generated 路径（不依赖 dataDir 既有文件）
      const kernel = new Kernel({
        config: makeConfig({ dataDir, persistRootToken: false }),
        serverFactory: stubServerFactory(calls),
      });
      const warnSpy = vi.spyOn(kernel.logger, 'warn');
      await kernel.boot();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ bootRootToken: expect.stringMatching(/^[0-9a-f]{64}$/) }),
        'generated root token (printed once, will not be shown again)',
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Kernel boot/shutdown 互斥', () => {
  it('boot 期间调用 shutdown：等待 boot 落定后正常关停（http stop 一次、provider stop 被调用）', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    let releaseBoot!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    class GatedProvider extends ServiceProvider {
      override register(): void {
        calls.push('gated:register');
      }

      override async boot(): Promise<void> {
        calls.push('gated:boot:start');
        await gate;
        calls.push('gated:boot:end');
      }

      override async stop(): Promise<void> {
        calls.push('gated:stop');
      }
    }
    kernel.useProvider(new GatedProvider());

    const bootPromise = kernel.boot();
    bootPromise.catch(() => {}); // 防未处理拒绝窗口（真实断言在下方）
    const deadline = Date.now() + 2000;
    while (kernel.state() !== 'booting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(kernel.state()).toBe('booting');

    const shutdownPromise = kernel.shutdown('during-boot');
    releaseBoot();
    await expect(bootPromise).resolves.toBeUndefined();
    await shutdownPromise;

    expect(kernel.state()).toBe('stopped');
    expect(kernel.isReady()).toBe(false);
    expect(calls).toContain('gated:boot:end');
    expect(calls.filter((c) => c === 'http:stop')).toHaveLength(1);
    expect(calls.filter((c) => c === 'gated:stop')).toHaveLength(1);
  });

  it('boot 期间调用 shutdown 且 boot 失败：最终 stopped，boot 错误仍归 boot() 调用方', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    kernel.useProvider(new RecordingProvider('b', calls, 'boot'));

    const bootPromise = kernel.boot();
    bootPromise.catch(() => {}); // 防未处理拒绝窗口（真实断言在下方）
    const shutdownPromise = kernel.shutdown('during-failing-boot');
    await expect(bootPromise).rejects.toThrow('boom-boot-b');
    await shutdownPromise;

    expect(kernel.state()).toBe('stopped');
    // http 尚未创建即失败：不应出现 http stop
    expect(calls).not.toContain('http:stop');
    expect(calls).toContain('a:stop'); // gracefulAbort 逆序 stop 已 boot 的 provider
    expect(calls).not.toContain('b:stop'); // boot 失败的 provider 不在 #booted，不 stop
  });
});

describe('Kernel shutdown', () => {
  it('shutdown：先 http stop，再逆序 provider stop，落 stopped', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    kernel.useProvider(new RecordingProvider('b', calls));
    await kernel.boot();

    calls.length = 0;
    await kernel.shutdown('test-done');

    expect(kernel.state()).toBe('stopped');
    expect(calls).toEqual(['http:stop', 'b:stop', 'a:stop']); // 逆序
  });

  it('shutdown 幂等：重复调用直接返回，不重复 stop', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    await kernel.boot();

    await kernel.shutdown('first');
    expect(kernel.state()).toBe('stopped');
    expect(calls.filter((c) => c === 'a:stop')).toHaveLength(1);

    await kernel.shutdown('second');
    await kernel.shutdown('third');
    expect(kernel.state()).toBe('stopped');
    expect(calls.filter((c) => c === 'a:stop')).toHaveLength(1);
    expect(calls.filter((c) => c === 'http:stop')).toHaveLength(1);
  });

  it('未 boot 的 kernel shutdown：无副作用直接 stopped', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);

    await kernel.shutdown('never-booted');

    expect(kernel.state()).toBe('stopped');
    expect(calls).toEqual([]);
  });

  it('handleSignal(sig) 等价 shutdown(`signal:${sig}`)，reason 写入关停日志', async () => {
    const calls: string[] = [];
    const kernel = makeKernel(calls);
    kernel.useProvider(new RecordingProvider('a', calls));
    await kernel.boot();

    calls.length = 0; // 只观察关停阶段的事件
    const infoSpy = vi.spyOn(kernel.logger, 'info');
    await kernel.handleSignal('SIGTERM');

    expect(kernel.state()).toBe('stopped');
    expect(calls).toEqual(['http:stop', 'a:stop']);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'signal:SIGTERM' }),
      'kernel shutting down',
    );
  });
});
