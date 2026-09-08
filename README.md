<div align="center">

# Opptrix Harness OS

**服务器级 AI Harness OS 框架** —— 机制归内核，语义归扩展。

内核提供 HTTP 路由、数据、任务调度、消息通道、升级、代码沙箱等 OS 级机制；一切领域能力（含认证与管理台）都以**扩展**形态运行在隔离沙箱中。

[快速开始](#快速开始) · [架构](#架构总览) · [扩展开发](#扩展开发) · [文档](#文档)

</div>

---

## 为什么是 Opptrix Harness

为「基于同一底座持续交付各行各业定制系统」而生：

- **一切皆扩展** —— 认证、管理台、文档识别、行业业务全部是扩展；内核只做机制，永不被业务污染
- **扩展即插即拔** —— 声明式激活、原子注册、运行中禁用不影响他者与内核；一个扩展崩溃不会带垮系统
- **数据物理隔离** —— 每个扩展独享一个 SQLite 数据库文件，越权与故障的爆炸半径止于自身
- **安全边界清晰** —— vm 沙箱 + 权限模型（fail-closed）+ 受限 require + 容器级代码执行沙箱
- **持续演进的底座** —— A/B 双槽热升级：下载 → 校验 → 预检自检 → 原子提交 → 失败自动回滚

## 特性全景

| 领域 | 能力 |
| --- | --- |
| HTTP | Fastify 薄路由层、洋葱中间件、统一错误体（`HARNESS-xxxx` 错误码）、OpenAPI 自动生成 |
| 扩展系统 | 唯一 worker 线程 + 每扩展独立 `vm.Context`、声明式激活、服务注册中心（`h.expose`/`h.call`）、热插拔自愈（fail-fast / 强制超时 / 异常隔离 / 退避重启 + 拓扑重注册 + 惯犯熔断） |
| 数据 | 每扩展独立 SQLite（knex query/schema builder）、内核迁移、settings/secrets 层、备份导出 |
| 消息 | 通知中心（inbox / webhook / email / console 渠道驱动 + 路由规则）、ChatChannels（结构化消息、入站 webhook、出站桥接、Bot 事件）、SSE 多 topic 实时推送 |
| 调度 | Cron（时区 / 重叠与错过策略 / 运行历史）、长任务（独立任务线程、进度上报、超时取消） |
| AI | LLM Gateway（OpenAI Chat Completions / Responses + Anthropic Messages 三协议、流式 SSE、参数白名单）、Docker 代码执行沙箱（持久 Workspace、非 root、资源上限） |
| 运维 | A/B 双槽热升级、pino 结构化日志（密钥 redact）+ SQLite 环形日志、doctor 环境体检、counters 指标 |
| 管理台 | 内置 Web 控制台（`/admin`）：登录、仪表盘、扩展管理、Cron、通知、聊天、文件任务、设置、升级管理 |

## 快速开始

### 本地开发

```bash
git clone https://github.com/Travisun/opptrix-harness.git
cd opptrix-harness
npm install
cp .env.example .env          # 可选：端口/日志级别/沙箱开关
npm run dev                   # 默认监听 0.0.0.0:3000

# 首次启动生成 break-glass root 令牌（打印一次并持久化）
cat data/root-token
curl -s http://localhost:3000/health
```

打开 `http://localhost:3000/admin` 进入管理台，使用 `owner` + root 令牌登录。

### Docker 部署

```bash
cp .env.example .env
docker build -t opptrix-sandbox:latest -f docker/Dockerfile.sandbox docker/   # 可选：代码执行沙箱基镜像
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml exec opptrix cat /data/root-token
```

### 60 秒体验扩展

```bash
npm run harness -- make:extension my-ext      # 脚手架
npm run harness -- validate extensions/my-ext # 校验
# 内核启动后新建的扩展需先重扫目录再启用（admin 令牌）：
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/extensions/rescan
# 在管理台「扩展」页启用 my-ext，或：
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/extensions/my-ext/enable
curl http://localhost:3000/ext/my-ext/hello   # → {"hello":"world"}
```

## 架构总览

```text
┌─────────────────────────────────────────────────────┐
│ 主线程 Kernel（bootstrap.mjs 进程监管）               │
│  HTTP 路由 │ 事件总线 │ Hooks │ Cron │ 通知 │ 聊天    │
│  文件存储 │ 任务调度 │ LLM 网关 │ 数据层 │ 升级器      │
│  DI 容器 │ ExtensionManager │ 服务注册中心            │
├──────────────┬──────────────────┬───────────────────┤
│ 扩展线程      │ 任务线程          │ 代码执行沙箱        │
│ 每扩展独立    │ CPU 密集长任务    │ Docker 持久容器     │
│ vm.Context   │ 进度/超时/取消     │ 非 root + 资源上限  │
└──────────────┴──────────────────┴───────────────────┘
        ▲ MessagePort RPC（权限门 + 审计 + 熔断）
```

- **扩展线程**：所有扩展共享一个 worker 线程，各自独立 `vm.Context`；handler 异常只终结单次调用，线程崩溃自动退避重启并按依赖拓扑重注册
- **每扩展独立数据库**：`<dataDir>/db/ext/<id>.sqlite`，互不污染，卸载可选保留或清除
- **升级五道防线**：升级前自动备份 → sha256 校验 → 独立端口预检自检 → slots 原子提交 → 健康看门狗失败自动回滚

详细设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 扩展开发

扩展就是一个目录 + 一个 `manifest.json` + 一个入口文件：

```js
// extensions/my-ext/index.js
module.exports = defineExtension({
  setup(h) {
    h.route('GET', '/hello', async () => ({ hello: 'world' }));
    h.cron.schedule({ name: 'tick', expr: '*/5 * * * *' }, async () => {
      await h.notify.send({ title: '心跳', level: 'info' });
    });
    h.on('file.uploaded', async (file) => { /* 文件到达 */ });
    h.expose('parse', { run: async (args) => { /* 供其他扩展调用 */ } });
  },
});
```

能力面由 `manifest.permissions` 声明（fail-closed）：`h.route / h.on / h.hook / h.cron.schedule / h.notify / h.chat / h.files / h.tasks / h.db / h.llm / h.sandbox / h.storage / h.ui / h.expose / h.call`；`auth:provider` / `sandbox` / `rpc:call` 等高危能力在运行时逐调用强制，其余细粒度复核在路线图中。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（tsx watch） |
| `npm run build` / `npm start` | 编译到 `dist/` 并运行 |
| `npm run typecheck` | 全量类型检查 |
| `npm test` | 全量测试（63 文件 / 1206 用例） |
| `npm test -- --coverage` | 覆盖率（内核行覆盖 ≥ 80%，否则失败） |
| `npm run harness -- make:extension <id>` | 扩展脚手架 |
| `npm run harness -- validate <extDir>` | 扩展校验 |
| `npm run release` | 发布工程：tar.gz + sha256 + 升级 feed |

## 文档

完整文档（快速开始、架构、14 个核心服务、扩展开发、REST / 沙箱 API 参考、运维与升级手册、实战教程）位于独立文档站仓库 `opptrixdocuments`（Mintlify，35 章）。

## 安全

安全模型与边界声明见 [ARCHITECTURE.md](./ARCHITECTURE.md)（沙箱隔离语义、权限 fail-closed、root break-glass 令牌、上传净化、SQL 防护、容器加固旗标）。发现安全问题请勿公开提 Issue，优先私下联系维护者。

## License

[Apache-2.0](./LICENSE)
