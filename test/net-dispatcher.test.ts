/**
 * network dispatcher — 出站网络基线安装契约。
 *
 * 真实网络行为（双栈回退）无法在 CI 断言，此处验证：安装幂等、安装后
 * node:dns 的默认解析序为 ipv4first（对双栈域名的出站连接不再首试 IPv6）。
 */
import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installNetworkDispatcher, isNetworkDispatcherInstalled, resetNetworkDispatcherForTest } from '../src/kernel/net/dispatcher.js';

describe('net/dispatcher', () => {
  let originalOrder: string;

  beforeEach(() => {
    originalOrder = dns.getDefaultResultOrder();
  });
  afterEach(() => {
    dns.setDefaultResultOrder(originalOrder);
    resetNetworkDispatcherForTest();
  });

  it('installNetworkDispatcher 幂等：重复调用不抛错且状态稳定', () => {
    installNetworkDispatcher();
    expect(() => installNetworkDispatcher()).not.toThrow();
    expect(isNetworkDispatcherInstalled()).toBe(true);
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });

  it('安装后 node:dns 默认解析序为 ipv4first（双栈环境 IPv6 挂死缓解）', () => {
    dns.setDefaultResultOrder('verbatim');
    installNetworkDispatcher();
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
  });
});
