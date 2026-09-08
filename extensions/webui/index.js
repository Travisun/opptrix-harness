'use strict';

/**
 * webui — Opptrix Harness OS 内置管理台扩展（builtin:true, mount:'ui'）。
 *
 * 职责：Vue3 SPA 管理台（源码见 ui-src/，构建产物见 ui/）。
 *
 * 声明面（两条等价通道并存，见 types/harness.d.ts PageDefinition 注释「二选一即可」）：
 * - manifest.json `ui.pages` / `ui.menu`：内核静态资产挂载的数据源——Kernel 装配期
 *   检查 `manifest.ui !== undefined` 且 `<extDir>/ui/` 目录在盘，才会把该目录挂到
 *   `/ext/webui/ui/**`（src/kernel/extensions/assets.ts）。没有这段声明，构建产物
 *   不会被内核静态服务。
 * - 下方 h.page / h.menu：运行期 UI 贡献注册（激活期捕获进贡献点快照，随 host.load
 *   回报内核），与 manifest 声明等价；本扩展是 SPA 单页应用，仅注册根页面。
 *
 * mount:'ui' 语义（AGENTS.md 内置扩展白名单：webui → /admin）：接管管理台入口。
 * 当前内核（阶段 11）的 mount 接线仅实现了 'auth'（→ /api/v1/auth|users），'ui' 的
 * /admin 路由由内核侧后续工作包落地；本扩展按"声明相对路径 '/'"的最小契约声明，
 * 不做任何越权的入口假设。
 *
 * 本文件运行在 VM 沙箱内：无 require / Node API，禁止 console 系列输出；
 * 仅可用注入的 `h.*` 与全局 `defineExtension`。
 */

defineExtension(async (h) => {
  // 管理台唯一页面：入口 HTML 为构建产物 ui/index.html（相对扩展目录）
  h.page('/', { title: 'Console', entry: 'index.html' });
  // 菜单（GET /api/v1/ui 聚合的消费形状；单值语义，最后一次提供为准）
  h.menu('Console');
});
