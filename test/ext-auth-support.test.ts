/**
 * ext-auth-support 单测 — 内核认证扩展支撑面：
 * - createPasswordSupport：scrypt hash/verify 往返、格式自描述、坏 hash 不抛、自定义参数；
 * - safeEqualStrings：常数时间比较（真/假/长度差）；
 * - kernel-handlers 的 auth.*：权限闸（'auth:provider'，最小 deps 桩直调 handler）、
 *   registerProvider/unregisterProvider 回调触发、payload 校验、未接线 NOT_IMPLEMENTED；
 * - sandbox HarnessApi.authProvider：激活期登记 / 非激活期拒绝 / 后注册覆盖；
 * - manifest 白名单放行 'auth:provider'。
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';

import { HOST_METHODS, KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import {
  createContributionsCollector,
  createHarnessApi,
} from '../src/extension-host/sandbox.js';
import { createTimerRegistry } from '../src/extension-host/vm-runtime.js';
import { safeEqualStrings, createPasswordSupport } from '../src/kernel/auth/ext-auth-support.js';
import { CONTAINER_KEYS } from '../src/kernel/Kernel.js';
import { createKernelHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import type { Kernel } from '../src/kernel/Kernel.js';
import { manifestSchema, validatePermissions } from '../src/kernel/extensions/manifest.js';
import type { KernelBridgeHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import { err } from '../src/kernel/errors/index.js';
import { HarnessError } from '../src/kernel/errors/HarnessError.js';

// ---------------------------------------------------------------------------
// createPasswordSupport
// ---------------------------------------------------------------------------

describe('createPasswordSupport', () => {
  const passwords = createPasswordSupport();

  it('hash/verify 往返：正确密码 true', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect(typeof hash).toBe('string');
    await expect(passwords.verify('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('hash 为自描述格式 scrypt$16384$8$1$<salt_hex>$<key_hex>（缺省 16B 盐 / 64B 钥）', async () => {
    const hash = await passwords.hash('pw');
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    expect(parts[4]).toMatch(/^[0-9a-f]{32}$/); // 16 字节盐
    expect(parts[5]).toMatch(/^[0-9a-f]{128}$/); // 64 字节派生钥
  });

  it('同密码两次 hash 产生不同盐（但两者都校验通过）', async () => {
    const h1 = await passwords.hash('same-pw');
    const h2 = await passwords.hash('same-pw');
    expect(h1).not.toBe(h2);
    await expect(passwords.verify('same-pw', h1)).resolves.toBe(true);
    await expect(passwords.verify('same-pw', h2)).resolves.toBe(true);
  });

  it('错误密码 → false', async () => {
    const hash = await passwords.hash('right-password');
    await expect(passwords.verify('wrong-password', hash)).resolves.toBe(false);
  });

  it('坏 hash 格式一律 false 且不抛（截断/异算法/非法 hex/坏参数）', async () => {
    const cases = [
      '',
      'bcrypt$2a$10$salt_hash',
      'scrypt$16384$8$1$deadbeef', // 段数不足
      'scrypt$abc$8$1$deadbeef$' + 'ab'.repeat(64), // N 非整数
      'scrypt$0$8$1$deadbeef$' + 'ab'.repeat(64), // N ≤ 0
      'scrypt$16384$8$1$zzzz$' + 'ab'.repeat(64), // 非法 hex（截断为空盐）
      'scrypt$16384$8$1$deadbeef$', // 空 key
      'scrypt$100$8$1$deadbeef$' + 'ab'.repeat(64), // N 非 2 的幂（node:crypto 拒绝）
    ];
    for (const bad of cases) {
      await expect(passwords.verify('pw', bad)).resolves.toBe(false);
    }
  });

  it('hash 被篡改（key 翻转一位 hex / 盐替换）→ false', async () => {
    const hash = await passwords.hash('pw');
    const parts = hash.split('$');
    const flipped = parts[5][0] === 'a' ? `b${parts[5].slice(1)}` : `a${parts[5].slice(1)}`;
    await expect(passwords.verify('pw', parts.slice(0, 5).concat(flipped).join('$'))).resolves.toBe(false);
    const otherSalt = parts[4][0] === 'a' ? `b${parts[4].slice(1)}` : `a${parts[4].slice(1)}`;
    await expect(passwords.verify('pw', parts.slice(0, 4).concat(otherSalt, parts[5]).join('$'))).resolves.toBe(false);
  });

  it('自定义 saltBytes/keyLen：hash 自带参数，verify 以 hash 内参数为准（跨实例可校验）', async () => {
    const custom = createPasswordSupport({ saltBytes: 8, keyLen: 32 });
    const hash = await custom.hash('pw');
    const parts = hash.split('$');
    expect(parts[4]).toMatch(/^[0-9a-f]{16}$/); // 8 字节盐
    expect(parts[5]).toMatch(/^[0-9a-f]{64}$/); // 32 字节钥
    // 缺省实例（参数基线不同）也能按 hash 内记录的参数校验
    await expect(passwords.verify('pw', hash)).resolves.toBe(true);
    await expect(passwords.verify('nope', hash)).resolves.toBe(false);
  });

  it('非字符串入参：verify → false 不抛；hash → TypeError（异步拒绝）', async () => {
    await expect(passwords.verify(42 as unknown as string, 'x')).resolves.toBe(false);
    await expect(passwords.verify('pw', null as unknown as string)).resolves.toBe(false);
    await expect(passwords.verify(undefined as unknown as string, undefined as unknown as string)).resolves.toBe(false);
    await expect(passwords.hash(42 as unknown as string)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// safeEqualStrings
// ---------------------------------------------------------------------------

describe('safeEqualStrings', () => {
  it('等值 → true（含空串）', () => {
    expect(safeEqualStrings('hello', 'hello')).toBe(true);
    expect(safeEqualStrings('', '')).toBe(true);
    expect(safeEqualStrings('🎉 emoji', '🎉 emoji')).toBe(true);
  });

  it('同长不同值 → false', () => {
    expect(safeEqualStrings('hello', 'hellO')).toBe(false);
    expect(safeEqualStrings('aa', 'bb')).toBe(false);
  });

  it('长度不等 → false（前缀/超集/空 vs 非空）', () => {
    expect(safeEqualStrings('hello', 'hello!')).toBe(false);
    expect(safeEqualStrings('hello!', 'hello')).toBe(false);
    expect(safeEqualStrings('', 'x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kernel-handlers：auth.* 四个 topic（最小 deps 桩直调 handler）
// ---------------------------------------------------------------------------

/** 构造最小 kernel 桩：容器只登记 extManager.getManifest（auth.* 权限判定唯一数据源） */
function makeAuthHandlers(opts: {
  permissionsOf: (extId: string) => string[];
  auth?: { registerProvider(extId: string): void; unregisterProvider(extId: string): void };
}): KernelBridgeHandlers {
  const container = {
    resolve: (key: unknown) => {
      if (key === CONTAINER_KEYS.extManager) {
        return { getManifest: (id: string) => ({ permissions: opts.permissionsOf(id) }) };
      }
      throw new Error(`unexpected container.resolve(${String(key)})`);
    },
  };
  const kernelLike = { config: {}, logger: pino({ level: 'silent' }), container } as unknown as Kernel;
  return createKernelHandlers({
    kernel: kernelLike,
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
  });
}

function handlerOf(handlers: KernelBridgeHandlers, topic: string): (payload: unknown, from: string) => Promise<unknown> {
  const handler = handlers[topic];
  expect(handler, `handler for "${topic}" must exist`).toBeTypeOf('function');
  return handler as (payload: unknown, from: string) => Promise<unknown>;
}

describe('kernel-handlers auth.*', () => {
  const WITH_PERM = { permissionsOf: () => ['auth:provider'] };
  const NO_PERM = { permissionsOf: () => ['http'] };

  it('四个 auth topic 都有 handler', () => {
    const handlers = makeAuthHandlers(WITH_PERM);
    for (const topic of [
      KERNEL_TOPICS.authHashPassword,
      KERNEL_TOPICS.authVerifyPassword,
      KERNEL_TOPICS.authRegisterProvider,
      KERNEL_TOPICS.authUnregisterProvider,
    ]) {
      expect(handlers[topic]).toBeTypeOf('function');
    }
  });

  it('非扩展端点（kernel）调用 auth.* → RPC_PERMISSION_DENIED', async () => {
    const handlers = makeAuthHandlers(WITH_PERM);
    for (const topic of [
      KERNEL_TOPICS.authHashPassword,
      KERNEL_TOPICS.authVerifyPassword,
      KERNEL_TOPICS.authRegisterProvider,
      KERNEL_TOPICS.authUnregisterProvider,
    ]) {
      await expect(handlerOf(handlers, topic)({}, 'kernel')).rejects.toMatchObject({
        code: err('RPC_PERMISSION_DENIED').code,
      });
    }
  });

  it('无权限扩展调用 auth.hashPassword → FORBIDDEN（message 指明所需权限）', async () => {
    const handlers = makeAuthHandlers(NO_PERM);
    const e = await handlerOf(handlers, KERNEL_TOPICS.authHashPassword)({ password: 'pw' }, 'ext:some-ext').catch(
      (e: unknown) => e,
    );
    expect(e).toMatchObject({ code: err('FORBIDDEN').code, status: 403 });
    expect((e as Error).message).toContain('auth:provider');
  });

  it('无权限扩展调用 registerProvider/unregisterProvider/verifyPassword → FORBIDDEN', async () => {
    const handlers = makeAuthHandlers({ permissionsOf: (id) => (id === 'other' ? [] : ['http']) });
    for (const topic of [
      KERNEL_TOPICS.authVerifyPassword,
      KERNEL_TOPICS.authRegisterProvider,
      KERNEL_TOPICS.authUnregisterProvider,
    ]) {
      await expect(
        handlerOf(handlers, topic)({ password: 'pw', hash: 'x' }, 'ext:other'),
      ).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    }
  });

  it('有权限路径：hashPassword → hash，经 verifyPassword 往返 { ok: true }', async () => {
    const handlers = makeAuthHandlers(WITH_PERM);
    const { hash } = (await handlerOf(handlers, KERNEL_TOPICS.authHashPassword)(
      { password: 's3cret-pw' },
      'ext:auth',
    )) as { hash: string };
    expect(typeof hash).toBe('string');
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authVerifyPassword)({ password: 's3cret-pw', hash }, 'ext:auth'),
    ).resolves.toEqual({ ok: true });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authVerifyPassword)({ password: 'nope', hash }, 'ext:auth'),
    ).resolves.toEqual({ ok: false });
  });

  it('payload 形状非法 → BAD_REQUEST（缺 password / 非对象 / 类型不符）', async () => {
    const handlers = makeAuthHandlers(WITH_PERM);
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authHashPassword)({}, 'ext:auth'),
    ).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authHashPassword)({ password: 42 }, 'ext:auth'),
    ).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authVerifyPassword)({ password: 'pw' }, 'ext:auth'),
    ).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authVerifyPassword)(undefined, 'ext:auth'),
    ).rejects.toMatchObject({ code: err('BAD_REQUEST').code });
  });

  it('registerProvider：有权限 + 已接线 → 注入回调以 extId 触发，应答 { ok, name }', async () => {
    const registered: string[] = [];
    const handlers = makeAuthHandlers({
      permissionsOf: () => ['auth:provider'],
      auth: { registerProvider: (extId) => registered.push(extId), unregisterProvider: () => {} },
    });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authRegisterProvider)({}, 'ext:auth'),
    ).resolves.toEqual({ ok: true, name: 'auth' });
    expect(registered).toEqual(['auth']);
  });

  it('registerProvider：未接线（deps.auth 缺省）→ NOT_IMPLEMENTED', async () => {
    const handlers = makeAuthHandlers(WITH_PERM);
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authRegisterProvider)({}, 'ext:auth'),
    ).rejects.toMatchObject({ code: err('NOT_IMPLEMENTED').code });
  });

  it('unregisterProvider：回调以 extId 触发；未接线时幂等成功', async () => {
    const unregistered: string[] = [];
    const handlers = makeAuthHandlers({
      permissionsOf: () => ['auth:provider'],
      auth: { registerProvider: () => {}, unregisterProvider: (extId) => unregistered.push(extId) },
    });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authUnregisterProvider)({}, 'ext:auth'),
    ).resolves.toEqual({ ok: true, name: 'auth' });
    expect(unregistered).toEqual(['auth']);

    const unwired = makeAuthHandlers(WITH_PERM);
    await expect(
      handlerOf(unwired, KERNEL_TOPICS.authUnregisterProvider)({}, 'ext:auth'),
    ).resolves.toEqual({ ok: true, name: 'auth' });
  });

  it('host.call 权限门数据源一致：仅 manifest 含 auth:provider 的扩展放行', async () => {
    const handlers = makeAuthHandlers({
      permissionsOf: (id) => (id === 'auth' ? ['auth:provider'] : []),
      auth: { registerProvider: () => {}, unregisterProvider: () => {} },
    });
    await expect(handlerOf(handlers, KERNEL_TOPICS.authRegisterProvider)({}, 'ext:auth')).resolves.toMatchObject({ ok: true });
    await expect(
      handlerOf(handlers, KERNEL_TOPICS.authRegisterProvider)({}, 'ext:webui'),
    ).rejects.toMatchObject({ code: err('FORBIDDEN').code });
  });
});

// ---------------------------------------------------------------------------
// sandbox HarnessApi.authProvider（激活期登记）
// ---------------------------------------------------------------------------

describe('HarnessApi.authProvider', () => {
  it('非激活期拒绝；激活期登记进 collector；后注册覆盖前者；非函数 TypeError', () => {
    const collector = createContributionsCollector();
    let active = false;
    const harness = createHarnessApi({
      extId: 'auth',
      kernelCall: async () => ({}),
      contributions: collector,
      timers: createTimerRegistry(),
      activationPhase: () => active,
    });

    expect(() => harness.authProvider(async () => null)).toThrow(/setup/);

    active = true;
    const first = async () => null;
    harness.authProvider(first);
    expect(collector.handlers.authProvider).toBe(first);

    const second = async () => ({ userId: 'u1', role: 'normal' as const, scopes: [] });
    harness.authProvider(second);
    expect(collector.handlers.authProvider).toBe(second);

    expect(() => harness.authProvider('nope' as unknown as () => unknown)).toThrow(TypeError);
  });

  it('authProvider handler 不进 contributions 快照（handler 不可结构化克隆）', () => {
    const collector = createContributionsCollector();
    const harness = createHarnessApi({
      extId: 'auth',
      kernelCall: async () => ({}),
      contributions: collector,
      timers: createTimerRegistry(),
      activationPhase: () => true,
    });
    harness.authProvider(async () => null);
    expect(collector.snapshot()).not.toHaveProperty('authProvider');
  });
});

// ---------------------------------------------------------------------------
// manifest 白名单
// ---------------------------------------------------------------------------

describe("manifest 权限白名单 'auth:provider'", () => {
  it('validatePermissions 放行 auth:provider；未知权限仍拒绝（EXT_MANIFEST_INVALID）', () => {
    const base = { id: 'auth', api: 1, version: '1.0.0' };
    const withAuth = manifestSchema.parse({ ...base, permissions: ['auth:provider'] });
    expect(() => validatePermissions(withAuth)).not.toThrow();
    const unknown = manifestSchema.parse({ ...base, permissions: ['auth:root'] });
    const e = (() => {
      try {
        validatePermissions(unknown);
        return null;
      } catch (cause) {
        return cause;
      }
    })();
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).code).toBe('HARNESS-3001');
  });
});

// 协议常量存在性（防 topics/methods 拼写漂移）
describe('protocol 契约', () => {
  it('auth 相关 topics 与 host.authVerify 已登记', () => {
    expect(KERNEL_TOPICS.authHashPassword).toBe('auth.hashPassword');
    expect(KERNEL_TOPICS.authVerifyPassword).toBe('auth.verifyPassword');
    expect(KERNEL_TOPICS.authRegisterProvider).toBe('auth.registerProvider');
    expect(KERNEL_TOPICS.authUnregisterProvider).toBe('auth.unregisterProvider');
    expect(HOST_METHODS.authVerify).toBe('host.authVerify');
  });
});
