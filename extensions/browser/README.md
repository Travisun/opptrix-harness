# browser — 浏览器自动化（内置扩展，轻壳）

给 LLM 提供浏览器导航/快照/交互/截图等工具。**引擎本体在内核**（`src/kernel/browser/**`，
Playwright 跑在内核主线程）；本扩展只是 manifest + 路由壳（doc-extract 同款模式）。

## 为什么引擎不在扩展沙箱里（方案 A 不可行的探针证据）

扩展运行于 `worker_threads + vm.Context`，`src/extension-host/sandbox.ts` 的受限
`require` 只放行**扩展目录内的相对 .js**（SEC-1/SEC-2 沙箱安全边界）。探针
（复刻实现同款路径裁决 + 真实 vm.Context，2026-09 在本仓库运行）：

| require 目标 | 结果 |
| --- | --- |
| `playwright-core` / `playwright` | 拒绝：`require denied: only relative .js files inside the extension directory` |
| `node:child_process` / `fs` | 同上拒绝 |
| `./local.js`（对照组，扩展目录内） | 正常加载 |

对照探针：裸 `worker_threads`（无 vm 沙箱）可以 `import('playwright-core')` 并拿到
`chromium.launch`——说明阻塞点正是扩展 vm 沙箱的 require 白名单，而非 worker 线程。
要么削弱 SEC-1/SEC-2 安全边界放行 npm 包与 Node 内置模块（不可接受），要么把引擎
放内核。故采用**方案 B**：扩展壳（本目录）+ 内核引擎（`src/kernel/browser`）。

## 能力面

- **LLM 工具（/mcp 系统工具，内核直接提供）**：`browser_navigate` / `browser_snapshot` /
  `browser_click` / `browser_type` / `browser_press_key` / `browser_screenshot` /
  `browser_close` / `browser_status`。
- **本扩展路由（auth:'user'，挂载于 `/ext/browser` 前缀）**：
  - `GET /api/status` → `{ extension, installed, running, installing, lastError }`；
  - `POST /install` → 幂等触发后台安装 chromium（立即返回 `{started, ...}`，不等完成）；
  - `GET /screenshots/:file` → 截图 PNG（`:file` 必须是 `browser_screenshot` 产出的
    `<uuid>.png`，uuid 形状校验防路径穿越）。
- **扩展桥（worker→kernel，manifest `'browser'` 权限收口）**：`browser.status` /
  `browser.install` / `browser.screenshot`（经沙箱门面 `h.browser.*`）。

## 运行语义

- 单例浏览器：同一时间至多一个 Browser + Page，全部操作 mutex 串行；等待队列
  深度超限（16）报 `browser_busy`；
- 空闲 10 分钟自动关浏览器（下轮工具调用再冷启动）；操作时实例已死自动重启一次；
- 页面导航超时 30s；URL 仅允许 http/https（`file://` 与其余协议拒绝）；
- **浏览器二进制默认不下载**（~150MB 重依赖）：未安装时页面类工具统一返回
  `{ ok:false, error:{ code:'browser_not_installed', hint } }` 结构化错误；
  `POST /ext/browser/install` 触发 `node node_modules/playwright-core/cli.js
  install chromium` 后台安装（幂等；状态内存 + `<dataDir>/browser/install.json` 标记）。
