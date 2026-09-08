# Opptrix Harness OS

**服务器级 AI Harness OS 框架** —— Laravel 理念、扩展优先、内核零领域语义。内核提供 HTTP / 数据 / 任务 / 升级 / 沙箱 / 扩展线程等 OS 语义，一切领域能力（含认证与管理台）都以扩展形态运行。

## 特性

- **内核零领域语义** —— 主线程 = Fastify HTTP + DI 容器 + 核心服务 + ExtensionManager；领域语义全部下沉到扩展
- **扩展线程 + vm 沙箱** —— 所有扩展跑在唯一 worker 线程里，各自独立 `vm.Context`；受限 require、最小全局面、单调用异常隔离
- **热插拔自愈** —— fail-fast 类型化错误 / RPC 强制超时 / VM 异常隔离 / 退避重启 + 拓扑重注册 + 惯犯熔断
- **每扩展独立 SQLite** —— `<dataDir>/db/ext/<id>.sqlite`，互不污染；主库承载内核表（knex + better-sqlite3）
- **A/B 双槽热升级** —— 下载 → sha256 校验 → 预检自检 → 原子提交 → 看门狗自动回滚；断电安全（全状态 tmp+rename 原子落盘）
- **通知与聊天面** —— inbox / webhook / console / email 渠道驱动，聊天桥（HMAC 签名投递 + 投递流水落库），SSE 多 topic 实时广播
- **LLM 网关** —— OpenAI / Anthropic 官方 SDK 适配；供应商配置存 settings，密钥经 secrets 引用解析，永不落配置/日志
- **代码执行沙箱** —— dockerode 按需拉起一次性容器（node24 + python3 + git 基镜像），Docker 不可用时优雅降级
- **结构化可观测** —— pino（密钥字段 redact）+ SQLite 环形日志汇 + doctor 环境体检 + 进程内 counters

## 快速开始

本地开发：

```bash
npm install
cp .env.example .env      # 可选：令牌/日志级别/沙箱开关
npm run dev               # tsx watch src/main.ts，默认 0.0.0.0:3000
cat data/root-token       # 首启生成的 break-glass root 令牌（或看首启日志 warn 行）
curl -s http://localhost:3000/health
```

Docker：

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml exec opptrix cat /data/root-token
# 镜像入口 bootstrap.mjs 从 <data>/releases/<slot>/dist/main.js 启动：
# 全新数据卷需先播种一次发布产物（npm run release 产出），详见下文「发布」
```

## 核心命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（tsx watch，`src/main.ts`） |
| `npm run build` | TypeScript 编译到 `dist/`（`tsconfig.build.json`） |
| `npm start` | 运行编译产物（`node dist/main.js`） |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm test` | vitest 全量单测 + 集成测试（`test/**/*.test.ts`） |
| `npm test -- --coverage` | 覆盖率（v8 provider，统计 `src/kernel/**`，行覆盖 ≥ 80% 否则失败） |
| `npm run harness -- <cmd>` | 扩展 CLI：`make:extension <id>` 脚手架 / `validate <extDir>` 校验 |
| `npm run release -- [opts]` | 发布工程：tar.gz + sha256 + 升级 feed（`--version/--out/--channel/--notes/--force/--skip-build`） |

CI（`.github/workflows/ci.yml`）：`npm ci → typecheck → npm audit --audit-level=high → test --coverage → build`。

## 目录结构

```text
OpptrixHarness/
├── src/
│   ├── main.ts               # 进程入口（dotenv → Kernel → 信号处理 → boot）
│   ├── kernel/               # 内核全部模块
│   │   ├── Kernel.ts         # 生命周期编排（boot/shutdown/状态机）
│   │   ├── Container.ts      # DI 容器（显式工厂，无反射）
│   │   ├── config/ logging/ errors/    # 配置 fail-fast / pino+SQLite 汇 / HARNESS-xxxx 错误码
│   │   ├── auth/ http/ events/ hooks/  # root 令牌+AuthProvider / SSE Hub / 事件总线 / 埋点
│   │   ├── storage/          # SQLite、迁移、settings、secrets、备份
│   │   ├── extensions/       # manifest/权限/生命周期/路由表/服务注册/UI 贡献
│   │   ├── providers/        # 核心服务总装配（channels/notify/chat/files/tasks/llm）
│   │   ├── chat/ notification/ files/ tasks/ cron/ llm/ channels/   # 领域服务
│   │   ├── sandbox/          # Docker 工作区沙箱（dockerode）
│   │   ├── update/           # A/B slots + Updater
│   │   └── system/           # doctor 体检 / counters
│   ├── api/                  # REST 路由模块（/api/v1/*，薄边界 + zod）
│   └── extension-host/       # worker 线程 / vm-runtime / 受限 require / RPC 协议
├── extensions/               # 第一方与示例扩展（auth、hello-world、echo-bot、doc-demo）
├── types/harness.d.ts        # 扩展作者类型声明（h.* API）
├── docker/                   # Dockerfile（多阶段）、Dockerfile.sandbox、docker-compose.yml
├── scripts/                  # release.mjs（薄入口）+ release-core.mjs（发布核心）
├── tools/                    # cli.ts / cli-core.ts（扩展脚手架与校验）
├── bootstrap.mjs             # 进程监管器：A/B slot 解析、退避重启、看门狗回滚
├── test/                     # vitest 单测 + 集成测试
└── docs/dependencies.md      # Package-First 依赖决策表（每依赖一行）
```

## 文档站

完整文档（快速开始、架构、扩展开发、运维手册）位于独立文档站仓库：`../opptrixdocuments`（Mintlify）。若与框架仓库同级克隆，直接 `cd ../opptrixdocuments` 查看；运维三章对应 `operations/deployment|upgrading|observability.mdx`，教程对应 `tutorials/`。

## 贡献

- 工程约束（Package-First 原则）：任何功能实现前先检索并评估合适的 npm 包，有合格包不自研；仅 OS 语义核心（vm 沙箱 / RPC 信封 / 权限门 / 生命周期编排）例外；
- 代码要求：TypeScript strict、入参 zod 校验、错误统一 `HarnessError`（`HARNESS-xxxx` 错误码）、pino 结构化日志（密钥不入日志）、时间一律 UTC 存储；
- 每个模块交付必须附带 vitest 单测，内核整体行覆盖率 ≥ 80%；
- 引入依赖须遵守许可证白名单（MIT / Apache-2.0 / BSD，禁 GPL 系）。

## License

未定（占位）。引入依赖须遵守 ENGINEERING.md 的许可证白名单（MIT / Apache-2.0 / BSD，禁 GPL 系）。
