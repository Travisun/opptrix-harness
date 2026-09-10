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
 * - **进度桥**：input.onDelta 原样透传 runner（流式增量回调）；input.onToolStep 在
 *   execute 桥前后构造 ChatToolStep 并回调（tool_start=running 版 / tool_done=补全版，
 *   中文标签与预览由 chat-progress.ts 纯函数生成）；
 * - 模型路由/回退、循环终止语义全部复用 runner.ts（本文件零循环逻辑）；
 * - 流式：input.onDelta 传入时按 runner 契约以 stream:true 调用网关（网关返回
 *   AsyncGenerator），否则维持 stream:false 现状。
 */
import type { Logger } from 'pino';

import {
  completeToolStep,
  createToolStep,
  type AgentLoopDeltaChunk,
  type ChatToolStep,
} from './chat-progress.js';
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
   * （LlmGateway.chat 天然满足）；会话循环按 input.onDelta 是否传入选择
   * stream:true（流式）/ stream:false（非流式，现状）。
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
  /** 技能短目录段 getter（透传 runAgentLoop deps.skillCatalog；缺省 = 不注入） */
  skillCatalog?: () => string;
  /** 会话级已激活技能正文段 getter（透传 runAgentLoop deps.activatedSkills；入参 agentId；缺省 = 不注入） */
  activatedSkills?: (agentId: string) => string;
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
  /** 流式增量回调（原样透传 runner；传入即按 stream:true 调用网关） */
  onDelta?: (chunk: AgentLoopDeltaChunk) => void;
  /**
   * 工具步骤回调：execute 桥在调用前回调 running 版 ChatToolStep（tool_start 语义）、
   * 执行结束后回调补全版（tool_done 语义，status done/error）。回调抛错由桥兜底忽略。
   */
  onToolStep?: (step: ChatToolStep) => void;
}

/** 会话循环执行器：单次执行一轮「对话 ↔ 工具」循环，直接返回完整循环结果 */
export type SessionRunner = (input: SessionRunnerInput) => Promise<AgentLoopResult>;

/**
 * 构建会话循环执行器（见模块头注释）。返回闭包无自身状态，可安全并发调用。
 */
export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
  // 工具步骤安全回调（进度分发不落地错误——呈现面失败不影响生成）
  const emitStep = (onToolStep: ((step: ChatToolStep) => void) | undefined, step: ChatToolStep): void => {
    if (onToolStep === undefined) return;
    try {
      onToolStep(step);
    } catch {
      // 进度回调异常静默忽略（与 runner 的 onDelta 守卫同语义；细节走 logger 会放大噪声）
    }
  };

  // 工具目录桥（AgentLoopToolRuntime）：目录下发 + 执行审计归因 + 工具步骤进度
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
      // runner 以 unknown 透传步骤回调（保持其零领域语义）；此处收窄回 ChatToolStep 形状
      const onToolStep = ctx.onToolStep as ((step: ChatToolStep) => void) | undefined;
      const step = createToolStep(name, args);
      emitStep(onToolStep, step);
      const out = await runtime.call(name, args ?? {}, { agentId: ctx.agentId, depth: ctx.depth });
      emitStep(onToolStep, completeToolStep(step, out));
      return out;
    },
  };

  const loopDeps = {
    gateway: {
      chat: (input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> =>
        // 非流式保持现状显式 stream:false；onDelta 传入时透传 stream:true（runner 消费流事件）
        deps.gateway.chat(input.stream === true ? input : { ...input, stream: false }),
    },
    tools,
    logger: deps.logger,
    ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.skillCatalog !== undefined ? { skillCatalog: deps.skillCatalog } : {}),
    ...(deps.activatedSkills !== undefined ? { activatedSkills: deps.activatedSkills } : {}),
  };

  return async (input: SessionRunnerInput): Promise<AgentLoopResult> => {
    const { onDelta, onToolStep } = input;
    return runAgentLoop(loopDeps, {
      agentId: input.agentId,
      depth: input.depth ?? 0,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      prompt: input.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      // runner 侧步骤形状为 unknown（零领域语义）；此处以收窄回调适配
      ...(onDelta !== undefined ? { onDelta } : {}),
      ...(onToolStep !== undefined
        ? { onToolStep: (step: unknown) => onToolStep(step as ChatToolStep) }
        : {}),
    });
  };
}
