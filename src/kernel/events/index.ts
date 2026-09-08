/**
 * 内核事件总线模块出口。
 * 使用方统一 `import { EventBus } from '../events/index.js'`。
 */
export { EventBus } from './bus.js';
export type { EventBusOptions, EventMeta, EventHandler, EmitResult, SubscribeOptions } from './bus.js';
