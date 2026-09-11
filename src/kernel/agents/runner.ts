/**
 * runner — Agent 循环（LLM 工具调用循环）的内核通用执行器（零领域语义）。
 *
 * 职责边界：只做「对话 ↔ 工具调用」的循环编排——组装消息、下发工具 schema、
 * 执行模型请求的工具调用并把结果回填消息流、在终止条件命中时收束出最终报告。
 * 不做：模型路由/回退（gateway 既有语义）、工具实现（tools 依赖注入）、
 * 子代理生命周期管理（manager 层职责）。
 *
 * 循环语义：
 * - 起始消息 = system（input.systemPrompt 或缺省 bootstrap 分层提示）+ user(input.prompt)；
 * - 每轮 `gateway.chat({ model, messages, tools: 白名单 schemas })`：
 *   - **未传 input.onDelta** → 非流式（现状）；
 *   - **传入 input.onDelta** → 以 stream:true 调用并消费流事件（delta/reasoning_delta/
 *     tool_call_delta/done）：文本按估算 token 80ms 节流、思考链每 120 字回调一次
 *     onDelta（回调抛错只 warn 不中断）；tool_call_delta 按 index 聚合为结构化调用；
 *   - `result.toolCalls` 非空 → 逐个 `tools.execute(name, JSON.parse(argsJson), ctx)`，
 *     以 `role:'tool'` 富形状消息回填结果文本（JSON 序列化）；**执行异常包装为
 *     `{ isError: true, error }` 结果继续循环**——工具失败是信息，不是终止；
 *     单条结果 >32KB → 溢出落盘（deps.workspace 有值时写 `<workspace>/tool-outputs/
 *     {callId}.json` 并以 `{_spilled,path,preview}` 信封替换消息体；无 workspace 截断 32KB）；
 *   - assistant 富形状消息恒携带该轮 reasoning（空串也带）——openai-chat 回写
 *     `reasoning_content`，满足 DeepSeek/LongCat 等推理模型 tool 轮续写的硬要求；
 *   - 文本非空且无工具调用 → 该文本即 finalText，循环结束；
 *   - 空文本且无工具调用 → 继续下一轮（迭代上限兜底，防空转收束）；
 *     **但本轮有思考链（reasoning）时判为「思考占满输出」→ 空回复守卫收束**
 *     （finalText = EMPTY_REPLY_HINT，避免无效轮询）。
 * - 思考链分段：每轮（工具轮 + 终轮 + 收尾轮）的 reasoning_content 累积为一段，
 *   全部轮次收集进 `result.reasoningSegments`（无思考链时不出现该键）。
 * - 终止兜底（两种同款「无工具收尾」）：迭代耗尽（模型每轮都在要工具）或
 *   **token 预算**超限（全部轮次 usage 累计 input+output > maxTokens）→
 *   追加一条系统收尾 user 消息、不带 tools 再对话一次，以其文本为 finalText。
 * - `input.signal` aborted → 抛 AbortError（name === 'AbortError'）；
 *   检查点：每轮 chat 前、流消费期间逐事件、每个工具执行前、收尾前。
 * - `iterations` = gateway.chat 调用次数（含收尾那次）；`toolCalls` =
 *   tools.execute 实际调用次数（参数 JSON 解析失败未执行的不计）。
 */
import type { Logger } from 'pino';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextBudget } from './context-budget.js';
import { assembleSystemPrompt } from './skill-catalog.js';
import { assembleBootstrapPrompt } from './prompts/assemble.js';

import { EMPTY_REPLY_HINT, type AgentLoopDeltaChunk } from './chat-progress.js';
import { hasToolMarkup, recoverToolCallsFromText, type LlmChatInput, type LlmChatResult, type LlmMessage, type LlmResultToolCall, type LlmStreamEvent, type LlmToolCall } from '../llm/index.js';

// ---------------------------------------------------------------------------
// 依赖与输入/输出契约
// ---------------------------------------------------------------------------

/** 工具执行上下文（审计归因 + 可选的工具步骤进度回调，由会话层桥接消费） */
export interface AgentLoopToolCtx {
  /** 发起方代理 id（审计/嵌套归因） */
  agentId: string;
  /** 嵌套深度（0 = 顶层委派） */
  depth: number;
  /** 工具步骤回调（可选；会话层用于 tool_start/tool_done 进度，runner 原样透传） */
  onToolStep?: (step: unknown) => void;
}

/** 工具目录最小结构视图（listSchemas 下发模型；execute 执行调用） */
export interface AgentLoopToolRuntime {
  /** 可用工具 schema（name/description/inputSchema 三元组，原样下发 provider tools 参数） */
  listSchemas(): Array<{ name: string; description: string; inputSchema: unknown }>;
  /** 执行单个工具调用；**允许抛错**——异常由循环包装为 isError 工具结果，不终止循环 */
  execute(name: string, args: unknown, ctx: AgentLoopToolCtx): Promise<unknown>;
}

/** runAgentLoop 依赖集合（gateway 为内核 LlmGateway.chat 天然满足的最小结构视图） */
export interface AgentLoopDeps {
  /**
   * LLM 网关。未流式调用返回 Promise 结果；stream:true 调用返回流事件迭代器
   * （LlmGateway.chat 天然满足；测试可按调用形状注入其中一种或双态替身）。
   */
  gateway: { chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> };
  /** 工具运行时（目录 + 执行） */
  tools: AgentLoopToolRuntime;
  logger: Logger;
  /** 每轮迭代次数上限缺省值（input.maxIterations 未给时生效），缺省 16 */
  maxIterations?: number;
  /** 技能短目录段（skill-catalog.buildSkillCatalog；缺省/空 = 不注入目录） */
  skillCatalog?: () => string;
  /** 会话级已激活技能正文段（skill-catalog.buildActivatedSkillsPrompt；入参 agentId=会话 id；缺省/空 = 不注入） */
  activatedSkills?: (agentId: string) => string;
  /**
   * 迭代间协作让出钩子（工具轮结束后 await sleep(0) 再进入下一轮）；
   * 缺省 setTimeout 实现，测试可注入空实现加速。
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 会话工作区取值器（可选；工具结果溢出落盘用）。返回工作区根目录视图（path 为绝对路径）
   * 或 undefined（本次无工作区）。缺省 undefined：超长工具结果直接截断，不落盘。
   */
  workspace?: () => { path: string } | undefined;
}

/** runAgentLoop 输入 */
export interface AgentLoopInput {
  /** 发起方代理 id（透传给 tools.execute 的 ctx，用于审计/嵌套归因） */
  agentId: string;
  /** 嵌套深度（0 = 顶层委派；透传给 tools.execute 的 ctx） */
  depth: number;
  /** 系统提示（缺省 = bootstrap 分层提示装配，含按域分组的工具目录；传入时整体替换） */
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
  /**
   * 会话级缓存键（session.ts 传 sessionId）：透传网关 → openai-chat 适配器将其作为
   * `prompt_cache_key` 下发（provider 侧会话级前缀缓存亲和；provider 可经
   * promptCacheKey:false 关闭）。缺省不携带。
   */
  sessionKey?: string;
  /**
   * 流式增量回调（可选）。传入时每轮 gateway.chat 以 stream:true 调用并消费流事件：
   * 文本增量按估算 token 80ms 节流合并回调、思考链增量每累积 120 字回调一次
   * （片段为「距上次回调的合并增量」；流结束时 flush 残余片段）。
   * 回调抛错只记 warn，不影响循环。
   */
  onDelta?: (chunk: AgentLoopDeltaChunk) => void;
  /**
   * 工具步骤回调（可选；透传给 tools.execute 的 ctx，供会话层发 tool_start/tool_done）。
   * 步骤形状由会话层定义（ChatToolStep），runner 保持零领域语义故此处为 unknown。
   */
  onToolStep?: (step: unknown) => void;
}

/** runAgentLoop 结果 */
export interface AgentLoopResult {
  /** 最终报告文本（自然收束或强制收尾的 chat 文本；收尾失败为 ''；空回复守卫时为用户提示文案） */
  finalText: string;
  /** gateway.chat 调用次数（含强制收尾那次） */
  iterations: number;
  /** tools.execute 实际调用次数（参数解析失败未执行的不计） */
  toolCalls: number;
  /** 全部轮次 usage 累计 */
  usage: { inputTokens: number; outputTokens: number };
  /** 完整消息轨迹（父代理可读的子代理工作内容；仅内存态，持久化由 manager 负责） */
  messages: unknown[];
  /**
   * 各轮思考链分段（每轮一段，按轮次序；**仅在存在思考链时出现**——省略该键以保持
   * 无思考链场景的结果形状与既有消费方/测试兼容）。
   */
  reasoningSegments?: string[];
}

// ---------------------------------------------------------------------------
// 常量与内部辅助
// ---------------------------------------------------------------------------

/** 迭代次数上限缺省值 */
export const DEFAULT_AGENT_MAX_ITERATIONS = 16;

/** token 用量预算缺省值（input+output 累计） */
export const DEFAULT_AGENT_MAX_TOKENS = 200_000;

/** 文本增量回调节流窗口（毫秒；窗口内合并为一次回调，流结束 flush 残余） */
export const TEXT_DELTA_THROTTLE_MS = 80;

/** 思考链增量回调粒度（每累积约 120 字回调一次；流结束 flush 残余） */
export const REASONING_DELTA_CHUNK_CHARS = 120;

/** 单条工具结果溢出阈值（字符数 ≈32KB）：超过即完整落盘、消息体替换为溢出信封 */
export const TOOL_RESULT_SPILL_THRESHOLD_CHARS = 32 * 1024;

/** 溢出信封 preview 长度（字符） */
export const TOOL_RESULT_SPILL_PREVIEW_CHARS = 2048;

/** 溢出落盘目录（会话工作区相对路径；模型可经 workspace_read 按需读回完整结果） */
export const TOOL_OUTPUTS_DIR = 'tool-outputs';

/** 无 workspace（或落盘失败）时的截断标注（确定性后缀，前缀稳定利于缓存） */
export const TOOL_RESULT_TRUNCATED_SUFFIX = '\n…[truncated: tool result exceeded 32KB]';

// 估算 token 数（chars/4 向上取整；仅用于进度节流/展示，非计费口径）
export function estimateLoopTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 流消费期 tool_call_delta 的聚合行（id 覆盖、name/arguments 按 index 拼接） */
interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** tool_call_delta payload 的最小结构视图（openai-chat 透传的 provider 增量形状） */
interface ToolCallDeltaPayload {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/**
 * 消费一轮流式事件并聚合为非流式等价结果：
 * - delta → 累积正文，80ms/估算 token 节流回调（回调片段 = 合并增量）；
 * - reasoning_delta → 累积思考链，每 120 字回调一次（片段 = 合并增量）；
 * - tool_call_delta → 按 index 聚合（id 覆盖、name/arguments 拼接）；
 * - done → 捕获 usage；error → 以 Error 抛出（消息原样）；
 * - 流结束 flush 思考链与正文残余片段（先 reasoning 后 text，与产生顺序一致）。
 * - 流结束聚合点：未收到任何 tool_call_delta 且累积正文含文本内嵌工具标记 → 恢复为
 *   结构化调用（正文同步清洗，见 tool-markup）。
 * 每个事件前检查中断信号；onDelta 回调抛错只 warn，不中断消费。
 */
async function consumeStream(
  stream: AsyncGenerator<LlmStreamEvent>,
  opts: {
    onDelta?: (chunk: AgentLoopDeltaChunk) => void;
    logger: Logger;
    throwIfAborted: () => void;
  },
): Promise<LlmChatResult> {
  const { onDelta, logger, throwIfAborted } = opts;

  let text = '';
  let reasoning = '';
  let usage: LlmChatResult['usage'] | undefined;

  let pendingText = '';
  let pendingReasoning = '';
  let lastEmitAt = 0;

  const safeOnDelta = (chunk: AgentLoopDeltaChunk): void => {
    if (onDelta === undefined) return;
    try {
      onDelta(chunk);
    } catch (e) {
      logger.warn({ err: e }, 'agent loop: onDelta callback failed (ignored)');
    }
  };

  const flushText = (): void => {
    if (pendingText === '') return;
    const chunk = pendingText;
    pendingText = '';
    safeOnDelta({ text: chunk });
  };

  const flushReasoning = (): void => {
    if (pendingReasoning === '') return;
    const chunk = pendingReasoning;
    pendingReasoning = '';
    safeOnDelta({ reasoning: chunk });
  };

  const toolCallsByIndex = new Map<number, PendingToolCall>();

  for await (const event of stream) {
    throwIfAborted();
    if (event.type === 'delta') {
      if (onDelta !== undefined) {
        const prevTokens = estimateLoopTokens(text);
        text += event.text;
        pendingText += event.text;
        // 估算 token 有变化才可能回调；80ms 节流窗口内合并为一次（流结束 flush 残余）
        if (estimateLoopTokens(text) !== prevTokens) {
          const now = Date.now();
          if (lastEmitAt === 0 || now - lastEmitAt >= TEXT_DELTA_THROTTLE_MS) {
            lastEmitAt = now;
            flushText();
          }
        }
      } else {
        text += event.text;
      }
      continue;
    }
    if (event.type === 'reasoning_delta') {
      if (onDelta !== undefined) {
        const prevTotal = reasoning.length;
        reasoning += event.text;
        pendingReasoning += event.text;
        // 首段立即回调；其后每跨过一个 120 字粒度边界回调一次
        if (prevTotal === 0 || Math.floor(reasoning.length / REASONING_DELTA_CHUNK_CHARS) > Math.floor(prevTotal / REASONING_DELTA_CHUNK_CHARS)) {
          flushReasoning();
        }
      } else {
        reasoning += event.text;
      }
      continue;
    }
    if (event.type === 'tool_call_delta') {
      const payload = (event.payload ?? {}) as ToolCallDeltaPayload;
      const index = typeof event.index === 'number' ? event.index : 0;
      let current = toolCallsByIndex.get(index);
      if (current === undefined) {
        current = { id: '', name: '', arguments: '' };
        toolCallsByIndex.set(index, current);
      }
      if (typeof payload.id === 'string' && payload.id !== '') current.id = payload.id;
      if (typeof payload.function?.name === 'string') current.name += payload.function.name;
      if (typeof payload.function?.arguments === 'string') current.arguments += payload.function.arguments;
      continue;
    }
    if (event.type === 'done') {
      usage = event.usage;
      continue;
    }
    // error 事件：流内不可恢复失败，原样上抛（for-await 自动关闭生成器）
    throw new Error(event.message);
  }

  // 流结束：flush 残余片段（先思考链后正文，与产生顺序一致）
  if (onDelta !== undefined) {
    flushReasoning();
    flushText();
  }

  const aggregated = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => tc)
    .filter((tc) => tc.id !== '' || tc.name !== '')
    .map((tc) => ({ id: tc.id, name: tc.name, argsJson: tc.arguments }));

  // 文本内嵌工具标记恢复（流式汇总层）：整条流未产生任何 tool_call_delta 且累积正文含
  // `<longcat_tool_call>`/`<tool_call>`/`<|tool_call|>` 等标记块 → 恢复为结构化调用并把
  // 正文清洗为剥离标记后的文本。已 yield 的增量不追改（进度展示侧可能短暂见过标记原文）；
  // 原生 tool_call_delta 存在时绝不恢复。恢复的调用与非流式路径的 LlmChatResult.toolCalls 同形状。
  let finalText = text;
  let finalToolCalls = aggregated;
  if (aggregated.length === 0 && hasToolMarkup(text)) {
    const recovered = recoverToolCallsFromText(text);
    if (recovered.toolCalls.length > 0) {
      finalText = recovered.cleanedText;
      finalToolCalls = recovered.toolCalls.map(({ id, name, argsJson }) => ({ id, name, argsJson }));
    }
  }

  return {
    text: finalText,
    ...(reasoning !== '' ? { reasoning } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(finalToolCalls.length > 0 ? { toolCalls: finalToolCalls } : {}),
  };
}

/**
 * 旧版缺省中文系统提示（**已不是缺省路径**，保留导出仅为兼容既有测试/外部调用）：
 * 列出可用工具名、约定完成即出最终报告。缺省路径为
 * `prompts/assemble.assembleBootstrapPrompt`（分层 bootstrap：角色 → 工具总纲 →
 * 工具目录 → 技能 → 工作区 → 输出 → 安全）。
 */
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

/**
 * 工具结果溢出处理（空间可控 + 模型可按需读回，借鉴 Opptrix spill）：
 * - 结果 ≤32KB → 原样内联；
 * - >32KB 且 deps.workspace 有值 → 完整结果写入 `<workspace>/tool-outputs/{callId}.json`，
 *   消息体替换为 `{"_spilled":true,"path":"tool-outputs/{callId}.json","preview":前2KB}`
 *   （path 为工作区相对 POSIX 路径，模型可经 workspace_read 读回）；
 * - 无 workspace 或落盘失败 → 截断 32KB + 确定性标注（循环绝不因溢出处理失败而中断）。
 */
async function spillToolResult(
  deps: AgentLoopDeps,
  callId: string,
  text: string,
): Promise<string> {
  if (text.length <= TOOL_RESULT_SPILL_THRESHOLD_CHARS) return text;
  const truncated = text.slice(0, TOOL_RESULT_SPILL_THRESHOLD_CHARS) + TOOL_RESULT_TRUNCATED_SUFFIX;
  const workspace = deps.workspace?.();
  if (workspace === undefined) return truncated;
  // callId 来自 provider 侧（不可信）：收窄为文件名安全字符，防目录穿越
  const safeCallId = callId.replace(/[^A-Za-z0-9._-]/g, '_');
  const relPath = `${TOOL_OUTPUTS_DIR}/${safeCallId}.json`;
  try {
    await mkdir(join(workspace.path, TOOL_OUTPUTS_DIR), { recursive: true });
    await writeFile(join(workspace.path, relPath), text, 'utf8');
    return JSON.stringify({
      _spilled: true,
      path: relPath,
      preview: text.slice(0, TOOL_RESULT_SPILL_PREVIEW_CHARS),
    });
  } catch (e) {
    deps.logger.warn({ err: e, callId }, 'agent loop: tool result spill failed; inlined truncated');
    return truncated;
  }
}

/** 模型请求的工具调用 → 消息流 assistant 富形状的 toolCalls（argsJson → arguments） */
function toMessageToolCalls(requested: LlmResultToolCall[]): LlmToolCall[] {
  return requested.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.argsJson }));
}

/** 网关返回值形状判定：AsyncGenerator（流）还是 Promise 结果（非流式） */
function isStreamResult(out: LlmChatResult | AsyncGenerator<LlmStreamEvent>): out is AsyncGenerator<LlmStreamEvent> {
  return typeof (out as AsyncGenerator<LlmStreamEvent>)[Symbol.asyncIterator] === 'function';
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
  // 缺省 system prompt = 分层 bootstrap 装配（prompts/assemble：锚点节重组 + 工具目录段 +
  // #skills 节按能力注入）；会话显式 systemPrompt 仍整体替换（优先级不变）。
  // 技能两层注入：短目录 + 会话级已激活正文（skill-catalog 纯函数；注册表/激活表经 deps 可选注入，
  // 未注入 = 无目录无激活，保持既有语义）
  const baseSystem = input.systemPrompt ?? assembleBootstrapPrompt({ toolNames });
  const catalog = deps.skillCatalog ? deps.skillCatalog() : '';
  const activated = deps.activatedSkills ? deps.activatedSkills(input.agentId) : '';
  const messages: LlmMessage[] = [
    { role: 'system', content: assembleSystemPrompt(baseSystem, catalog, activated) },
    { role: 'user', content: input.prompt },
  ];

  let iterations = 0;
  let executedToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const reasoningSegments: string[] = [];
  /** 有状态上下文预算（水位线在多次 chatOnce 间保持——压缩边界一旦固定不再漂移） */
  const budget = new ContextBudget();
  const onDelta = input.onDelta;
  const onToolStep = input.onToolStep;

  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw abortError();
  };

  /** 轮结果记账：迭代/用量累计 + 有思考链则收一段 */
  let consecutiveEmpty = 0;
  const accountRound = (result: LlmChatResult): LlmChatResult => {
    iterations += 1;
    const isEmptyRound =
      (result.toolCalls?.length ?? 0) === 0 &&
      (result.text ?? '') === '' &&
      (result.reasoning ?? '') === '';
    consecutiveEmpty = isEmptyRound ? consecutiveEmpty + 1 : 0;
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
    if (typeof result.reasoning === 'string' && result.reasoning.trim() !== '') {
      reasoningSegments.push(result.reasoning);
    }
    deps.logger.debug(
      {
        agentId: input.agentId,
        depth: input.depth,
        iteration: iterations,
        hasToolCalls: (result.toolCalls?.length ?? 0) > 0,
        hasReasoning: typeof result.reasoning === 'string' && result.reasoning !== '',
        usage: { inputTokens, outputTokens },
      messages,
      },
      'agent loop: iteration',
    );
    return result;
  };

  /** 单次对话 + 计数/用量累计/迭代日志（useTools=false 用于无工具收尾） */
  const chatOnce = async (useTools: boolean): Promise<LlmChatResult> => {
    throwIfAborted();
    // 上下文预算：超限时对早期轮做 micro 压缩（有状态水位线：边界一旦压缩即固定，
    // 后续轮次前缀 append-only 稳定——provider prompt 缓存友好；预算内零开销原样返回）
    const budgetView = budget.apply(messages);
    const payload: LlmChatInput = {
      // 未指定 model：原样透传 undefined，沿用网关既有路由/回退语义（不可路由 → LLM_MODEL_NOT_FOUND）
      model: input.model as string,
      messages: budgetView.messages,
      // 会话级 prompt 缓存键（session.ts 传 sessionId；适配器直写 prompt_cache_key，不经参数白名单）
      ...(input.sessionKey !== undefined && input.sessionKey !== '' ? { sessionKey: input.sessionKey } : {}),
      ...(useTools && schemas.length > 0 ? { tools: schemas } : {}),
    };
    // 恒走流式聚合：兼容网关（LongCat/Qwen 系）非流式路径会 (a) 间歇回 200 空 body、
    // (b) 把工具调用写成正文标记而非原生 tool_calls——流式路径两者皆无（实测原生
    // tool_call deltas）。onDelta 未传时仅不回调节流，聚合语义不变。
    // 网关违约回了非流结果时兜底原样（isStreamResult 判别）。
    if (onDelta === undefined) {
      const out = await deps.gateway.chat({ ...payload, stream: true });
      const result = isStreamResult(out)
        ? await consumeStream(out, { logger: deps.logger, throwIfAborted })
        : out;
      return accountRound(result);
    }
    // 流式：onDelta 传入即走 stream:true，事件消费见 consumeStream（节流回调/聚合在其内）
    const out = await deps.gateway.chat({ ...payload, stream: true });
    const result = await consumeStream(
      isStreamResult(out) ? out : (out as unknown as AsyncGenerator<LlmStreamEvent>),
      { onDelta, logger: deps.logger, throwIfAborted },
    );
    return accountRound(result);
  };

  /** 工具调用执行 + assistant/tool 消息回填（异常包装 isError 继续；参数非法不执行直接 isError） */
  const executeAndAppend = async (requested: LlmResultToolCall[], assistantText: string, reasoning: string): Promise<void> => {
    // assistant 富形状消息（文本 + 工具调用 + 本轮思考链），回传 provider 时由 adapter 与
    // 协议结构互转。reasoning 恒携带（无思考链为空串）——openai-chat 对富形状回写
    // reasoning_content（DeepSeek/LongCat 等要求 tool 轮续写带该键，丢思考也要带 key）。
    messages.push({
      role: 'assistant',
      content: {
        ...(assistantText !== '' ? { text: assistantText } : {}),
        toolCalls: toMessageToolCalls(requested),
        reasoning,
      },
    });
      for (const tc of requested) {
        throwIfAborted();
        let text: string;
        let isError = false;
        try {
          const args: unknown = JSON.parse(tc.argsJson);
          executedToolCalls += 1;
          const out = await deps.tools.execute(tc.name, args, {
            agentId: input.agentId,
            depth: input.depth,
            ...(onToolStep !== undefined ? { onToolStep } : {}),
          });
          text = resultJson(out);
        } catch (e) {
        // 工具失败是信息不是终止：isError 结果回填，循环继续
        isError = true;
        text = JSON.stringify({ isError: true, error: messageOf(e) });
      }
      // 溢出治理：单条结果 >32KB → 完整落盘工作区、消息体替换为 {_spilled,path,preview}
      //（无 workspace/落盘失败 → 截断 32KB；见 spillToolResult）
      const boundedText = await spillToolResult(deps, tc.id, text);
      messages.push({ role: 'tool', content: { toolCallId: tc.id, text: boundedText } });
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
      await executeAndAppend(requested, result.text, typeof result.reasoning === 'string' ? result.reasoning : '');
      continue;
    }
    if (result.text !== '') {
      finalText = result.text;
      break;
    }
    // 空回复守卫：空文本、无工具调用、但有思考链 → 思考占满本轮输出，提示后收束
    //（避免对推理模型的无效轮询；无思考链时维持现状继续轮询）
    if (typeof result.reasoning === 'string' && result.reasoning.trim() !== '') {
      finalText = EMPTY_REPLY_HINT;
      break;
    }
    // 全空结果连续多次 = 上游网关空响应/断流（链路问题），提前收束——避免空转到迭代
    // 上限后让模型产出误导性的「迭代耗尽」报告
    if (consecutiveEmpty >= 3) {
      finalText = await finalize('上游服务连续多次返回空响应（网络或模型服务临时异常），请稍后重试或检查模型服务连通性');
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
    ...(reasoningSegments.length > 0 ? { reasoningSegments } : {}),
  };
}
