/**
 * MCP 扩展桥 — 扩展线程经 worker→kernel RPC 访问 MCP 客户端子系统的 handler 表。
 *
 * 与 kernel-handlers.ts 的桥接模式一致：本工厂只产出 `handlers[topic]` 表
 * （键 = KERNEL_TOPICS.mcpServersList / mcpToolsList / mcpToolsCall），由集成方
 * 并入 ExtensionManager.deps.bridgeHandlers。权限不在此自查 manifest——依赖注入的
 * `requirePermission(extId, topic, permission)` 闭包（集成方传 kernel-handlers 同款
 * 实现）做裁决，本模块保证三个 topic 都以 'mcp:client' 权限收口（fail-closed：
 * 调用方非扩展端点、或未声明权限，一律抛错，不会触达 registry）。
 *
 * 线格式（h.mcp.* 契约，面向扩展开发者）：
 * - `mcp.servers.list`  {} → { id, name, transport, enabled, state, toolCount }[]
 *   （刻意裁剪：不含 command/args/env/url/headers——env/headers 可含凭据，永不下发扩展）
 * - `mcp.tools.list`    { serverId? } → (McpToolInfo & { serverId })[]
 *   （serverId==='system' 时返回系统操作工具目录；缺省 = 外部 server 工具 + system 目录合并）
 * - `mcp.tools.call`    { serverId, toolName, args?, timeoutMs? } → McpCallToolResult
 *   （serverId==='system' 时路由到系统工具目录执行器，返回 {ok,...} 结果对象——
 *   系统工具执行身份固定为内核 admin，见 system-tools.ts 的信任模型说明）
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';
import type { McpRegistry } from './registry.js';
import { SYSTEM_SERVER_ID } from './system-tools.js';
import { currentSystemRuntime, type SystemToolRuntime } from './system-server.js';

/** 扩展访问 MCP 客户端所需 manifest 权限（manifest.permissions 声明） */
export const MCP_CLIENT_PERMISSION = 'mcp:client';

/** 桥 handler 的统一形状（与 KernelBridgeHandlers 兼容，但不依赖其类型避免环） */
export type McpBridgeHandler = (payload: unknown, from: string) => Promise<unknown>;
export type McpBridgeHandlers = Record<string, McpBridgeHandler>;

/** createMcpBridge 依赖集合 */
export interface McpBridgeDeps {
  /** MCP 注册中心的只读/调用面（刻意窄接口：扩展不可连接/断连/改配置） */
  registry: Pick<McpRegistry, 'listTools' | 'callTool' | 'list'>;
  /** 权限闸（集成方注入 kernel-handlers 同款闭包）：不通过即抛 FORBIDDEN */
  requirePermission: (extId: string, topic: string, permission: string) => void;
  /**
   * 系统工具目录执行器的懒解析（可选；Kernel /mcp 接线后容器内才存在）。
   * 提供后 mcp.tools.list 追加 serverId='system' 的系统操作工具，mcp.tools.call
   * 对 serverId==='system' 的调用路由到目录执行器（admin 身份执行）。
   */
  systemRuntime?: () => SystemToolRuntime | undefined;
}

/** mcp.tools.list 线格式 */
const toolsListSchema = z.object({
  serverId: z.string().min(1).max(64).optional(),
});

/** mcp.tools.call 线格式 */
const toolsCallSchema = z.object({
  serverId: z.string().min(1).max(64),
  toolName: z.string().min(1).max(256),
  args: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
});

/** 端点 → 裸扩展 id（与 kernel-handlers 同规则）；'kernel'/空 → null */
function extIdFrom(from: string): string | null {
  if (from === 'kernel' || from === '') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** 非扩展端点闸：内核自身不走 worker→kernel 通道调 MCP（RPC_PERMISSION_DENIED 同款语义） */
function requireExtCaller(from: string, topic: string): string {
  const extId = extIdFrom(from);
  if (extId === null || extId === '') {
    throw err('RPC_PERMISSION_DENIED', {
      message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
      detail: { topic, from },
    });
  }
  return extId;
}

/**
 * 装配 MCP 扩展桥 handler 表（见模块头注释的 h.mcp.* 契约）。
 *
 * @param deps.registry MCP 注册中心窄面（listTools/callTool/list）
 * @param deps.requirePermission 权限闭包（集成方传 kernel-handlers 的校验实现；
 *   以 MCP_CLIENT_PERMISSION='mcp:client' 收口全部三个 topic）
 */
export function createMcpBridge(deps: McpBridgeDeps): McpBridgeHandlers {
  /** 统一闸：扩展端点 + 'mcp:client' 权限；返回 extId 供 detail 使用 */
  const gate = (from: string, topic: string): string => {
    const extId = requireExtCaller(from, topic);
    deps.requirePermission(extId, topic, MCP_CLIENT_PERMISSION);
    return extId;
  };

  /** server 摘要的扩展安全投影（裁剪配置明细，防凭据出内核） */
  const toExtSafeSummary = (summary: Awaited<ReturnType<McpBridgeDeps['registry']['list']>>[number]) => ({
    id: summary.id,
    name: summary.name,
    transport: summary.transport,
    enabled: summary.enabled,
    state: summary.state,
    toolCount: summary.toolCount,
  });

  /** 系统工具目录条目的目录合并投影（serverId='system'，描述标注「系统操作」） */
  const resolveSystemRuntime = deps.systemRuntime ?? currentSystemRuntime;
  const systemToolEntries = (): Array<{ serverId: string; name: string; description: string; inputSchema: unknown }> => {
    const runtime = resolveSystemRuntime();
    if (runtime === undefined) return [];
    return runtime.listTools().map((tool) => ({
      serverId: SYSTEM_SERVER_ID,
      name: tool.name,
      description: `${tool.description}（系统操作）`,
      inputSchema: tool.inputSchema,
    }));
  };

  /** system 调用路由的运行时解析（未接线 → INTERNAL，提示装配缺失） */
  const requireSystemRuntime = (): SystemToolRuntime => {
    const runtime = resolveSystemRuntime();
    if (runtime === undefined) {
      throw err('INTERNAL', {
        message: 'system tool runtime is not available (kernel /mcp wiring missing)',
      });
    }
    return runtime;
  };

  return {
    [KERNEL_TOPICS.mcpServersList]: async (payload, from) => {
      void payload;
      const extId = gate(from, KERNEL_TOPICS.mcpServersList);
      const servers = await deps.registry.list();
      void extId;
      return servers.map(toExtSafeSummary);
    },

    [KERNEL_TOPICS.mcpToolsList]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.mcpToolsList);
      const parsed = toolsListSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'mcp.tools.list requires payload { serverId?: string }',
          detail: parsed.error.issues,
        });
      }
      // system 目录优先路由：serverId==='system' → 仅系统工具（不触达外部 registry）；
      // 缺省 → 外部 server 工具 + 系统工具合并；其余 serverId → 仅该 server 的工具
      if (parsed.data.serverId === SYSTEM_SERVER_ID) return systemToolEntries();
      const remote = await deps.registry.listTools(
        parsed.data.serverId !== undefined ? { serverId: parsed.data.serverId } : undefined,
      );
      if (parsed.data.serverId !== undefined) return remote;
      return [...remote, ...systemToolEntries()];
    },

    [KERNEL_TOPICS.mcpToolsCall]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.mcpToolsCall);
      const parsed = toolsCallSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'mcp.tools.call requires payload { serverId: string, toolName: string, args?: object, timeoutMs?: number }',
          detail: parsed.error.issues,
        });
      }
      // serverId==='system' → 目录执行器（admin 身份；结果恒为 {ok,...} 形状，不抛）
      if (parsed.data.serverId === SYSTEM_SERVER_ID) {
        return await requireSystemRuntime().call(parsed.data.toolName, parsed.data.args ?? {});
      }
      return await deps.registry.callTool(
        parsed.data.serverId,
        parsed.data.toolName,
        parsed.data.args,
        parsed.data.timeoutMs,
      );
    },
  };
}
