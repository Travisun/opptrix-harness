/**
 * Chat Bridge Dispatcher：按频道的 bridges 配置把出站聊天消息并发投递到全部桥驱动。
 *
 * - bridges 配置由集成方从 channels.meta.bridges 读出，经 deps.getChannelBridges(channelId) 提供；
 *   无配置时 dispatch 直接返回（no-op）。
 * - 驱动经 deps.registry.getChatBridgeDriver(name) 查找；未注册视为该桥投递失败（不中断其余桥）。
 * - 全部桥 Promise.allSettled 并发；单桥失败不抛——recordDelivery(kind='chat_bridge', ok=false)
 *   + logger.error；成功记 recordDelivery(ok=true, durationMs)。
 * - 密钥安全：recordDelivery/logger 中的 target 均为脱敏摘要（secret 等键替换为 [redacted]）。
 */
import type { Logger } from 'pino';

import { err } from '../errors/HarnessError.js';
import type { ChatMessagePayload } from '../channels/types.js';

/** 频道 bridge 配置项（channels.meta.bridges 的规范化形状） */
export interface ChannelBridgeConfig {
  /** 桥驱动名（如 'webhook' / 'email'），须已注册到 ChannelRegistry */
  driver: string;
  /** 驱动 target 配置（结构由各驱动自行 zod 校验） */
  target: unknown;
}

/** 投递记录（kind='chat_bridge' 时 channel 为频道 id） */
export interface DeliveryRecord {
  kind: string;
  target: string;
  channel: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
}

/** 依赖注入（由内核集成方装配） */
export interface ChatBridgeDispatcherDeps {
  /** ChannelRegistry 的桥驱动查找面 */
  registry: {
    getChatBridgeDriver(name: string): { deliverOutbound(message: unknown, target: unknown): Promise<void> } | undefined;
  };
  /** 读频道 bridges 配置（集成方从 channels.meta.bridges 提供） */
  getChannelBridges(channelId: string): ChannelBridgeConfig[];
  /** 投递结果记录（内核投递日志/审计） */
  recordDelivery(entry: DeliveryRecord): void;
  /** kernel logger（pino） */
  logger: Logger;
}

/** 脱敏键：这些键在 target 摘要中一律替换为 [redacted]（密钥永不入日志） */
const REDACTED_KEYS = new Set(['secret', 'pass', 'password', 'token', 'apikey', 'api_key', 'authorization']);

/**
 * 聊天桥调度器：channel → bridges[] → 并发投递 → 记录结果。
 */
export class ChatBridgeDispatcher {
  private readonly deps: ChatBridgeDispatcherDeps;

  constructor(deps: ChatBridgeDispatcherDeps) {
    this.deps = deps;
  }

  /**
   * 把 message 投递到 channel 配置的全部桥驱动。
   * - 无 bridges 配置：直接返回（no-op）。
   * - 单桥失败不抛（记录 + 日志）；本方法仅在全部桥处理完毕后正常返回。
   */
  async dispatch(message: ChatMessagePayload, channel: { id: string; slug: string }): Promise<void> {
    const bridges = this.deps.getChannelBridges(channel.id);
    if (bridges.length === 0) return;

    // dispatcher 以 channel 行为权威：channelSlug 与频道 slug 不一致时归一化
    const outbound: ChatMessagePayload =
      message.channelSlug === channel.slug ? message : { ...message, channelSlug: channel.slug };

    const results = await Promise.allSettled(bridges.map((b) => this.deliverOne(b, outbound, channel)));
    // deliverOne 已兜底不抛；allSettled 仅作双保险
    for (const r of results) {
      if (r.status === 'rejected') {
        this.deps.logger.error({ err: r.reason instanceof Error ? r.reason.message : String(r.reason) }, 'chat bridge dispatcher: unexpected rejection');
      }
    }
  }

  /** 单桥投递：成功/失败均 recordDelivery（kind='chat_bridge'），失败不抛 */
  private async deliverOne(
    bridge: ChannelBridgeConfig,
    message: ChatMessagePayload,
    channel: { id: string; slug: string },
  ): Promise<void> {
    const startedAt = Date.now();
    const targetLabel = describeTarget(bridge.target);
    try {
      const driver = this.deps.registry.getChatBridgeDriver(bridge.driver);
      if (!driver) {
        throw err('DELIVERY_DRIVER_NOT_FOUND', {
          message: `chat bridge driver "${bridge.driver}" is not registered on the channel registry`,
        });
      }
      await driver.deliverOutbound(message, bridge.target);
      this.deps.recordDelivery({
        kind: 'chat_bridge',
        target: targetLabel,
        channel: channel.id,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    } catch (e) {
      const messageText = e instanceof Error ? e.message : String(e);
      this.deps.recordDelivery({
        kind: 'chat_bridge',
        target: targetLabel,
        channel: channel.id,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: messageText,
      });
      this.deps.logger.error(
        { driver: bridge.driver, channel: channel.id, target: targetLabel, err: messageText },
        'chat bridge delivery failed',
      );
    }
  }
}

/** target 脱敏摘要：前两层键中密钥类键替换为 [redacted]；序列化失败有兜底 */
function describeTarget(target: unknown): string {
  return JSON.stringify(sanitize(target, 2)) ?? '[unserializable target]';
}

function sanitize(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return depth <= 0 ? '[array]' : value.map((v) => sanitize(v, depth - 1));
  }
  if (depth <= 0) return '[object]';
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : sanitize(val, depth - 1);
  }
  return out;
}
