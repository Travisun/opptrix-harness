import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthProviderRegistry } from '../src/kernel/auth/AuthProviderRegistry.js';
import { createAuthChecker, extractToken } from '../src/kernel/auth/authProxy.js';
import { ensureRootToken } from '../src/kernel/auth/root-token.js';
import type { AuthProvider, AuthIdentity, AuthVerifyInput } from '../src/kernel/auth/types.js';
import { HarnessError } from '../src/kernel/errors/HarnessError.js';

const isHarnessError = (e: unknown): HarnessError => {
  expect(e).toBeInstanceOf(HarnessError);
  return e as HarnessError;
};

describe('ensureRootToken', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-root-token-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('source=env：cfg.token（≥32 字符）trim 后直接使用，不落盘', async () => {
    const d = path.join(dir, 'env');
    const envToken = 'e'.repeat(64);
    const res = await ensureRootToken({ token: `  ${envToken}  `, dataDir: d, persistRootToken: true });
    expect(res).toEqual({ token: envToken, source: 'env' });
    // 未创建任何文件
    await expect(readdir(d)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('HARNESS_TOKEN 过短（<32）→ VALIDATION_FAILED，信息含生成指引', async () => {
    const d = path.join(dir, 'short');
    const e = await ensureRootToken({ token: 'short-token', dataDir: d, persistRootToken: true }).catch(
      (e: unknown) => e,
    );
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-1009');
    expect(he.message).toContain('HARNESS_TOKEN');
    expect(he.message).toContain('openssl rand -hex 32');
    expect(he.message).not.toContain('short-token'); // 令牌值不回显
  });

  it('token 空白串视为未设置 → 走生成路径', async () => {
    const d = path.join(dir, 'blank');
    const res = await ensureRootToken({ token: '   ', dataDir: d, persistRootToken: false });
    expect(res.source).toBe('generated');
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('source=persisted：已有持久文件复用且多次一致', async () => {
    const d = path.join(dir, 'persisted');
    const file = path.join(d, 'root-token');
    await mkdir(d, { recursive: true });
    await writeFile(file, 'persisted-secret\n', { mode: 0o600 });

    const first = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(first).toEqual({ token: 'persisted-secret', source: 'persisted' });
    const second = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(second).toEqual({ token: 'persisted-secret', source: 'persisted' });
  });

  it('persisted 命中时 chmod 0600 兜底（修复历史过宽权限）', async () => {
    const d = path.join(dir, 'perm');
    const file = path.join(d, 'root-token');
    await mkdir(d, { recursive: true });
    await writeFile(file, 'persisted-perm-secret\n', { mode: 0o644 });

    const res = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(res).toEqual({ token: 'persisted-perm-secret', source: 'persisted' });
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('source=generated：新生成 64 位 hex 并以 0600 权限持久化，重启后转 persisted', async () => {
    const d = path.join(dir, 'generated');
    const first = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(first.source).toBe('generated');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);

    const file = path.join(d, 'root-token');
    const st = await stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    expect((await readFile(file, 'utf8')).trim()).toBe(first.token);

    const second = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(second).toEqual({ token: first.token, source: 'persisted' });
  });

  it('generated 持久化为原子写（tmp+rename）：不留 .tmp 残留', async () => {
    const d = path.join(dir, 'atomic');
    const res = await ensureRootToken({ token: '', dataDir: d, persistRootToken: true });
    expect(res.source).toBe('generated');
    const files = await readdir(d);
    expect(files).toContain('root-token');
    expect(files).not.toContain('root-token.tmp');
  });

  it('persistRootToken=false：生成但不落盘', async () => {
    const d = path.join(dir, 'no-persist');
    const res = await ensureRootToken({ token: '', dataDir: d, persistRootToken: false });
    expect(res.source).toBe('generated');
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    await expect(stat(path.join(d, 'root-token'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('AuthProviderRegistry', () => {
  const providerOf = (
    name: string,
    accept: (input: AuthVerifyInput) => AuthIdentity | null,
    hits: { n: number },
  ): AuthProvider => ({
    name,
    verify: async (input) => {
      hits.n += 1;
      return accept(input);
    },
  });

  it('按注册顺序尝试，第一个非 null 生效', async () => {
    const reg = new AuthProviderRegistry();
    const hitsA = { n: 0 };
    const hitsB = { n: 0 };
    reg.register(
      providerOf('a', (i) => (i.token === 'ta' ? { userId: 'ua', role: 'normal', scopes: ['s1'] } : null), hitsA),
    );
    reg.register(
      providerOf('b', () => ({ userId: 'ub', role: 'admin', scopes: ['*'] }), hitsB),
    );
    expect(reg.list()).toEqual(['a', 'b']);

    const hit = await reg.verify({ token: 'ta', headers: {} });
    expect(hit).toEqual({ userId: 'ua', role: 'normal', scopes: ['s1'] });
    expect(hitsA.n).toBe(1);
    expect(hitsB.n).toBe(0); // a 命中后 b 不再被尝试

    const miss = await reg.verify({ token: 'other', headers: {} });
    expect(miss).toEqual({ userId: 'ub', role: 'admin', scopes: ['*'] });
    expect(hitsA.n).toBe(2);
    expect(hitsB.n).toBe(1);
  });

  it('unregister 后不再参与验证；未知名静默；无 provider 返回 null', async () => {
    const reg = new AuthProviderRegistry();
    const hitsA = { n: 0 };
    const hitsB = { n: 0 };
    reg.register(providerOf('a', () => null, hitsA));
    reg.register(
      providerOf('b', () => ({ userId: 'ub', role: 'normal', scopes: [] }), hitsB),
    );

    reg.unregister('not-exist'); // 静默
    expect(reg.list()).toEqual(['a', 'b']);

    reg.unregister('a');
    expect(reg.list()).toEqual(['b']);
    await expect(reg.verify({ token: 'x', headers: {} })).resolves.toEqual({
      userId: 'ub',
      role: 'normal',
      scopes: [],
    });

    reg.unregister('b');
    expect(reg.list()).toEqual([]);
    await expect(reg.verify({ token: 'x', headers: {} })).resolves.toBeNull();
  });

  it('同名重复注册视为替换', () => {
    const reg = new AuthProviderRegistry();
    reg.register({ name: 'dup', verify: async () => null });
    reg.register({ name: 'dup', verify: async () => ({ userId: 'u2', role: 'normal', scopes: [] }) });
    expect(reg.list()).toEqual(['dup']);
  });
});

describe('createAuthChecker', () => {
  const registry = new AuthProviderRegistry();
  registry.register({
    name: 'static',
    verify: async (input) =>
      input.token === 'user-tok' ? { userId: 'u1', role: 'normal', scopes: ['chat.read'] } : null,
  });

  it('无 token → 401 HarnessError(UNAUTHORIZED)', async () => {
    const checker = createAuthChecker({ rootToken: 'root-tok', registry });
    const e = await checker({ headers: {} }).catch(isHarnessError);
    expect(e.status).toBe(401);
    expect(e.code).toBe('HARNESS-1006');
    expect(e.name).toBe('HarnessError');
  });

  it('空字符串 token 视为缺失 → 401', async () => {
    const checker = createAuthChecker({ rootToken: 'root-tok', registry });
    const e = await checker({ token: '', headers: {} }).catch(isHarnessError);
    expect(e.status).toBe(401);
  });

  it('root 命中：rootToken 值形式与函数形式都返回 root 身份', async () => {
    const checker = createAuthChecker({ rootToken: 'root-tok', registry });
    await expect(checker({ token: 'root-tok', headers: {} })).resolves.toEqual({
      userId: 'root',
      role: 'root',
      scopes: ['*'],
    });

    const fnChecker = createAuthChecker({ rootToken: () => 'root-tok', registry });
    await expect(fnChecker({ token: 'root-tok', headers: {} })).resolves.toEqual({
      userId: 'root',
      role: 'root',
      scopes: ['*'],
    });
  });

  it('provider 命中：返回 provider 身份', async () => {
    const checker = createAuthChecker({ rootToken: 'root-tok', registry });
    await expect(checker({ token: 'user-tok', headers: {} })).resolves.toEqual({
      userId: 'u1',
      role: 'normal',
      scopes: ['chat.read'],
    });
  });

  it('provider 拒绝 → 401 HarnessError', async () => {
    const checker = createAuthChecker({ rootToken: 'root-tok', registry });
    const e = await checker({ token: 'bad-tok', headers: {} }).catch(isHarnessError);
    expect(e.status).toBe(401);
    expect(e.code).toBe('HARNESS-1006');
  });
});

describe('extractToken', () => {
  it('Authorization: Bearer（大小写不敏感）', () => {
    expect(extractToken({ authorization: 'Bearer abc.def' })).toBe('abc.def');
    expect(extractToken({ Authorization: 'bearer tok' })).toBe('tok');
    expect(extractToken({ AUTHORIZATION: 'BEARER TOK' })).toBe('TOK');
  });

  it('无 Bearer / 无 token → undefined', () => {
    expect(extractToken({})).toBeUndefined();
    expect(extractToken({ authorization: 'Basic xyz' })).toBeUndefined();
    expect(extractToken({ authorization: 'Bearer' })).toBeUndefined();
    expect(extractToken({ authorization: 42 as unknown as string })).toBeUndefined();
  });

  it('query.token 兜底，Authorization 优先', () => {
    expect(extractToken({}, { token: 'qt' })).toBe('qt');
    expect(extractToken({ authorization: 'Bearer h' }, { token: 'q' })).toBe('h');
    expect(extractToken({}, { token: 42 })).toBeUndefined();
    expect(extractToken({}, { token: '' })).toBeUndefined();
    expect(extractToken({}, { token: ['a', 'b'] })).toBeUndefined();
  });
});
