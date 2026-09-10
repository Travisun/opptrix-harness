/**
 * coding 桥 — 扩展线程经 worker→kernel RPC 访问代码执行会话引擎的 handler 表。
 *
 * 与 memory/asr/extract 三桥同构（参照 kernel-handlers 的 requirePermission 收口模式）：
 * 本工厂只产出 `handlers[topic]` 表（键 = KERNEL_TOPICS.coding*），由集成方并入
 * ExtensionManager.deps.bridgeHandlers（经容器 'ext.bridges' 懒合入）。权限不在此自查
 * manifest——依赖注入的 `requirePermission(extId, topic, permission)` 闭包做裁决，
 * 全部 topic 以 'sandbox' 权限收口（fail-closed：调用方非扩展端点、或未声明权限，
 * 一律抛错）。sessionId 缺省 "default"；路径参数一律会话目录内相对（引擎侧钉死）。
 *
 * 线格式：
 * - `coding.exec`          { sessionId?, cmd, args?, cwd?, timeoutMs?, env? } → CodingRunResult
 * - `coding.runCode`       { sessionId?, language: 'node'|'python', code, timeoutMs? } → CodingRunResult
 * - `coding.fs.write`      { sessionId?, path, content } → { path, size }
 * - `coding.fs.read`       { sessionId?, path } → { path, size, content, truncated }
 * - `coding.fs.list`       { sessionId?, path? } → [{ name, size, dir }]
 * - `coding.sessions`      {} → [{ id, dir, createdAt }]
 * - `coding.session.reset` { sessionId? } → CodingSessionInfo
 * - `coding.session.delete`{ sessionId } → { deleted: boolean }
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';
import type { CodingEngine } from './engine.js';

/** 扩展访问代码执行会话所需 manifest 权限（进程/文件类高危能力，与 sandbox.exec 同门） */
export const CODING_PERMISSION = 'sandbox';

/** coding_* topic 共用的 sessionId（缺省 "default"） */
export const DEFAULT_CODING_SESSION = 'default';

/** 桥 handler 的统一形状（与 KernelBridgeHandlers 兼容，但不依赖其类型避免环） */
export type CodingBridgeHandler = (payload: unknown, from: string) => Promise<unknown>;
export type CodingBridgeHandlers = Record<string, CodingBridgeHandler>;

/** 桥依赖集合（engine 为 CodingEngine 结构兼容窄面；测试可注入替身） */
export interface CodingBridgeDeps {
  engine: Pick<
    CodingEngine,
    | 'runInSession'
    | 'runCode'
    | 'fsWrite'
    | 'fsRead'
    | 'fsList'
    | 'listSessions'
    | 'resetSession'
    | 'deleteSession'
  >;
  /** 权限闸（集成方注入 kernel-handlers 同款闭包）：不通过即抛 FORBIDDEN */
  requirePermission: (extId: string, topic: string, permission: string) => void;
}

// ---------------------------------------------------------------------------
// 线格式 schema
// ---------------------------------------------------------------------------

const sessionIdSchema = z.string().min(1).max(128).optional();

const execSchema = z.object({
  sessionId: sessionIdSchema,
  cmd: z.string().min(1).max(128),
  args: z.array(z.string()).max(256).optional(),
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const runCodeSchema = z.object({
  sessionId: sessionIdSchema,
  language: z.enum(['node', 'python']),
  code: z.string().min(1).max(256 * 1024),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const fsWriteSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().min(1).max(1024),
  content: z.string().max(2 * 1024 * 1024),
});

const fsReadSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().min(1).max(1024),
});

const fsListSchema = z.object({
  sessionId: sessionIdSchema,
  path: z.string().max(1024).optional(),
});

const sessionResetSchema = z.object({ sessionId: sessionIdSchema });
const sessionDeleteSchema = z.object({ sessionId: z.string().min(1).max(128) });

/** 端点 → 裸扩展 id（与 kernel-handlers 同规则）；'kernel'/空 → null */
function extIdFrom(from: string): string | null {
  if (from === 'kernel' || from === '') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** 非扩展端点闸（RPC_PERMISSION_DENIED 同款语义） */
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

/** zod 失败 → VALIDATION_FAILED（detail 携带 issues，面向扩展可操作） */
function parsedOrThrow<T>(schema: z.ZodType<T>, payload: unknown, topic: string, shape: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw err('VALIDATION_FAILED', {
      message: `kernel service "${topic}" requires payload ${shape}`,
      detail: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * 装配 coding 桥 handler 表（见模块头注释的线格式契约）。
 *
 * @param deps.engine 代码执行会话引擎（kernel CodingEngine）
 * @param deps.requirePermission 权限闭包（集成方传 kernel-handlers 的校验实现；
 *   全部 topic 以 CODING_PERMISSION='sandbox' 收口）
 */
export function createCodingBridge(deps: CodingBridgeDeps): CodingBridgeHandlers {
  /** 统一闸：扩展端点 + 'sandbox' 权限 → 返回归一后的 sessionId */
  const gate = (from: string, topic: string, sessionId?: string): string => {
    const extId = requireExtCaller(from, topic);
    deps.requirePermission(extId, topic, CODING_PERMISSION);
    return sessionId ?? DEFAULT_CODING_SESSION;
  };

  return {
    [KERNEL_TOPICS.codingExec]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingExec;
      const input = parsedOrThrow(execSchema, payload, topic, '{ sessionId?, cmd, args?, cwd?, timeoutMs?, env? }');
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.runInSession(sessionId, {
        cmd: input.cmd,
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
    },

    [KERNEL_TOPICS.codingRunCode]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingRunCode;
      const input = parsedOrThrow(runCodeSchema, payload, topic, "{ sessionId?, language: 'node'|'python', code, timeoutMs? }");
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.runCode(sessionId, {
        language: input.language,
        code: input.code,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
    },

    [KERNEL_TOPICS.codingFsWrite]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingFsWrite;
      const input = parsedOrThrow(fsWriteSchema, payload, topic, '{ sessionId?, path, content }');
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.fsWrite(sessionId, input.path, input.content);
    },

    [KERNEL_TOPICS.codingFsRead]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingFsRead;
      const input = parsedOrThrow(fsReadSchema, payload, topic, '{ sessionId?, path }');
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.fsRead(sessionId, input.path);
    },

    [KERNEL_TOPICS.codingFsList]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingFsList;
      const input = parsedOrThrow(fsListSchema, payload, topic, '{ sessionId?, path? }');
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.fsList(sessionId, input.path);
    },

    [KERNEL_TOPICS.codingSessions]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingSessions;
      gate(from, topic);
      return deps.engine.listSessions();
    },

    [KERNEL_TOPICS.codingSessionReset]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingSessionReset;
      const input = parsedOrThrow(sessionResetSchema, payload, topic, '{ sessionId? }');
      const sessionId = gate(from, topic, input.sessionId);
      return deps.engine.resetSession(sessionId);
    },

    [KERNEL_TOPICS.codingSessionDelete]: async (payload, from) => {
      const topic = KERNEL_TOPICS.codingSessionDelete;
      const input = parsedOrThrow(sessionDeleteSchema, payload, topic, '{ sessionId }');
      const sessionId = gate(from, topic, input.sessionId);
      return { deleted: deps.engine.deleteSession(sessionId) };
    },
  };
}
