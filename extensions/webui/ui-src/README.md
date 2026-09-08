# opptrix-webui — Opptrix Harness OS Web Console（ui-src）

React 18 + TypeScript + Tailwind CSS v4 + shadcn/ui 管理台 SPA，构建产物输出到
`extensions/webui/ui/`，由内核以 `@fastify/static` 挂载到 `/ext/webui/ui/**`
（`src/kernel/extensions/assets.ts`），`/admin` 接管重定向到同一产物。

```bash
npm install
npm run build       # 产物 → ../ui
npm run typecheck   # tsc --noEmit（strict）
npm run dev         # 本地开发（联调时对真实内核地址使用或自行加 proxy）
```

## 技术选型（Package-First）

- **React 18 + react-router-dom（HashRouter）**：静态挂载无目录索引（index:false）
  与 rewrite 能力，hash 路由是深链可刷新的唯一自洽模式（历史约束）。
- **Tailwind CSS v4**（`@tailwindcss/vite` + CSS-first `@theme inline`）：CSS 变量即
  设计 token，与 shadcn/ui 官方 v4 组件源码零摩擦；无 tailwind.config.js/postcss 配置。
- **shadcn/ui 组件源码 vendor 进 `src/components/ui/*`**（MIT）：button/input/label/card/
  dialog/sheet/dropdown-menu/tabs/table/badge/switch/select/textarea/scroll-area/
  separator/skeleton/tooltip/avatar/alert；Radix 原语按需引入（无头、无样式锁定）。
  toast 为轻量自研（context + 模块级事件总线，api.ts 可直接调用，不引 sonner）。
- 图标 lucide-react；类名工具 clsx + tailwind-merge + class-variance-authority。

## 主题 Token 体系（src/lib/theme.tsx + src/styles.css）

- shadcn 标准 CSS 变量全集（`--background/--foreground/--card/--primary/--secondary/
  --muted/--accent/--destructive/--border/--input/--ring/--radius/--sidebar-*/…`），
  `:root` 亮色 + `.dark` 暗色两套（zinc 基调，oklch）。
- `ThemeProvider` 运行期覆盖链：**mode → accent 预设 → radius/density → custom**，
  全部经 `document.documentElement.style.setProperty` 应用；重应用前清空上一轮内联
  属性，`resetToDefaults()` 无残留。
  - mode：`light | dark | system`（跟随 prefers-color-scheme），class 策略 +
    localStorage('ui.mode')；index.html 内联脚本首帧前预应用防闪烁；
  - accent 预设 ≥6 组（default/zinc/violet/blue/emerald/amber/rose，每组覆盖
    `--primary/--ring/--accent/--sidebar-*` 等，亮暗两套取值）；
  - 圆角档位 `--radius`：0 / 0.25 / 0.5 / 0.75 / 1rem；
  - 密度：comfortable / compact（`--density-py/--density-px/--density-line-height/
    --density-gap` 行高与 padding 令牌）；
  - 自定义覆盖：任意 `--*` CSS 变量键值直改，存 localStorage('ui.tokens')。
- 「外观（主题定制器）」设置界面由 W4 批次在 Settings 页填充，本包已提供全部能力。

## 壳层（src/components/layout + src/features）

- 桌面（≥lg）三栏：可折叠侧栏（折叠态持久化 localStorage('ui.sidebar.collapsed')）
  ｜主内容｜右侧聊天面板（默认隐藏，宽 ~380px）。
- 移动（<lg）：侧栏 → 汉堡 + Sheet 抽屉；聊天面板 → 右侧全屏 Sheet；顶栏含汉堡/
  标题/主题切换/聊天开关（未读徽标）/用户菜单（身份 + 退出）。
- 未读计数：`NotificationsProvider` 订阅 SSE topics=notifications（REST 初始 + SSE
  增量 + replay-gap 对账），与聊天未读（`ChatPanelContext.unread`）分开徽标显示。
- 聊天面板槽位：`src/features/chat/ChatPanel.tsx` 的 `ChatPanelSlot`，W3 聊天包只替换
  该槽位内部实现。

## 与内核的契约

- REST 形状对齐 `src/api/*` 与 auth 扩展（错误统一 `{ code, message }`；
  401 清 localStorage('ui.token') 回登录页）。
- SSE 对齐 `src/kernel/http/sse/hub.ts`：`GET /api/v1/stream?topics=&token=
  [&lastEventId=topic:seq]`；断线自动重连带游标、`: replay` 帧静默、`replay-gap`
  触发调用方 REST 对账。
- 路由：/login + 11 条主导航（仪表盘/扩展/定时任务/通知中心/文件与任务/沙箱/用户/
  API Keys/日志/设置/升级）+ 兜底重定向；未实现页渲染统一 Placeholder 空态。
