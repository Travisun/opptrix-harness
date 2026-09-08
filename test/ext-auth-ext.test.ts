/**
 * extensions/auth — 内置认证扩展测试（node:vm 最小沙箱 + better-sqlite3 内存库透传）。
 *
 * 方法：读取 extensions/auth/index.js 源码 → 在全新 vm 上下文中执行（只注入全局
 * defineExtension 与沙箱约定注入的 crypto.getRandomValues；刻意不注入 console，
 * 误用即 ReferenceError）→ 捕获 setup → 注入 HarnessApi 形状的内存桩：
 * - h.db：真 better-sqlite3 `:memory:` 库，all/get/run/schema 四方法 SQL 直通；
 * - h.auth：内核真实现 createPasswordSupport（src/kernel/auth/ext-auth-support.ts，
 *   与 kernelCall auth.hashPassword / auth.verifyPassword 底层同源）；
 * - h.route / h.authProvider：捕获进 Map / 槽位，随后直接调用处理器模拟请求。
 *
 * 覆盖：契约 fail-fast、建表、owner 引导（boot/ctx/config 三通道与反例）、
 * login/logout/me/change-password、users CRUD 与 admin 门、api-key 签发/认证/吊销、
 * root 令牌直连、错误形状（HARNESS-1006/1007/1008/1009/1001）、源码卫生。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';

import { createPasswordSupport } from '../src/kernel/auth/ext-auth-support.js';

/** 内核 auth.hashToken topic 的同款实现（kernel-handlers.ts：SHA-256 hex）——测试桩与内核逐字对齐 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------------------
// 桩类型与脚手架
// ---------------------------------------------------------------------------

const EXT_INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'auth', 'index.js');
const ROOT_TOKEN = 'f'.repeat(64); // 64 hex，模拟 ensureRootToken 产出的 root 令牌

/** 路由处理器入参（HarnessApi RouteContext 的测试子集） */
interface RouteContextLike {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | undefined>;
  requestId: string;
}

/** AuthProvider 契约（kernel auth/types.ts AuthVerifyInput → AuthIdentity | null） */
type ProviderFn = (input: { token?: string; headers?: Record<string, unknown> }) => Promise<{
  userId: string;
  role: string;
  scopes: string[];
} | null>;

/** defineExtension 捕获到的 setup（当前 worker 只传 h；ctx 兼容通道在用例中显式传） */
type SetupFn = (h: AuthHarness, ctx?: { rootToken?: string }) => Promise<void>;

/** 扩展用到的 HarnessApi 子集（内存桩形状） */
interface AuthHarness {
  boot?: { rootToken: string };
  auth: {
    hashPassword(pw: string): Promise<string>;
    verifyPassword(pw: string, hash: string): Promise<boolean>;
    hashToken(value: string): Promise<{ hash: string }>;
  };
  authProvider(register: ProviderFn): void;
  route(method: string, routePath: string, handler: (ctx: RouteContextLike) => Promise<unknown>, opts?: { auth: string }): void;
  db: {
    all(sql: string, params?: unknown[]): Promise<unknown[]>;
    get(sql: string, params?: unknown[]): Promise<unknown>;
    run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
    schema(statements: string[]): Promise<void>;
  };
  config: { get(pathKey: string): Promise<unknown> };
  log: Record<'debug' | 'info' | 'warn' | 'error', (message: string, data?: unknown) => void>;
}

interface RouteDef {
  handler: (ctx: RouteContextLike) => Promise<unknown>;
  opts: { auth: string };
}

interface Booted {
  db: Database.Database;
  routes: Map<string, RouteDef>;
  getProvider(): ProviderFn;
  /** 激活扩展（等价内核 load → def.setup(h, ctx)） */
  activate(ctx?: { rootToken?: string }): Promise<void>;
}

const passwords = createPasswordSupport();

/** 读取源码并在全新 vm 上下文中执行，返回捕获到的 setup（每用例独立调用，零串扰） */
function loadSetup(): SetupFn {
  const capture: { setup: SetupFn | null } = { setup: null };
  // 最小沙箱：只注入 defineExtension 与 crypto（无 console/require/process —— 源码误用即抛）
  const sandbox = {
    defineExtension: (def: unknown) => {
      capture.setup = def as SetupFn;
    },
    crypto: webcrypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(EXT_INDEX, 'utf8'), sandbox, { filename: 'extensions/auth/index.js' });
  if (capture.setup === null) {
    throw new Error('extension source did not call defineExtension');
  }
  return capture.setup;
}

/** HarnessApi 形状的内存桩（fail-fast 用例可抽走 auth / authProvider 字段） */
function makeHarness(
  db: Database.Database,
  routes: Map<string, RouteDef>,
  providerSlot: { fn: ProviderFn | null },
  opts: { bootRootToken?: string; configRootToken?: string; omit?: Array<'auth' | 'authProvider'> } = {},
): AuthHarness {
  const h: AuthHarness = {
    ...(opts.bootRootToken === undefined ? {} : { boot: { rootToken: opts.bootRootToken } }),
    // 沙箱契约名 hashPassword/verifyPassword/hashToken；内核 topic 层即对本实现的薄封装（同名换皮）
    auth: {
      hashPassword: (pw: string) => passwords.hash(pw),
      verifyPassword: (pw: string, hash: string) => passwords.verify(pw, hash),
      // 与内核 kernel-handlers.ts auth.hashToken 同源：SHA-256 → { hash: 64hex }（令牌脱敏存储）
      hashToken: async (value: string) => ({ hash: sha256Hex(value) }),
    },
    authProvider: (register) => {
      providerSlot.fn = register;
    },
    route: (method, routePath, handler, opts) => {
      routes.set(`${String(method).toUpperCase()} ${routePath}`, { handler, opts: opts ?? { auth: 'public' } });
    },
    db: {
      all: async (sql, params = []) => db.prepare(sql).all(...params),
      get: async (sql, params = []) => db.prepare(sql).get(...params),
      run: async (sql, params = []) => db.prepare(sql).run(...params),
      schema: async (statements) => {
        for (const s of statements) db.exec(s);
      },
    },
    config: { get: async () => opts.configRootToken },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  for (const key of opts.omit ?? []) delete (h as Record<string, unknown>)[key];
  return h;
}

/** 一站式脚手架：新库 + 新沙箱 + 捕获面 */
function boot(opts: { bootRootToken?: string; configRootToken?: string } = {}): Booted {
  const db = new Database(':memory:');
  const routes = new Map<string, RouteDef>();
  const providerSlot: { fn: ProviderFn | null } = { fn: null };
  const setup = loadSetup();
  return {
    db,
    routes,
    getProvider: () => {
      if (providerSlot.fn === null) throw new Error('h.authProvider was not registered during setup');
      return providerSlot.fn;
    },
    activate: (ctx) => setup(makeHarness(db, routes, providerSlot, opts), ctx),
  };
}

/** 调用已注册路由（模拟内核 dispatch：构造 RouteContext 后直调处理器） */
async function call(
  routes: Map<string, RouteDef>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  routePath: string,
  init: Partial<RouteContextLike> = {},
): Promise<unknown> {
  const entry = routes.get(`${method} ${routePath}`);
  if (entry === undefined) throw new Error(`route not registered: ${method} ${routePath}`);
  return entry.handler({ params: {}, query: {}, body: undefined, headers: {}, requestId: 'test-req', ...init });
}

/** 便捷断言：错误形状 { status, body: { code } } */
function expectFail(res: unknown, status: number, code: string): void {
  expect(res).toMatchObject({ status, body: { code } });
}

/** Bearer 头便捷构造 */
function bearer(token: string): Record<string, string | undefined> {
  return { authorization: `Bearer ${token}` };
}

/** 便捷登录（owner 默认密码即 ROOT_TOKEN）；意外失败时抛出便于定位 */
async function login(
  b: Booted,
  username: string,
  password: string,
): Promise<{ token: string; expiresAt: number; user: { id: string; username: string; role: string } }> {
  const res = (await call(b.routes, 'POST', '/auth/login', { body: { username, password } })) as {
    token?: string;
    user?: { id: string; username: string; role: string };
    expiresAt?: number;
  };
  if (typeof res.token !== 'string' || res.user === undefined) {
    throw new Error(`login unexpectedly failed: ${JSON.stringify(res)}`);
  }
  return { token: res.token, expiresAt: res.expiresAt ?? 0, user: res.user };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

let src = '';

beforeAll(() => {
  src = readFileSync(EXT_INDEX, 'utf8');
});

describe('auth 扩展 · 激活期（setup）', () => {
  it('建三张表与索引（users / sessions / api_keys）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const names = (b.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as {
      name: string;
    }[]).map((r) => r.name);
    for (const t of ['users', 'sessions', 'api_keys', 'idx_sessions_user', 'idx_api_keys_user']) {
      expect(names).toContain(t);
    }
  });

  it('注册 authProvider 与全部 11 条路由，且全部声明 auth:"public"', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    b.getProvider(); // 未注册会 throw
    const expected = [
      'DELETE /auth/api-keys/:id',
      'DELETE /users/:id',
      'GET /auth/api-keys',
      'GET /auth/me',
      'GET /users',
      'PATCH /users/:id',
      'POST /auth/api-keys',
      'POST /auth/change-password',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /users',
    ];
    expect([...b.routes.keys()].sort()).toEqual(expected);
    for (const def of b.routes.values()) {
      expect(def.opts.auth).toBe('public');
    }
  });

  it('契约 fail-fast：缺 h.auth / h.authProvider / h.db → setup 拒绝且报错说清缺什么', async () => {
    const setup = loadSetup();
    const make = (omit: Array<'auth' | 'authProvider'>) => {
      const slot: { fn: ProviderFn | null } = { fn: null };
      return { setup, h: makeHarness(new Database(':memory:'), new Map(), slot, { omit }) };
    };
    await expect(setup(make(['auth']).h)).rejects.toThrow(
      /HarnessApi\.auth \{ hashPassword, verifyPassword, hashToken \}/,
    );
    await expect(setup(make(['authProvider']).h)).rejects.toThrow(/HarnessApi\.authProvider/);
  });

  it('owner 引导：users 空表 + h.boot.rootToken → owner/admin，密码可校验为 rootToken', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = b.db.prepare('SELECT id, username, role, password_hash FROM users').get() as {
      id: string;
      username: string;
      role: string;
      password_hash: string;
    };
    expect(owner.username).toBe('owner');
    expect(owner.role).toBe('admin');
    expect(owner.id).toMatch(/^usr_[0-9a-f]{24}$/);
    expect(await passwords.verify(ROOT_TOKEN, owner.password_hash)).toBe(true);
  });

  it('owner 引导兼容通道：h.boot 缺失时回落 ctx.rootToken', async () => {
    const b = boot(); // 无 h.boot
    await b.activate({ rootToken: ROOT_TOKEN });
    const owner = b.db.prepare('SELECT username, role FROM users').get() as { username: string; role: string };
    expect(owner).toMatchObject({ username: 'owner', role: 'admin' });
  });

  it('owner 引导兜底通道：ctx 亦缺时读 h.config.get("boot.rootToken")', async () => {
    const b = boot({ configRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = b.db.prepare('SELECT username FROM users').get() as { username: string };
    expect(owner.username).toBe('owner');
  });

  it('无 rootToken（三通道皆缺）→ 不引导 owner，setup 仍成功', async () => {
    const b = boot();
    await b.activate();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('users 非空时不重复引导（重载幂等）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(1); // 只有 owner，未二次插入
  });

  it('源码卫生：无 console.* / require( / process.（沙箱内也不注入这三者）', () => {
    expect(src).not.toMatch(/\bconsole\./);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bprocess\./);
  });
});

describe('auth 扩展 · login / 会话', () => {
  it('login 成功：ses_+48hex 令牌、7 天有效期入库、返回用户三字段；库内只存 SHA-256 hex（脱敏）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const before = Date.now();
    const res = await login(b, 'owner', ROOT_TOKEN);
    expect(res.token).toMatch(/^ses_[0-9a-f]{48}$/);
    expect(res.user).toMatchObject({ username: 'owner', role: 'admin' });
    expect(res.user.id).toMatch(/^usr_/);
    expect(res.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 1000);
    // T1 脱敏存储：token_hash 列 = 令牌的 SHA-256 hex，明文令牌不落库
    const row = b.db
      .prepare('SELECT token_hash, expires_at, created_at FROM sessions WHERE token_hash = ?')
      .get(sha256Hex(res.token)) as { token_hash: string; expires_at: number; created_at: number };
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(sha256Hex(res.token));
    expect(row.token_hash).not.toBe(res.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expires_at).toBe(res.expiresAt);
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    // 以明文令牌直查（旧版明文存储语义）→ 查不到
    const legacy = b.db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(res.token);
    expect(legacy).toBeUndefined();
  });

  it('令牌哈希迁移：setup 清除旧版明文 token_hash 残留行（sessions + api_keys），64-hex 行保留', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate(); // 首次 boot：建表 + owner 引导（v1 明文版本升级前的库）
    const now = Date.now();
    // 模拟升级前残留：直插旧版明文令牌行 + 一行合法 64-hex（新格式，应保留）
    b.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('ssn_plain', 'usr_legacy', 'ses_' + 'a'.repeat(48), now + 1000, now); // 明文（52 字符）→ 清除
    b.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('ssn_hashed', 'usr_legacy', sha256Hex('ses_' + 'b'.repeat(48)), now + 1000, now); // 64-hex → 保留
    b.db
      .prepare(
        'INSERT INTO api_keys (id, user_id, name, token_hash, scopes, expires_at, revoked, created_at)' +
          ' VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run('key_plain', 'usr_legacy', 'old', 'ak_' + 'c'.repeat(48), '["*"]', null, now); // 明文 → 清除

    await b.activate(); // 升级后再次 boot：迁移清理生效（幂等重跑）

    const sesHashes = (b.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]).map(
      (r) => r.token_hash,
    );
    expect(sesHashes).toEqual([sha256Hex('ses_' + 'b'.repeat(48))]); // 明文行已清除，合法哈希保留
    const keyCount = b.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number };
    expect(keyCount.n).toBe(0); // 明文 api_key 行已清除
  });

  it('login 密码错误 / 用户不存在：同为 401 HARNESS-1006，响应完全一致（不泄露存在性）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const badPw = await call(b.routes, 'POST', '/auth/login', { body: { username: 'owner', password: 'wrong-pass' } });
    const noUser = await call(b.routes, 'POST', '/auth/login', { body: { username: 'ghost', password: 'wrong-pass' } });
    expectFail(badPw, 401, 'HARNESS-1006');
    expect(noUser).toEqual(badPw);
  });

  it('login 缺参 → 400 HARNESS-1009（可操作信息）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    expectFail(await call(b.routes, 'POST', '/auth/login', { body: { username: 'owner' } }), 400, 'HARNESS-1009');
    expectFail(await call(b.routes, 'POST', '/auth/login', { body: { password: 'x' } }), 400, 'HARNESS-1009');
  });

  it('authProvider：会话令牌 → {userId, role, scopes:["*"]}；未知/过期令牌 → null', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const identity = await b.getProvider()({ token: ses.token, headers: {} });
    expect(identity).toMatchObject({ userId: ses.user.id, role: 'admin', scopes: ['*'] });

    expect(await b.getProvider()({ token: 'ses_' + '0'.repeat(48) })).toBeNull();
    expect(await b.getProvider()({ token: 'ak_' + '0'.repeat(48) })).toBeNull();
    expect(await b.getProvider()({ token: 'garbage' })).toBeNull();
    expect(await b.getProvider()({})).toBeNull();

    // 手工插入过期会话 → null（expires_at 判定生效）
    b.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('ssn_dead', ses.user.id, 'ses_' + 'd'.repeat(48), Date.now() - 1000, Date.now());
    expect(await b.getProvider()({ token: 'ses_' + 'd'.repeat(48) })).toBeNull();
  });

  it('logout：删除会话行；此后 provider 拒绝，重复 logout → 401', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const res = await call(b.routes, 'POST', '/auth/logout', { headers: bearer(ses.token) });
    expect(res).toEqual({ ok: true });
    expect(await b.getProvider()({ token: ses.token })).toBeNull();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(0);
    expectFail(await call(b.routes, 'POST', '/auth/logout', { headers: bearer(ses.token) }), 401, 'HARNESS-1006');
  });

  it('me：会话 / root 令牌分别回显身份与 tokenType；支持 query.token；无令牌 → 401', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);

    const meSes = (await call(b.routes, 'GET', '/auth/me', { headers: bearer(ses.token) })) as {
      userId: string;
      username: string | null;
      role: string;
      tokenType: string;
    };
    expect(meSes).toMatchObject({ userId: ses.user.id, username: 'owner', role: 'admin', tokenType: 'session' });

    // root 令牌直连（与内核 authProxy root 语义一致）
    const meRoot = (await call(b.routes, 'GET', '/auth/me', { headers: bearer(ROOT_TOKEN) })) as {
      userId: string;
      role: string;
      tokenType: string;
    };
    expect(meRoot).toMatchObject({ userId: 'root', role: 'root', tokenType: 'root' });

    // query.token 兜底通道（与内核 extractToken 语义对齐）
    const meQuery = (await call(b.routes, 'GET', '/auth/me', { query: { token: ses.token } })) as { userId: string };
    expect(meQuery.userId).toBe(ses.user.id);

    expectFail(await call(b.routes, 'GET', '/auth/me'), 401, 'HARNESS-1006');
  });

  it('change-password：短密码 400；旧密码错 401；成功后改哈希并撤销其他会话', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const sesA = await login(b, 'owner', ROOT_TOKEN);
    const sesB = await login(b, 'owner', ROOT_TOKEN); // 待被撤销的"另一端"会话

    expectFail(
      await call(b.routes, 'POST', '/auth/change-password', {
        headers: bearer(sesA.token),
        body: { oldPassword: ROOT_TOKEN, newPassword: 'short' },
      }),
      400,
      'HARNESS-1009',
    );
    expectFail(
      await call(b.routes, 'POST', '/auth/change-password', {
        headers: bearer(sesA.token),
        body: { oldPassword: 'not-the-old', newPassword: 'long-enough-8' },
      }),
      401,
      'HARNESS-1006',
    );

    const ok = (await call(b.routes, 'POST', '/auth/change-password', {
      headers: bearer(sesA.token),
      body: { oldPassword: ROOT_TOKEN, newPassword: 'new-password-8' },
    })) as { ok: boolean; revokedOtherSessions: number };
    expect(ok).toMatchObject({ ok: true, revokedOtherSessions: 1 });

    // 另一会话已失效；当前会话保留；旧密码不可登录，新密码可登录
    expect(await b.getProvider()({ token: sesB.token })).toBeNull();
    expect(await b.getProvider()({ token: sesA.token })).not.toBeNull();
    expectFail(
      await call(b.routes, 'POST', '/auth/login', { body: { username: 'owner', password: ROOT_TOKEN } }),
      401,
      'HARNESS-1006',
    );
    const relogin = await login(b, 'owner', 'new-password-8');
    expect(relogin.token).toMatch(/^ses_[0-9a-f]{48}$/);
  });

  it('会话门：API Key / root 令牌 / 匿名均不能 logout 或 change-password', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const key = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(ses.token),
      body: { name: 'ci' },
    })) as { token: string };

    expectFail(await call(b.routes, 'POST', '/auth/logout', { headers: bearer(key.token) }), 401, 'HARNESS-1006');
    expectFail(
      await call(b.routes, 'POST', '/auth/change-password', {
        headers: bearer(key.token),
        body: { oldPassword: 'x', newPassword: 'yyyyyyyy' },
      }),
      401,
      'HARNESS-1006',
    );
    expectFail(await call(b.routes, 'POST', '/auth/logout', { headers: bearer(ROOT_TOKEN) }), 401, 'HARNESS-1006');
    expectFail(await call(b.routes, 'POST', '/auth/logout'), 401, 'HARNESS-1006');
  });
});

describe('auth 扩展 · API Keys', () => {
  it('签发：ak_+48hex 一次性返回明文；provider 校验通过且 scopes 生效；列表不回显令牌', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const key = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(ses.token),
      body: { name: 'ci', scopes: ['chat:send'] },
    })) as { id: string; token: string };
    expect(key.token).toMatch(/^ak_[0-9a-f]{48}$/);

    const identity = await b.getProvider()({ token: key.token });
    expect(identity).toMatchObject({ role: 'admin', scopes: ['chat:send'] });
    const sesIdentity = await b.getProvider()({ token: ses.token });
    expect(identity?.userId).toBe(sesIdentity?.userId);

    const list = (await call(b.routes, 'GET', '/auth/api-keys', { headers: bearer(ses.token) })) as {
      apiKeys: { id: string; name: string; scopes: string[]; revoked: boolean }[];
    };
    expect(list.apiKeys).toHaveLength(1);
    expect(list.apiKeys[0]).toMatchObject({ id: key.id, name: 'ci', scopes: ['chat:send'], revoked: false });
    expect(JSON.stringify(list)).not.toContain(key.token);
    expect(JSON.stringify(list)).not.toContain('token_hash');
  });

  it('expiresInDays 落库 expires_at；缺省为 null（长期）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const k1 = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(ses.token),
      body: { name: 'day', expiresInDays: 1 },
    })) as { expiresAt: number | null };
    const k2 = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(ses.token),
      body: { name: 'forever' },
    })) as { expiresAt: number | null };
    expect(k1.expiresAt).not.toBeNull();
    expect(k1.expiresAt as number).toBeGreaterThan(Date.now());
    expect(k2.expiresAt).toBeNull();
  });

  it('非法入参 → 400 HARNESS-1009（name 空 / scopes 形状 / expiresInDays 越界）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const ses = await login(b, 'owner', ROOT_TOKEN);
    const mk = (body: unknown) => call(b.routes, 'POST', '/auth/api-keys', { headers: bearer(ses.token), body });
    expectFail(await mk({ name: '  ' }), 400, 'HARNESS-1009');
    expectFail(await mk({ name: 'x', scopes: 'chat:send' }), 400, 'HARNESS-1009');
    expectFail(await mk({ name: 'x', scopes: [] }), 400, 'HARNESS-1009');
    expectFail(await mk({ name: 'x', expiresInDays: 0 }), 400, 'HARNESS-1009');
    expectFail(await mk({ name: 'x', expiresInDays: 1.5 }), 400, 'HARNESS-1009');
  });

  it('吊销：provider 立即拒绝；他人的 key / 不存在的 key → 404 不泄露存在性', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = await login(b, 'owner', ROOT_TOKEN);
    const own = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(owner.token),
      body: { name: 'mine' },
    })) as { id: string; token: string };

    // 另一个用户（normal）建自己的 key
    await call(b.routes, 'POST', '/users', {
      headers: bearer(owner.token),
      body: { username: 'alice', password: 'alice-pass-8' },
    });
    const alice = await login(b, 'alice', 'alice-pass-8');
    const aliceKey = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(alice.token),
      body: { name: 'alice-ci' },
    })) as { id: string; token: string };

    expectFail(
      await call(b.routes, 'DELETE', '/auth/api-keys/:id', { headers: bearer(alice.token), params: { id: own.id } }),
      404,
      'HARNESS-1001',
    );
    expectFail(
      await call(b.routes, 'DELETE', '/auth/api-keys/:id', { headers: bearer(owner.token), params: { id: 'key_nope' } }),
      404,
      'HARNESS-1001',
    );

    const ok = (await call(b.routes, 'DELETE', '/auth/api-keys/:id', {
      headers: bearer(alice.token),
      params: { id: aliceKey.id },
    })) as { ok: boolean; revoked: boolean };
    expect(ok).toEqual({ ok: true, revoked: true });
    expect(await b.getProvider()({ token: aliceKey.token })).toBeNull();
    // 吊销不影响他人的 key
    expect(await b.getProvider()({ token: own.token })).not.toBeNull();
  });
});

describe('auth 扩展 · users 管理（admin 门）', () => {
  it('normal 用户访问 /users → 403 HARNESS-1007；匿名 → 401；admin 的 API Key 可过角色门', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = await login(b, 'owner', ROOT_TOKEN);
    await call(b.routes, 'POST', '/users', {
      headers: bearer(owner.token),
      body: { username: 'alice', password: 'alice-pass-8' },
    });
    const alice = await login(b, 'alice', 'alice-pass-8');

    expectFail(await call(b.routes, 'GET', '/users'), 401, 'HARNESS-1006');
    expectFail(await call(b.routes, 'GET', '/users', { headers: bearer(alice.token) }), 403, 'HARNESS-1007');

    const key = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(owner.token),
      body: { name: 'admin-key' },
    })) as { token: string };
    const list = (await call(b.routes, 'GET', '/users', { headers: bearer(key.token) })) as { users: unknown[] };
    expect(list.users).toHaveLength(2);
  });

  it('POST /users：创建入列（对外形状无 password_hash）；重名 400；短密码/坏角色 400', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = await login(b, 'owner', ROOT_TOKEN);

    const created = (await call(b.routes, 'POST', '/users', {
      headers: bearer(owner.token),
      body: { username: 'bob', password: 'bob-pass-8', role: 'normal' },
    })) as { id: string; username: string; role: string; createdAt: number };
    expect(created.username).toBe('bob');
    expect(created.id).toMatch(/^usr_[0-9a-f]{24}$/);

    const list = (await call(b.routes, 'GET', '/users', { headers: bearer(owner.token) })) as {
      users: Record<string, unknown>[];
    };
    expect(list.users.map((u) => u['username'])).toEqual(['owner', 'bob']);
    for (const u of list.users) {
      expect(Object.keys(u).sort()).toEqual(['createdAt', 'id', 'role', 'username']);
    }

    expectFail(
      await call(b.routes, 'POST', '/users', {
        headers: bearer(owner.token),
        body: { username: 'bob', password: 'zzzzzzzz' },
      }),
      400,
      'HARNESS-1008',
    );
    expectFail(
      await call(b.routes, 'POST', '/users', { headers: bearer(owner.token), body: { username: 'carol', password: 'short' } }),
      400,
      'HARNESS-1009',
    );
    expectFail(
      await call(b.routes, 'POST', '/users', {
        headers: bearer(owner.token),
        body: { username: 'carol', password: 'long-enough', role: 'superuser' },
      }),
      400,
      'HARNESS-1009',
    );
  });

  it('PATCH /users/:id：改密后新密码可登录、旧密码失效；改角色生效并回读；未知用户 404', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = await login(b, 'owner', ROOT_TOKEN);
    const created = (await call(b.routes, 'POST', '/users', {
      headers: bearer(owner.token),
      body: { username: 'bob', password: 'bob-pass-8' },
    })) as { id: string };

    const patched = (await call(b.routes, 'PATCH', '/users/:id', {
      headers: bearer(owner.token),
      params: { id: created.id },
      body: { role: 'admin', password: 'bob-new-pass-8' },
    })) as { id: string; role: string; username: string };
    expect(patched).toMatchObject({ id: created.id, role: 'admin', username: 'bob' });

    expectFail(
      await call(b.routes, 'POST', '/auth/login', { body: { username: 'bob', password: 'bob-pass-8' } }),
      401,
      'HARNESS-1006',
    );
    const relogin = await login(b, 'bob', 'bob-new-pass-8');
    expect(relogin.user.role).toBe('admin');

    expectFail(
      await call(b.routes, 'PATCH', '/users/:id', {
        headers: bearer(owner.token),
        params: { id: 'usr_nope' },
        body: { role: 'normal' },
      }),
      404,
      'HARNESS-1001',
    );
  });

  it('保护规则：降级/删除最后一个 admin 400；删自己 400；删 normal 用户连带清凭据', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    const owner = await login(b, 'owner', ROOT_TOKEN);
    const created = (await call(b.routes, 'POST', '/users', {
      headers: bearer(owner.token),
      body: { username: 'bob', password: 'bob-pass-8' },
    })) as { id: string };
    const me = (await call(b.routes, 'GET', '/auth/me', { headers: bearer(owner.token) })) as { userId: string };

    // 唯一 admin：不可降级、不可删除自己（最后一个 admin）
    expectFail(
      await call(b.routes, 'PATCH', '/users/:id', {
        headers: bearer(owner.token),
        params: { id: me.userId },
        body: { role: 'normal' },
      }),
      400,
      'HARNESS-1008',
    );
    expectFail(
      await call(b.routes, 'DELETE', '/users/:id', { headers: bearer(owner.token), params: { id: me.userId } }),
      400,
      'HARNESS-1008',
    );

    // bob 建会话与 key，随后被删除 → 凭据一并清空
    const bob = await login(b, 'bob', 'bob-pass-8');
    const bobKey = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(bob.token),
      body: { name: 'bob-key' },
    })) as { token: string };
    const del = await call(b.routes, 'DELETE', '/users/:id', {
      headers: bearer(owner.token),
      params: { id: created.id },
    });
    expect(del).toEqual({ ok: true });
    expect(await b.getProvider()({ token: bob.token })).toBeNull();
    expect(await b.getProvider()({ token: bobKey.token })).toBeNull();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
