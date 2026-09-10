/**
 * OpenAI Chat Completions 协议适配器（官方 openai SDK）。
 *
 * - 消息互转：system/user/assistant 直传；tool 消息 ↔ `role:'tool'`（tool_call_id），
 *   assistant 富形状 toolCalls ↔ `tool_calls`（type:function）。
 * - 非流式：`choices[0].message.tool_calls`（type:function）→ `LlmChatResult.toolCalls`
 *   结构化提取（id/name/argsJson）；流式仍以 `tool_call_delta` 增量透传。
 * - 流式：`stream_options:{ include_usage: true }` 保证最后一个 chunk 携带 usage；
 *   工具调用增量以 `tool_call_delta` 透传（index 取自 chunk 内声明）；
 *   思考链增量解析 `delta.reasoning_content`（兼容 reasoningContent）→ `reasoning_delta` 事件；
 *   非流式同步提取 `message.reasoning_content` → `LlmChatResult.reasoning`。
 * - 超时：client `timeout` + 每请求 `AbortSignal.timeout(timeoutMs)` 双保险。
 * - 错误：SDK 异常统一包装 `LLM_PROVIDER_ERROR`；不做隐藏重试（策略归上层）。
 */
import OpenAI from 'openai';
import { err } from '../../errors/index.js';
import {
  assistantTextOf,
  assistantToolCallsOf,
  DEFAULT_TIMEOUT_MS,
  filterProviderParams,
  toolContentOf,
  type LlmAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmResultToolCall,
  type LlmStreamEvent,
} from '../types.js';

/** SDK 错误统一包装：LLM_PROVIDER_ERROR（原始错误挂 cause） */
function wrapProviderError(e: unknown): never {
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
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 缺省 2 次（SDK 缺省）：兼容网关链路波动（间歇空 body/连接重置）是常态而非异常；
    // 每次重试带指数退避，配置面可经 timeoutMs/paramAllowlist 同层的 retry 覆盖（未开放时取缺省）。
    maxRetries: cfg.maxRetries ?? 2,
    // debug 排障：SDK 自带请求/响应日志（默认 console，stderr 进 dev 日志；非 debug 不输出）
    ...(process.env.HARNESS_LOG_LEVEL === 'debug' ? { logLevel: 'debug' as const } : {}),
  });
  return client;
}

function toOpenAiMessages(messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
    if (m.role === 'tool') {
      const { toolCallId, text } = toolContentOf(m.content);
      return { role: 'tool', tool_call_id: toolCallId, content: text };
    }
    const toolCalls = m.role === 'assistant' ? assistantToolCallsOf(m.content) : undefined;
    if (toolCalls) {
      return {
        role: 'assistant',
        content: assistantTextOf(m.content) ?? null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content } as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function baseParams(input: LlmChatInput, passthrough: Record<string, unknown>): Record<string, unknown> {
  return {
    model: input.model,
    messages: toOpenAiMessages(input.messages),
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.stop !== undefined ? { stop: input.stop } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...passthrough,
  };
}

export const openaiChatAdapter: LlmAdapter = {
  protocol: 'openai-chat',

  async chat(cfg, apiKey, input): Promise<LlmChatResult> {
    const client = clientOf(cfg, apiKey);
    const params = baseParams(input, filterProviderParams(input, cfg)) as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
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
      const toolCalls: LlmResultToolCall[] = (res.choices[0]?.message.tool_calls ?? [])
        .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
        .map((tc) => ({ id: tc.id, name: tc.function.name, argsJson: tc.function.arguments }));
      // 思考链全文（推理模型经 message.reasoning_content 回传；空 = 无思考链，不出现该键）
      const reasoning = reasoningContentOf(res.choices[0]?.message);
      return {
        text: res.choices[0]?.message.content ?? '',
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
      ...baseParams(input, filterProviderParams(input, cfg)),
      stream: true,
      // 让服务端在最后一个 chunk（choices 为空）回传 usage
      stream_options: { include_usage: true },
    } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
    try {
      const stream = await client.chat.completions.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      let usage: LlmChatResult['usage'] | undefined;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        // 思考链增量（reasoning_content 优先，兼容 camelCase reasoningContent）
        const reasoningText = reasoningContentOf(delta);
        if (reasoningText !== undefined) {
          yield { type: 'reasoning_delta', text: reasoningText };
        }
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          yield { type: 'delta', text: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          yield { type: 'tool_call_delta', index: tc.index, payload: tc };
        }
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        }
      }
      yield usage ? { type: 'done', usage } : { type: 'done' };
    } catch (e) {
      wrapProviderError(e);
    }
  },
};
