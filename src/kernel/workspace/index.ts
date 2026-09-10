/**
 * workspace — 会话工作区内核出口。
 * 统一 `import { WorkspaceService } from '../workspace/index.js'`。
 */
export {
  MAX_CHAIN_DEPTH,
  MAX_FILE_BYTES,
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  MAX_REL_PATH_CHARS,
  WorkspaceService,
} from './service.js';
export type { WorkspaceEntry, WorkspaceResolveResult, WorkspaceServiceDeps } from './service.js';
