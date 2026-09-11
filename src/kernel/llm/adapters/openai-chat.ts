/**
 * OpenAI Chat Completions 协议适配器（官方 openai SDK）。
 *
 * - 消息互转：system/user/assistant 直传；tool 消息 ↔ `role:'tool'`（tool_call_id），
 *   assistant 富形状 toolCalls ↔ `tool_calls`（type:function）；assistant 富形状携带
 *   `reasoning`（含空串）时回写 `reasoning_content`（DeepSeek/LongCat 等推理模型要求
 *   tool 轮续写时 assistant 消息带该键，丢思考也要带 key）。
 * - baseUrl 规范化：clientOf 处经 `normalizeBaseUrl` 容错（补协议/剥多余 /chat/completions
 *   尾巴；不自动补 /v1——国内网关路径各异）。
 * - `<think>` 剥离：Qwen 系把思考链写进正文 `<think>` 标签——非流式解析为 reasoning
 *   （`reasoning_content` 字段优先，正文 think 块兜底）；流式经增量状态机分流为
 *   `reasoning_delta` 事件（跨 delta 边界安全），思考链绝不混入 text。
 * - 非流式：`choices[0].message.tool_calls`（type:function）→ `LlmChatResult.toolCalls`
 *   结构化提取（id/name/argsJson）；流式仍以 `tool_call_delta` 增量透传。
 * - 文本内嵌工具标记恢复（markup recovery）：原生 tool_calls **为空/缺失**且 content 含
 *   `<longcat_tool_call>`/`<tool_call>`/`<|tool_call|>` 等标记块时（LongCat/Qwen 系兼容网关
 *   偶发行为），经 tool-markup 解析为等价 toolCalls，text 用剥离标记后的 cleanedText；
 *   原生优先——原生 tool_calls 存在时绝不恢复、正文原样。
 * - 流式：`stream_options:{ include_usage: true }` 保证最后一个 chunk 携带 usage
 *   （provider `streamOptions:false` 时请求不带该键——部分网关校验未知键回 400）；
 *   工具调用增量以 `tool_call_delta` 透传（index 取自 chunk 内声明）；
 *   思考链增量解析 `delta.reasoning_content`（兼容 reasoningContent）→ `reasoning_delta` 事件；
 *   非流式同步提取 `message.reasoning_content` → `LlmChatResult.reasoning`。
 * - prompt 缓存亲和：provider `promptCacheKey !== false` 且 input.sessionKey 非空时
 *   payload 追加 `prompt_cache_key`（会话级前缀缓存；键由适配器直写，不经参数白名单）。
 * - 超时：client `timeout` + 每请求 `AbortSignal.timeout(timeoutMs)` 双保险。
 * - 错误：SDK 异常统一包装 `LLM_PROVIDER_ERROR`（空 body / 空 choices / 空流守卫均带
 *   `detail.kind`，供网关健康统计归因）；不做隐藏重试（策略归上层）。
 */
import OpenAI from 'openai';
import { err, HarnessError } from '../../errors/index.js';
import { hasToolMarkup, recoverToolCallsFromText } from '../tool-markup.js';
import { createThinkStripper, extractThinkContent } from '../think.js';
import {
  assistantReasoningOf,
  assistantTextOf,
  assistantToolCallsOf,
  DEFAULT_TIMEOUT_MS,
  filterProviderParams,
  normalizeBaseUrl,
  toolContentOf,
  type LlmAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmResultToolCall,
  type LlmStreamEvent,
} from '../types.js';

/** SDK 错误统一包装：LLM_PROVIDER_ERROR（原始错误挂 cause）。已是 HarnessError
 * （空 body/空流等 kind 守卫错误）→ 原样透传，detail.kind 不丢（健康统计归因依赖）。 */
function wrapProviderError(e: unknown): never {
  if (e instanceof HarnessError) throw e;
  throw err('LLM_PROVIDER_ERROR', {
    message: e instanceof Error ? e.message : String(e),
    // 提供方侧失败是排障高频点：带 errorKind 与内层 cause 链摘要进 detail
    //（REST 面已鉴权；堆栈只进日志面——HarnessError.cause 由 logSink 序列化）
    detail: {
      errorKind: e instanceof Error ? e.name : typeof e,
      causeChain: causeChainOf(e),
      ...(e instanceof Error && e.stack !== undefined ? { stack: e.stack.split('\n').slice(0, 8) } : {}),
    },
    cause: e,
  });
}

/** 提取 cause 链摘要（最多 3 层，每层 type+message；排障 SDK/undici 包装错误） */
function causeChainOf(e: unknown, depth = 0): string[] {
  if (depth >= 3 || e === null || e === undefined || typeof e !== 'object') return [];
  const err = e as { name?: string; message?: string; cause?: unknown };
  const line = `${err.name ?? 'unknown'}: ${err.message ?? ''}`;
  return [line, ...causeChainOf(err.cause, depth + 1)];
}

/** 最近一次响应的头部快照（empty-body 诊断用；SDK 消化 response 后守卫处已拿不到） */

/**
 * delta/message 上的思考链字段读取：`reasoning_content` 优先（DeepSeek 等约定），
 * 兼容 camelCase `reasoningContent`；非字符串/空串收敛为 undefined。
 */
function reasoningContentOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as { reasoning_content?: unknown; reasoningContent?: unknown };
  if (typeof rec.reasoning_content === 'string' && rec.reasoning_content !== '') return rec.reasoning_content;
  if (typeof rec.reasoningContent === 'string' && rec.reasoningContent !== '') return rec.reasoningContent;
  return undefined;
}

function clientOf(cfg: LlmProviderConfig, apiKey: string): OpenAI {
  const client = new OpenAI({
    apiKey,
    // 入队规范化：补协议/剥多余 /chat/completions 尾巴（不补 /v1，见 normalizeBaseUrl 注释）
    baseURL: normalizeBaseUrl(cfg.baseUrl),
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 缺省 2 次（SDK 缺省）：兼容网关链路波动（间歇空 body/连接重置）是常态而非异常；
    // 每次重试带指数退避，配置面可经 timeoutMs/paramAllowlist 同层的 retry 覆盖（未开放时取缺省）。
    maxRetries: cfg.maxRetries ?? 2,
    // debug 排障：SDK 自带请求/响应日志（默认 console，stderr 进 dev 日志；非 debug 不输出）
    ...(process.env.HARNESS_LOG_LEVEL === 'debug' ? { logLevel: 'debug' as const } : {}),
  });
  return client;
}

/** prompt_cache_key 组装：provider 未显式关闭且 sessionKey 非空时返回该键 */
function promptCacheKeyOf(cfg: LlmProviderConfig, input: LlmChatInput): string | undefined {
  if (cfg.promptCacheKey === false) return undefined;
  const key = input.sessionKey;
  return typeof key === 'string' && key !== '' ? key : undefined;
}

function toOpenAiMessages(messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    if (m.role === 'tool') {
      const { toolCallId, text } = toolContentOf(m.content);
      return { role: 'tool', tool_call_id: toolCallId, content: text };
    }
    const toolCalls = m.role === 'assistant' ? assistantToolCallsOf(m.content) : undefined;
    if (toolCalls) {
      // DeepSeek/LongCat 等推理模型的硬要求：tool 轮续写时 assistant 消息必须带
      // reasoning_content（丢思考也要带 key——空串也写，保证键存在）。
      const reasoning = assistantReasoningOf(m.content);
      return {
        role: 'assistant',
        content: assistantTextOf(m.content) ?? null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }
    return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function baseParams(input: LlmChatInput, cfg: LlmProviderConfig, passthrough: Record<string, unknown>): Record<string, unknown> {
  const cacheKey = promptCacheKeyOf(cfg, input);
  return {
    model: input.model,
    messages: toOpenAiMessages(input.messages),
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.stop !== undefined ? { stop: input.stop } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    // prompt 缓存亲和（会话级）：键由适配器直写 payload，不经 paramAllowlist
    ...(cacheKey !== undefined ? { prompt_cache_key: cacheKey } : {}),
    ...passthrough,
  };
}

export const openaiChatAdapter: LlmAdapter = {
  protocol: 'openai-chat',

  async chat(cfg, apiKey, input): Promise<LlmChatResult> {
    const client = clientOf(cfg, apiKey);
    const params = baseParams(input, cfg, filterProviderParams(input, cfg)) as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    try {
      const res = await client.chat.completions.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      // 兼容网关在链路波动时会回 200 + JSON content-type + 空 body（SDK 对此静默
      // resolve undefined，见 openai/internal/parse.mjs 的 content-length:0/空正文
      // 分支）——收敛为明确可重试的 provider 错误，而非裸 TypeError。
      if (res === undefined || res === null) {
        throw err('LLM_PROVIDER_ERROR', {
          message: `provider "${cfg.name}" returned an empty response body (transient gateway behavior) — retry`,
          detail: { provider: cfg.name, model: input.model, kind: 'empty-body' },
        });
      }
      if (!Array.isArray(res.choices) || res.choices.length === 0) {
        throw err('LLM_PROVIDER_ERROR', {
          message: `provider "${cfg.name}" returned no choices`,
          detail: { provider: cfg.name, model: input.model, kind: 'empty-choices' },
        });
      }
      const usage = res.usage
        ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
        : undefined;
      // 结构化工具调用提取（function 类型；custom 等其他类型不在 harness 工具规约内，跳过）
      const nativeToolCalls: LlmResultToolCall[] = (res.choices[0]?.message.tool_calls ?? [])
        .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
        .map((tc) => ({ id: tc.id, name: tc.function.name, argsJson: tc.function.arguments }));
      // `<think>` 剥离（Qwen 系思考链写进正文）：先剥 think 块出 reasoning，
      // 再对剥离后的正文做工具标记恢复——思考块里出现过的标记样例绝不误恢复。
      let text = res.choices[0]?.message.content ?? '';
      let toolCalls = nativeToolCalls;
      const fieldReasoning = reasoningContentOf(res.choices[0]?.message);
      let thinkReasoning = '';
      if (typeof text === 'string' && text.includes('<think')) {
        const stripped = extractThinkContent(text);
        text = stripped.text;
        thinkReasoning = stripped.reasoning;
      }
      if (nativeToolCalls.length === 0 && typeof text === 'string' && hasToolMarkup(text)) {
        const recovered = recoverToolCallsFromText(text);
        if (recovered.toolCalls.length > 0) {
          text = recovered.cleanedText;
          toolCalls = recovered.toolCalls.map(({ id, name, argsJson }) => ({ id, name, argsJson }));
        }
      }
      // 思考链全文：`reasoning_content` 字段优先（显式约定 > 正文启发式），
      // 无字段时用 `<think>` 剥离结果；两者皆无 = 本轮无思考链，不出现该键
      const reasoning = fieldReasoning ?? (thinkReasoning !== '' ? thinkReasoning : undefined);
      return {
        text,
        usage,
        raw: res,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (e) {
      wrapProviderError(e);
    }
  },

  async *stream(cfg, apiKey, input): AsyncGenerator<LlmStreamEvent> {
    const client = clientOf(cfg, apiKey);
    const params = {
      ...baseParams(input, cfg, filterProviderParams(input, cfg)),
      stream: true,
      // 让服务端在最后一个 chunk（choices 为空）回传 usage；provider 可显式关闭
      //（部分兼容网关校验未知键回 400——streamOptions:false 时请求不带该键）
      ...(cfg.streamOptions !== false ? { stream_options: { include_usage: true } } : {}),
    } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
    // `<think>` 剥离状态机：content 增量中的 think 开/闭分流为正文 delta 与 reasoning_delta
    //（跨 delta 边界安全，见 think.ts）。空流重建不重复投喂——重建仅发生在零 chunk 尝试。
    const stripper = createThinkStripper();
    // 空 flux 守卫：兼容网关间歇回 200 + 零 chunk 的"空流"（HTTP 层成功，SDK 不重试）
    // ——检测到零增量流即整段静默重建（最多 3 次 attempt）；已产出的增量绝不重复。
    // 三次尝试仍零 chunk → 抛 kind:'empty-stream' 守卫错误（网关健康统计归因 + 上层可重试），
    // 绝不以裸 done 收尾（空结果静默成功会遮蔽链路故障）。
    for (let attempt = 1; attempt <= 3; attempt++) {
      let chunks = 0;
      try {
        const stream = await client.chat.completions.create(params, {
          signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        let usage: LlmChatResult['usage'] | undefined;
        for await (const chunk of stream) {
          chunks += 1;
          const delta = chunk.choices[0]?.delta;
          // 思考链增量（reasoning_content 优先，兼容 camelCase reasoningContent）
          const reasoningText = reasoningContentOf(delta);
          if (reasoningText !== undefined) {
            yield { type: 'reasoning_delta', text: reasoningText };
          }
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            // `<think>` 分流：正文片段 → delta；思考片段 → reasoning_delta
            const stripped = stripper.push(delta.content);
            if (stripped.reasoning !== '') {
              yield { type: 'reasoning_delta', text: stripped.reasoning };
            }
            if (stripped.text !== '') {
              yield { type: 'delta', text: stripped.text };
            }
          }
          for (const tc of delta?.tool_calls ?? []) {
            yield { type: 'tool_call_delta', index: tc.index, payload: tc };
          }
          if (chunk.usage) {
            usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
          }
        }
        if (chunks === 0) {
          if (attempt < 3) continue; // 空流：本轮未 yield 任何增量，重建下一 attempt 安全
          throw err('LLM_PROVIDER_ERROR', {
            message: `provider "${cfg.name}" returned an empty stream (zero chunks in 3 attempts) — retry`,
            detail: { provider: cfg.name, model: input.model, kind: 'empty-stream' },
          });
        }
        const flushed = stripper.flush();
        if (flushed.reasoning !== '') {
          yield { type: 'reasoning_delta', text: flushed.reasoning };
        }
        if (flushed.text !== '') {
          yield { type: 'delta', text: flushed.text };
        }
        yield usage ? { type: 'done', usage } : { type: 'done' };
        return;
      } catch (e) {
        // 传输层异常：本轮未产出增量时静默重试（增量已出则上抛，绝不重复/拼接错乱）
        if (chunks > 0 || attempt >= 3) wrapProviderError(e);
      }
    }
  },
};
