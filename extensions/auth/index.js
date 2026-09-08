'use strict';

/**
 * auth — Opptrix Harness OS 内置认证扩展（builtin:true, mount:'auth'）。
 *
 * 职责：用户/会话/API Key 管理 + 内核 AuthProvider 注册（受保护请求的令牌校验）。
 * 内核零领域语义：本扩展是"谁能进来"的默认实现，可被同 mount 语义的第三方扩展替换。
 *
 * 本文件运行在 VM 沙箱内：无 require / Node API，禁止 console 系列输出；仅可用注入的
 * `h.*` 与全局 `defineExtension`、`crypto.getRandomValues`。契约详见同目录 README.md。
 *
 * 契约依赖（v1，需内核/沙箱侧就位，setup 时 fail-fast 校验）：
 * - h.boot.rootToken            内核 load payload 携带的 root 令牌（仅 builtin auth 可见）
 * - h.auth.hashPassword(pw)     内核 scrypt 哈希（kernelCall auth.hashPassword）
 * - h.auth.verifyPassword(pw,h) 内核 scrypt 校验（kernelCall auth.verifyPassword）
 * - h.authProvider(fn)          注册 AuthProvider（需 manifest 权限 'auth:provider'）
 *
 * v1 简化（T1 加固项，见 README）：session/api-key 令牌明文存于本扩展独立 SQLite 的
 * token_hash 列（沙箱无摘要原语可用；库文件 0600 由部署保证）。
 */

/**
 * @typedef {Object} HarnessApiLike
 * auth 扩展实际使用的 HarnessApi 子集（完整契约见仓库 types/harness.d.ts 与 README）。
 * @property {{ rootToken?: string }} [boot] 内核注入的引导态（rootToken 仅 builtin auth 可见）
 * @property {{ hashPassword(pw: string): Promise<string>, verifyPassword(pw: string, hash: string): Promise<boolean> }} auth 内核密码原语
 * @property {(register: (input: { token?: string, headers?: Record<string, unknown> }) => Promise<null | { userId: string, role: string, scopes: string[] }>) => void} authProvider AuthProvider 注册（激活期一次）
 * @property {{ schema(statements: string[]): Promise<void>, get(sql: string, params?: unknown[]): Promise<unknown>, all(sql: string, params?: unknown[]): Promise<unknown>, run(sql: string, params?: unknown[]): Promise<{ changes: number }> }} db
 * @property {{ get(path: string): Promise<unknown> }} config 只读内核配置
 * @property {{ debug(m: string, d?: unknown): void, info(m: string, d?: unknown): void, warn(m: string, d?: unknown): void, error(m: string, d?: unknown): void }} log
 */

/**
 * 本扩展实例的 root 令牌（setup 引导期解析，仅本 VM 实例可见；worker 每次装载
 * 建新 VM，模块作用域不跨实例共享）。供 authLookupToken 做 root 直连判定，
 * 与内核 authProxy 的 root 身份语义（userId 'root' / role 'root' / scopes ['*']）对齐。
 * @type {string | undefined}
 */
var AUTH_ROOT_TOKEN;

// ---------------------------------------------------------------------------
// 常量（约定优于配置）
// ---------------------------------------------------------------------------

/** 会话有效期：7 天 */
var AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 密码最小长度 */
var AUTH_MIN_PASSWORD_LEN = 8;
/** 合法角色（users.role CHECK 同款） */
var AUTH_ROLES = ['admin', 'normal'];
/** 令牌随机部分字节数（24 字节 = 48 hex 字符） */
var AUTH_TOKEN_BYTES = 24;

// ---------------------------------------------------------------------------
// 小工具（顶层函数，供 setup 注册的处理器复用）
// ---------------------------------------------------------------------------

/**
 * 生成随机 hex 字符串（沙箱全局 crypto.getRandomValues，无 Node crypto）。
 * @param {number} nBytes 随机字节数
 * @returns {string} 2*nBytes 位小写 hex
 */
function authRandomHex(nBytes) {
  if (typeof crypto === 'undefined' || crypto === null || typeof crypto.getRandomValues !== 'function') {
    throw new TypeError(
      'auth extension: sandbox global crypto.getRandomValues is required (random token generation); ' +
        'kernel sandbox is too old — upgrade the kernel',
    );
  }
  var buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  var out = '';
  for (var i = 0; i < buf.length; i++) out += buf[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * 构造错误形状的 HTTP 响应（HarnessApi.route 契约：{ status, body }）。
 * 错误码一律取自内核注册表 src/kernel/errors/codes.ts，禁止裸造。
 * @param {number} status HTTP 状态码
 * @param {string} code HARNESS-xxxx 错误码
 * @param {string} message 面向调用者的可操作信息
 * @returns {{ status: number, body: { code: string, message: string } }}
 */
function authFail(status, code, message) {
  return { status: status, body: { code: code, message: message } };
}

/** 401 HARNESS-1006（UNAUTHORIZED） */
function authUnauthorized(message) {
  return authFail(401, 'HARNESS-1006', message || 'unauthorized');
}

/** 403 HARNESS-1007（FORBIDDEN） */
function authForbidden() {
  return authFail(403, 'HARNESS-1007', 'forbidden');
}

/** 400 HARNESS-1008（BAD_REQUEST）——业务规则拒绝（删自己/最后一个 admin/重名等） */
function authBadRequest(message) {
  return authFail(400, 'HARNESS-1008', message);
}

/** 400 HARNESS-1009（VALIDATION_FAILED）——入参形状不合法 */
function authInvalid(message) {
  return authFail(400, 'HARNESS-1009', message);
}

/**
 * 从 RouteContext 提取令牌（与内核 extractToken 语义对齐）：
 * Authorization: Bearer <token> 优先，其次 query.token；都无 → undefined。
 * @param {{ headers?: Record<string, string | undefined>, query?: Record<string, string> }} req
 * @returns {string | undefined}
 */
function authTokenOf(req) {
  var headers = req && req.headers ? req.headers : {};
  var authz = headers['authorization'];
  if (typeof authz === 'string') {
    var m = /^\s*bearer\s+(\S+)\s*$/i.exec(authz);
    if (m && m[1]) return m[1];
  }
  var query = req && req.query ? req.query : {};
  var qt = query['token'];
  if (typeof qt === 'string' && qt !== '') return qt;
  return undefined;
}

/**
 * 解析 body 为对象（内核已做 JSON 解析，这里只兜底形状）。
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function authBodyOf(body) {
  return body !== null && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
}

/**
 * 行对象安全取字符串字段。
 * @param {unknown} row
 * @param {string} key
 * @returns {string}
 */
function authStr(row, key) {
  var rec = /** @type {Record<string, unknown>} */ (row);
  var v = rec[key];
  return v === null || v === undefined ? '' : String(v);
}

/**
 * 行对象安全取数值字段（null/undefined → null）。
 * @param {unknown} row
 * @param {string} key
 * @returns {number | null}
 */
function authNumOrNull(row, key) {
  var rec = /** @type {Record<string, unknown>} */ (row);
  var v = rec[key];
  return v === null || v === undefined ? null : Number(v);
}

/** scopes 列文本 → 数组（损坏/为空时保守取 ['*']，正常写入路径不会发生） */
function authScopesOf(text) {
  try {
    var parsed = JSON.parse(String(text));
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(function (s) { return String(s); });
    }
  } catch (_e) {
    // 落入下方默认值
  }
  return ['*'];
}

// ---------------------------------------------------------------------------
// 令牌校验（authProvider 与路由自检共用）
// ---------------------------------------------------------------------------

/**
 * 按令牌查身份。token 形如 'ses_<48hex>'（会话）或 'ak_<48hex>'（API Key），
 * 或恰好等于 rootToken（root 直连，同内核 authProxy 语义）。
 *
 * ⚠️ v1 限制：令牌明文比对/存取（沙箱无摘要原语），时序侧信道与静态泄露面见 README「T1 加固」。
 *
 * @param {HarnessApiLike} h
 * @param {unknown} token
 * @returns {Promise<null | { userId: string, role: string, scopes: string[], username: string | null, tokenType: 'root' | 'session' | 'api-key', token: string }>}
 */
async function authLookupToken(h, token) {
  if (typeof token !== 'string' || token === '') return null;
  var now = Date.now();

  // root 令牌直连（break-glass；与内核 authProxy 的 root 身份语义一致）
  if (AUTH_ROOT_TOKEN !== undefined && token === AUTH_ROOT_TOKEN) {
    return { userId: 'root', role: 'root', scopes: ['*'], username: null, tokenType: 'root', token: token };
  }

  if (token.indexOf('ses_') === 0) {
    var ses = await h.db.get(
      'SELECT s.expires_at AS expires_at, s.user_id AS user_id, u.username AS username, u.role AS role' +
        ' FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
      [token],
    );
    if (!ses || typeof ses !== 'object') return null;
    if (Number(/** @type {Record<string, unknown>} */ (ses)['expires_at']) <= now) return null;
    return {
      userId: authStr(ses, 'user_id'),
      role: authStr(ses, 'role'),
      scopes: ['*'],
      username: authStr(ses, 'username') || null,
      tokenType: 'session',
      token: token,
    };
  }

  if (token.indexOf('ak_') === 0) {
    var key = await h.db.get(
      'SELECT k.expires_at AS expires_at, k.revoked AS revoked, k.scopes AS scopes,' +
        ' k.user_id AS user_id, u.username AS username, u.role AS role' +
        ' FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.token_hash = ?',
      [token],
    );
    if (!key || typeof key !== 'object') return null;
    if (Number(/** @type {Record<string, unknown>} */ (key)['revoked']) === 1) return null;
    var expiresAt = authNumOrNull(key, 'expires_at');
    if (expiresAt !== null && expiresAt <= now) return null;
    return {
      userId: authStr(key, 'user_id'),
      role: authStr(key, 'role'),
      scopes: authScopesOf(/** @type {Record<string, unknown>} */ (key)['scopes']),
      username: authStr(key, 'username') || null,
      tokenType: 'api-key',
      token: token,
    };
  }

  return null;
}

/**
 * 会话门（logout / change-password / api-keys 管理：明确要求会话，API Key 与 root 令牌不算）。
 * @returns {Promise<null | { userId: string, role: string, username: string | null, sessionToken: string }>}
 */
async function authRequireSession(h, req) {
  var identity = await authLookupToken(h, authTokenOf(req));
  if (identity === null || identity.tokenType !== 'session') return null;
  return { userId: identity.userId, role: identity.role, username: identity.username, sessionToken: identity.token };
}

/**
 * 身份门（/users 管理与 /auth/me；root 令牌直连视为已认证，同内核语义）。
 * @returns {Promise<null | { userId: string, role: string }>} null = 未认证（401），否则校验角色（403）
 */
async function authRequireIdentity(h, req) {
  var identity = await authLookupToken(h, authTokenOf(req));
  if (identity === null) return null;
  return { userId: identity.userId, role: identity.role };
}

/** admin/root 角色判定（内核角色层级 root > admin > normal） */
function authIsAdminRole(role) {
  return role === 'admin' || role === 'root';
}

/** users 行 → 对外形状（永不携带 password_hash / token_hash） */
function authPublicUser(row) {
  return {
    id: authStr(row, 'id'),
    username: authStr(row, 'username'),
    role: authStr(row, 'role'),
    createdAt: Number(/** @type {Record<string, unknown>} */ (row)['created_at']),
  };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

defineExtension(async (h, ctx) => {
  // ---- 0. 契约前置校验（fail-fast，报错说清缺什么、怎么补）------------------
  if (!h.db || typeof h.db.schema !== 'function' || typeof h.db.get !== 'function' || typeof h.db.run !== 'function') {
    throw new TypeError('auth extension: HarnessApi.db { schema, get, run } is required; kernel sandbox is too old');
  }
  if (!h.auth || typeof h.auth.hashPassword !== 'function' || typeof h.auth.verifyPassword !== 'function') {
    throw new TypeError(
      'auth extension: HarnessApi.auth { hashPassword, verifyPassword } is required ' +
        '(kernel topics auth.hashPassword / auth.verifyPassword); kernel is too old — upgrade the kernel',
    );
  }
  if (typeof h.authProvider !== 'function') {
    throw new TypeError(
      'auth extension: HarnessApi.authProvider(register) is required (manifest permission "auth:provider"); ' +
        'kernel is too old — upgrade the kernel',
    );
  }

  // ---- 1. 建表（本扩展独立 SQLite；批次内失败由内核整体回滚）----------------
  await h.db.schema([
    'CREATE TABLE IF NOT EXISTS users (' +
      'id TEXT PRIMARY KEY,' +
      'username TEXT NOT NULL UNIQUE,' +
      'password_hash TEXT NOT NULL,' +
      "role TEXT NOT NULL DEFAULT 'normal' CHECK (role IN ('admin','normal'))," +
      'created_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (' +
      'id TEXT PRIMARY KEY,' +
      'user_id TEXT NOT NULL,' +
      'token_hash TEXT NOT NULL UNIQUE,' +
      'expires_at INTEGER NOT NULL,' +
      'created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
    'CREATE TABLE IF NOT EXISTS api_keys (' +
      'id TEXT PRIMARY KEY,' +
      'user_id TEXT NOT NULL,' +
      'name TEXT NOT NULL,' +
      'token_hash TEXT NOT NULL UNIQUE,' +
      "scopes TEXT NOT NULL DEFAULT '[\"*\"]'," +
      'expires_at INTEGER,' +
      'revoked INTEGER NOT NULL DEFAULT 0,' +
      'created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)',
  ]);

  // ---- 2. rootToken 解析 + owner 引导 --------------------------------------
  // 契约优先级：h.boot.rootToken（内核 load payload 注入，主通道）→ ctx.rootToken
  // （worker 若改为 payload 第二参传入 setup）→ h.config.get('boot.rootToken')（只读配置兜底）。
  var rootToken;
  if (h.boot && typeof h.boot.rootToken === 'string' && h.boot.rootToken !== '') {
    rootToken = h.boot.rootToken;
  } else if (ctx && typeof ctx.rootToken === 'string' && ctx.rootToken !== '') {
    rootToken = ctx.rootToken;
  } else {
    var fromCfg = await h.config.get('boot.rootToken');
    if (typeof fromCfg === 'string' && fromCfg !== '') rootToken = fromCfg;
  }
  AUTH_ROOT_TOKEN = rootToken;

  // owner 引导：users 表为空且拿到 rootToken 时，创建可登录的 owner（break-glass 入口）。
  // 只在空表时执行一次；rootToken 轮换后 owner 密码不自动跟随（用 PATCH /users/:id 改密，见 README）。
  if (rootToken !== undefined) {
    var countRow = await h.db.get('SELECT COUNT(*) AS n FROM users');
    if (countRow && Number(authStr(countRow, 'n') || '0') === 0) {
      var now = Date.now();
      await h.db.run(
        'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
        ['usr_' + authRandomHex(12), 'owner', String(await h.auth.hashPassword(rootToken)), 'admin', now],
      );
      h.log.info('auth: owner bootstrapped from root token', { username: 'owner' });
    }
  }

  // ---- 3. 注册 AuthProvider（内核对每个受保护请求派发；激活期一次）----------
  h.authProvider(async (input) => {
    var token = input && typeof input === 'object' ? input['token'] : undefined;
    var identity = await authLookupToken(h, token);
    if (identity === null) return null;
    return { userId: identity.userId, role: identity.role, scopes: identity.scopes };
  });

  // ---- 4. 路由 -------------------------------------------------------------
  // mount 'auth' 由内核挂载机制补前缀（builtin mount 白名单 auth → /api/v1/auth|users）。
  // 这里声明相对路径：'/auth/*' → /api/v1/auth/*；'/users*' → /api/v1/users*（见 README「mount 契约」）。
  // 全部声明 auth:'public'：鉴权在处理器内自查 —— login 必须公开；其余路由需要完整身份
  // （userId/令牌类型），且要区分会话与 API Key，内核 AuthProxy 的二元判定不够用。
  var routeOpts = { auth: 'public' };

  // POST /api/v1/auth/login — 用户名密码登录，建 7 天会话
  h.route('POST', '/auth/login', async (req) => {
    var body = authBodyOf(req.body);
    var username = typeof body['username'] === 'string' ? body['username'].trim() : '';
    var password = typeof body['password'] === 'string' ? body['password'] : '';
    if (username === '' || password === '') {
      return authInvalid('username and password are required (strings)');
    }
    var user = await h.db.get(
      'SELECT id, username, password_hash, role FROM users WHERE username = ?',
      [username],
    );
    if (!user || typeof user !== 'object') {
      // 用户不存在也烧一次 scrypt，抑制"用户是否存在"的时序侧信道（同 T1 清单）
      await h.auth.hashPassword(password);
      return authUnauthorized('invalid credentials');
    }
    var ok = await h.auth.verifyPassword(password, authStr(user, 'password_hash'));
    if (!ok) {
      return authUnauthorized('invalid credentials');
    }
    var now = Date.now();
    var token = 'ses_' + authRandomHex(AUTH_TOKEN_BYTES);
    var expiresAt = now + AUTH_SESSION_TTL_MS;
    await h.db.run(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      ['ssn_' + authRandomHex(12), authStr(user, 'id'), token, expiresAt, now],
    );
    return {
      token: token,
      expiresAt: expiresAt,
      user: { id: authStr(user, 'id'), username: authStr(user, 'username'), role: authStr(user, 'role') },
    };
  }, routeOpts);

  // POST /api/v1/auth/logout — 注销当前会话（仅会话令牌；API Key / root 令牌无会话可注销）
  h.route('POST', '/auth/logout', async (req) => {
    var session = await authRequireSession(h, req);
    if (session === null) return authUnauthorized('a session token (ses_*) is required');
    await h.db.run('DELETE FROM sessions WHERE token_hash = ?', [session.sessionToken]);
    return { ok: true };
  }, routeOpts);

  // GET /api/v1/auth/me — 当前身份（provider 语义之外自查；会话 / API Key / root 令牌皆可）
  h.route('GET', '/auth/me', async (req) => {
    var identity = await authLookupToken(h, authTokenOf(req));
    if (identity === null) return authUnauthorized('missing or invalid token (Authorization: Bearer <token>)');
    return {
      userId: identity.userId,
      username: identity.username,
      role: identity.role,
      scopes: identity.scopes,
      tokenType: identity.tokenType,
    };
  }, routeOpts);

  // POST /api/v1/auth/change-password — 改密（仅会话；成功后撤销本人其他会话）
  h.route('POST', '/auth/change-password', async (req) => {
    var session = await authRequireSession(h, req);
    if (session === null) return authUnauthorized('a session token (ses_*) is required');
    var body = authBodyOf(req.body);
    var oldPassword = typeof body['oldPassword'] === 'string' ? body['oldPassword'] : '';
    var newPassword = typeof body['newPassword'] === 'string' ? body['newPassword'] : '';
    if (newPassword.length < AUTH_MIN_PASSWORD_LEN) {
      return authInvalid('newPassword must be a string of at least ' + AUTH_MIN_PASSWORD_LEN + ' characters');
    }
    var user = await h.db.get('SELECT password_hash FROM users WHERE id = ?', [session.userId]);
    if (!user || typeof user !== 'object') return authUnauthorized('session user no longer exists');
    var ok = await h.auth.verifyPassword(oldPassword, authStr(user, 'password_hash'));
    if (!ok) return authUnauthorized('invalid credentials');
    await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
      String(await h.auth.hashPassword(newPassword)),
      session.userId,
    ]);
    // 撤销本人其他会话（保留当前会话），让旧凭据在其他端尽快失效
    var revoked = await h.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [
      session.userId,
      session.sessionToken,
    ]);
    return { ok: true, revokedOtherSessions: Number((revoked && revoked['changes']) || 0) };
  }, routeOpts);

  // GET /api/v1/auth/api-keys — 列出自己的 API Key（永不返回令牌）
  h.route('GET', '/auth/api-keys', async (req) => {
    var session = await authRequireSession(h, req);
    if (session === null) return authUnauthorized('a session token (ses_*) is required');
    var rows = await h.db.all(
      'SELECT id, name, scopes, expires_at, revoked, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [session.userId],
    );
    var list = /** @type {Record<string, unknown>[]} */ (Array.isArray(rows) ? rows : []);
    return {
      apiKeys: list.map(function (r) {
        return {
          id: authStr(r, 'id'),
          name: authStr(r, 'name'),
          scopes: authScopesOf(r['scopes']),
          expiresAt: authNumOrNull(r, 'expires_at'),
          revoked: Number(r['revoked']) === 1,
          createdAt: Number(r['created_at']),
        };
      }),
    };
  }, routeOpts);

  // POST /api/v1/auth/api-keys — 签发 API Key（明文令牌仅本次响应返回一次，库内不回显）
  h.route('POST', '/auth/api-keys', async (req) => {
    var session = await authRequireSession(h, req);
    if (session === null) return authUnauthorized('a session token (ses_*) is required');
    var body = authBodyOf(req.body);
    var name = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (name === '' || name.length > 100) {
      return authInvalid('name is required (string, 1-100 chars after trim)');
    }
    var scopes = ['*'];
    if (body['scopes'] !== undefined && body['scopes'] !== null) {
      if (!Array.isArray(body['scopes']) || body['scopes'].length === 0 ||
          !body['scopes'].every(function (s) { return typeof s === 'string' && s !== ''; })) {
        return authInvalid('scopes must be a non-empty array of non-empty strings');
      }
      scopes = /** @type {string[]} */ (body['scopes']).map(function (s) { return String(s); });
    }
    var expiresAt = null;
    if (body['expiresInDays'] !== undefined && body['expiresInDays'] !== null) {
      var days = Number(body['expiresInDays']);
      if (!Number.isInteger(days) || days <= 0 || days > 3650) {
        return authInvalid('expiresInDays must be an integer in (0, 3650]');
      }
      expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    }
    var now = Date.now();
    var id = 'key_' + authRandomHex(12);
    var token = 'ak_' + authRandomHex(AUTH_TOKEN_BYTES);
    await h.db.run(
      'INSERT INTO api_keys (id, user_id, name, token_hash, scopes, expires_at, revoked, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      [id, session.userId, name, token, JSON.stringify(scopes), expiresAt, now],
    );
    return { id: id, name: name, token: token, scopes: scopes, expiresAt: expiresAt, createdAt: now };
  }, routeOpts);

  // DELETE /api/v1/auth/api-keys/:id — 吊销自己的 API Key（他人的 key 一律 404，不泄露存在性）
  h.route('DELETE', '/auth/api-keys/:id', async (req) => {
    var session = await authRequireSession(h, req);
    if (session === null) return authUnauthorized('a session token (ses_*) is required');
    var id = req.params && req.params['id'] ? String(req.params['id']) : '';
    var key = await h.db.get('SELECT user_id FROM api_keys WHERE id = ?', [id]);
    if (!key || typeof key !== 'object' || authStr(key, 'user_id') !== session.userId) {
      // 404 复用 HARNESS-1001（HTTP 域唯一 not-found 码；注册表无实体 not-found 专码，禁止裸造）
      return authFail(404, 'HARNESS-1001', 'api key not found');
    }
    await h.db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', [id]);
    return { ok: true, revoked: true };
  }, routeOpts);

  // ---- 5. users 管理（/api/v1/users*，admin/root）---------------------------

  // GET /api/v1/users — 用户列表（不含 password_hash）
  h.route('GET', '/users', async (req) => {
    var caller = await authRequireIdentity(h, req);
    if (caller === null) return authUnauthorized('missing or invalid token');
    if (!authIsAdminRole(caller.role)) return authForbidden();
    var rows = await h.db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC, id ASC');
    var list = /** @type {Record<string, unknown>[]} */ (Array.isArray(rows) ? rows : []);
    return { users: list.map(authPublicUser) };
  }, routeOpts);

  // POST /api/v1/users — 创建用户
  h.route('POST', '/users', async (req) => {
    var caller = await authRequireIdentity(h, req);
    if (caller === null) return authUnauthorized('missing or invalid token');
    if (!authIsAdminRole(caller.role)) return authForbidden();
    var body = authBodyOf(req.body);
    var username = typeof body['username'] === 'string' ? body['username'].trim() : '';
    var password = typeof body['password'] === 'string' ? body['password'] : '';
    var role = body['role'] === undefined || body['role'] === null ? 'normal' : body['role'];
    if (username === '' || username.length > 100) {
      return authInvalid('username is required (string, 1-100 chars after trim)');
    }
    if (password.length < AUTH_MIN_PASSWORD_LEN) {
      return authInvalid('password must be a string of at least ' + AUTH_MIN_PASSWORD_LEN + ' characters');
    }
    if (typeof role !== 'string' || AUTH_ROLES.indexOf(role) === -1) {
      return authInvalid("role must be one of: 'admin', 'normal'");
    }
    var dup = await h.db.get('SELECT id FROM users WHERE username = ?', [username]);
    if (dup) return authBadRequest('username already exists');
    var now = Date.now();
    var id = 'usr_' + authRandomHex(12);
    await h.db.run(
      'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, username, String(await h.auth.hashPassword(password)), role, now],
    );
    return { id: id, username: username, role: role, createdAt: now };
  }, routeOpts);

  // PATCH /api/v1/users/:id — 改角色/改密（降级最后一个 admin → 系统锁死，禁止）
  h.route('PATCH', '/users/:id', async (req) => {
    var caller = await authRequireIdentity(h, req);
    if (caller === null) return authUnauthorized('missing or invalid token');
    if (!authIsAdminRole(caller.role)) return authForbidden();
    var id = req.params && req.params['id'] ? String(req.params['id']) : '';
    var target = await h.db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [id]);
    if (!target || typeof target !== 'object') {
      // 404 复用 HARNESS-1001（同上：HTTP 域唯一 not-found 码，禁止裸造新码）
      return authFail(404, 'HARNESS-1001', 'user not found');
    }
    var body = authBodyOf(req.body);
    var newRole = body['role'];
    var newPassword = body['password'];
    if (newRole !== undefined && newRole !== null) {
      if (typeof newRole !== 'string' || AUTH_ROLES.indexOf(newRole) === -1) {
        return authInvalid("role must be one of: 'admin', 'normal'");
      }
    }
    if (newPassword !== undefined && newPassword !== null) {
      if (typeof newPassword !== 'string' || newPassword.length < AUTH_MIN_PASSWORD_LEN) {
        return authInvalid('password must be a string of at least ' + AUTH_MIN_PASSWORD_LEN + ' characters');
      }
    }
    if (typeof newRole === 'string' && authStr(target, 'role') === 'admin' && newRole !== 'admin') {
      var adminCount = await h.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
      if (adminCount && Number(authStr(adminCount, 'n') || '0') <= 1) {
        return authBadRequest('cannot demote the last admin');
      }
    }
    if (typeof newRole === 'string' && newRole !== authStr(target, 'role')) {
      await h.db.run('UPDATE users SET role = ? WHERE id = ?', [newRole, id]);
    }
    if (typeof newPassword === 'string') {
      await h.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [
        String(await h.auth.hashPassword(newPassword)),
        id,
      ]);
    }
    var fresh = await h.db.get('SELECT id, username, role, created_at FROM users WHERE id = ?', [id]);
    return authPublicUser(/** @type {Record<string, unknown>} */ (fresh));
  }, routeOpts);

  // DELETE /api/v1/users/:id — 删除用户（不可删自己/最后一个 admin；连带清空其会话与 API Key）
  h.route('DELETE', '/users/:id', async (req) => {
    var caller = await authRequireIdentity(h, req);
    if (caller === null) return authUnauthorized('missing or invalid token');
    if (!authIsAdminRole(caller.role)) return authForbidden();
    var id = req.params && req.params['id'] ? String(req.params['id']) : '';
    if (id === caller.userId) return authBadRequest('cannot delete yourself');
    var target = await h.db.get('SELECT id, role FROM users WHERE id = ?', [id]);
    if (!target || typeof target !== 'object') {
      return authFail(404, 'HARNESS-1001', 'user not found'); // 同 PATCH：404 复用 HARNESS-1001
    }
    if (authStr(target, 'role') === 'admin') {
      var adminCount = await h.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
      if (adminCount && Number(authStr(adminCount, 'n') || '0') <= 1) {
        return authBadRequest('cannot delete the last admin');
      }
    }
    // 先清凭据（会话/API Key 立即失效）再删用户
    await h.db.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    await h.db.run('DELETE FROM api_keys WHERE user_id = ?', [id]);
    await h.db.run('DELETE FROM users WHERE id = ?', [id]);
    return { ok: true };
  }, routeOpts);

  // （无 cron、无事件订阅：会话过期行惰性剔除——查询时以 expires_at 判定，T1 再考虑清理任务）
});
