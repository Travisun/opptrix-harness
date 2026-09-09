/**
 * ChatChannels 平台连接器 — 统一契约（入站回调解析 + 出站平台 API 投递）。
 *
 * 与既有「聊天桥」（`../bridges/`，纯出站 webhook/email）并存：连接器面向主流 IM
 * 平台，同时覆盖两个方向——
 * - 出站：`deliverOutbound(message, target)` 与 `ChatBridgeDriver.deliverOutbound`
 *   同构，经 `createPlatformConnectors().bridgeDrivers()` 注册进 ChannelRegistry
 *   （name = 平台名），由 ChatBridgeDispatcher 按频道 `meta.bridges` 分发；
 * - 入站：平台回调打到统一路由 `POST /hooks/connector/:platform/:token`
 *   （src/api/chat.ts），经 `verifyInbound`（可选，签名/密钥校验）→
 *   `parseInbound`（平台 body → 统一消息形状）→ ChatService.sendMessage。
 *
 * target 形状（连接参数）由各连接器自行 zod 校验，非法一律 DELIVERY_FAILED；
 * 平台矩阵与各平台 target 示例见文档站 docs/chat-platforms.mdx。
 */
import type { ChatMessagePayload } from '../../channels/types.js';

/**
 * 支持的平台名（ChannelRegistry 桥驱动主键 + 入站路由 :platform 段）。
 *
 * `imessage` 仅为未来「宿主代理」实现保留的契约位：无官方 API，运行时连接器
 * 不内置（探索结论与宿主代理设计草案见文档站 docs/chat-platforms.mdx）。
 */
export type ConnectorPlatform = 'telegram' | 'slack' | 'feishu' | 'dingtalk' | 'wecom' | 'imessage';

/**
 * 入站请求的最小结构视图（与 fastify request 结构兼容，便于单测构造）。
 * body 为平台回调 JSON（框架已完成 JSON 解析；解析失败在路由层 400）。
 */
export interface ConnectorInboundRequest {
  /** 请求头（键为小写；值可能为 string[]） */
  headers: Record<string, string | string[] | undefined>;
  /** 平台回调 body（JSON 值；形状由各连接器 parseInbound 自行判定） */
  body: unknown;
}

/** parseInbound 的统一产出（路由层包装为 `content: { type: 'text', text }` 入库） */
export interface ParsedInboundMessage {
  /** 消息文本（非空；空文本/不可解析载荷应返回 null 而非空串） */
  text: string;
  /** 平台用户名/标识（senderName；缺省时路由回退为平台名） */
  senderName?: string;
  /** 平台原始标识（chatId / ts / message_id 等，供扩展事件消费） */
  meta?: unknown;
}

/** 平台连接器依赖（全部可选，便于最小装配与测试注入） */
export interface PlatformConnectorDeps {
  /** 出站平台 API 的 fetch 实现（缺省全局 fetch；测试注入 mock 断言请求） */
  fetchImpl?: typeof fetch;
  /** 时钟（缺省 Date.now；feishu token 缓存过期等时间语义的测试注入点） */
  now?: () => number;
}

/**
 * 平台连接器：一个主流 IM 平台的入站解析 + 出站投递实现。
 */
export interface PlatformConnector {
  /** 平台名（'telegram' | 'slack' | ...；同为 ChannelRegistry 桥驱动名） */
  platform: ConnectorPlatform;
  /** 出站一条消息到平台；失败抛 HarnessError(DELIVERY_FAILED)，不静默吞错 */
  deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void>;
  /**
   * 入站校验（可选）：平台签名/共享密钥头校验（如 Telegram secret_token）。
   * `target` 为该频道 meta.bridges 中本平台的出站目标（密钥随 target 配置）；
   * 未配置 target / target 无密钥字段时返回 true（仅凭 URL 令牌鉴权）。
   */
  verifyInbound?(req: ConnectorInboundRequest, target?: unknown): boolean | Promise<boolean>;
  /** 入站解析：平台回调 body → 统一消息；非消息载荷/不可解析返回 null（路由 202 ignored） */
  parseInbound(req: ConnectorInboundRequest): ParsedInboundMessage | null;
}
