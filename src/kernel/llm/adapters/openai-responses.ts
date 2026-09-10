/**
 * OpenAI Responses 协议适配器（官方 openai SDK `client.responses`）。
 *
 * - 消息映射：system/user/assistant → `{ role, content }` 输入项；
 *   assistant 富形状 toolCalls → `function_call` 项；tool 消息 → `function_call_output` 项。
 * - 参数映射：maxTokens → `max_output_tokens`；temperature/top_p/tools 直传（协议无 stop）。
 * - 非流式：output[] 中 `function_call` 项 → `LlmChatResult.toolCalls` 结构化提取。
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
  type LlmResultToolCall,
  type LlmStreamEvent,
} from '../types.js';

function wrapProviderError(e: unknown): never {
  throw err('LLM_PROVIDER_ERROR', {
    message: e instanceof Error ? e.message : String(e),
    // 提供方侧失败是排障高频点：带 errorKind 与内层 cause 链摘要进 detail
    //（REST 面已鉴权；堆栈只进日志面——HarnessError.cause 由 logSink 序列化）
    detail: {
      errorKind: e instanceof Error ? e.name : typeof e,
      causeChain: causeChainOf(e),
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

function clientOf(cfg: LlmProviderConfig, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 缺省 2 次（同 openai-chat）：波动链路下兼容网关的间歇失败是常态
    maxRetries: cfg.maxRetries ?? 2,
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
      // 兼容网关链路波动时回 200 + 空 body（SDK 静默 resolve undefined）——见 openai-chat 同款守卫
      if (res === undefined || res === null) {
        throw err('LLM_PROVIDER_ERROR', {
          message: `provider "${cfg.name}" [guard:oir] returned an empty response body (transient gateway behavior) — retry`,
          detail: { provider: cfg.name, model: input.model, kind: 'empty-body' },
        });
      }
      const text =
        typeof res.output_text === 'string' && res.output_text.length > 0
          ? res.output_text
          : aggregateOutputText(res.output);
      const usage = res.usage
        ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }
        : undefined;
      // 结构化工具调用提取：output[] 中 type==='function_call' 项（custom 等其他类型跳过）
      const toolCalls: LlmResultToolCall[] = res.output
        .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === 'function_call')
        .map((item) => ({ id: item.call_id, name: item.name, argsJson: item.arguments }));
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
