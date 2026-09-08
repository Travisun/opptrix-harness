# opptrix-webui — Opptrix Harness OS Web Console（ui-src）

Vue3 + Vite SPA，构建产物输出到 `extensions/webui/ui/`，由内核以
`@fastify/static` 挂载到 `/ext/webui/ui/**`（`src/kernel/extensions/assets.ts`）。

```bash
npm install
npm run build   # 产物 → ../ui
npm run dev     # 本地开发（API 代理未配置；联调时直接对真实内核地址使用或加 proxy）
```

## 技术选型（Package-First 已评估）

依赖刻意压到最小：`vue`、`vue-router`、`vite`、`@vitejs/plugin-vue`。

- **无第三方 UI 组件库**：评估过 element-plus / naive-ui / primevue 等暗色管理台方案，
  均为重依赖（全量数百 KB 起步、主题体系与内核 `#0f1115` 暗色语言不一致、且会拖入
  图标/样式流水线）。控制台页面数量有限（10 页），以内联 CSS 变量暗色主题 +
  单文件组件 scoped 样式自绘即可覆盖，避免重依赖（ENGINEERING.md Package-First：
  "无合适暗色管理台微库" 的结论在此落地）。
- **状态管理未引入 pinia**：页面自治 + `api.ts` 模块级 toast/凭据状态已够；跨页共享
  状态只有 token/user 两项，localStorage 即存储位。
- **路由 hash 模式**：内核静态挂载无目录索引（`index:false`）与 rewrite 能力，
  history 深链刷新会 404；hash 路由是静态前缀托管下唯一自洽的模式。

## 与内核的契约

- REST 形状对齐 `src/api/*`（错误统一 `{ code, message }`，401 清凭据回登录页）。
- SSE 对齐 `src/kernel/http/sse/hub.ts`：`GET /api/v1/stream?topics=&token=`，
  事件帧 `event: notification.created | chat.message.created | task.progress …`。
- 页面清单：Login / Dashboard / Extensions / Cron / Notifications / Chat /
  FilesTasks / Settings / Update / Sandbox。
