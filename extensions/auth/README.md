# auth — 内置认证扩展（builtin, mount 'auth'）

Opptrix Harness OS 的默认认证实现：用户 / 会话 / API Key 管理、**Onboarding 引导**、
**全员强制 2FA（TOTP）**，并向内核注册 `AuthProvider`（每个受保护请求的令牌校验）。
内核零领域语义——本扩展是"谁能进来"的默认答案，可被同语义的第三方扩展替换。

本扩展运行在 VM 沙箱内：纯 JS，无 `require` / Node API / `console.*`，仅用注入的
`h.*`、全局 `defineExtension` 与 `crypto.getRandomValues`。

## 路由（经内核 mount 机制挂载）

扩展声明的是**相对路径**；内核 builtin mount 白名单（`auth → /api/v1/auth|users`，
见 `src/kernel/extensions/manifest.ts` 头注与 AGENTS.md）决定最终 URL：

| 声明路径                     | 最终 URL（内核挂载后）                | 鉴权要求                    |
| ---------------------------- | ------------------------------------- | --------------------------- |
| `GET  /onboarding/status`    | `GET /api/v1/onboarding/status`       | 公开                        |
| `POST /onboarding`           | `POST /api/v1/onboarding`             | root 令牌门（body 内）      |
| `GET  /2fa/setup`            | `GET /api/v1/2fa/setup`               | enr 注册令牌门（query 内）  |
| `POST /2fa/enroll`           | `POST /api/v1/2fa/enroll`             | enr 注册令牌门（body 内）   |
| `POST /auth/login`           | `POST /api/v1/auth/login`             | 公开                        |
| `POST /auth/login/2fa`       | `POST /api/v1/auth/login/2fa`         | mfa 令牌门（body 内）       |
| `POST /auth/2fa/disable`     | `POST /api/v1/auth/2fa/disable`       | 会话（`ses_*`）             |
| `POST /auth/logout`          | `POST /api/v1/auth/logout`            | 会话（`ses_*`）             |
| `GET  /auth/me`              | `GET /api/v1/auth/me`                 | 任意有效令牌                |
| `POST /auth/change-password` | `POST /api/v1/auth/change-password`   | 会话（`ses_*`）             |
| `GET  /auth/api-keys`        | `GET /api/v1/auth/api-keys`           | 会话（`ses_*`）             |
| `POST /auth/api-keys`        | `POST /api/v1/auth/api-keys`          | 会话（`ses_*`）             |
| `DELETE /auth/api-keys/:id`  | `DELETE /api/v1/auth/api-keys/:id`    | 会话（`ses_*`，仅本人）     |
| `GET  /users`                | `GET /api/v1/users`                   | admin / root                |
| `POST /users`                | `POST /api/v1/users`                  | admin / root                |
| `PATCH /users/:id`           | `PATCH /api/v1/users/:id`             | admin / root                |
| `DELETE /users/:id`          | `DELETE /api/v1/users/:id`            | admin / root                |

> ⚠️ **集成对齐点**：`/onboarding*` 与 `/2fa/*` 的最终 URL 依赖内核 auth-mount
> catch-all（`src/kernel/Kernel.ts` `makeAuthMountHandler`）当前注册的 `auth`、
> `users` 两个前缀；若内核侧尚未为 `onboarding` / `2fa` 前缀接线，这些路径会 404。
> 扩展侧声明已按上述契约固定，内核 mount 前缀扩展后即通。

**mount 契约（集成对齐点）**：本扩展把相对路径解释为"相对 `/api/v1`"——首段
`auth` 归 `/api/v1/auth`、首段 `users` 归 `/api/v1/users`，与 mount 白名单
`auth → /api/v1/auth|users` 的双前缀形状一一对应。若内核挂载实现采用别的相对基准
（例如统一前缀 `/api/v1/auth`），只需调整 `index.js` 中 `h.route` 的路径字面量
（集中、无派生），处理器逻辑零改动。

全部路由声明 `{ auth: 'public' }`：鉴权在处理器内自查。原因：login 必须公开；
其余路由需要完整身份（userId / 令牌类型 / scopes）、或需要"门内令牌"（root 门 /
enr 门 / mfa 门），且必须区分**会话**与**API Key**（如 logout 仅接受 `ses_*`），
内核 AuthProxy 的二元判定不够用。令牌提取与内核 `extractToken` 对齐：
`Authorization: Bearer <token>` 优先，其次 `query.token`。

错误形状遵守 `HarnessApi.route` 契约：`{ status, body: { code, message } }`，
错误码一律取自 `src/kernel/errors/codes.ts`：

- `401 HARNESS-1006` 未认证 / 凭据无效。固定 message：login 失败统一 `invalid
  credentials`；root 门 `root token verification failed`；enr/mfa 门
  `enrollment/mfa token expired or invalid`；2FA 码错 `invalid 2fa code`
- `403 HARNESS-1007` 已认证但角色不足（非 admin 访问 `/users*`）
- `400 HARNESS-1008` 业务规则拒绝（重名、删自己、动最后一个 admin、`invalid 2fa code`）
- `400 HARNESS-1009` 入参形状不合法（短密码、缺 code、未 setup 先 enroll 等）
- `404 HARNESS-1001` 实体不存在（用户 / API Key）。⚠️ 复用 `ROUTE_NOT_FOUND` 码：
  HTTP 1xxx 域没有实体 not-found 专码，错误码注册表禁止裸造；以 `message` 区分。
  若内核后续补充通用实体 not-found 码，此处应随之替换。

## Onboarding 与全员强制 2FA（TOTP）

**策略**：全员（admin 与 normal 一视同仁）必须绑定 TOTP 才能拿到会话。登录密码
通过但未绑定 → 不签发会话，返回 `enrollmentRequired + enrollToken`；已绑定但未带码
→ 返回 `mfaRequired + mfaToken`。root 令牌直连（Bearer root）不受 2FA 约束——
它是唯一找回通道。

### 流程一：fresh onboarding（users 表为空）

```
GET  /onboarding/status                    → { needsOnboarding: true }
POST /onboarding { rootToken, password,
                   username?='owner' }      │ root 门（h.auth.verifyRootToken）
     ├─ rootToken 错  → 401 'root token verification failed'
     ├─ password <8   → 400 HARNESS-1009
     └─ ok：建 admin（username 缺省 'owner'）
          → 200 { enrollmentRequired: true, enrollToken: 'enr_<48hex>' }
GET  /2fa/setup?enrollToken=…              → 200 { uri, secret }   # 扫码用
POST /2fa/enroll { enrollToken, code }     │ 首枚 TOTP 对 pending secret
     ├─ 错码 → 400 HARNESS-1008 'invalid 2fa code'（不消费 enr，可重试）
     └─ 对码 → 写 users.totp_secret/totp_enabled=1，enr 即焚
          → 200 { token: 'ses_…', expiresAt, user }   # 直接拿到会话
```

### 流程二：日常登录 MFA（已绑定）

```
POST /auth/login { username, password }
     ├─ 密码错 → 401 'invalid credentials'
     ├─ 未带 totp → 200 { mfaRequired: true, mfaToken: 'mfa_<48hex>' }
     │     POST /auth/login/2fa { mfaToken, totp }
     │        ├─ 错码 → 401 'invalid 2fa code'（mfa 令牌保留，可重试至过期）
     │        └─ 对码 → 200 { token, expiresAt, user }（mfa 即焚）
     └─ 带 totp：对码 → 200 { token, … }；错码 → 401 'invalid 2fa code'
     （"login 带 totp" 与 "login/2fa" 二选一，语义等价）
```

### 流程三：强制 enrollment（未绑定用户登录 / disable 后再登录）

```
POST /auth/login { username, password }（totp_enabled=0）
     → 200 { enrollmentRequired: true, enrollToken }   # pending secret 已预置
     → GET /2fa/setup?enrollToken=…（可跳过，重扫二维码时用）
     → POST /2fa/enroll { enrollToken, code } → 200 { token, … }
```

### 流程四：解绑 disable（下次登录强制重新绑定）

```
POST /auth/2fa/disable { password, code }   # 会话门（ses_*）
     ├─ 密码错 → 401 'invalid credentials'
     ├─ 码错   → 401 'invalid 2fa code'
     └─ 全对   → { ok: true }（totp_secret/totp_enabled 清空；未绑定时幂等 {ok:true}）
下次登录 → 流程三（enrollmentRequired）
```

### 流程五：找回（break-glass = root 令牌）

```
POST /onboarding { rootToken, password }（users 非空 = 重置模式）
     → 固定重置 owner：密码改写、totp_secret/totp_enabled 清空、
       sessions/api_keys 全清、该用户在途 enr/mfa 令牌作废
     → 200 { enrollmentRequired: true, enrollToken } → 流程一后三步
```

### 安全说明

- **TOTP 强制全员**：未绑定用户在任何登录路径都拿不到会话；`POST /users` 新建用户
  同样需走 enrollment。2FA 校验走内核 `auth.totpVerify`（otplib，window ±1）。
- **enr/mfa 令牌短时单用途**：仅存扩展进程内存（`AUTH_MEM_TOKENS` Map，绝不落库），
  TTL 10 分钟；enr 成功即焚（错码不消费、可重试）；mfa 成功即焚（错码保留）。
  进程重启令牌全失效——重新走流程即可，无持久化状态需要清理。
- **root 令牌即找回通道**：owner 忘记密码 / 丢失 TOTP 时，`POST /onboarding` 用
  内核 root 令牌（`h.auth.verifyRootToken` 常数时间比较）重置 owner 全部凭据；
  root 令牌直连 API 不经 2FA（与内核 authProxy root 语义一致，从不落库）。
- **pending secret 只存内存**：`/2fa/setup` 生成的 secret 绑定 enrollToken 暂存
  内存，重复调用 setup 以最后一次为准（重扫二维码语义）；绑定成功后写入
  `users.totp_secret`（明文列，敏感度等同密码哈希——库文件应受内核数据目录权限保护）。
- **错误信息不泄露存在性**：login 对不存在用户烧一次 scrypt（时序对齐）；enr/mfa
  门的"不存在"与"已过期"返回同一 message。

## 契约依赖（内核 / 沙箱侧需就位；setup 时 fail-fast 校验，缺失即 EXT_ACTIVATION_FAILED 并给出可操作报错）

| 依赖 | 说明 | 来源 |
| --- | --- | --- |
| `h.boot.rootToken` | 内核 load payload 额外携带的 root 令牌，经 HarnessApi `h.boot` 暴露（仅 `builtin:true && mount==='auth'` 可见） | 并行包在沙箱 HarnessApi 增加 `boot` |
| `h.auth.hashPassword(pw)` / `h.auth.verifyPassword(pw, hash)` | 内核 scrypt 密码原语（kernelCall `auth.hashPassword` / `auth.verifyPassword`） | 需 manifest 权限 `auth:provider` |
| `h.auth.hashToken(value)` | 内核 SHA-256 摘要，返回 `{ hash }`（64 位小写 hex；kernelCall `auth.hashToken`）——令牌脱敏存储专用 | 需 manifest 权限 `auth:provider` |
| `h.auth.totpGenerate(account)` | 内核 TOTP 密钥生成，返回 `{ secret, uri }`（uri = `otpauth://totp/Opptrix%20Harness:<account>`；kernelCall `auth.totpGenerate`） | 需 manifest 权限 `auth:provider` |
| `h.auth.totpVerify({ secret, token })` | 内核 TOTP 校验（window ±1），返回 `{ ok, delta }`；入参非法一律 `ok:false` | 需 manifest 权限 `auth:provider` |
| `h.auth.verifyRootToken(token)` | 内核 root 令牌常数时间校验，返回 `{ ok }`（kernelCall `auth.verifyRootToken`） | 需 manifest 权限 `auth:provider` |
| `h.authProvider(fn)` | 注册 `async ({ token, headers }) => AuthIdentity \| null`；内核对每个受保护请求派发 | 同上 |
| 全局 `crypto.getRandomValues` | 令牌随机源（沙箱无 Node crypto、无 `crypto.subtle.digest`，令牌 hex 化在本扩展内完成） | 沙箱注入 |
| `h.db`（`schema/get/all/run`） | 本扩展独立 SQLite（`<dataDir>/db/ext/auth.sqlite`） | 既有契约 |

### rootToken 解析优先级（setup 内）

1. `h.boot.rootToken` —— **主通道**（约定：内核 load payload 的 rootToken 出现在 `h.boot`，由并行包在 HarnessApi 增加）；
2. `ctx.rootToken` —— 兼容通道（若 worker 改为把 load payload 第二参传入 `setup(h, ctx)`；当前 worker 只传 `h`，见 `src/extension-host/worker.ts` 的 `def.setup(harness)`）；
3. `h.config.get('boot.rootToken')` —— 只读配置兜底（异步）。

三者皆缺时**不**引导 owner（不报错），扩展其余功能照常；首次登录将无从谈起，
运维需先补 root 令牌注入。

### owner 引导（break-glass）

`setup` 建表后，若 `users` 表为空且解析到 rootToken，则创建用户
`owner`（role `admin`，password = rootToken，id `usr_<24hex>`）。只在空表时执行一次。
该用户仍未绑定 TOTP——首次 `POST /auth/login` 返回 `enrollmentRequired + enrollToken`，
走「流程三」绑定后即可正常使用（亦可 `POST /onboarding` 用 root 令牌重设自己喜欢的
密码再绑定）。rootToken 后续轮换不会自动改 owner 密码——用 `PATCH /api/v1/users/:id`
显式改密，或 `POST /onboarding` 重置。root 令牌本身也可直连：`authLookupToken` 对
恰好等于 rootToken 的令牌返回 `{ userId: 'root', role: 'root', scopes: ['*'] }`，
与内核 `authProxy` 的 root 语义一致（root 直连不经 2FA）。

## 数据模型（本扩展独立 SQLite）

- `users(id, username UNIQUE, password_hash, role['admin'|'normal'], totp_secret,
  totp_enabled 0/1, created_at)` — TOTP 绑定态；`totp_enabled=1` 且 `totp_secret`
  非空才算已绑定（双条件防"半绑定"脏行）
- `sessions(id, user_id, token_hash UNIQUE, expires_at, created_at)` — 令牌形如 `ses_<48hex>`，有效期 7 天
- `api_keys(id, user_id, name, token_hash UNIQUE, scopes JSON, expires_at NULL, revoked 0/1, created_at)` — 令牌形如 `ak_<48hex>`，明文仅在签发响应中出现一次，列表接口永不回显

**TOTP 列迁移（幂等）**：新库由 `CREATE TABLE` 直接携带 totp 两列；旧库在 setup 时
`PRAGMA table_info(users)` 检查缺列后 `ALTER TABLE users ADD COLUMN totp_secret
TEXT` / `ADD COLUMN totp_enabled INTEGER DEFAULT 0` 补齐，旧行默认未绑定
（下次登录即被引导进 enrollment 流程）。

**`token_hash` 列语义（T1 已交付）**：存令牌的 **SHA-256 hex**（64 位小写 hex，经
`h.auth.hashToken` 现算），不再存明文令牌。生成（login / 签发 API Key）与校验
（AuthProvider / 路由自查）对称：明文令牌只存在于响应与请求头中，落库前即哈希。

时间一律 UTC epoch ms。`provider` 返回的身份形状：`{ userId, role, scopes }`
（session 固定 `scopes: ['*']`；api-key 取存储的 scopes 数组）。

## 升级影响（v1 明文 → T1 哈希存储）

- **升级后需重新登录 / 重签 API Key**。setup 时检测 `sessions` / `api_keys` 中存在
  非 64 位 hex 的 `token_hash` 行（即旧版明文令牌残留）→ 直接清除该行（一次性失效，
  info 日志记录清除条数）。明文令牌无法反向迁移为哈希，故不做迁移、只做失效。
- root 令牌不受影响（从不落库，内核/内存直连语义不变）。

## v1 简化与 T1 加固清单

1. ~~**令牌明文存储**~~ → **已交付（哈希存储）**：`sessions.token_hash` /
   `api_keys.token_hash` 现存令牌的 SHA-256 hex（经内核摘要 topic
   `auth.hashToken`，需 manifest 权限 `auth:provider`）。库文件即使被拖走也拿不到
   可用的会话/API Key 令牌。加密说明：令牌完整性由 SHA-256 单向性保证；密码仍为
   scrypt（`auth.hashPassword`，自带随机盐）；secrets 层（如 LLM apiKey）的落盘
   加密由内核 `SecretsService` 的 AES-256-GCM 数据密钥方案负责（见
   `src/kernel/storage/secrets.ts` / `secretkey.ts`），与本扩展无关。
2. **root 令牌明文比对**：与内核 `authProxy` 同思路的常量时间比较在沙箱内不可得
   （`timingSafeEqual` 不可用），仍 plain equal（root 令牌从不落库，仅内存直连）。
3. **用户名枚举的时序缓解**：login 对不存在的用户也会烧一次 `hashPassword`
   （scrypt），抑制存在性侧信道；rate limiting 依赖内核 per-route `rateLimit`。
4. **过期会话惰性失效**：查询时以 `expires_at` 判定，无清理 cron（本扩展刻意不注册
   cron/事件订阅）。T1：可加每日清理任务。
5. **改密撤销其他会话**：`change-password` 成功后撤销本人除当前外的全部会话；
   删除用户时连带清空其会话与 API Key。
6. API Key 管理接口仅接受会话令牌（`ses_*`）；API Key 不能再签发 API Key、不能
   logout、不能改密（最小权限，防令牌自我复制）。
7. 令牌随机强度：`crypto.getRandomValues` 24 字节（192 bit）hex 化；SHA-256 哈希
   后按唯一索引等值查询，令牌碰库不可行。
8. **强制 2FA（已交付，见「Onboarding 与全员强制 2FA」）**：全员登录强制 TOTP；
   enr/mfa 令牌内存化（10 分钟 TTL、单用途、成功即焚）；`POST /auth/2fa/disable`
   需密码 + 当前 TOTP 双因子，解绑后下次登录强制重新绑定。
9. **users.totp_secret 为明文列**（TOTP 共享密钥无哈希语义，验证需原文）：敏感度
   等同凭据，依赖数据目录文件权限保护；如需落盘加密，属内核 SecretsService 范畴。

## 测试

`test/ext-auth-ext.test.ts`：用 `node:vm` 搭最小沙箱（注入 `defineExtension` /
`crypto`），`h.db` 用真 better-sqlite3 内存库 SQL 透传，`h.auth` 用内核同款 scrypt
实现 + totp 可编程 canned 桩（默认仅 `'123456'` ok）+ root 令牌比对桩，
`h.route` / `h.authProvider` 捕获后直接调用处理器；覆盖建表与 totp 列迁移、owner
引导、login/logout/me/change-password、users CRUD 与权限门、api-key 签发/认证/吊销、
root 令牌直连、错误形状，以及 2FA 全链：onboarding status、fresh onboarding、
root 令牌重置找回、login 三分支（enrollmentRequired / mfaRequired / 带码直登）、
enr/mfa 令牌门与单次消费、内存令牌过期（VM 内篡改 expiresAt）、disable 与强制重绑。
