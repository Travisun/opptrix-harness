/**
 * ChannelRegistry — 渠道驱动注册中心（Notification 与 Chat 共用）。
 *
 * 语义速览：
 * - 通知驱动与聊天桥驱动分两张表登记，同名互不干扰；
 * - 同名重复注册 = 覆盖（后注册者生效），不报错（支持驱动热替换）；
 * - list 输出为去重排序后的驱动名（Map key 本就唯一，排序保证输出稳定）；
 * - get 未命中返回 undefined（DELIVERY_DRIVER_NOT_FOUND 由上层服务判定抛出，
 *   注册中心保持查询语义纯净）；
 * - 编程性误用（驱动缺 name / name 非非空字符串）fail-fast 抛
 *   HarnessError(INTERNAL)，message 以 [channels] 前缀定位。
 */
import { err } from '../errors/index.js';
import type { ChatBridgeDriver, NotificationDriver } from './types.js';

export class ChannelRegistry {
  /** 驱动名 -> 通知驱动 */
  #notificationDrivers = new Map<string, NotificationDriver>();

  /** 驱动名 -> 聊天桥驱动 */
  #chatBridgeDrivers = new Map<string, ChatBridgeDriver>();

  /** 注册（或覆盖同名）通知驱动 */
  registerNotificationDriver(d: NotificationDriver): void {
    this.#assertName(d?.name, 'registerNotificationDriver()');
    this.#notificationDrivers.set(d.name, d);
  }

  /** 注册（或覆盖同名）聊天桥驱动 */
  registerChatBridgeDriver(d: ChatBridgeDriver): void {
    this.#assertName(d?.name, 'registerChatBridgeDriver()');
    this.#chatBridgeDrivers.set(d.name, d);
  }

  /** 按名取通知驱动；未注册返回 undefined */
  getNotificationDriver(name: string): NotificationDriver | undefined {
    return this.#notificationDrivers.get(name);
  }

  /** 按名取聊天桥驱动；未注册返回 undefined */
  getChatBridgeDriver(name: string): ChatBridgeDriver | undefined {
    return this.#chatBridgeDrivers.get(name);
  }

  /** 已注册通知驱动名列表（去重、字典序） */
  listNotificationDrivers(): string[] {
    return [...this.#notificationDrivers.keys()].sort();
  }

  /** 已注册聊天桥驱动名列表（去重、字典序） */
  listChatBridgeDrivers(): string[] {
    return [...this.#chatBridgeDrivers.keys()].sort();
  }

  /** name 必须是非空字符串（fail-fast，编程性误用） */
  #assertName(name: unknown, api: string): void {
    if (typeof name !== 'string' || name === '') {
      throw err('INTERNAL', { message: `[channels] ${api}: driver.name 必须是非空字符串（收到 ${typeof name}）` });
    }
  }
}
