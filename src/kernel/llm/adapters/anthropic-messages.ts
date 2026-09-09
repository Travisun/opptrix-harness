/**
 * Anthropic Messages 协议适配器（官方 @anthropic-ai/sdk）。
 *
 * - system 提取：harness `system` 消息拼接为顶层 `system` 参数，不进入 messages。
 * - 消息互转：user/assistant 直传；tool 消息 → user 角色 `tool_result` 块；
 *   assistant 富形状 toolCalls → `tool_use` 块（arguments JSON 反序列化为 input）。
 * - max_tokens 必填（缺省 4096）；stop → `stop_sequences`。
 * - 非流式：content[] 中 `tool_use` 块 → `LlmChatResult.toolCalls` 结构化提取
 *   （input 对象经 JSON.stringify 归一为 argsJson，与 openai 系 arguments 字符串对齐）。
 * - 流式：`content_block_delta`(text_delta) → delta；`message_start` 取 input_tokens、
 *   `message_delta` 取 output_tokens，流结束统一 emit done(usage)。
 * - 错误：SDK 异常统一包装 `LLM_PROVIDER_ERROR`；不做隐藏重试（策略归上层）。
 */
import Anthropic from '@anthropic-ai/sdk';
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
  type LlmResultToolCall,
  type LlmStreamEvent,
} from '../types.js';

const DEFAULT_MAX_TOKENS = 4096;

function wrapProviderError(e: unknown): never {
  throw err('LLM_PROVIDER_ERROR', {
    message: e instanceof Error ? e.message : String(e),
    cause: e,
  });
}

function clientOf(cfg: LlmProviderConfig, apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });
}

/** system 消息从消息列表提取（'\n\n' 拼接为顶层 system 参数） */
function splitSystem(messages: LlmMessage[]): { system: string | undefined; rest: LlmMessage[] } {
  const systemParts: string[] = [];
  const rest: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(textOrJson(m.content));
    else rest.push(m);
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, rest };
}

function toAnthropicMessages(rest: LlmMessage[]): Anthropic.MessageParam[] {
  return rest.map((m): Anthropic.MessageParam => {
    if (m.role === 'tool') {
      const { toolCallId, text } = toolContentOf(m.content);
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content: text }],
      };
    }
    const toolCalls = m.role === 'assistant' ? assistantToolCallsOf(m.content) : undefined;
    if (toolCalls) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      const text = assistantTextOf(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: JSON.parse(tc.arguments) as unknown });
      }
      return { role: 'assistant', content: blocks };
    }
    return { role: m.role, content: m.content } as Anthropic.MessageParam;
  });
}

function baseParams(input: LlmChatInput, system: string | undefined, rest: LlmMessage[], passthrough: Record<string, unknown>): Record<string, unknown> {
  return {
    model: input.model,
    // Anthropic 协议 max_tokens 必填
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toAnthropicMessages(rest),
    ...(system !== undefined ? { system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.stop !== undefined ? { stop_sequences: input.stop } : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...passthrough,
  };
}

export const anthropicMessagesAdapter: LlmAdapter = {
  protocol: 'anthropic-messages',

  async chat(cfg, apiKey, input): Promise<LlmChatResult> {
    const client = clientOf(cfg, apiKey);
    const { system, rest } = splitSystem(input.messages);
    const params = baseParams(input, system, rest, {
      ...filterProviderParams(input, cfg),
      stream: false,
    }) as unknown as Anthropic.MessageCreateParamsNonStreaming;
    try {
      const res = await client.messages.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
      // 结构化工具调用提取：content[] 中 type==='tool_use' 块（input 对象序列化为 argsJson）
      const toolCalls: LlmResultToolCall[] = res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, argsJson: JSON.stringify(b.input ?? {}) }));
      return {
        text,
        usage,
        raw: res,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (e) {
      wrapProviderError(e);
    }
  },

  async *stream(cfg, apiKey, input): AsyncGenerator<LlmStreamEvent> {
    const client = clientOf(cfg, apiKey);
    const { system, rest } = splitSystem(input.messages);
    const params = baseParams(input, system, rest, {
      ...filterProviderParams(input, cfg),
      stream: true,
    }) as unknown as Anthropic.MessageCreateParamsStreaming;
    try {
      const stream = await client.messages.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && event.delta.text.length > 0) {
            yield { type: 'delta', text: event.delta.text };
          }
        } else if (event.type === 'message_start') {
          inputTokens = event.message.usage?.input_tokens;
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
        }
      }
      yield inputTokens !== undefined || outputTokens !== undefined
        ? { type: 'done', usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 } }
        : { type: 'done' };
    } catch (e) {
      wrapProviderError(e);
    }
  },
};
