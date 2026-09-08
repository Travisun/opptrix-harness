# ARCHITECTURE.md — Opptrix Harness OS 架构

> 面向贡献者的架构文档。工程约束见 [ENGINEERING.md](./ENGINEERING.md)（最高约束），协作协议与术语见 [AGENTS.md](./AGENTS.md)，依赖决策的单一事实来源见 [docs/dependencies.md](./docs/dependencies.md)。本文所有表述以代码为准，均给出文件锚点。

## 1. 总览与进程模型

Opptrix Harness OS 是一个多线程单进程内核 + 进程监管器的框架：**主线程**承载 HTTP 与全部核心服务，**唯一的 Extension Worker 线程**承载所有扩展（每扩展一个 `vm.Context`），**任务线程池**承载 CPU 密集长任务。生产环境由 `bootstrap.mjs` 作为监管进程拉起内核并负责崩溃重启与升级回滚。

```text
┌────────────────────────── bootstrap.mjs（监管进程）──────────────────────────┐
│  解析启动槽（releases/slots.json）→ spawn node <slot>/dist/main.js           │
│  崩溃退避重启（500ms×2^n ≤ 30s）· 看门狗每 2s GET /readyz · 自动回滚          │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ spawn（env 透传, stdio inherit）
┌───────────────▼────── 内核进程（node dist/main.js）──────────────────────────┐
│                                                                              │
│  主线程（Kernel）                                                             │
│  ├─ Fastify HTTP（/health /readyz /api/v1/* /ext/* /hooks/chat/*）           │
│  ├─ Container（DI：config/logger/db/secrets/notify/chat/files/tasks/llm…）   │
│  ├─ 核心服务（providers/core-services.ts 总装配）                             │
│  ├─ ExtensionManager + ExtBridge（跨线程 RPC）                               │
│  ├─ CronScheduler（croner）· EventBus · HookManager · SseHub                 │
│  └─ Updater（A/B 升级）· SandboxManager（dockerode）                          │
│                                                                              │
│  Extension Worker 线程（唯一，worker_threads）                                │
│  └─ 每扩展一个 vm.Context（受限 require / 最小全局面 / 定时器登记表）           │
│                                                                              │
│  Task 线程池（默认 1，HARNESS_TASK_WORKERS 1–16）—— 每任务新 VM               │
└──────────────┬──────────────────────────────┬────────────────────────────────┘
               │ dockerode（按需）             │ 预检自检（升级期）
┌──────────────▼─────────────┐   ┌────────────▼──────────────┐
│ 沙箱容器（一次性）           │   │ 预检子进程（独立端口 3987  │
│ opptrix-sandbox:latest      │   │ + 临时数据目录，探 /readyz）│
└─────────────────────────────┘   └───────────────────────────┘
```

线程边界的权威定义在 `src/extension-host/protocol.ts`：内核 → 扩展线程用 `HOST_METHODS.*`（`host.load / host.route / host.event / host.hook / host.cron / host.call / host.task / host.authVerify`），扩展线程 → 内核用 `KERNEL_TOPICS.*`（30+ 个 topic：storage/db/notify/chat/files/tasks/cron/ui/llm/sandbox/system/auth 原语）。

## 2. 模块清单与职责

### src/kernel/（内核）

| 模块 | 职责 |
| --- | --- |
| `Kernel.ts` | 生命周期编排：状态机 `created → registering → booting → ready → stopping → stopped`；boot 顺序 = 鉴权挂点 → SQLite+迁移 → 事件/Hook/Cron → 核心服务 → 沙箱/升级器 → 扩展子系统 → HTTP；关停逆序且幂等 |
| `Container.ts` / `ServiceProvider.ts` / `Facades.ts` | DI 容器（bind/singleton/instance/alias，显式工厂、无反射）；provider 的 register/boot/stop 契约；静态门面（App/Config/Log/Event/Hook/Cron） |
| `config/` | `HARNESS_*` 环境变量 → `HarnessConfig`（同步 fail-fast，非法值启动期抛 `VALIDATION_FAILED`）；.env 可选装载 |
| `errors/` | `HarnessError` + `HARNESS-xxxx` 错误码表（域分段：1xxx 通用、3xxx 资源、4xxx 任务、7xxx 投递、8xxx 升级…见 `codes.ts`） |
| `logging/` | pino logger（epoch ms、密钥 redact）+ 启动期 multistream + SQLite 环形日志汇（`logs` 表，默认 5000 行上限，批量 flush，容错） |
| `auth/` | break-glass root 令牌（生成/持久化/原子写）、`AuthProviderRegistry`、`authProxy`（统一 checker + `extractToken`：Bearer 优先 `?token=` 次之）、扩展 AuthProvider 支撑 |
| `http/` | Fastify 服务器工厂（统一错误形状 `{code,message,detail,retryable}`、404/405 区分、CORS、trustProxy）+ `sse/hub.ts`（多 topic SSE：鉴权、心跳、帧 id 序列、topic 订阅上限） |
| `events/` `hooks/` | 进程内事件总线（监听器异常隔离）；Hook 埋点链（kernel.boot/ready/shutdown、cron.beforeRun/afterRun/onError、notification.beforeSend 等 filter 语义） |
| `storage/` | `openSqlite`（主库 `<dataDir>/db/kernel.sqlite`、扩展库 `db/ext/<id>.sqlite`）；`Migrator`（批次化迁移，记账表 `migrations_log`）+ `kernel-migrations.ts`（001–014 权威 Schema）；settings/secrets；`backup.ts`（VACUUM INTO + tar.gz 备份，含恢复约定） |
| `extensions/` | `manifest.ts`（zod schema + 权限白名单 + API 版本门禁）、`manager.ts`（生命周期 + 自愈 + 惯犯熔断）、`routes.ts`（/ext/* 通配兜底 + 路由表 + 并发/超时/drain）、`registry.ts`（h.expose/h.call 服务目录）、`kernel-handlers.ts`（KERNEL_TOPICS 的内核侧实现 + 权限闸）、`ui-registry.ts` + `assets.ts`（UI 贡献与静态挂载）、`contributions.ts`、`bridge.ts` |
| `providers/core-services.ts` | 核心领域服务总装配：ChannelRegistry（通知驱动 inbox/webhook/console/email + 聊天桥 webhook/email）→ NotificationManager / ChatService(+BridgeDispatcher+deliveries 落库) / FileService(本地驱动) / TaskManager(+WorkerPool) / LlmGateway，并挂载对应 REST |
| `chat/` `notification/` `files/` `tasks/` `cron/` `llm/` `channels/` | 领域服务实现：频道/成员/消息（判别联合内容 text/file/card）；通知（入库 → SSE created → 渠道投递 → delivered）；文件（本地驱动 `uploads/`，`file.uploaded/deleted` 事件）；任务（store/pool/worker、进度/超时 sweep）；croner 调度 + `cron_runs` 历史；LLM 协议适配（openai-chat / openai-responses / anthropic-messages）；signedPost（HMAC 头 + 超时 + 退避重试） |
| `sandbox/` | Docker 工作区沙箱：一次性容器执行命令、家目录恢复扫描、空闲停机；Docker 不可用 → `SANDBOX_DISABLED` 优雅降级 |
| `update/` | `slots.ts`（A/B 槽状态：原子读写、boot 解析、提交/结算）+ `updater.ts`（check/apply/history、下载→校验→安全解压→预检→原子提交）+ boot 期 `settlePendingUpdate` |
| `system/` | `doctor.ts`（五项体检）、`info.ts`（Counters：`name{排序 tags}`，唯一 key 上限 10000） |

### src/api/（REST 薄边界）

`system / files / notifications / chat / tasks / cron / llm / sandbox / extensions / update` 十个路由模块。约定：token 经 `extractToken` 交 checker；入参 zod；HarnessError 按自身状态码下发；路由必须在 `app.ready()` 前注册。

### src/extension-host/（扩展宿主）

| 文件 | 职责 |
| --- | --- |
| `protocol.ts` | RPC 信封（from/to/topic/payload/ok/err）+ HOST_METHODS / KERNEL_TOPICS 常量，入参 zod |
| `worker.ts` | 线程入口：host.load 装配 VM → 受限 require 执行 main → 识别 `defineExtension` → setup（限时 30s）；各 HOST_METHODS 分发，单 handler 异常一律隔离 |
| `vm-runtime.ts` | 每扩展 `vm.Context`：注入受控 console（转发 log topic）/定时器（登记表，cleanup 全清）/TextEncoder/URL/crypto 子集；全部绑定不可写不可配置；刻意不注入 process/require/Buffer/performance |
| `sandbox.ts` | `createHarnessApi`（h.* API 面 + 权限映射）、受限 require、贡献收集（routes/events/services/cron/ui 快照） |
| `worker-factory.ts` | 生产（dist 直载）/开发（tsx loader）双模式；`HARNESS_WORKER_MODE=auto|dist|dev` 可钉死 |

### 顶层

`bootstrap.mjs`（监管器，纯 JS，与 slots.ts 保持语义一致的内联实现）、`tools/cli*.ts`（make:extension / validate）、`scripts/release*.mjs`（发布工程）、`types/harness.d.ts`（扩展作者类型面）、`extensions/`（auth 内置扩展 + hello-world / echo-bot / doc-demo 示例）。

## 3. 请求生命周期

### boot 序列（Kernel.#runBoot）

1. `ensureRootToken`（env → `<data>/root-token` → 生成并持久化；生成令牌以 warn 打印**一次**）；
2. `auth.registry / auth.checker / sse.hub` 登记容器（provider 在 register 阶段即可注册 AuthProvider）；
3. `openSqlite(kernelDbPath)` → `Migrator.latest()`（fail-fast）→ settings/secrets/counters 登记；
4. EventBus / HookManager / CronJobStore + CronScheduler；
5. `createCoreServices`（领域服务装配 + 容器登记）；
6. Updater + SandboxManager；`updateAuto && updateFeed` 时注册内核 cron 任务 `kernel:auto-update`（`extId=null`）；
7. 扩展子系统：UiRegistry → kernel-handlers → 服务注册中心 → ExtensionManager（auth 接线：扩展可注册 AuthProvider；worker→kernel 服务表；路由表 diff 应用器）；
8. SQLite 日志汇挂载（minLevel info）→ `kernel.boot` hook/event → providers register → providers boot；
9. serverFactory：挂 system/cron/core REST → sandbox/update/extensions API → `/api/v1/ui` → ExtRouteRegistry（构造即挂 `/ext/*` 通配兜底）→ 重放缓存路由表 → 扩展 UI 静态资产 → builtin auth mount（`/api/v1/auth|users` 静态 catch-all，运行时查 manager 路由表）→ 宿主 registerExtra；
10. 启动序：`core.start()`（任务池）→ `settlePendingUpdate`（在途升级收尾）→ `sandbox.start()` → `extManager.start()`（worker + 已启用扩展）→ `cron.start()`（含 misfire 裁决）→ `http.start()` → **ready**。

### 一次请求

```text
HTTP 请求
  → fastify 路由匹配
     ├─ 内核公开路由：/health（恒 200）/ /readyz（ready 才 200）/ /（webui 未启用的应急页）
     ├─ 内核 API（/api/v1/*）：extractToken → authChecker（root 令牌或 AuthProvider）
     │    → 角色门禁（admin 路由）→ zod 入参 → 领域服务 → JSON
     ├─ 扩展路由（/ext/<extId>/*）：ExtRouteRegistry 查表裁决（auth/scope/timeoutMs）
     │    → 并发闸（maxConcurrentPerExt）→ bridge.callToWorker(host.route)
     │    → 扩展线程执行 handler（超时竞速）→ 归一化 { status, headers?, body }
     ├─ builtin auth mount（/api/v1/auth|users/*）：catch-all → 查表 → 派发到 auth 扩展
     └─ 未命中：notFound 处理器区分 404（ROUTE_NOT_FOUND）与 405（METHOD_NOT_ALLOWED，附 Allow）
  → 错误统一形状：HarnessError → { code: HARNESS-xxxx, message, detail, retryable }
     非 HarnessError → 500 INTERNAL（服务端记日志，客户端不泄露内部信息）
```

### 关停序（幂等，与 boot 互斥）

`stopping` → 扩展子系统停（terminate worker，拒新调用）→ core.stop（任务判失败 + 终止线程）→ sandbox → cron → HTTP → SSE Hub → 日志汇刷尽 → 关库 → 逆序 provider stop → `stopped`。信号处理只在 `src/main.ts`（内核可嵌入任意宿主，经 `handleSignal` 委托）。

## 4. 扩展执行链

### 激活链

```text
extensions 目录扫描（<dataDir>/extensions + <cwd>/extensions）
  → validateManifest → validatePermissions（白名单 + net:out:<domain>）→ checkApiCompat（api ∈ [1]）
  → worker.load：createExtVm 装配独立 Context → 受限 require 执行 manifest.main
  → 识别 defineExtension → setup(h)（限时 30s）
  → 注册类 API 落 contributions（routes/events/hooks/services/cron/ui 快照）
  → 提交：路由表 diff（/ext/*）、服务目录（ext.<id>.<service>）、cron 注册、UI 贡献、AuthProvider
```

### 运行期不变量

- **注册期闸门**：`route/webhook/on/hook/expose/cron/page/menu` 仅可在 setup 内调用（`EXT_REGISTRATION_PHASE`）；
- **权限即能力面**：KERNEL_TOPICS 的内核侧实现按 manifest.permissions 放行（如 `llm.chat` 需 `llm`、`sandbox.exec` 需 `sandbox`、`auth.*` 需 `auth:provider`）；root 令牌只注入 `builtin && mount==='auth'` 扩展（worker 侧双重复核）；
- **RPC 有界**：worker→kernel 单次调用默认 30s；路由 handler 默认 30s（可 `timeoutMs` 覆盖）；超时 = `HARNESS-1002`，VM 内继续跑但结果丢弃；
- **自愈**：worker 异常退出 → 指数退避重启 + 拓扑重注册（路由/服务/UI/AuthProvider 全量重建）；`crashLoopWindowMs`（默认 60s）内崩溃 > `crashLoopMax`（默认 5）→ 熔断：全部扩展停用、`EXT_CRASH_LOOP` 记 last_error，人工 enable 是唯一恢复出口。

## 5. 数据流（三条代表性链路）

**文件 → 解析 → 通知/卡片**（`extensions/doc-demo` 即此链路的参考实现）：

```text
POST /api/v1/files（multipart, ≤ maxUploadBytes）
  → FileService：磁盘落位 uploads/ + files 表落库（失败回滚磁盘）
  → emit('file.uploaded', record) → 扩展 h.on 处理器
  → h.call('doc-demo','parse.run') → h.files.read（内核回 base64）
  → h.notify.send（入库 → SSE notification.created → 渠道投递 → notification.delivered）
  → h.chat.send（messages 落库 → SSE → meta.bridges 桥外发 → deliveries 流水落库）
```

**定时任务**：croner 触发 → `#onCronFire`：`cron.beforeRun` hook → 内核任务分派（`kernel:auto-update` → Updater.apply，fire-and-forget）→ `kernel.cron.fired` 事件（扩展任务由扩展子系统派发 `host.cron`）→ onError/afterRun 埋点 → `cron_runs` 记录。

**A/B 升级**：`POST /api/v1/system/update/apply` → 备份 → 下载 `releases/incoming.tar.gz` → sha256 → 安全解压到非活动槽（仅 `dist/**`+`node_modules/**`）→ 预检（子进程 + 临时数据目录探 `/readyz`）→ `commitNewSlot`（tmp+rename 原子写 slots.json）+ `history.json` → 优雅退出 → bootstrap 拉起新槽 → boot 期 `settlePendingUpdate` 结算；新槽不健康 → 看门狗/崩溃循环回滚。

### 存储布局

| 位置 | 内容 |
| --- | --- |
| `<dataDir>/db/kernel.sqlite` | 主库：`settings / secrets / logs / extensions / ext_kv / cron_jobs / cron_runs / notifications / channels / channel_members / messages / files / tasks / deliveries`（内核迁移 001–014 权威 Schema，全部可逆序回滚） |
| `<dataDir>/db/ext/<extId>.sqlite` | 每扩展专属库（`h.db`） |
| `<dataDir>/uploads/` `extensions/` `backups/` `releases/` `root-token` | 文件面（备份/升级槽/令牌布局见运维文档） |

## 6. 依赖决策（Package-First）

完整决策表见 **[docs/dependencies.md](./docs/dependencies.md)**：每个引入的依赖登记一行「包名 / 用途角色 / 自研例外理由」。核心依赖速览：

| 包 | 角色 |
| --- | --- |
| fastify + @fastify/*（cors/multipart/rate-limit/static/swagger） | HTTP 引擎与外围 |
| knex + better-sqlite3 | 现代化 query/schema builder + 同步 SQLite 驱动 |
| zod | 全部外部入参（HTTP body / RPC payload / manifest）校验 |
| croner / dockerode / pino / dotenv / semver / tar-stream / nodemailer | cron · Docker 沙箱 · 结构化日志 · .env · 版本裁决 · 打包 · SMTP |
| openai / @anthropic-ai/sdk | LLM 协议官方 SDK |

**自研清单（OS 语义核心例外，均在 dependencies.md 有理由行）**：扩展 vm 沙箱（`node:vm`）、RPC 信封（热插拔语义所在）、SseHub（多 topic 鉴权 + 重放契约无合格包）、Counters（prom-client 留待指标体系阶段评估）、DI Container（awilix 等装饰器/反射风格与显式工厂 + 热插拔语义不合，见 `Container.ts` 头注释）、`node:crypto`（scrypt/HMAC/随机令牌无合格纯 JS 替代）。

## 7. 关键设计决策（ADR 风格）

### ADR-001 Package-First：零手写核心件

- **状态**：已实施（ENGINEERING.md 第 1 条，最高优先级）。
- **背景**：框架的价值在 OS 语义编排，不在重造 HTTP/SQL/日志轮子；自研默认是负债。
- **决策**：任何功能实现前先过评估清单（周下载量/维护活跃度/TS 类型/许可证 MIT·Apache·BSD/`npm audit` 无 high+ /传递体积）；仅 vm 沙箱、RPC 信封、权限门、生命周期编排四类 OS 核心允许自研，且每个引入的依赖与每个自研件都必须在 `docs/dependencies.md` 登记一行理由。
- **后果**：`package.json` 的每个依赖都有一行「为什么是它」；自研件数量收敛且可审计（见第 6 节）。

### ADR-002 每扩展独立 SQLite

- **状态**：已实施（`storage/db.ts` `extDbPath`、`kernel-handlers.ts` 的 `h.db` 懒打开 + 缓存）。
- **背景**：共享库 + 行级租户列会让扩展之间互相踩踏 schema 与性能；独立文件则隔离彻底但需防句柄泛滥。
- **决策**：扩展持久化默认落在 `<dataDir>/db/ext/<extId>.sqlite` 的专属库；内核提供 `db.all/get/run/schema` 四个 topic，不暴露跨扩展 SQL；主库仅供内核与受控 topic 使用。
- **后果**：扩展卸载可 `--purge` 连库删除（`uninstall` 的 `purge` 语义）；备份/恢复按目录粒度自然打包；Migrator 设计为不绑定文件布局，可按库复用（扩展 schema 版本化的现成路径）。

### ADR-003 A/B 目录槽升级

- **状态**：已实施（`kernel/update/slots.ts|updater.ts` + `bootstrap.mjs` + `scripts/release-core.mjs`）。
- **背景**：容器外的单机升级需要「失败能自动回去」；原地覆盖二进制在半写状态下的崩溃窗口不可接受。
- **决策**：`<data>/releases/` 下固定 `slot-a|slot-b` 两个完整发布（入口 `<slot>/dist/main.js`）+ `slots.json` 权威状态 + `history.json` 历史；apply 只写非活动槽；提交 = 原子写 slots.json；新槽能启动即 boot 期结算，不能启动则监管器（看门狗 5 连败 / 5 分钟崩溃循环）自动回滚。所有状态写入 tmp+rename 原子落盘（0600）。
- **后果**：断电任意时刻都收敛到「旧槽或完整新槽」；代价是数据卷需容纳两份发布（node_modules 全量保留是正确性优先的取舍，体积优化登记为路线图项）。

### ADR-004 扩展 UI 合同：声明式贡献 + 静态资产挂载

- **状态**：已实施内核侧（`extensions/manifest.ts` uiSchema、`ui-registry.ts`、`assets.ts`）；宿主渲染器（webui）已作为内置扩展交付（Vue3 SPA，构建产物随镜像）。
- **背景**：内核零领域语义，不能内置任何前端框架；管理台又必须能聚合第三方扩展的界面。
- **决策**：合同只有两半——(1) **声明式贡献**：manifest `ui`（menu/pages/widgets/renderers）与激活期 `h.ui.register(fragment)` 累加合并，经 `GET /api/v1/ui` 输出目录快照；(2) **静态资产**：扩展目录 `ui/` 由 @fastify/static 挂载到 `/ext/<extId>/ui/`（无目录索引，路径安全交 @fastify/static）。页面 `entry` 是完整 HTML 文档（如 `ui/index.html`），宿主（webui 控制台，规划中 mount `/admin`）按贡献目录以独立页面承载/嵌入，内核不参与渲染。
- **后果**：扩展作者可用任何前端技术栈，只要产出一个 HTML 入口；合同面极小、无运行时耦合。注：早期任务书曾以「iframe UI 合同」描述此项，代码中的实际机制如上（iframe 是宿主可选的承载手段，不是合同的一部分）。

### ADR-005 auth / webui 内置扩展化

- **状态**：auth 已实施（`extensions/auth`，`builtin:true` + `mount:'auth'`）；webui 为已规划内置扩展（内核已留 fallback 页与 `/admin` mount 白名单，尚未入库）。
- **背景**：框架开箱即用需要认证与管理台，但把它们写进内核即违背「内核零领域语义」。
- **决策**：以 `builtin` 扩展形态提供默认答案。auth 扩展声明相对路由（`/auth/*`、`/users*`），内核按 mount 白名单映射到 `/api/v1/auth|users`（静态 catch-all + 运行时查路由表，enable/disable 即表变更）；auth 扩展还经 `auth.registerProvider` 向内核注册 AuthProvider，使每个受保护请求的令牌校验走 `host.authVerify` 派发回扩展线程；内核 scrypt 密码原语以 `auth:provider` 权限门暴露。同语义第三方扩展可整体替换它。
- **后果**：内核本体可嵌入无认证的宿主；break-glass root 令牌作为内核层兜底始终可用（worker 不可达时直连校验），且只注入 builtin auth 扩展。
