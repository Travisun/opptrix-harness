/**
 * runner — Agent 循环（LLM 工具调用循环）的内核通用执行器（零领域语义）。
 *
 * 职责边界：只做「对话 ↔ 工具调用」的循环编排——组装消息、下发工具 schema、
 * 执行模型请求的工具调用并把结果回填消息流、在终止条件命中时收束出最终报告。
 * 不做：模型路由/回退（gateway 既有语义）、工具实现（tools 依赖注入）、
 * 子代理生命周期管理（manager 层职责）。
 *
 * 循环语义：
 * - 起始消息 = system（input.systemPrompt 或缺省中文系统提示）+ user(input.prompt)；
 * - 每轮 `gateway.chat({ model, messages, tools: 白名单 schemas })`（非流式）：
 *   - `result.toolCalls` 非空 → 逐个 `tools.execute(name, JSON.parse(argsJson), ctx)`，
 *     以 `role:'tool'` 富形状消息回填结果文本（JSON 序列化）；**执行异常包装为
 *     `{ isError: true, error }` 结果继续循环**——工具失败是信息，不是终止；
 *   - 文本非空且无工具调用 → 该文本即 finalText，循环结束；
 *   - 空文本且无工具调用 → 继续下一轮（迭代上限兜底，防空转收束）。
 * - 终止兜底（两种同款「无工具收尾」）：迭代耗尽（模型每轮都在要工具）或
 *   **token 预算**超限（全部轮次 usage 累计 input+output > maxTokens）→
 *   追加一条系统收尾 user 消息、不带 tools 再对话一次，以其文本为 finalText。
 * - `input.signal` aborted → 抛 AbortError（name === 'AbortError'）；
 *   检查点：每轮 chat 前、每个工具执行前、收尾前。
 * - `iterations` = gateway.chat 调用次数（含收尾那次）；`toolCalls` =
 *   tools.execute 实际调用次数（参数 JSON 解析失败未执行的不计）。
 */
import type { Logger } from 'pino';

import type { LlmChatInput, LlmChatResult, LlmMessage, LlmResultToolCall, LlmToolCall } from '../llm/index.js';

// ---------------------------------------------------------------------------
// 依赖与输入/输出契约
// ---------------------------------------------------------------------------

/** 工具目录最小结构视图（listSchemas 下发模型；execute 执行调用） */
export interface AgentLoopToolRuntime {
  /** 可用工具 schema（name/description/inputSchema 三元组，原样下发 provider tools 参数） */
  listSchemas(): Array<{ name: string; description: string; inputSchema: unknown }>;
  /** 执行单个工具调用；**允许抛错**——异常由循环包装为 isError 工具结果，不终止循环 */
  execute(name: string, args: unknown, ctx: { agentId: string; depth: number }): Promise<unknown>;
}

/** runAgentLoop 依赖集合（gateway 为内核 LlmGateway.chat 天然满足的最小结构视图） */
export interface AgentLoopDeps {
  /** LLM 网关（非流式 chat） */
  gateway: { chat(input: LlmChatInput): Promise<LlmChatResult> };
  /** 工具运行时（目录 + 执行） */
  tools: AgentLoopToolRuntime;
  logger: Logger;
  /** 每轮迭代次数上限缺省值（input.maxIterations 未给时生效），缺省 16 */
  maxIterations?: number;
  /**
   * 迭代间协作让出钩子（工具轮结束后 await sleep(0) 再进入下一轮）；
   * 缺省 setTimeout 实现，测试可注入空实现加速。
   */
  sleep?: (ms: number) => Promise<void>;
}

/** runAgentLoop 输入 */
export interface AgentLoopInput {
  /** 发起方代理 id（透传给 tools.execute 的 ctx，用于审计/嵌套归因） */
  agentId: string;
  /** 嵌套深度（0 = 顶层委派；透传给 tools.execute 的 ctx） */
  depth: number;
  /** 系统提示（缺省 = 内置中文子代理系统提示，含可用工具名清单） */
  systemPrompt?: string;
  /** 用户任务提示（首轮 user 消息） */
  prompt: string;
  /**
   * 模型名；缺省 = 原样不指定，沿用网关既有路由/回退语义
   * （gateway 按 model 精确路由，不可路由时 LLM_MODEL_NOT_FOUND）。
   */
  model?: string;
  /** 工具白名单（按 name 过滤 listSchemas()）；缺省 = 全部可用工具 */
  toolNames?: string[];
  /** 本轮循环迭代上限（覆盖 deps.maxIterations），缺省 16 */
  maxIterations?: number;
  /** token 用量预算（全部轮次 usage 累计 input+output），超限强制收尾；缺省 200_000 */
  maxTokens?: number;
  /** 中断信号：aborted 时循环尽快抛 AbortError */
  signal?: AbortSignal;
}

/** runAgentLoop 结果 */
export interface AgentLoopResult {
  /** 最终报告文本（自然收束或强制收尾的 chat 文本；收尾失败为 ''） */
  finalText: string;
  /** gateway.chat 调用次数（含强制收尾那次） */
  iterations: number;
  /** tools.execute 实际调用次数（参数解析失败未执行的不计） */
  toolCalls: number;
  /** 全部轮次 usage 累计 */
  usage: { inputTokens: number; outputTokens: number };
  /** 完整消息轨迹（父代理可读的子代理工作内容；仅内存态，持久化由 manager 负责） */
  messages: unknown[];
}

// ---------------------------------------------------------------------------
// 常量与内部辅助
// ---------------------------------------------------------------------------

/** 迭代次数上限缺省值 */
export const DEFAULT_AGENT_MAX_ITERATIONS = 16;

/** token 用量预算缺省值（input+output 累计） */
export const DEFAULT_AGENT_MAX_TOKENS = 200_000;

/** 缺省中文系统提示：列出可用工具名，约定完成即出最终报告 */
export function defaultAgentSystemPrompt(toolNames: string[]): string {
  const listing = toolNames.length > 0 ? toolNames.join('、') : '（本次未提供任何工具）';
  return (
    '你是 Opptrix Harness 子代理，在父代理委派的任务范围内自主完成工作。' +
    `可用工具：${listing}。按需调用工具收集信息或执行操作；` +
    '工具失败属于过程信息，据实说明并继续推进；' +
    '任务完成后直接给出最终报告，不要再调用工具。'
  );
}

/** 中断错误（约定 name === 'AbortError'，调用方按名分流，不新增错误码） */
function abortError(): Error {
  const e = new Error('agent loop aborted');
  e.name = 'AbortError';
  return e;
}

/** 未知异常 → 可读消息 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 工具结果 → JSON 文本（undefined 归一 'null'；不可序列化兜底为 isError 形状） */
function resultJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return JSON.stringify({ isError: true, error: 'tool result is not JSON-serializable' });
  }
}

/** 缺省迭代间让出（setTimeout(0)） */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 模型请求的工具调用 → 消息流 assistant 富形状的 toolCalls（argsJson → arguments） */
function toMessageToolCalls(requested: LlmResultToolCall[]): LlmToolCall[] {
  return requested.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.argsJson }));
}

// ---------------------------------------------------------------------------
// 循环主体
// ---------------------------------------------------------------------------

/**
 * 运行 Agent 工具调用循环（语义见模块头注释）。gateway/tools 全部依赖注入，
 * 本函数无 IO 副作用之外的状态；chat 异常（LLM_PROVIDER_ERROR 等）原样上抛。
 */
export async function runAgentLoop(deps: AgentLoopDeps, input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxIterations = input.maxIterations ?? deps.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS;
  const maxTokens = input.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS;
  const sleep = deps.sleep ?? defaultSleep;
  const signal = input.signal;

  // ---- 工具白名单（toolNames 缺省 = 全部；未命中项静默剔除） ----
  const allSchemas = deps.tools.listSchemas();
  const whitelist = input.toolNames;
  const schemas = whitelist === undefined ? allSchemas : allSchemas.filter((s) => whitelist.includes(s.name));
  const toolNames = schemas.map((s) => s.name);

  // ---- 起始消息：system + user ----
  const messages: LlmMessage[] = [
    { role: 'system', content: input.systemPrompt ?? defaultAgentSystemPrompt(toolNames) },
    { role: 'user', content: input.prompt },
  ];

  let iterations = 0;
  let executedToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw abortError();
  };

  /** 单次对话 + 计数/用量累计/迭代日志（useTools=false 用于无工具收尾） */
  const chatOnce = async (useTools: boolean): Promise<LlmChatResult> => {
    throwIfAborted();
    const result = await deps.gateway.chat({
      // 未指定 model：原样透传 undefined，沿用网关既有路由/回退语义（不可路由 → LLM_MODEL_NOT_FOUND）
      model: input.model as string,
      messages,
      ...(useTools && schemas.length > 0 ? { tools: schemas } : {}),
    });
    iterations += 1;
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
    deps.logger.debug(
      {
        agentId: input.agentId,
        depth: input.depth,
        iteration: iterations,
        hasToolCalls: (result.toolCalls?.length ?? 0) > 0,
        usage: { inputTokens, outputTokens },
      messages,
      },
      'agent loop: iteration',
    );
    return result;
  };

  /** 工具调用执行 + assistant/tool 消息回填（异常包装 isError 继续；参数非法不执行直接 isError） */
  const executeAndAppend = async (requested: LlmResultToolCall[], assistantText: string): Promise<void> => {
    // assistant 富形状消息（文本 + 工具调用），回传 provider 时由 adapter 与协议结构互转
    messages.push({
      role: 'assistant',
      content: {
        ...(assistantText !== '' ? { text: assistantText } : {}),
        toolCalls: toMessageToolCalls(requested),
      },
    });
    for (const tc of requested) {
      throwIfAborted();
      let text: string;
      let isError = false;
      try {
        const args: unknown = JSON.parse(tc.argsJson);
        executedToolCalls += 1;
        const out = await deps.tools.execute(tc.name, args, { agentId: input.agentId, depth: input.depth });
        text = resultJson(out);
      } catch (e) {
        // 工具失败是信息不是终止：isError 结果回填，循环继续
        isError = true;
        text = JSON.stringify({ isError: true, error: messageOf(e) });
      }
      messages.push({ role: 'tool', content: { toolCallId: tc.id, text } });
      deps.logger.debug(
        { agentId: input.agentId, depth: input.depth, tool: tc.name, callId: tc.id, isError },
        'agent loop: tool executed',
      );
    }
    // 协作式让出（可注入 sleep 加速测试 / 避免热循环独占事件循环）
    await sleep(0);
  };

  /** 强制无工具收尾：追加系统收尾消息后不带 tools 对话一次，以其文本为最终报告 */
  const finalize = async (reason: string): Promise<string> => {
    messages.push({
      role: 'user',
      content: `（系统）${reason}：请立即基于以上全部信息直接输出最终报告，不要再调用任何工具。`,
    });
    const result = await chatOnce(false);
    return result.text;
  };

  // ---- 主循环 ----
  let finalText: string | null = null;
  while (iterations < maxIterations) {
    const result = await chatOnce(true);
    const requested = result.toolCalls ?? [];
    if (requested.length > 0) {
      // token 预算：模型仍要工具但用量已超限 → 立即无工具收束
      if (inputTokens + outputTokens > maxTokens) {
        finalText = await finalize('已达到 token 用量预算上限');
        break;
      }
      await executeAndAppend(requested, result.text);
      continue;
    }
    if (result.text !== '') {
      finalText = result.text;
      break;
    }
    // 空文本且无工具调用：继续下一轮（迭代上限兜底防空转）
  }
  if (finalText === null) {
    finalText = await finalize('已达到最大迭代次数上限');
  }

  return {
    finalText,
    iterations,
    toolCalls: executedToolCalls,
    usage: { inputTokens, outputTokens },
    messages,
  };
}
