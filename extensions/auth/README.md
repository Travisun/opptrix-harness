# auth — 内置认证扩展（builtin, mount 'auth'）

Opptrix Harness OS 的默认认证实现：用户 / 会话 / API Key 管理，并向内核注册
`AuthProvider`（每个受保护请求的令牌校验）。内核零领域语义——本扩展是"谁能进来"的
默认答案，可被同语义的第三方扩展替换。

本扩展运行在 VM 沙箱内：纯 JS，无 `require` / Node API / `console.*`，仅用注入的
`h.*`、全局 `defineExtension` 与 `crypto.getRandomValues`。

## 路由（经内核 mount 机制挂载）

扩展声明的是**相对路径**；内核 builtin mount 白名单（`auth → /api/v1/auth|users`，
见 `src/kernel/extensions/manifest.ts` 头注与 AGENTS.md）决定最终 URL：

| 声明路径                  | 最终 URL（内核挂载后）                | 鉴权要求           |
| ------------------------- | ------------------------------------- | ------------------ |
| `POST /auth/login`        | `POST /api/v1/auth/login`             | 公开               |
| `POST /auth/logout`       | `POST /api/v1/auth/logout`            | 会话（`ses_*`）    |
| `GET  /auth/me`           | `GET /api/v1/auth/me`                 | 任意有效令牌       |
| `POST /auth/change-password` | `POST /api/v1/auth/change-password` | 会话（`ses_*`）    |
| `GET  /auth/api-keys`     | `GET /api/v1/auth/api-keys`           | 会话（`ses_*`）    |
| `POST /auth/api-keys`     | `POST /api/v1/auth/api-keys`          | 会话（`ses_*`）    |
| `DELETE /auth/api-keys/:id` | `DELETE /api/v1/auth/api-keys/:id`  | 会话（`ses_*`，仅本人） |
| `GET  /users`             | `GET /api/v1/users`                   | admin / root       |
| `POST /users`             | `POST /api/v1/users`                  | admin / root       |
| `PATCH /users/:id`        | `PATCH /api/v1/users/:id`             | admin / root       |
| `DELETE /users/:id`       | `DELETE /api/v1/users/:id`            | admin / root       |

**mount 契约（集成对齐点）**：本扩展把相对路径解释为"相对 `/api/v1`"——首段
`auth` 归 `/api/v1/auth`、首段 `users` 归 `/api/v1/users`，与 mount 白名单
`auth → /api/v1/auth|users` 的双前缀形状一一对应。若内核挂载实现采用别的相对基准
（例如统一前缀 `/api/v1/auth`），只需调整 `index.js` 中 `h.route` 的路径字面量
（集中、无派生），处理器逻辑零改动。

全部路由声明 `{ auth: 'public' }`：鉴权在处理器内自查。原因：login 必须公开；
其余路由需要完整身份（userId / 令牌类型 / scopes），且必须区分**会话**与
**API Key**（如 logout 仅接受 `ses_*`），内核 AuthProxy 的二元判定不够用。
令牌提取与内核 `extractToken` 对齐：`Authorization: Bearer <token>` 优先，其次
`query.token`。

错误形状遵守 `HarnessApi.route` 契约：`{ status, body: { code, message } }`，
错误码一律取自 `src/kernel/errors/codes.ts`：

- `401 HARNESS-1006` 未认证 / 凭据无效（login 失败统一 `invalid credentials`，不区分"用户不存在"与"密码错误"）
- `403 HARNESS-1007` 已认证但角色不足（非 admin 访问 `/users*`）
- `400 HARNESS-1008` 业务规则拒绝（重名、删自己、动最后一个 admin）
- `400 HARNESS-1009` 入参形状不合法
- `404 HARNESS-1001` 实体不存在（用户 / API Key）。⚠️ 复用 `ROUTE_NOT_FOUND` 码：
  HTTP 1xxx 域没有实体 not-found 专码，错误码注册表禁止裸造；以 `message` 区分。
  若内核后续补充通用实体 not-found 码，此处应随之替换。

## 契约依赖（内核 / 沙箱侧需就位；setup 时 fail-fast 校验，缺失即 EXT_ACTIVATION_FAILED 并给出可操作报错）

| 依赖 | 说明 | 来源 |
| --- | --- | --- |
| `h.boot.rootToken` | 内核 load payload 额外携带的 root 令牌，经 HarnessApi `h.boot` 暴露（仅 `builtin:true && mount==='auth'` 可见） | 并行包在沙箱 HarnessApi 增加 `boot` |
| `h.auth.hashPassword(pw)` / `h.auth.verifyPassword(pw, hash)` | 内核 scrypt 密码原语（kernelCall `auth.hashPassword` / `auth.verifyPassword`） | 需 manifest 权限 `auth:provider` |
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
这样 root 令牌持有者可以 `POST /api/v1/auth/login` 换取正式会话，再走常规 API。
rootToken 后续轮换不会自动改 owner 密码——用 `PATCH /api/v1/users/:id` 显式改密。
root 令牌本身也可直连：`authLookupToken` 对恰好等于 rootToken 的令牌返回
`{ userId: 'root', role: 'root', scopes: ['*'] }`，与内核 `authProxy` 的 root 语义一致。

## 数据模型（本扩展独立 SQLite）

- `users(id, username UNIQUE, password_hash, role['admin'|'normal'], created_at)`
- `sessions(id, user_id, token_hash UNIQUE, expires_at, created_at)` — 令牌形如 `ses_<48hex>`，有效期 7 天
- `api_keys(id, user_id, name, token_hash UNIQUE, scopes JSON, expires_at NULL, revoked 0/1, created_at)` — 令牌形如 `ak_<48hex>`，明文仅在签发响应中出现一次，列表接口永不回显

时间一律 UTC epoch ms。`provider` 返回的身份形状：`{ userId, role, scopes }`
（session 固定 `scopes: ['*']`；api-key 取存储的 scopes 数组）。

## v1 简化与 T1 加固清单

1. **令牌明文存储**（`sessions.token_hash` / `api_keys.token_hash` 列存明文令牌）：
   沙箱内没有摘要原语（无 `crypto.subtle.digest`、无 Node crypto），HMAC 亦无密钥可用；
   secrets 层 v1 本就明文先例，且库文件权限 0600 由部署保证。T1：沙箱注入
   `crypto.subtle.digest`（或内核摘要 topic），改为存 SHA-256，令牌生成不变。
2. **root 令牌明文比对**：与内核 `authProxy` 同思路的常量时间比较在沙箱内不可得
   （`timingSafeEqual` 不可用），先 plain equal。T1 随第 1 项改为哈希后比较。
3. **用户名枚举的时序缓解**：login 对不存在的用户也会烧一次 `hashPassword`
   （scrypt），抑制存在性侧信道；rate limiting 依赖内核 per-route `rateLimit`。
4. **过期会话惰性失效**：查询时以 `expires_at` 判定，无清理 cron（本扩展刻意不注册
   cron/事件订阅）。T1：可加每日清理任务。
5. **改密撤销其他会话**：`change-password` 成功后撤销本人除当前外的全部会话；
   删除用户时连带清空其会话与 API Key。
6. API Key 管理接口仅接受会话令牌（`ses_*`）；API Key 不能再签发 API Key、不能
   logout、不能改密（最小权限，防令牌自我复制）。
7. 令牌随机强度：`crypto.getRandomValues` 24 字节（192 bit）hex 化。

## 测试

`test/ext-auth-ext.test.ts`：用 `node:vm` 搭最小沙箱（注入 `defineExtension` /
`crypto`），`h.db` 用真 better-sqlite3 内存库 SQL 透传，`h.auth` 用内核同款 scrypt
八行实现，`h.route` / `h.authProvider` 捕获后直接调用处理器；覆盖建表、owner 引导、
login/logout/me/change-password、users CRUD 与权限门、api-key 签发/认证/吊销、
root 令牌直连与错误形状。
