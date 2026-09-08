/**
 * tasks — 长任务模块桶导出（TaskStore / TaskWorkerPool / TaskManager）。
 *
 * 典型组装（内核 provider 阶段）：
 * ```ts
 * const store = new TaskStore(db);
 * const manager = new TaskManager({ store, pool: poolFacade, emit: bus.emit.bind(bus), publish: hub.publish.bind(hub), logger });
 * const pool = new TaskWorkerPool({
 *   size: 4, logger,
 *   onProgress: manager.onProgress, onDone: manager.onDone, onFailed: manager.onFailed,
 * });
 * await manager.start(); // pool.start + sweep 定时器
 * ```
 * （poolFacade 为指向 pool 的懒门面，规避 manager/pool 互相引用的构造顺序问题。）
 */
export * from './store.js';
export * from './manager.js';
export * from './worker-pool.js';
