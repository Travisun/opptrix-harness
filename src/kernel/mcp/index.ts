/**
 * MCP 客户端子系统出口（Harness OS 作为 MCP Host/Client）。
 *
 * - `McpConfigStore`：`<dataDir>/mcp/config.json` 的原子持久化（0600）
 * - `McpRegistry`：连接编排（stdio / Streamable HTTP / SSE）+ 工具/资源/Prompt 门面
 * - `createMcpBridge`：扩展桥 handler 表（h.mcp.*，需 manifest 'mcp:client' 权限）
 * - 类型与 zod schema（McpServerConfig 及归一化结果形状）
 *
 * REST 面（registerMcpRoutes）在 src/api/mcp.ts；内核接线（boot 期装配 + bridge 并表）
 * 属集成层职责，本目录保持零内核依赖（Kernel.ts 不反向 import 本子系统）。
 */
export { McpConfigStore, type McpConfigPatch } from './config-store.js';
export { McpRegistry, type McpRegistryDeps } from './registry.js';
export { createMcpBridge, MCP_CLIENT_PERMISSION, type McpBridgeDeps, type McpBridgeHandlers } from './bridge.js';
export {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_ID_PATTERN,
  MCP_TIMEOUT_MAX_MS,
  MCP_TIMEOUT_MIN_MS,
  mcpServerConfigSchema,
  validateMcpServerConfig,
} from './types.js';
export type {
  McpCallToolResult,
  McpContentBlock,
  McpGetPromptResult,
  McpListToolsFilter,
  McpPromptInfo,
  McpRefreshResult,
  McpResourceContents,
  McpResourceInfo,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpServerSummary,
  McpToolInfo,
  McpTransportKind,
} from './types.js';
