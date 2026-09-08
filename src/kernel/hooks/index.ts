/**
 * 内核 hook 模块出口。
 * 使用方统一 `import { HookManager, HookAbort, HOOK_POINTS, EVENT_NS } from '../hooks/index.js'`。
 */
export { HookAbort, HookManager } from './manager.js';
export type { HookContext, HookHandler, HookManagerOptions } from './manager.js';
export { EVENT_NS, HOOK_POINTS } from './points.js';
export type { HookPoint } from './points.js';
