/**
 * MCP 客户端子系统 — 共享类型与校验。
 *
 * Harness OS 作为 MCP Host/Client 接入外部 MCP Server（官方规范：
 * https://modelcontextprotocol.io —— 客户端经 transport 与 server 交换
 * tools / resources / prompts 三类能力）。本模块定义：
 * - `McpServerConfig`：单个外部 server 的持久化配置（transport 三形态之一）
 * - `McpServerConfig` 的 zod schema（入参单一事实来源，REST 与 config store 共用）
 * - 运行时状态与归一化结果类型（registry 对外只吐本模块的形状，不泄漏 SDK 类型）
 *
 * Package-First：协议实现全部委托 @modelcontextprotocol/sdk（官方 SDK，MIT），
 * 本子系统只做配置持久化、连接编排、错误归一与门禁，不自研协议。
 */
import { z } from 'zod';

import { err } from '../errors/index.js';

/** 传输形态：stdio 子进程 / Streamable HTTP（远程，现行推荐）/ SSE（远程，旧版兼容） */
export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

/** server id 形态约束：小写字母/数字开头，仅小写字母、数字、下划线、连字符（文件名安全） */
export const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** 单次 MCP RPC 的默认超时（毫秒）；可被 config.timeoutMs / registry defaultTimeoutMs 覆盖 */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** timeoutMs 允许区间：1s .. 10min（与内核 rpcTimeoutMs 量级对齐） */
export const MCP_TIMEOUT_MIN_MS = 1_000;
export const MCP_TIMEOUT_MAX_MS = 600_000;

/**
 * 单个外部 MCP Server 的持久化配置（`<dataDir>/mcp/config.json` 的条目形状）。
 * stdio 必填 command（可选 args/env）；streamable-http/sse 必填 url（可选 headers）。
 * env/headers 可能携带凭据：文件 0600、REST 仅 admin，且永不入日志。
 */
export interface McpServerConfig {
  /** 稳定标识（^[a-z0-9][a-z0-9_-]*$）；连接/工具检索的唯一键 */
  id: string;
  /** 展示名（管理台/日志用，可读） */
  name: string;
  /** 传输形态（决定 registry 用哪个 ClientTransport） */
  transport: McpTransportKind;
  /** stdio：可执行文件（绝对路径或 PATH 可解析名） */
  command?: string;
  /** stdio：命令行参数 */
  args?: string[];
  /** stdio：追加到最小安全环境（PATH/HOME 等）之后的进程环境 */
  env?: Record<string, string>;
  /** streamable-http / sse：server 端点（http/https） */
  url?: string;
  /** streamable-http / sse：随请求发送的额外头（可含 Authorization 等凭据） */
  headers?: Record<string, string>;
  /** false = 不参与自动连接（refreshAll 跳过并断开既有连接） */
  enabled: boolean;
  /** 单次 MCP RPC 超时（毫秒）；缺省 30_000 */
  timeoutMs?: number;
}

/**
 * `McpServerConfig` 的 zod schema（字段级校验；跨字段约束见 `validateMcpServerConfig`：
 * stdio 必须给 command，streamable-http/sse 必须给 url）。
 */
export const mcpServerConfigSchema = z.object({
  id: z.string().regex(MCP_ID_PATTERN, 'id must match ^[a-z0-9][a-z0-9_-]*$').max(64),
  name: z.string().min(1).max(200),
  transport: z.enum(['stdio', 'streamable-http', 'sse']),
  command: z.string().min(1).max(2048).optional(),
  args: z.array(z.string().min(1).max(4096)).max(128).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.url().max(2048).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(MCP_TIMEOUT_MIN_MS).max(MCP_TIMEOUT_MAX_MS).optional(),
});

/**
 * 校验并归一一条 server 配置：字段级（zod）+ 跨字段（transport 与必填项的配套）。
 * 失败抛 HarnessError(VALIDATION_FAILED)，message 面向管理员可操作。
 */
export function validateMcpServerConfig(input: unknown): McpServerConfig {
  const parsed = mcpServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw err('VALIDATION_FAILED', {
      message:
        'mcp server config is invalid — id must match ^[a-z0-9][a-z0-9_-]*$, name must be 1-200 chars, ' +
        'transport one of stdio|streamable-http|sse, timeoutMs (when present) in [1000, 600000]',
      detail: parsed.error.issues,
    });
  }
  const cfg = parsed.data;
  if (cfg.transport === 'stdio' && (cfg.command === undefined || cfg.command === '')) {
    throw err('VALIDATION_FAILED', {
      message: `mcp server "${cfg.id}": transport "stdio" requires a "command" (executable to spawn)`,
      detail: { id: cfg.id, transport: cfg.transport },
    });
  }
  if ((cfg.transport === 'streamable-http' || cfg.transport === 'sse') && (cfg.url === undefined || cfg.url === '')) {
    throw err('VALIDATION_FAILED', {
      message: `mcp server "${cfg.id}": transport "${cfg.transport}" requires a "url" (http/https endpoint)`,
      detail: { id: cfg.id, transport: cfg.transport },
    });
  }
  if (cfg.url !== undefined && cfg.url !== '' && !/^https?:\/\//i.test(cfg.url)) {
    throw err('VALIDATION_FAILED', {
      message: `mcp server "${cfg.id}": "url" must start with http:// or https:// (got "${cfg.url.slice(0, 64)}")`,
      detail: { id: cfg.id },
    });
  }
  return cfg;
}

/** server 运行态：已连接 / 出错 / 已禁用 / 从未连接（进程生命周期内的记忆态） */
export type McpServerState = 'connected' | 'error' | 'disabled' | 'never';

/** status(id) 的返回形状 */
export interface McpServerStatus {
  id: string;
  state: McpServerState;
  /** state === 'error' 时最后一次失败的归一原因（面向管理员可操作） */
  error?: string;
  /** 连接期缓存的工具数（未连接为 0） */
  toolCount: number;
}

/** list() 的条目：完整配置 + 运行态（仅 admin 面使用；env/headers 含凭据不下发扩展） */
export interface McpServerSummary extends McpServerConfig, McpServerStatus {}

/** 工具目录条目（connect 时 listTools 缓存） */
export interface McpToolInfo {
  name: string;
  description?: string;
  /** JSON Schema（MCP 规范 draft 2020-12）原样透传 */
  inputSchema?: unknown;
}

/** 资源目录条目（connect 时 listResources 缓存） */
export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Prompt 目录条目（connect 时 listPrompts 缓存） */
export interface McpPromptInfo {
  name: string;
  description?: string;
  /** 参数声明原样透传（MCP 规范的 prompt argument 列表） */
  arguments?: unknown;
}

/**
 * MCP content 块的归一形状：text 块收敛为 `{ type: 'text', text }`；
 * 其余块（image/audio/resource_link/…）按 server 原样透传（仅保证 type: string 且可 JSON 序列化）。
 */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** callTool 的归一返回（MCP CallToolResult 的最小投影） */
export interface McpCallToolResult {
  content: McpContentBlock[];
  /** server 侧声明执行失败（isError:true）时置 true，缺省不出现 */
  isError?: boolean;
}

/** readResource 的归一返回（MCP ReadResourceResult.contents 的最小投影） */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  /** 文本资源（mimeType 缺省 text/*） */
  text?: string;
  /** 二进制资源（base64） */
  blob?: string;
}

/** getPrompt 的归一返回（MCP GetPromptResult 的最小投影；messages 原样透传） */
export interface McpGetPromptResult {
  description?: string;
  messages: unknown[];
}

/** listTools 的过滤条件；serverId 缺省 = 全部已连接 server 的工具合并列表 */
export interface McpListToolsFilter {
  serverId?: string;
}

/** refreshAll 的结果摘要（失败不抛错，逐条落 failed 供调用方观测） */
export interface McpRefreshResult {
  connected: string[];
  failed: { id: string; error: string }[];
}
