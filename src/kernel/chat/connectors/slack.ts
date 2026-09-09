/**
 * slack 平台连接器。
 *
 * 出站：target `{ botToken, channel }` →
 *   POST https://slack.com/api/chat.postMessage（Authorization: Bearer <botToken>）
 *   `{ channel, text }`；平台业务失败 = 响应 `{ ok: false, error }`。
 * 入站：Slack Events API（`{ type: 'event_callback', event: { type: 'message', text, user } }`）；
 *   跳过带 `bot_id` 的消息（本应用自己发出的消息，防回声循环）与带 `subtype` 的
 *   派生事件（message_changed / channel_join 等）。
 */
import { z } from 'zod';

import { err } from '../../errors/index.js';
import type { ChatMessagePayload } from '../../channels/types.js';
import type { ConnectorInboundRequest, PlatformConnector, PlatformConnectorDeps } from './types.js';
import { asRecord, contentToText, platformRejected, postJson } from './http.js';

/** Slack Web API chat.postMessage 端点 */
const CHAT_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/** slack target 契约（channels.meta.bridges[].target 的 slack 分支） */
export interface SlackTarget {
  /** Bot User OAuth Token（xoxb-…） */
  botToken: string;
  /** 目标频道 ID（C…）或频道名 */
  channel: string;
}

const slackTargetSchema = z.object({
  botToken: z.string().min(1),
  channel: z.string().min(1),
});

/** slack 连接器工厂（deps.fetchImpl 注入便于测试） */
export function createSlackConnector(deps: PlatformConnectorDeps = {}): PlatformConnector {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = slackTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `slack connector: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as SlackTarget;
    const res = await postJson({
      fetchImpl,
      platform: 'slack',
      url: CHAT_POST_MESSAGE_URL,
      headers: { authorization: `Bearer ${cfg.botToken}` },
      body: { channel: cfg.channel, text: contentToText(message.content) },
    });
    const body = asRecord(res.body);
    if (body?.['ok'] !== true) {
      const error = typeof body?.['error'] === 'string' ? body['error'] : 'unknown error';
      platformRejected('slack', CHAT_POST_MESSAGE_URL, res.body, `chat.postMessage rejected: ${error}`);
    }
  }

  function parseInbound(req: ConnectorInboundRequest) {
    const body = asRecord(req.body);
    const event = asRecord(body?.['event']);
    if (event?.['type'] !== 'message') return null;
    // 防回声循环：本应用经 chat.postMessage 发出的消息带 bot_id，一律跳过
    if (typeof event['bot_id'] === 'string' && event['bot_id'] !== '') return null;
    // 派生事件（message_changed/message_deleted/…）与子类型消息不作为新消息入库
    if (typeof event['subtype'] === 'string' && event['subtype'] !== '') return null;
    const text = event['text'];
    if (typeof text !== 'string' || text.trim() === '') return null;
    const user = event['user'];
    return {
      text,
      senderName: typeof user === 'string' && user !== '' ? user : undefined,
      meta: {
        channel: event['channel'],
        ts: event['ts'],
        teamId: body?.['team_id'],
      },
    };
  }

  return { platform: 'slack', deliverOutbound, parseInbound };
}
