/**
 * dingtalk（钉钉群机器人自定义 webhook）平台连接器。
 *
 * 出站：target `{ webhook, secret? }` →
 *   POST webhook `{ msgtype: 'text', text: { content } }`；配置 `secret`
 *   （安全设置=加签）时按钉钉规则加签：
 *   `sign = base64(hmac_sha256(secret, "<timestamp>\n<secret>"))`，
 *   追加 query `&timestamp=<epoch ms>&sign=<urlencoded>`（webhook 已含
 *   access_token query，故用 `&` 拼接）；平台业务失败 = 响应 `{ errcode != 0 }`。
 * 入站：v1 不做 —— 钉钉机器人接收侧为 Stream 模式（需长连接 SDK）或企业内部
 *   应用回调，非简单 HTTP 回调；`parseInbound` 恒返回 null（路由 202 ignored），
 *   入站方向留待后续版本（见 docs/chat-platforms.mdx 平台矩阵）。
 */
import { createHmac } from 'node:crypto';

import { z } from 'zod';

import { err } from '../../errors/index.js';
import type { ChatMessagePayload } from '../../channels/types.js';
import type { ConnectorInboundRequest, PlatformConnector, PlatformConnectorDeps } from './types.js';
import { asRecord, contentToText, platformRejected, postJson } from './http.js';

/** dingtalk target 契约（channels.meta.bridges[].target 的 dingtalk 分支） */
export interface DingtalkTarget {
  /** 群机器人 webhook 地址（含 access_token query） */
  webhook: string;
  /** 加签密钥（安全设置=加签时的 SEC… secret；缺省 = 安全设置为自定义关键词/IP 白名单） */
  secret?: string;
}

const dingtalkTargetSchema = z.object({
  webhook: z.url(),
  secret: z.string().min(1).optional(),
});

/** dingtalk 连接器工厂（deps.fetchImpl 注入便于测试） */
export function createDingtalkConnector(deps: PlatformConnectorDeps = {}): PlatformConnector {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = dingtalkTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `dingtalk connector: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as DingtalkTarget;
    const url = signedWebhookUrl(cfg);
    const res = await postJson({
      fetchImpl,
      platform: 'dingtalk',
      url,
      body: { msgtype: 'text', text: { content: contentToText(message.content) } },
    });
    const body = asRecord(res.body);
    if (body?.['errcode'] !== 0) {
      const errmsg = typeof body?.['errmsg'] === 'string' ? body['errmsg'] : 'unknown error';
      platformRejected('dingtalk', url, res.body, `webhook rejected: ${errmsg}`);
    }
  }

  function parseInbound(_req: ConnectorInboundRequest): null {
    // v1 不做入站：钉钉接收侧为 Stream 模式（见模块头注释），无简单 HTTP 回调可解析
    return null;
  }

  return { platform: 'dingtalk', deliverOutbound, parseInbound };
}

/** 计算加签后的 webhook URL：secret 缺省原样返回；否则追加 timestamp/sign query */
export function signedWebhookUrl(cfg: DingtalkTarget, timestamp = Date.now()): string {
  if (cfg.secret === undefined) return cfg.webhook;
  const stringToSign = `${timestamp}\n${cfg.secret}`;
  const sign = createHmac('sha256', cfg.secret).update(stringToSign, 'utf8').digest('base64');
  const sep = cfg.webhook.includes('?') ? '&' : '?';
  return `${cfg.webhook}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
}
