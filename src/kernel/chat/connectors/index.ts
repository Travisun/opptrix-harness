/**
 * 内核 chat 平台连接器模块出口。
 * 使用方统一 `import { createPlatformConnectors } from '../chat/connectors/index.js'`。
 */
export type {
  ConnectorInboundRequest,
  ConnectorPlatform,
  ParsedInboundMessage,
  PlatformConnector,
  PlatformConnectorDeps,
} from './types.js';
export { createPlatformConnectors, platformTargetFromMeta, type PlatformConnectorRegistry } from './registry.js';
export { postJson, safeUrlOf, contentToText } from './http.js';
export { createTelegramConnector, TELEGRAM_SECRET_TOKEN_HEADER, type TelegramTarget } from './telegram.js';
export { createSlackConnector, type SlackTarget } from './slack.js';
export { createFeishuConnector, parseFeishuChallenge, type FeishuTarget } from './feishu.js';
export { createDingtalkConnector, signedWebhookUrl, type DingtalkTarget } from './dingtalk.js';
export { createWecomConnector, type WecomTarget } from './wecom.js';
