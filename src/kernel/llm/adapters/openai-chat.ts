/**
 * OpenAI Chat Completions 协议适配器（官方 openai SDK）。
 *
 * - 消息互转：system/user/assistant 直传；tool 消息 ↔ `role:'tool'`（tool_call_id），
 *   assistant 富形状 toolCalls ↔ `tool_calls`（type:function）。
 * - 流式：`stream_options:{ include_usage: true }` 保证最后一个 chunk 携带 usage；
 *   工具调用增量以 `tool_call_delta` 透传（index 取自 chunk 内声明）。
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
  type LlmStreamEvent,
} from '../types.js';

/** SDK 错误统一包装：LLM_PROVIDER_ERROR（原始错误挂 cause） */
function wrapProviderError(e: unknown): never {
  throw err('LLM_PROVIDER_ERROR', {
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}

function clientOf(cfg: LlmProviderConfig, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });
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
      const usage = res.usage
        ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
        : undefined;
      return { text: res.choices[0]?.message.content ?? '', usage, raw: res };
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
