/**
 * 平台连接器注册中心工厂：一次创建全部内置平台连接器，并给出两种视图——
 * - `get(platform)`：入站统一回调路由（POST /hooks/connector/:platform/:token）按
 *   platform 段查找连接器；
 * - `bridgeDrivers()`：出站 ChatBridgeDriver 视图（name = 平台名），由内核装配层
 *   注册进 ChannelRegistry（registerChatBridgeDriver），与既有 webhook/email 桥并存。
 *
 * 出站投递目标 target 形状由各连接器 zod 定义（见 docs/chat-platforms.mdx 平台矩阵）；
 * iMessage 无运行时连接器（无官方 API，见文档「探索结论」），get('imessage') 为 undefined。
 */
import type { ChatBridgeDriver } from '../../channels/types.js';
import { createDingtalkConnector } from './dingtalk.js';
import { createFeishuConnector } from './feishu.js';
import { createSlackConnector } from './slack.js';
import { createTelegramConnector } from './telegram.js';
import { createWecomConnector } from './wecom.js';
import type { ConnectorPlatform, PlatformConnector, PlatformConnectorDeps } from './types.js';

/** createPlatformConnectors 产物的注册中心视图 */
export interface PlatformConnectorRegistry {
  /** 按平台名取连接器；未内置（如 'imessage'）返回 undefined */
  get(platform: string): PlatformConnector | undefined;
  /** 已内置平台名列表（字典序） */
  platforms(): string[];
  /** 出站桥驱动视图（name = 平台名），供 ChannelRegistry.registerChatBridgeDriver */
  bridgeDrivers(): ChatBridgeDriver[];
}

/** 创建全部内置平台连接器（telegram / slack / feishu / dingtalk / wecom） */
export function createPlatformConnectors(deps: PlatformConnectorDeps = {}): PlatformConnectorRegistry {
  const factories: Array<(d: PlatformConnectorDeps) => PlatformConnector> = [
    createTelegramConnector,
    createSlackConnector,
    createFeishuConnector,
    createDingtalkConnector,
    createWecomConnector,
  ];
  const connectors = factories.map((factory) => factory(deps));
  const byPlatform = new Map<ConnectorPlatform, PlatformConnector>(
    connectors.map((c) => [c.platform, c]),
  );

  return {
    get(platform: string): PlatformConnector | undefined {
      return byPlatform.get(platform as ConnectorPlatform);
    },
    platforms(): string[] {
      return [...byPlatform.keys()].sort();
    },
    bridgeDrivers(): ChatBridgeDriver[] {
      return connectors.map((c) => ({ name: c.platform, deliverOutbound: c.deliverOutbound }));
    },
  };
}

/**
 * 从频道 meta（`{ bridges: [{ driver, target }, …] }`）提取指定平台的出站目标。
 * meta 非（对象 + bridges 数组）或无该平台的配置项时返回 undefined
 * （与 core-services.bridgesFromMeta 同一规范化约定）。
 */
export function platformTargetFromMeta(meta: unknown, platform: string): unknown {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const bridges = (meta as Record<string, unknown>)['bridges'];
  if (!Array.isArray(bridges)) return undefined;
  for (const item of bridges) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (rec['driver'] === platform) return rec['target'];
  }
  return undefined;
}
