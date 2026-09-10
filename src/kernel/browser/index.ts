/**
 * browser — 浏览器自动化内核能力层出口（Playwright 跑在内核主线程，方案 B）。
 *
 * 装配示例（内核 provider 层，本包不接线）：
 * ```ts
 * const engine = new BrowserEngine({ dataDir: config.dataDir, logger });
 * kernel.container.instance(CONTAINER_KEYS.browserEngine, engine);
 * const bridgeHandlers = createBrowserBridge({ engine, requirePermission }); // 扩展桥并表
 * // LLM 工具面：system-server 的 buildSystemToolCatalog 追加 createBrowserTools
 * ```
 *
 * 调用方与门禁：
 * - **LLM/外部系统**：/mcp 系统工具 browser_*（createBrowserTools，admin 身份）；
 * - **扩展壳（extensions/browser）**：h.browser.* 门面 → browser.* 桥 topic
 *   （manifest 'browser' 权限收口）；壳把 status/install/screenshots 暴露为
 *   /ext/browser/* 扩展路由（auth:'user'）。
 * - 本模块不提供 REST：/ext/browser/* 即管理面（需求如此），工具面经 /mcp。
 */
export { BrowserEngine } from './engine.js';
export type {
  BrowserEngineDeps,
  BrowserLogger,
  InstallerProcessLike,
  PlaywrightBrowserLike,
  PlaywrightLocatorLike,
  PlaywrightModuleLike,
  PlaywrightPageLike,
  PlaywrightResponseLike,
} from './engine.js';
export { createBrowserBridge, BROWSER_PERMISSION } from './bridge.js';
export type { BrowserBridgeDeps, BrowserBridgeHandlers, BrowserBridgeService } from './bridge.js';
export {
  BROWSER_IDLE_CLOSE_MS,
  BROWSER_NAV_TIMEOUT_MS,
  BROWSER_QUEUE_LIMIT,
  BROWSER_SNAPSHOT_MAX_BYTES,
  SCREENSHOT_FILE_PATTERN,
  BrowserBusyError,
  BrowserNotInstalledError,
  BrowserScreenshotNameError,
  BrowserUrlRejectedError,
} from './types.js';
export type {
  BrowserClickInput,
  BrowserInstallResult,
  BrowserNavigateResult,
  BrowserPressKeyInput,
  BrowserScreenshotFile,
  BrowserScreenshotInput,
  BrowserScreenshotResult,
  BrowserSnapshotResult,
  BrowserStatus,
  BrowserTypeInput,
} from './types.js';
