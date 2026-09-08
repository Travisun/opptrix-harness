/**
 * OpenAI Responses 协议适配器（官方 openai SDK `client.responses`）。
 *
 * - 消息映射：system/user/assistant → `{ role, content }` 输入项；
 *   assistant 富形状 toolCalls → `function_call` 项；tool 消息 → `function_call_output` 项。
 * - 参数映射：maxTokens → `max_output_tokens`；temperature/top_p/tools 直传（协议无 stop）。
 * - 流式事件映射：`response.output_text.delta` → delta；`response.completed` → done(usage)；
 *   `response.failed` / `error` → error 事件。
 * - 错误：SDK 异常统一包装 `LLM_PROVIDER_ERROR`；不做隐藏重试（策略归上层）。
 */
import OpenAI from 'openai';
import { err } from '../../errors/index.js';
import {
  assistantTextOf,
  assistantToolCallsOf,
  DEFAULT_TIMEOUT_MS,
  filterProviderParams,
  textOrJson,
  toolContentOf,
  type LlmAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmStreamEvent,
} from '../types.js';

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

function toResponsesInput(messages: LlmMessage[]): OpenAI.Responses.ResponseInput {
  const items: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const { toolCallId, text } = toolContentOf(m.content);
      items.push({ type: 'function_call_output', call_id: toolCallId, output: text });
      continue;
    }
    const toolCalls = m.role === 'assistant' ? assistantToolCallsOf(m.content) : undefined;
    if (toolCalls) {
      const text = assistantTextOf(m.content);
      if (text) items.push({ role: 'assistant', content: text });
      for (const tc of toolCalls) {
        items.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      continue;
    }
    items.push({ role: m.role, content: textOrJson(m.content) });
  }
  return items;
}

function baseParams(input: LlmChatInput, passthrough: Record<string, unknown>): Record<string, unknown> {
  return {
    model: input.model,
    input: toResponsesInput(input.messages),
    ...(input.maxTokens !== undefined ? { max_output_tokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...passthrough,
  };
}

/** 兜底聚合：output[] 中 message 项的 output_text 片段 */
function aggregateOutputText(output: OpenAI.Responses.Response['output']): string {
  let text = '';
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'output_text') text += part.text;
    }
  }
  return text;
}

export const openaiResponsesAdapter: LlmAdapter = {
  protocol: 'openai-responses',

  async chat(cfg, apiKey, input): Promise<LlmChatResult> {
    const client = clientOf(cfg, apiKey);
    const params = baseParams(input, filterProviderParams(input, cfg)) as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    try {
      const res = await client.responses.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const text =
        typeof res.output_text === 'string' && res.output_text.length > 0
          ? res.output_text
          : aggregateOutputText(res.output);
      const usage = res.usage
        ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
        : undefined;
      return { text, usage, raw: res };
    } catch (e) {
      wrapProviderError(e);
    }
  },

  async *stream(cfg, apiKey, input): AsyncGenerator<LlmStreamEvent> {
    const client = clientOf(cfg, apiKey);
    const params = {
      ...baseParams(input, filterProviderParams(input, cfg)),
      stream: true,
    } as unknown as OpenAI.Responses.ResponseCreateParamsStreaming;
    try {
      const stream = await client.responses.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      let usage: LlmChatResult['usage'] | undefined;
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          if (event.delta.length > 0) yield { type: 'delta', text: event.delta };
        } else if (event.type === 'response.completed') {
          const u = event.response.usage;
          if (u) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
        } else if (event.type === 'response.failed') {
          yield { type: 'error', message: event.response.error?.message ?? 'llm response failed' };
        } else if (event.type === 'error') {
          yield { type: 'error', message: event.message ?? 'llm stream error' };
        }
      }
      yield usage ? { type: 'done', usage } : { type: 'done' };
    } catch (e) {
      wrapProviderError(e);
    }
  },
};
