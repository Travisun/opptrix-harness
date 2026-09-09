/**
 * wecom（企业微信群机器人 webhook）平台连接器。
 *
 * 出站：target `{ webhook }` → POST webhook `{ msgtype: 'text', text: { content } }`；
 *   平台业务失败 = 响应 `{ errcode != 0 }`（errcode 0/errmsg 'ok' 为成功）。
 * 入站：v1 不做 —— 企业微信自建应用回调需要 AES 加解密 + msg_signature 校验
 *   （回调协议重，凭据面大），v1 仅做出站；`parseInbound` 恒返回 null
 *   （路由 202 ignored），入站方向留待后续版本（见 docs/chat-platforms.mdx）。
 */
import { z } from 'zod';

import { err } from '../../errors/index.js';
import type { ChatMessagePayload } from '../../channels/types.js';
import type { ConnectorInboundRequest, PlatformConnector, PlatformConnectorDeps } from './types.js';
import { asRecord, contentToText, platformRejected, postJson } from './http.js';

/** wecom target 契约（channels.meta.bridges[].target 的 wecom 分支） */
export interface WecomTarget {
  /** 群机器人 webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…） */
  webhook: string;
}

const wecomTargetSchema = z.object({
  webhook: z.url(),
});

/** wecom 连接器工厂（deps.fetchImpl 注入便于测试） */
export function createWecomConnector(deps: PlatformConnectorDeps = {}): PlatformConnector {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = wecomTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `wecom connector: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as WecomTarget;
    const res = await postJson({
      fetchImpl,
      platform: 'wecom',
      url: cfg.webhook,
      body: { msgtype: 'text', text: { content: contentToText(message.content) } },
    });
    const body = asRecord(res.body);
    if (body?.['errcode'] !== 0) {
      const errmsg = typeof body?.['errmsg'] === 'string' ? body['errmsg'] : 'unknown error';
      platformRejected('wecom', cfg.webhook, res.body, `webhook rejected: ${errmsg}`);
    }
  }

  function parseInbound(_req: ConnectorInboundRequest): null {
    // v1 不做入站：企业微信回调需 AES 解密 + msg_signature 校验（见模块头注释）
    return null;
  }

  return { platform: 'wecom', deliverOutbound, parseInbound };
}
