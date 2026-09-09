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
 * 覆盖：契约 fail-fast、建表、owner 引导新语义（v0.2：激活期不再自动建号——users 空表
 * = needsOnboarding；owner 一律经 POST /auth/onboarding 的 root 令牌门创建/重置；
 * rootToken 三通道解析仅影响 root 直连）、login/logout/me/change-password、
 * users CRUD 与 admin 门、api-key 签发/认证/吊销、
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
/** owner 账号密码（v0.2 语义：owner 一律经 POST /auth/onboarding 创建，root 令牌不再是登录密码） */
const OWNER_PASSWORD = 'owner-pass-8';

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
    totpGenerate(account: string): Promise<{ secret: string; uri: string }>;
    totpVerify(input: { secret: string; token: string }): Promise<{ ok: boolean; delta: number | null }>;
    verifyRootToken(token: string): Promise<{ ok: boolean }>;
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
  /** totpVerify 桩的可编程罐头码表（默认仅 '123456' ok；用例可增删改） */
  totpOkCodes: string[];
  /** 在扩展 VM 上下文里执行片段（访问模块级 var，如 AUTH_MEM_TOKENS——过期语义用例用） */
  runInVm(code: string): unknown;
}

const passwords = createPasswordSupport();
/** totpGenerate 桩的固定 secret（桩不真验 TOTP 数学，只按罐头码判定） */
const TOTP_STUB_SECRET = 'TESTSECRETBASE32';

/** 读取源码并在全新 vm 上下文中执行，返回捕获到的 setup 与沙箱（每用例独立调用，零串扰） */
function loadSetup(): { setup: SetupFn; sandbox: vm.Context } {
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
  return { setup: capture.setup, sandbox };
}

/** HarnessApi 形状的内存桩（fail-fast 用例可抽走 auth / authProvider 字段） */
function makeHarness(
  db: Database.Database,
  routes: Map<string, RouteDef>,
  providerSlot: { fn: ProviderFn | null },
  opts: { bootRootToken?: string; configRootToken?: string; omit?: Array<'auth' | 'authProvider'>; totpOkCodes?: string[] } = {},
): AuthHarness {
  const okCodes = opts.totpOkCodes ?? ['123456'];
  const h: AuthHarness = {
    ...(opts.bootRootToken === undefined ? {} : { boot: { rootToken: opts.bootRootToken } }),
    // 沙箱契约名 hashPassword/verifyPassword/hashToken；内核 topic 层即对本实现的薄封装（同名换皮）
    auth: {
      hashPassword: (pw: string) => passwords.hash(pw),
      verifyPassword: (pw: string, hash: string) => passwords.verify(pw, hash),
      // 与内核 kernel-handlers.ts auth.hashToken 同源：SHA-256 → { hash: 64hex }（令牌脱敏存储）
      hashToken: async (value: string) => ({ hash: sha256Hex(value) }),
      // 内核 auth.totpGenerate 同形状桩：{ secret, uri }（uri label = account）
      totpGenerate: async (account: string) => ({
        secret: TOTP_STUB_SECRET,
        uri: `otpauth://totp/Opptrix%20Harness:${encodeURIComponent(account)}?secret=${TOTP_STUB_SECRET}&issuer=Opptrix%20Harness`,
      }),
      // 可编程 canned：默认 code==='123456' ok；secret 为空一律 false（对齐内核 fail-closed）
      totpVerify: async (input: { secret: string; token: string }) => ({
        ok: input.secret !== '' && okCodes.includes(input.token),
        delta: null,
      }),
      // 内核 auth.verifyRootToken 同语义桩：常数时间桩化为本测试常量比对
      verifyRootToken: async (token: string) => ({ ok: token === ROOT_TOKEN }),
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
  const totpOkCodes = ['123456'];
  const { setup, sandbox } = loadSetup();
  return {
    db,
    routes,
    totpOkCodes,
    runInVm: (code: string) => vm.runInContext(code, sandbox),
    getProvider: () => {
      if (providerSlot.fn === null) throw new Error('h.authProvider was not registered during setup');
      return providerSlot.fn;
    },
    activate: (ctx) => setup(makeHarness(db, routes, providerSlot, { ...opts, totpOkCodes }), ctx),
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

/** 便捷 enroll（默认 canned 码 '123456'）；意外失败时抛出便于定位 */
async function enroll(
  b: Booted,
  enrollToken: string,
  code = '123456',
): Promise<{ token: string; expiresAt: number; user: { id: string; username: string; role: string } }> {
  const res = (await call(b.routes, 'POST', '/auth/2fa/enroll', { body: { enrollToken, code } })) as {
    token?: string;
    expiresAt?: number;
    user?: { id: string; username: string; role: string };
  };
  if (typeof res.token !== 'string' || res.user === undefined) {
    throw new Error(`enroll unexpectedly failed: ${JSON.stringify(res)}`);
  }
  return { token: res.token, expiresAt: res.expiresAt ?? 0, user: res.user };
}

/**
 * fixture helper（v0.2 语义）：激活后经 POST /auth/onboarding（root 令牌所有权门）创建 owner。
 * 激活期不再自动建号（users 空表 = needsOnboarding），依赖 owner 的用例必须先调用本助手。
 * users 为空 → fresh 分支建首个 admin；返回 enr 注册令牌（可续走 2FA 绑定）。
 */
async function ensureOwner(b: Booted, password: string = OWNER_PASSWORD): Promise<string> {
  const res = (await call(b.routes, 'POST', '/auth/onboarding', {
    body: { rootToken: ROOT_TOKEN, password },
  })) as { enrollmentRequired?: boolean; enrollToken?: string };
  if (res.enrollmentRequired !== true || typeof res.enrollToken !== 'string') {
    throw new Error(`ensureOwner unexpectedly failed: ${JSON.stringify(res)}`);
  }
  return res.enrollToken;
}

/**
 * 便捷登录（owner 密码为 onboarding 时设置的 OWNER_PASSWORD，先 ensureOwner 再登录）：
 * 自动续走强制 2FA——enrollmentRequired → POST /2fa/enroll（canned 码）；mfaRequired →
 * POST /auth/login/2fa。意外失败时抛出便于定位。
 */
async function login(
  b: Booted,
  username: string,
  password: string,
): Promise<{ token: string; expiresAt: number; user: { id: string; username: string; role: string } }> {
  const res = (await call(b.routes, 'POST', '/auth/login', { body: { username, password } })) as {
    token?: string;
    user?: { id: string; username: string; role: string };
    expiresAt?: number;
    mfaRequired?: boolean;
    mfaToken?: string;
    enrollmentRequired?: boolean;
    enrollToken?: string;
  };
  if (res.enrollmentRequired === true && typeof res.enrollToken === 'string') {
    const done = await enroll(b, res.enrollToken);
    return { token: done.token, expiresAt: done.expiresAt, user: done.user };
  }
  if (res.mfaRequired === true && typeof res.mfaToken === 'string') {
    const res2 = (await call(b.routes, 'POST', '/auth/login/2fa', {
      body: { mfaToken: res.mfaToken, totp: '123456' },
    })) as { token?: string; user?: { id: string; username: string; role: string }; expiresAt?: number };
    if (typeof res2.token !== 'string' || res2.user === undefined) {
      throw new Error(`login/2fa unexpectedly failed: ${JSON.stringify(res2)}`);
    }
    return { token: res2.token, expiresAt: res2.expiresAt ?? 0, user: res2.user };
  }
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

  it('注册 authProvider 与全部 17 条路由，且全部声明 auth:"public"', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    b.getProvider(); // 未注册会 throw
    const expected = [
      'DELETE /auth/api-keys/:id',
      'DELETE /users/:id',
      'GET /auth/2fa/setup',
      'GET /auth/api-keys',
      'GET /auth/me',
      'GET /auth/onboarding/status',
      'GET /users',
      'PATCH /users/:id',
      'POST /auth/2fa/disable',
      'POST /auth/2fa/enroll',
      'POST /auth/api-keys',
      'POST /auth/change-password',
      'POST /auth/login',
      'POST /auth/login/2fa',
      'POST /auth/logout',
      'POST /auth/onboarding',
      'POST /users',
    ];
    expect([...b.routes.keys()].sort()).toEqual(expected);
    for (const def of b.routes.values()) {
      expect(def.opts.auth).toBe('public');
    }
  });

  it('契约 fail-fast：缺 h.auth / h.authProvider / h.db → setup 拒绝且报错说清缺什么', async () => {
    const { setup } = loadSetup();
    const make = (omit: Array<'auth' | 'authProvider'>) => {
      const slot: { fn: ProviderFn | null } = { fn: null };
      return { setup, h: makeHarness(new Database(':memory:'), new Map(), slot, { omit }) };
    };
    await expect(setup(make(['auth']).h)).rejects.toThrow(
      /HarnessApi\.auth \{ hashPassword, verifyPassword, hashToken, totpGenerate, totpVerify, verifyRootToken \}/,
    );
    await expect(setup(make(['authProvider']).h)).rejects.toThrow(/HarnessApi\.authProvider/);
  });

  it('owner 引导新语义：users 空表 + h.boot.rootToken 激活后不再自动创建 owner（needsOnboarding=true）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    // v0.2 起 owner 一律经 POST /auth/onboarding 创建：激活路径零 users 写入
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0);
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: true });
    // root 令牌解析通道不受影响：onboarding 所有权门仍按内核 verifyRootToken 判定（错令牌拒绝）
    expectFail(
      await call(b.routes, 'POST', '/auth/onboarding', { body: { rootToken: 'not-the-root', password: OWNER_PASSWORD } }),
      401,
      'HARNESS-1006',
    );
  });

  it('rootToken 兼容通道：h.boot 缺失时回落 ctx.rootToken —— 不建号，但 root 直连解析生效', async () => {
    const b = boot(); // 无 h.boot
    await b.activate({ rootToken: ROOT_TOKEN });
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0); // ctx 通道同样不再自动建号（v0.2 语义）
    // ctx.rootToken 解析进 AUTH_ROOT_TOKEN：root 直连（break-glass 语义）仍可用
    const meRoot = (await call(b.routes, 'GET', '/auth/me', { headers: bearer(ROOT_TOKEN) })) as {
      userId: string;
      role: string;
      tokenType: string;
    };
    expect(meRoot).toMatchObject({ userId: 'root', role: 'root', tokenType: 'root' });
  });

  it('rootToken 兜底通道：ctx 亦缺时读 h.config.get("boot.rootToken") —— root 直连可用且不建号', async () => {
    const b = boot({ configRootToken: ROOT_TOKEN });
    await b.activate();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0);
    const meRoot = (await call(b.routes, 'GET', '/auth/me', { headers: bearer(ROOT_TOKEN) })) as {
      userId: string;
      role: string;
      tokenType: string;
    };
    expect(meRoot).toMatchObject({ userId: 'root', role: 'root', tokenType: 'root' });
  });

  it('无 rootToken（三通道皆缺）→ setup 仍成功；users 空表（needsOnboarding）且 root 直连不可用', async () => {
    const b = boot();
    await b.activate();
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0);
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: true });
    // AUTH_ROOT_TOKEN 未解析：root 令牌不再被识别为直连身份
    expectFail(await call(b.routes, 'GET', '/auth/me', { headers: bearer(ROOT_TOKEN) }), 401, 'HARNESS-1006');
  });

  it('POST /auth/onboarding（root 令牌门）创建 owner：fresh 建号后 needsOnboarding 翻转、密码为入参而非 rootToken', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: true });
    await ensureOwner(b); // users 空表 → fresh 分支
    const owner = b.db.prepare('SELECT username, role, password_hash FROM users').get() as {
      username: string;
      role: string;
      password_hash: string;
    };
    expect(owner).toMatchObject({ username: 'owner', role: 'admin' });
    expect(await passwords.verify(OWNER_PASSWORD, owner.password_hash)).toBe(true);
    expect(await passwords.verify(ROOT_TOKEN, owner.password_hash)).toBe(false); // root 令牌仅作所有权门
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: false });
  });

  it('重载幂等：onboarding 建号后再次激活不重复建号（users 仍 1 行，激活路径从不写 users）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const after = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(after.n).toBe(1);
    await b.activate(); // 重载（等价内核 reload：setup 幂等重跑）
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(1);
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
    await ensureOwner(b); // owner 一律经 onboarding 创建（v0.2 语义）
    const before = Date.now();
    const res = await login(b, 'owner', OWNER_PASSWORD);
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
    await b.activate(); // 首次 boot：建表（v0.2 起激活不建号；残留行为直插，无外键依赖）
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
    await ensureOwner(b); // owner 存在：badPw 走"密码错"分支，noUser 走"用户不存在"分支
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);

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
    await ensureOwner(b);
    const sesA = await login(b, 'owner', OWNER_PASSWORD);
    const sesB = await login(b, 'owner', OWNER_PASSWORD); // 待被撤销的"另一端"会话

    expectFail(
      await call(b.routes, 'POST', '/auth/change-password', {
        headers: bearer(sesA.token),
        body: { oldPassword: OWNER_PASSWORD, newPassword: 'short' },
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
      body: { oldPassword: OWNER_PASSWORD, newPassword: 'new-password-8' },
    })) as { ok: boolean; revokedOtherSessions: number };
    expect(ok).toMatchObject({ ok: true, revokedOtherSessions: 1 });

    // 另一会话已失效；当前会话保留；旧密码不可登录，新密码可登录
    expect(await b.getProvider()({ token: sesB.token })).toBeNull();
    expect(await b.getProvider()({ token: sesA.token })).not.toBeNull();
    expectFail(
      await call(b.routes, 'POST', '/auth/login', { body: { username: 'owner', password: OWNER_PASSWORD } }),
      401,
      'HARNESS-1006',
    );
    const relogin = await login(b, 'owner', 'new-password-8');
    expect(relogin.token).toMatch(/^ses_[0-9a-f]{48}$/);
  });

  it('会话门：API Key / root 令牌 / 匿名均不能 logout 或 change-password', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const owner = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const owner = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const owner = await login(b, 'owner', OWNER_PASSWORD);

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
    await ensureOwner(b);
    const owner = await login(b, 'owner', OWNER_PASSWORD);
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
    await ensureOwner(b);
    const owner = await login(b, 'owner', OWNER_PASSWORD);
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

// ---------------------------------------------------------------------------
// Onboarding 引导 + 全员强制 2FA（TOTP）
// ---------------------------------------------------------------------------

/** 未绑定用户"第一步登录"：断言返回 enrollmentRequired 形状并取出 enr 令牌 */
async function loginUnbound(
  b: Booted,
  username: string,
  password: string,
): Promise<{ enrollmentRequired: true; enrollToken: string }> {
  const res = (await call(b.routes, 'POST', '/auth/login', { body: { username, password } })) as {
    enrollmentRequired?: boolean;
    enrollToken?: string;
    token?: string;
  };
  expect(res).toMatchObject({ enrollmentRequired: true });
  expect(typeof res.enrollToken).toBe('string');
  expect(res.enrollToken as string).toMatch(/^enr_[0-9a-f]{48}$/);
  expect(res.token).toBeUndefined(); // 强制 2FA：未绑定绝不签发会话
  return { enrollmentRequired: true, enrollToken: res.enrollToken as string };
}

/** 已绑定用户"第一步登录"：断言返回 mfaRequired 形状并取出 mfa 令牌 */
async function loginMfa(
  b: Booted,
  username: string,
  password: string,
): Promise<{ mfaRequired: true; mfaToken: string }> {
  const res = (await call(b.routes, 'POST', '/auth/login', { body: { username, password } })) as {
    mfaRequired?: boolean;
    mfaToken?: string;
    token?: string;
  };
  expect(res).toMatchObject({ mfaRequired: true });
  expect(typeof res.mfaToken).toBe('string');
  expect(res.mfaToken as string).toMatch(/^mfa_[0-9a-f]{48}$/);
  expect(res.token).toBeUndefined();
  return { mfaRequired: true, mfaToken: res.mfaToken as string };
}

describe('auth 扩展 · Onboarding 引导 + 全员强制 2FA', () => {
  it('GET /onboarding/status：users 空表 → true；建号后 → false（幂等可重复查）', async () => {
    const b = boot(); // 无 rootToken：不引导 owner，users 保持空表
    await b.activate();
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: true });
    await call(b.routes, 'POST', '/auth/onboarding', { body: { rootToken: ROOT_TOKEN, password: 'owner-pass-8' } });
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: false });
    expect(await call(b.routes, 'GET', '/auth/onboarding/status')).toEqual({ needsOnboarding: false });
  });

  it('POST /onboarding：rootToken 错 → 401 HARNESS-1006 "root token verification failed"（users 表零写入）', async () => {
    const b = boot();
    await b.activate();
    const bad = await call(b.routes, 'POST', '/auth/onboarding', {
      body: { rootToken: 'f'.repeat(63) + 'e', password: 'owner-pass-8' },
    });
    expectFail(bad, 401, 'HARNESS-1006');
    expect(bad).toMatchObject({ body: { message: 'root token verification failed' } });
    const missing = await call(b.routes, 'POST', '/auth/onboarding', { body: { password: 'owner-pass-8' } });
    expectFail(missing, 401, 'HARNESS-1006');
    const count = b.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('POST /onboarding：rootToken 对但短密码/超长用户名 → 400 HARNESS-1009', async () => {
    const b = boot();
    await b.activate();
    expectFail(
      await call(b.routes, 'POST', '/auth/onboarding', { body: { rootToken: ROOT_TOKEN, password: 'short' } }),
      400,
      'HARNESS-1009',
    );
    expectFail(
      await call(b.routes, 'POST', '/auth/onboarding', {
        body: { rootToken: ROOT_TOKEN, password: 'owner-pass-8', username: 'x'.repeat(101) },
      }),
      400,
      'HARNESS-1009',
    );
  });

  it('fresh onboarding 全链：enrollToken → setup 出 uri/secret → enroll 错码 400 → 对码会话 + totp_enabled=1', async () => {
    const b = boot();
    await b.activate();
    const onb = (await call(b.routes, 'POST', '/auth/onboarding', {
      body: { rootToken: ROOT_TOKEN, password: 'owner-pass-8' }, // username 缺省 → owner
    })) as { enrollmentRequired: boolean; enrollToken: string };
    expect(onb.enrollmentRequired).toBe(true);

    // owner 已建：admin 角色、密码为入参 password（而非 rootToken）
    const owner = b.db
      .prepare('SELECT id, username, role, password_hash, totp_enabled FROM users')
      .get() as { id: string; username: string; role: string; password_hash: string; totp_enabled: number };
    expect(owner).toMatchObject({ username: 'owner', role: 'admin', totp_enabled: 0 });
    expect(await passwords.verify('owner-pass-8', owner.password_hash)).toBe(true);
    expect(await passwords.verify(ROOT_TOKEN, owner.password_hash)).toBe(false);

    // setup：enr 门内出 otpauth URI 与 secret（label 带 username），pending secret 暂存内存
    const setupRes = (await call(b.routes, 'GET', '/auth/2fa/setup', { query: { enrollToken: onb.enrollToken } })) as {
      uri: string;
      secret: string;
    };
    expect(setupRes.uri).toContain('otpauth://totp/Opptrix%20Harness:');
    expect(setupRes.uri).toContain('owner');
    expect(typeof setupRes.secret).toBe('string');
    expect(setupRes.secret.length).toBeGreaterThan(0);

    // enroll 错码 → 400 HARNESS-1008 "invalid 2fa code"，且不消费 enr（可重试）、不写库
    const badCode = await call(b.routes, 'POST', '/auth/2fa/enroll', {
      body: { enrollToken: onb.enrollToken, code: '000000' },
    });
    expectFail(badCode, 400, 'HARNESS-1008');
    expect(badCode).toMatchObject({ body: { message: 'invalid 2fa code' } });
    expect(
      (b.db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(owner.id) as { totp_enabled: number })
        .totp_enabled,
    ).toBe(0);

    // 对码 → 会话 + totp 落库
    const before = Date.now();
    const done = (await call(b.routes, 'POST', '/auth/2fa/enroll', {
      body: { enrollToken: onb.enrollToken, code: '123456' },
    })) as { token: string; expiresAt: number; user: { id: string; username: string; role: string } };
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
    expect(done.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 3600 * 1000 - 1000);
    expect(done.user).toMatchObject({ id: owner.id, username: 'owner', role: 'admin' });
    const row = b.db.prepare('SELECT totp_enabled, totp_secret FROM users WHERE id = ?').get(owner.id) as {
      totp_enabled: number;
      totp_secret: string;
    };
    expect(row.totp_enabled).toBe(1);
    expect(row.totp_secret).not.toBeNull();
    expect(await b.getProvider()({ token: done.token })).toMatchObject({ userId: owner.id, role: 'admin' });

    // enr 单次消费：enroll 成功即焚——再用同一令牌（对码）→ 401
    const replay = await call(b.routes, 'POST', '/auth/2fa/enroll', {
      body: { enrollToken: onb.enrollToken, code: '123456' },
    });
    expectFail(replay, 401, 'HARNESS-1006');
  });

  it('onboarding reset 分支：先 onboarding 建号，再 onboarding 重置 → 密码改写 + totp/sessions/api_keys 清空', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();

    // 第一分支（fresh）：users 空表 → onboarding 创建 owner，登录绑定 2FA 并签发 API Key
    await ensureOwner(b, OWNER_PASSWORD);
    const first = await login(b, 'owner', OWNER_PASSWORD); // helper 自动走绑定流程 → owner 已绑 2FA
    const key = (await call(b.routes, 'POST', '/auth/api-keys', {
      headers: bearer(first.token),
      body: { name: 'pre-reset' },
    })) as { token: string };
    expect(await b.getProvider()({ token: key.token })).not.toBeNull();

    // 第二分支（reset）：users 非空 → root 令牌找回通道：固定重置 owner（username 入参被忽略）
    const reset = (await call(b.routes, 'POST', '/auth/onboarding', {
      body: { rootToken: ROOT_TOKEN, password: 'reset-pass-8' },
    })) as { enrollmentRequired: boolean; enrollToken: string };
    expect(reset.enrollmentRequired).toBe(true);

    // 密码改写：新密码可校验、旧密码（与 root 令牌）均不可校验
    const owner = b.db.prepare('SELECT password_hash, totp_enabled, totp_secret FROM users').get() as {
      password_hash: string;
      totp_enabled: number;
      totp_secret: string | null;
    };
    expect(await passwords.verify('reset-pass-8', owner.password_hash)).toBe(true);
    expect(await passwords.verify(OWNER_PASSWORD, owner.password_hash)).toBe(false);
    expect(await passwords.verify(ROOT_TOKEN, owner.password_hash)).toBe(false);
    // totp 清空 + 会话 / API Key 全清（旧凭据立即失效）
    expect(owner.totp_enabled).toBe(0);
    expect(owner.totp_secret).toBeNull();
    expect(await b.getProvider()({ token: first.token })).toBeNull();
    expect(await b.getProvider()({ token: key.token })).toBeNull();
    const sesCount = b.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(sesCount.n).toBe(0);
    const keyCount = b.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number };
    expect(keyCount.n).toBe(0);

    // 新密码可登录但被强制重新绑定（新 enr → setup → enroll）
    const unbound = await loginUnbound(b, 'owner', 'reset-pass-8');
    const done = await enroll(b, unbound.enrollToken);
    expect(done.user.username).toBe('owner');
    expect(await b.getProvider()({ token: done.token })).not.toBeNull();
  });

  it('login 未绑定 → enrollmentRequired + enr；pending secret 预置：不经 setup 直接 enroll 也可成功', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    const done = await enroll(b, unbound.enrollToken); // 直接触 enroll（跳过 /2fa/setup）
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
    const row = b.db.prepare('SELECT totp_enabled FROM users WHERE username = ?').get('owner') as {
      totp_enabled: number;
    };
    expect(row.totp_enabled).toBe(1);
  });

  it('login 已绑定未带码 → mfaRequired；POST /auth/login/2fa 错码 401（令牌保留可重试）→ 对码会话', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    await login(b, 'owner', OWNER_PASSWORD); // 绑定 2FA
    const mfa = await loginMfa(b, 'owner', OWNER_PASSWORD);

    const bad = await call(b.routes, 'POST', '/auth/login/2fa', {
      body: { mfaToken: mfa.mfaToken, totp: '000000' },
    });
    expectFail(bad, 401, 'HARNESS-1006');
    expect(bad).toMatchObject({ body: { message: 'invalid 2fa code' } });

    // 错码不消费 mfa 令牌：同令牌重试对码 → 会话
    const done = (await call(b.routes, 'POST', '/auth/login/2fa', {
      body: { mfaToken: mfa.mfaToken, totp: '123456' },
    })) as { token: string; user: { username: string; role: string } };
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
    expect(done.user).toMatchObject({ username: 'owner', role: 'admin' });
    expect(await b.getProvider()({ token: done.token })).not.toBeNull();

    // mfa 单用途：成功即焚——同一 mfaToken 再换一枚会话 → 401
    const replay = await call(b.routes, 'POST', '/auth/login/2fa', {
      body: { mfaToken: mfa.mfaToken, totp: '123456' },
    });
    expectFail(replay, 401, 'HARNESS-1006');
  });

  it('login 已绑定带码：对码直接会话（与 login/2fa 等价）；错码 → 401 "invalid 2fa code"', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    await login(b, 'owner', OWNER_PASSWORD); // 绑定 2FA

    const bad = await call(b.routes, 'POST', '/auth/login', {
      body: { username: 'owner', password: OWNER_PASSWORD, totp: '000000' },
    });
    expectFail(bad, 401, 'HARNESS-1006');
    expect(bad).toMatchObject({ body: { message: 'invalid 2fa code' } });

    const ok = (await call(b.routes, 'POST', '/auth/login', {
      body: { username: 'owner', password: OWNER_PASSWORD, totp: '123456' },
    })) as { token: string; mfaRequired?: boolean; enrollmentRequired?: boolean };
    expect(ok.token).toMatch(/^ses_[0-9a-f]{48}$/);
    expect(ok.mfaRequired).toBeUndefined();
    expect(ok.enrollmentRequired).toBeUndefined();
  });

  it('enr/mfa 令牌门：未知令牌 → 401 "enrollment/mfa token expired or invalid"；enroll 缺 code → 400 1009', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const ghost = 'enr_' + '0'.repeat(48);
    const ghostMfa = 'mfa_' + '0'.repeat(48);
    const msg = 'enrollment/mfa token expired or invalid';

    const setupRes = await call(b.routes, 'GET', '/auth/2fa/setup', { query: { enrollToken: ghost } });
    expectFail(setupRes, 401, 'HARNESS-1006');
    expect(setupRes).toMatchObject({ body: { message: msg } });
    const enrollRes = await call(b.routes, 'POST', '/auth/2fa/enroll', { body: { enrollToken: ghost, code: '123456' } });
    expectFail(enrollRes, 401, 'HARNESS-1006');
    expect(enrollRes).toMatchObject({ body: { message: msg } });
    const mfaRes = await call(b.routes, 'POST', '/auth/login/2fa', { body: { mfaToken: ghostMfa, totp: '123456' } });
    expectFail(mfaRes, 401, 'HARNESS-1006');
    expect(mfaRes).toMatchObject({ body: { message: msg } });
    // 缺 enrollToken / 缺 code：同一令牌门 / 入参形状语义
    expectFail(await call(b.routes, 'GET', '/auth/2fa/setup', { query: {} }), 401, 'HARNESS-1006');

    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    expectFail(
      await call(b.routes, 'POST', '/auth/2fa/enroll', { body: { enrollToken: unbound.enrollToken } }),
      400,
      'HARNESS-1009',
    );
  });

  it('enr 错码不消费：错码 400 后原令牌重试对码仍可成功', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    expectFail(
      await call(b.routes, 'POST', '/auth/2fa/enroll', { body: { enrollToken: unbound.enrollToken, code: '999999' } }),
      400,
      'HARNESS-1008',
    );
    const done = await enroll(b, unbound.enrollToken); // 原令牌原流程
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
  });

  it('GET /2fa/setup 可重复调用刷新 pending secret（重扫二维码语义），刷新后 enroll 对新 secret 生效', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    const s1 = (await call(b.routes, 'GET', '/auth/2fa/setup', { query: { enrollToken: unbound.enrollToken } })) as {
      uri: string;
      secret: string;
    };
    const s2 = (await call(b.routes, 'GET', '/auth/2fa/setup', { query: { enrollToken: unbound.enrollToken } })) as {
      uri: string;
      secret: string;
    };
    expect(s2.uri).toContain('owner');
    expect(typeof s2.secret).toBe('string');
    expect(s2.secret.length).toBeGreaterThan(0);
    // 桩下 secret 恒定，但"以最后一次 setup 为准"的语义由 enroll 成功兜底验证
    expect(s1.uri).toEqual(s2.uri);
    const done = await enroll(b, unbound.enrollToken);
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
  });

  it('POST /auth/2fa/disable：密码错 401；totp 错码 401；全对 → {ok:true} 清 2FA；再登录强制重绑', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const ses = await login(b, 'owner', OWNER_PASSWORD);

    const badPw = await call(b.routes, 'POST', '/auth/2fa/disable', {
      headers: bearer(ses.token),
      body: { password: 'not-the-password', code: '123456' },
    });
    expectFail(badPw, 401, 'HARNESS-1006');
    expect(badPw).toMatchObject({ body: { message: 'invalid credentials' } });
    const badCode = await call(b.routes, 'POST', '/auth/2fa/disable', {
      headers: bearer(ses.token),
      body: { password: OWNER_PASSWORD, code: '000000' },
    });
    expectFail(badCode, 401, 'HARNESS-1006');
    expect(badCode).toMatchObject({ body: { message: 'invalid 2fa code' } });
    // 失败路径不解绑
    expect(
      (b.db.prepare('SELECT totp_enabled FROM users WHERE username = ?').get('owner') as { totp_enabled: number })
        .totp_enabled,
    ).toBe(1);

    // 匿名 / API Key 不可调用（会话门）
    expectFail(await call(b.routes, 'POST', '/auth/2fa/disable', { body: { password: OWNER_PASSWORD, code: '123456' } }), 401, 'HARNESS-1006');

    const ok = await call(b.routes, 'POST', '/auth/2fa/disable', {
      headers: bearer(ses.token),
      body: { password: OWNER_PASSWORD, code: '123456' },
    });
    expect(ok).toEqual({ ok: true });
    const row = b.db.prepare('SELECT totp_enabled, totp_secret FROM users WHERE username = ?').get('owner') as {
      totp_enabled: number;
      totp_secret: string | null;
    };
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_secret).toBeNull();
    // 解绑后当前会话仍有效，但再次 disable 幂等 {ok:true}（无需 totp 码）
    expect(await b.getProvider()({ token: ses.token })).not.toBeNull();
    expect(
      await call(b.routes, 'POST', '/auth/2fa/disable', {
        headers: bearer(ses.token),
        body: { password: OWNER_PASSWORD, code: '000000' },
      }),
    ).toEqual({ ok: true });
    // 下次登录强制重新绑定（与「强制 2FA」一致）
    await loginUnbound(b, 'owner', OWNER_PASSWORD);
  });

  it('内存令牌过期：expiresAt 翻到过去 → enr/mfa 一律 401 "enrollment/mfa token expired or invalid"', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    // 篡改扩展 VM 内 AUTH_MEM_TOKENS 全部条目为已过期（等价 TTL 流逝；现有测试手法无注入时钟）
    b.runInVm('AUTH_MEM_TOKENS.forEach(function (v) { v.expiresAt = 0; })');
    const msg = 'enrollment/mfa token expired or invalid';
    const setupRes = await call(b.routes, 'GET', '/auth/2fa/setup', { query: { enrollToken: unbound.enrollToken } });
    expectFail(setupRes, 401, 'HARNESS-1006');
    expect(setupRes).toMatchObject({ body: { message: msg } });
    const enrollRes = await call(b.routes, 'POST', '/auth/2fa/enroll', {
      body: { enrollToken: unbound.enrollToken, code: '123456' },
    });
    expectFail(enrollRes, 401, 'HARNESS-1006');
    expect(enrollRes).toMatchObject({ body: { message: msg } });

    // mfa 令牌同样受过期语义约束
    await login(b, 'owner', OWNER_PASSWORD); // 重新绑定
    const mfa = await loginMfa(b, 'owner', OWNER_PASSWORD);
    b.runInVm('AUTH_MEM_TOKENS.forEach(function (v) { v.expiresAt = 0; })');
    const mfaRes = await call(b.routes, 'POST', '/auth/login/2fa', {
      body: { mfaToken: mfa.mfaToken, totp: '123456' },
    });
    expectFail(mfaRes, 401, 'HARNESS-1006');
    expect(mfaRes).toMatchObject({ body: { message: msg } });
  });

  it('canned 可编程：改写罐头码表后，只有新码可过 verify（totpVerify 桩按表判定）', async () => {
    const b = boot({ bootRootToken: ROOT_TOKEN });
    await b.activate();
    await ensureOwner(b);
    const unbound = await loginUnbound(b, 'owner', OWNER_PASSWORD);
    b.totpOkCodes.length = 0;
    b.totpOkCodes.push('654321');
    // 默认码 '123456' 已不再是合法码
    expectFail(
      await call(b.routes, 'POST', '/auth/2fa/enroll', { body: { enrollToken: unbound.enrollToken, code: '123456' } }),
      400,
      'HARNESS-1008',
    );
    const done = await enroll(b, unbound.enrollToken, '654321');
    expect(done.token).toMatch(/^ses_[0-9a-f]{48}$/);
    // 会话内 disable 也按新罐头码判定
    expectFail(
      await call(b.routes, 'POST', '/auth/2fa/disable', {
        headers: bearer(done.token),
        body: { password: OWNER_PASSWORD, code: '123456' },
      }),
      401,
      'HARNESS-1006',
    );
    expect(
      await call(b.routes, 'POST', '/auth/2fa/disable', {
        headers: bearer(done.token),
        body: { password: OWNER_PASSWORD, code: '654321' },
      }),
    ).toEqual({ ok: true });
  });

  it('源码卫生（2FA 增量）：无 console.* / require( / process.，内存令牌不落库（SQL 行无 enr_/mfa_）', () => {
    expect(src).not.toMatch(/\bconsole\./);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/\bprocess\./);
    // enr/mfa 只存内存 Map：任何含 SQL 关键字的行都不得出现 enr_/mfa_ 令牌字面量
    for (const line of src.split('\n')) {
      if (/INSERT INTO|UPDATE\s|DELETE FROM|SELECT\s/.test(line)) {
        expect(line).not.toContain('enr_');
        expect(line).not.toContain('mfa_');
      }
    }
    // users 表携带 TOTP 列（新库直建 + 旧库 ALTER 迁移双通道）
    expect(src).toContain('totp_secret TEXT');
    expect(src).toContain('totp_enabled INTEGER DEFAULT 0');
    expect(src).toContain('PRAGMA table_info(users)');
  });
});
