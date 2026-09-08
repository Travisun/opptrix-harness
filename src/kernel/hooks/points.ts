/**
 * 全系统 hook 埋点常量（单一事实来源）。
 *
 * 内核与扩展注册/触发 hook 一律引用此常量（如 `HOOK_POINTS.chatBeforeSend`），
 * 禁止手写埋点字符串，避免拼写漂移导致 hook 静默失效。
 * 值形如 `<domain>.<event>`（camelCase 事件名）。
 */
export const HOOK_POINTS = {
  // ---- 内核生命周期 ----
  kernelBoot: 'kernel.boot',
  kernelReady: 'kernel.ready',
  kernelShutdown: 'kernel.shutdown',
  // ---- HTTP ----
  httpBeforeRoute: 'http.beforeRoute',
  httpAfterRoute: 'http.afterRoute',
  // ---- Chat ----
  chatBeforeSend: 'chat.beforeSend',
  // ---- Notification ----
  notificationBeforeSend: 'notification.beforeSend',
  // ---- File 存储 ----
  fileBeforeStore: 'file.beforeStore',
  fileAfterStore: 'file.afterStore',
  // ---- Task ----
  taskBeforeRun: 'task.beforeRun',
  taskAfterRun: 'task.afterRun',
  taskOnError: 'task.onError',
  // ---- Cron ----
  cronBeforeRun: 'cron.beforeRun',
  cronAfterRun: 'cron.afterRun',
  cronOnError: 'cron.onError',
  // ---- Extension 生命周期 ----
  extensionInstalling: 'extension.installing',
  extensionInstalled: 'extension.installed',
  extensionBeforeDisable: 'extension.beforeDisable',
  extensionDisabled: 'extension.disabled',
  extensionEnabled: 'extension.enabled',
  extensionUninstalled: 'extension.uninstalled',
} as const;

/** 埋点名类型：HOOK_POINTS 的全部合法取值 */
export type HookPoint = (typeof HOOK_POINTS)[keyof typeof HOOK_POINTS];

/**
 * 事件命名空间（供 Broker/事件系统与 hook 埋点共享同一套域前缀）。
 * 扩展私有事件用 `EVENT_NS.ext(id)` 生成 `ext.<id>` 前缀，与内核域隔离。
 */
export const EVENT_NS = {
  kernel: 'kernel',
  file: 'file',
  task: 'task',
  chat: 'chat',
  ext: (id: string) => `ext.${id}`,
} as const;
