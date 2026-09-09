/**
 * memory-bridge — 扩展 → 内核记忆服务的 RPC 桥（worker→kernel 网关的 handler 表）。
 *
 * topics 已在 extension-host/protocol.ts 预置（本模块只消费不改动）：
 * `memory.search` / `memory.add` / `memory.extract` / `memory.list` / `memory.forget`。
 *
 * 权限模型（照 src/kernel/extensions/kernel-handlers.ts 的闸模式）：
 * - `requireExtId`：调用方必须是扩展端点（'ext:<id>' 或裸扩展 id；'kernel' 拒绝——
 *   内核自身不走 worker→kernel 通道）；
 * - `deps.requirePermission(extId, topic, 'memory')`：权限检查闭包由**集成方注入**
 *   （内核装配时通常为"manifest.permissions 必须声明 'memory'"的复核），本桥不直接
 *   依赖 ExtensionManager，保持与 skills/mcp/plugins 三桥同款的可装配性；
 * - `extract` 额外语义：抽取要调 LLM 网关（有成本），manifest 仍只需 'memory' 一项
 *   权限（v1 不细分 memory:extract——权限矩阵口径见 docs/memory.mdx）。
 *
 * 线格式与 REST 同形状（camelCase 入参、MemoryRecord 出参），差异仅在错误语义：
 * handler 抛 HarnessError 由桥层统一映射（RPC_TIMEOUT/HANDLER 语义由网关兜底）。
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';
import type { MemoryManager } from './manager.js';

/** 扩展访问记忆服务所需的 manifest 权限名 */
export const MEMORY_PERMISSION = 'memory';

/** 桥 handler 表形状（与 KernelBridgeHandlers 兼容的最小结构） */
export type MemoryBridgeHandlers = Record<string, (payload: unknown, from: string) => Promise<unknown>>;

export interface MemoryBridgeDeps {
  /** 记忆管理器（领域编排层） */
  manager: MemoryManager;
  /** 权限检查闭包（集成方注入；未通过应抛 FORBIDDEN/RPC_PERMISSION_DENIED） */
  requirePermission: (extId: string, topic: string, permission: string) => void;
}

/** 端点 → 裸扩展 id；'kernel' 返回 null（worker 自身诊断通道，无权访问记忆） */
function extIdFrom(from: string): string | null {
  if (from === 'kernel') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** 非日志 topic 的调用方闸：必须是扩展端点（照 kernel-handlers 同名函数的模式） */
function requireExtId(from: string, topic: string): string {
  const extId = extIdFrom(from);
  if (extId === null || extId === '') {
    throw err('RPC_PERMISSION_DENIED', {
      message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
      detail: { topic, from },
    });
  }
  return extId;
}

// ---------------------------------------------------------------------------
// 线格式 payload schema（与 REST body 同形状）
// ---------------------------------------------------------------------------

const searchPayloadSchema = z.object({
  query: z.string().min(1).max(4_096),
  limit: z.number().int().min(1).max(100).optional(),
  kind: z.string().min(1).max(32).optional(),
});

const addPayloadSchema = z.object({
  content: z.string().min(1).max(8_000),
  kind: z.enum(['fact', 'preference', 'event', 'procedure']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
  source: z.enum(['manual', 'llm_extract', 'extension']).optional(),
  scope: z.string().min(1).max(128).optional(),
  sessionRef: z.string().max(256).nullable().optional(),
});

const extractPayloadSchema = z.object({
  text: z.string().min(1).max(100_000),
  model: z.string().min(1).max(256).optional(),
  sessionRef: z.string().max(256).optional(),
  scope: z.string().min(1).max(128).optional(),
});

const listPayloadSchema = z.object({
  kind: z.string().min(1).max(32).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const forgetPayloadSchema = z.object({
  id: z.string().min(1).max(128),
});

/** zod 校验失败 → VALIDATION_FAILED（detail = issues） */
function parsePayload<T extends z.ZodType>(schema: T, payload: unknown, topic: string): z.output<T> {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw err('VALIDATION_FAILED', {
      message: `kernel service "${topic}": invalid payload`,
      detail: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * 装配记忆桥 handler 表（topic 键与 KERNEL_TOPICS.memory* 一致）。
 * 返回的表交由集成方并进 bridgeHandlers（与 skills/mcp/plugins 桥同款装配：
 * 内核 handler 表未命中时经 extraBridges 代理查询）。
 */
export function createMemoryBridge(deps: MemoryBridgeDeps): MemoryBridgeHandlers {
  const { manager, requirePermission } = deps;

  /** 单 topic 的统一闸：扩展端点 + manifest 权限（闭包裁决） */
  const gate = (from: string, topic: string): string => {
    const extId = requireExtId(from, topic);
    requirePermission(extId, topic, MEMORY_PERMISSION);
    return extId;
  };

  return {
    [KERNEL_TOPICS.memorySearch]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.memorySearch);
      const input = parsePayload(searchPayloadSchema, payload, KERNEL_TOPICS.memorySearch);
      const items = await manager.search(input.query, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
      });
      return { items };
    },

    [KERNEL_TOPICS.memoryAdd]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.memoryAdd);
      const input = parsePayload(addPayloadSchema, payload, KERNEL_TOPICS.memoryAdd);
      return manager.add({
        content: input.content,
        kind: input.kind,
        tags: input.tags,
        source: 'extension',
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
      });
    },

    [KERNEL_TOPICS.memoryExtract]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.memoryExtract);
      const input = parsePayload(extractPayloadSchema, payload, KERNEL_TOPICS.memoryExtract);
      return manager.extractAndStore(input.text, {
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      });
    },

    [KERNEL_TOPICS.memoryList]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.memoryList);
      const input = parsePayload(listPayloadSchema, payload, KERNEL_TOPICS.memoryList);
      const items = await manager.list({
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { items };
    },

    [KERNEL_TOPICS.memoryForget]: async (payload, from) => {
      gate(from, KERNEL_TOPICS.memoryForget);
      const input = parsePayload(forgetPayloadSchema, payload, KERNEL_TOPICS.memoryForget);
      const removed = await manager.forget(input.id);
      return { ok: true, removed };
    },
  };
}
