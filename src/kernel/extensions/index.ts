/**
 * kernel/extensions 桶导出。
 *
 * 生命周期与 RPC 桥（本工作包核心）：
 * - `ExtensionBridge` / `WorkerLike` / `ExtensionBridgeDeps`
 * - `ExtensionManager` / `ExtensionManagerDeps` / `ExtRouteTableEntry` / `ExtSummary` …
 *
 * 契约层（manifest / contributions 的 zod schema 与校验器）一并在此露出；
 * HTTP 集成层模块（routes / registry / assets）由路由模块按深路径直接导入，
 * 不进本桶（避免内核消费者被迫拉入 fastify 依赖图）。
 */
export * from './bridge.js';
export * from './manager.js';
export * from './manifest.js';
export * from './contributions.js';
