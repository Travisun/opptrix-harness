/**
 * agents/session-runner — 把 runner.ts 的 runAgentLoop 包装为 AgentSessionManager 可用的
 * 会话循环执行器（SessionRunner）。
 *
 * 职责边界：
 * - 输入形状对齐 SubagentRunner 的 input 面（agentId/depth/systemPrompt/prompt/model/signal），
 *   但直接以 Promise 返回 AgentLoopResult（finalText/usage/messages 轨迹）——会话面需要
 *   完整轨迹落库，不走 SubagentRunner 的 onEvent 事件流；
 * - 工具目录桥接：listSchemas ← SystemToolRuntime.listTools()；execute →
 *   SystemToolRuntime.call(name, args, { agentId, depth })（审计 ctx 随行，系统工具侧
 *   以 admin 身份执行——信任模型见 mcp/system-server.ts）；运行时未 attach 时
 *   listSchemas 为空目录、execute 收敛为 isError 结果（与 core-services 的子代理桥同语义）；
 * - 模型路由/回退、循环终止语义全部复用 runner.ts（本文件零循环逻辑）。
 */
import type { Logger } from 'pino';

import { runAgentLoop, type AgentLoopResult, type AgentLoopToolRuntime } from './runner.js';
import type { LlmChatInput, LlmChatResult, LlmStreamEvent } from '../llm/index.js';

/** 系统工具运行时的最小结构视图（真实 SystemToolRuntime 天然满足；测试可注入替身） */
export interface SystemToolRuntimeLike {
  /** 工具目录投影（name/description/inputSchema 三元组） */
  listTools(): Array<{ name: string; description: string; inputSchema: unknown }>;
  /** 按名执行工具（永不抛错，失败收敛为 { ok:false, error } 结果对象）；audit 随行审计信息 */
  call(name: string, args: unknown, audit?: { agentId?: string; depth?: number }): Promise<unknown>;
}

/** createSessionRunner 依赖集合 */
export interface SessionRunnerDeps {
  /**
   * LLM 网关（gateway.chat 的最小结构视图）。返回类型为 chat 契约的完整并集
   * （LlmGateway.chat 天然满足）；会话循环恒以 stream:false 调用并把结果收窄为 Promise。
   */
  gateway: { chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> };
  /** 系统工具运行时取值器（缺省/返回 undefined = 本次无工具可用） */
  systemRuntime?: () => SystemToolRuntimeLike | undefined;
  /** 内核 pino logger */
  logger: Logger;
  /** 迭代次数上限缺省值（透传 runAgentLoop deps.maxIterations） */
  maxIterations?: number;
  /** 迭代间让出（透传 runAgentLoop deps.sleep；测试注入空实现加速） */
  sleep?: (ms: number) => Promise<void>;
}

/** 会话循环输入（agentId = 会话 id，用于工具执行审计归因） */
export interface SessionRunnerInput {
  agentId: string;
  /** 嵌套深度（会话恒为 0；透传工具审计 ctx） */
  depth?: number;
  /** 系统提示（缺省 = runner 内置中文系统提示，含可用工具名清单） */
  systemPrompt?: string;
  /** 组装好的用户提示（历史上下文 + 当前消息，由 manager 组装） */
  prompt: string;
  /** 模型名（undefined = 沿用网关既有路由语义） */
  model?: string;
  /** 中断信号（cancelGeneration 的 AbortController） */
  signal?: AbortSignal;
}

/** 会话循环执行器：单次执行一轮「对话 ↔ 工具」循环，直接返回完整循环结果 */
export type SessionRunner = (input: SessionRunnerInput) => Promise<AgentLoopResult>;

/**
 * 构建会话循环执行器（见模块头注释）。返回闭包无自身状态，可安全并发调用。
 */
export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  // 工具目录桥（AgentLoopToolRuntime）：目录下发 + 执行审计归因
  const tools: AgentLoopToolRuntime = {
    listSchemas: () =>
      (deps.systemRuntime?.()?.listTools() ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    execute: async (name, args, ctx) => {
      const runtime = deps.systemRuntime?.();
      if (runtime === undefined) {
        return { isError: true, error: 'system tool runtime is not attached yet' };
      }
      return runtime.call(name, args ?? {}, { agentId: ctx.agentId, depth: ctx.depth });
    },
  };

  const loopDeps = {
    gateway: {
      chat: (input: LlmChatInput): Promise<LlmChatResult> =>
        // 会话循环恒为非流式（stream:false）；结果必为 Promise 形状（见 gateway.chat 契约）
        deps.gateway.chat({ ...input, stream: false }) as Promise<LlmChatResult>,
    },
    tools,
    logger: deps.logger,
    ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
  };

  return async (input: SessionRunnerInput): Promise<AgentLoopResult> =>
    runAgentLoop(loopDeps, {
      agentId: input.agentId,
      depth: input.depth ?? 0,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      prompt: input.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
}
