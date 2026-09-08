/**
 * LLM 网关模块出口。
 * 使用方统一 `import { LlmGateway, ... } from '../llm/index.js'`。
 */
export {
  assistantTextOf,
  assistantToolCallsOf,
  DEFAULT_PARAM_ALLOWLIST,
  DEFAULT_TIMEOUT_MS,
  filterProviderParams,
  isRecord,
  textOrJson,
  toolContentOf,
  type LlmAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmMessage,
  type LlmProtocol,
  type LlmProviderConfig,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';
export { LlmGateway, type LlmGatewayDeps } from './gateway.js';
export { openaiChatAdapter } from './adapters/openai-chat.js';
export { openaiResponsesAdapter } from './adapters/openai-responses.js';
export { anthropicMessagesAdapter } from './adapters/anthropic-messages.js';
