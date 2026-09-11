/**
 * LLM 网关模块出口。
 * 使用方统一 `import { LlmGateway, ... } from '../llm/index.js'`。
 */
export {
  assistantReasoningOf,
  assistantTextOf,
  assistantToolCallsOf,
  DEFAULT_PARAM_ALLOWLIST,
  DEFAULT_TIMEOUT_MS,
  filterProviderParams,
  isRecord,
  normalizeBaseUrl,
  textOrJson,
  toolContentOf,
  type LlmAdapter,
  type LlmChatInput,
  type LlmChatResult,
  type LlmHaAttempt,
  type LlmMessage,
  type LlmProtocol,
  type LlmProviderConfig,
  type LlmResultToolCall,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmUsage,
} from './types.js';
export { LlmGateway, type LlmGatewayDeps } from './gateway.js';
export {
  createThinkStripper,
  extractThinkContent,
  type ThinkExtraction,
  type ThinkStreamStripper,
} from './think.js';
export {
  jitteredFailoverDelayMs,
  ProviderHealthRegistry,
  sharedProviderHealth,
  type ProviderHealthLike,
  type ProviderHealthOptions,
  type ProviderHealthStat,
} from './health.js';
export { openaiChatAdapter } from './adapters/openai-chat.js';
export { openaiResponsesAdapter } from './adapters/openai-responses.js';
export { anthropicMessagesAdapter } from './adapters/anthropic-messages.js';
export {
  hasToolMarkup,
  recoverToolCallsFromText,
  type RecoveredToolCall,
  type ToolMarkupRecovery,
} from './tool-markup.js';
