/**
 * 全局 LLM 记忆系统 — 公共出口。
 *
 * 模块构成：
 * - `types.ts`：共享类型/设置缺省（MemoryRecord / MemorySettings …）；
 * - `store.ts`：MemoryStore（kernel.sqlite 的 memories 表 + FTS5 虚表 + 同步触发器）；
 * - `extractor.ts`：createMemoryExtractor（LLM 抽取管线，自家 LlmGateway 契约）；
 * - `manager.ts`：MemoryManager（去重 / 检索 / 抽取入库 / 容量治理）；
 * - `bridge.ts`：createMemoryBridge（扩展 RPC 桥，manifest 'memory' 权限）。
 *
 * 接线（集成方，参照 providers/core-services.ts 的桥装配模式）：
 * - REST：`registerMemoryRoutes(app, { checker, manager, settings })`；
 * - 桥：`createMemoryBridge({ manager, requirePermission })` 并进 bridgeHandlers。
 */
export {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_KINDS,
  MEMORY_SETTINGS_KEY,
  mergeMemorySettings,
} from './types.js';
export type {
  ExtractedFact,
  MemoryAddInput,
  MemoryExtractResult,
  MemoryForgetFilter,
  MemoryKind,
  MemoryListOptions,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchOptions,
  MemorySettings,
  MemorySource,
  MemoryStats,
} from './types.js';
export {
  DEFAULT_SEARCH_LIMIT,
  MEMORIES_FTS_TABLE,
  MEMORIES_TABLE,
  MemoryStore,
  ftsMatchQuery,
} from './store.js';
export { EXTRACTION_PROMPT, createMemoryExtractor, parseFactsJson } from './extractor.js';
export type {
  MemoryExtractOptions,
  MemoryExtractor,
  MemoryExtractorDeps,
  MemoryExtractorGateway,
} from './extractor.js';
export { DEFAULT_MAX_MEMORIES, MemoryManager } from './manager.js';
export type { MemoryAddResult, MemoryManagerDeps } from './manager.js';
export { MEMORY_PERMISSION, createMemoryBridge } from './bridge.js';
export type { MemoryBridgeDeps, MemoryBridgeHandlers } from './bridge.js';
