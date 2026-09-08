/**
 * LLM 网关：按模型路由到 provider（协议适配器），密钥经 secret 引用运行时解析。
 *
 * - 路由：`getProviders()` 中找 models 包含 input.model 的第一个 provider；
 *   无 → `LLM_MODEL_NOT_FOUND`（detail.model）。
 * - 密钥：`resolveSecret(cfg.apiKeySecretRef)` 为 null → `LLM_NOT_CONFIGURED`（detail.provider）；
 *   密钥仅传给 adapter，不落日志。
 * - stream !== true → `adapter.chat`（Promise 结果）；否则返回 `adapter.stream`（AsyncGenerator 直接透出）。
 */
import { err } from '../errors/index.js';
import { anthropicMessagesAdapter } from './adapters/anthropic-messages.js';
import { openaiChatAdapter } from './adapters/openai-chat.js';
import { openaiResponsesAdapter } from './adapters/openai-responses.js';
import type {
  LlmAdapter,
  LlmChatInput,
  LlmChatResult,
  LlmProtocol,
  LlmProviderConfig,
  LlmStreamEvent,
} from './types.js';

export interface LlmGatewayDeps {
  getProviders(): Promise<LlmProviderConfig[]>;
  resolveSecret(ref: string): Promise<string | null>;
  logger: import('pino').Logger;
}

const ADAPTERS: Readonly<Record<LlmProtocol, LlmAdapter>> = {
  'openai-chat': openaiChatAdapter,
  'openai-responses': openaiResponsesAdapter,
  'anthropic-messages': anthropicMessagesAdapter,
};

export class LlmGateway {
  constructor(private readonly deps: LlmGatewayDeps) {}

  /** 按模型路由执行一次对话；stream=true 时返回流事件迭代器（首个事件在首次 next 时产生） */
  async chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> {
    const providers = await this.deps.getProviders();
    const cfg = providers.find((p) => p.models.includes(input.model));
    if (!cfg) {
      throw err('LLM_MODEL_NOT_FOUND', { detail: { model: input.model } });
    }
    const apiKey = await this.deps.resolveSecret(cfg.apiKeySecretRef);
    if (apiKey === null) {
      throw err('LLM_NOT_CONFIGURED', { detail: { provider: cfg.name } });
    }
    const adapter = ADAPTERS[cfg.protocol];
    this.deps.logger.debug(
      { provider: cfg.name, protocol: cfg.protocol, model: input.model, stream: input.stream === true },
      'llm gateway: routed to provider',
    );
    if (input.stream === true) {
      return adapter.stream(cfg, apiKey, input);
    }
    return adapter.chat(cfg, apiKey, input);
  }
}
