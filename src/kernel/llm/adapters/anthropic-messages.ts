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
import { err, HarnessError } from '../../errors/index.js';
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

/** SDK 错误统一包装：LLM_PROVIDER_ERROR（原始错误挂 cause）。已是 HarnessError
 * （空 body 等守卫错误）→ 原样透传，detail.kind 不丢（健康统计归因依赖）。 */
function wrapProviderError(e: unknown): never {
  if (e instanceof HarnessError) throw e;
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

function clientOf(cfg: LlmProviderConfig, apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 缺省 2 次（同 openai-chat）：波动链路下兼容网关的间歇失败是常态
    maxRetries: cfg.maxRetries ?? 2,
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

/**
 * Anthropic 协议 cache_control 断点（prompt 缓存亲和）：
 * - 顶层 `system` 参数：字符串 → 单元素 text 块数组并标 `cache_control:{type:'ephemeral'}`；
 * - 最后一条 user 消息：字符串 content → 包为 text 块；块数组 → 尾部块补标。
 * 前缀（system）+ 最近的对话断点命中 ephemeral 缓存，长会话显著降本。
 * SDK 类型未在所有版本面暴露 system 块数组的 cache_control 形状——以 as unknown 包裹
 * （协议层合法字段，服务端接受；与整个 params 的既有 cast 策略一致）。
 */
function applyCacheControlEphemeral(params: Record<string, unknown>): void {
  const system = params['system'];
  if (typeof system === 'string' && system !== '') {
    params['system'] = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  const messages = params['messages'];
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (m === undefined || m.role !== 'user') continue;
    if (typeof m.content === 'string' && m.content !== '') {
      m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }];
    } else if (Array.isArray(m.content) && m.content.length > 0) {
      const lastIndex = m.content.length - 1;
      const last = m.content[lastIndex] as Record<string, unknown>;
      m.content[lastIndex] = { ...last, cache_control: { type: 'ephemeral' } };
    }
    break;
  }
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
    applyCacheControlEphemeral(params as unknown as Record<string, unknown>);
    try {
      const res = await client.messages.create(params, {
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      // 空响应守卫（同 openai-chat）：链路波动时网关可能回空 body，SDK 静默 resolve undefined
      if (res === undefined || res === null || !Array.isArray(res.content)) {
        throw err('LLM_PROVIDER_ERROR', {
          message: `provider "${cfg.name}" [guard:am] returned an empty response body (transient gateway behavior) — retry`,
          detail: { provider: cfg.name, model: input.model, kind: 'empty-body' },
        });
      }
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
    applyCacheControlEphemeral(params as unknown as Record<string, unknown>);
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
