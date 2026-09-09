/**
 * telegram 平台连接器（参考实现）。
 *
 * 出站：target `{ botToken, chatId, secretToken? }` →
 *   POST https://api.telegram.org/bot<botToken>/sendMessage `{ chat_id, text }`
 *   （botToken 在 URL path；平台业务失败 = 响应 `{ ok: false, description }`）。
 * 入站：Telegram webhook update（`{ message: { text, from: { first_name } } }`）；
 *   可选 `secretToken` 校验：设置 webhook 时传入的 secret_token 会由 Telegram 原样
 *   回传在 `X-Telegram-Bot-Api-Secret-Token` 头（timing-safe 比较）；未配置
 *   secretToken 时仅凭 URL 中的频道令牌鉴权。
 */
import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { err } from '../../errors/index.js';
import type { ChatMessagePayload } from '../../channels/types.js';
import type { ConnectorInboundRequest, PlatformConnector, PlatformConnectorDeps } from './types.js';
import { asRecord, contentToText, headerValue, platformRejected, postJson } from './http.js';

/** Telegram Bot API 根地址 */
const API_BASE = 'https://api.telegram.org';

/** Telegram 回传 secret_token 的请求头（fastify 头为小写键） */
export const TELEGRAM_SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

/** telegram target 契约（channels.meta.bridges[].target 的 telegram 分支） */
export interface TelegramTarget {
  botToken: string;
  /** 目标 chat（群为负数，故允许 number） */
  chatId: string | number;
  /** 设置 webhook 时下发的 secret_token（入站头校验用；缺省 = 仅 URL 令牌鉴权） */
  secretToken?: string;
}

const telegramTargetSchema = z.object({
  botToken: z.string().min(1),
  chatId: z.union([z.string().min(1), z.number()]),
  secretToken: z.string().min(1).optional(),
});

/** telegram 连接器工厂（deps.fetchImpl 注入便于测试） */
export function createTelegramConnector(deps: PlatformConnectorDeps = {}): PlatformConnector {
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = telegramTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `telegram connector: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as TelegramTarget;
    const url = `${API_BASE}/bot${cfg.botToken}/sendMessage`;
    const res = await postJson({
      fetchImpl,
      platform: 'telegram',
      url,
      body: { chat_id: cfg.chatId, text: contentToText(message.content) },
    });
    const body = asRecord(res.body);
    if (body?.['ok'] !== true) {
      const description = typeof body?.['description'] === 'string' ? body['description'] : 'unknown error';
      platformRejected('telegram', url, res.body, `sendMessage rejected: ${description}`);
    }
  }

  function verifyInbound(req: ConnectorInboundRequest, target?: unknown): boolean {
    const parsed = telegramTargetSchema.safeParse(target);
    const expected = parsed.success ? (parsed.data as TelegramTarget).secretToken : undefined;
    if (expected === undefined) return true;
    const received = headerValue(req.headers, TELEGRAM_SECRET_TOKEN_HEADER);
    if (received === undefined) return false;
    return timingSafeStringEqual(received, expected);
  }

  function parseInbound(req: ConnectorInboundRequest) {
    const body = asRecord(req.body);
    const message = asRecord(body?.['message']);
    const text = message?.['text'];
    if (typeof text !== 'string' || text.trim() === '') return null;
    const from = asRecord(message?.['from']);
    const firstName = from?.['first_name'];
    const username = from?.['username'];
    const chat = asRecord(message?.['chat']);
    return {
      text,
      senderName: typeof firstName === 'string' && firstName !== ''
        ? firstName
        : typeof username === 'string' && username !== ''
          ? username
          : undefined,
      meta: {
        updateId: body?.['update_id'],
        chatId: chat?.['id'],
        messageId: message?.['message_id'],
      },
    };
  }

  return { platform: 'telegram', deliverOutbound, verifyInbound, parseInbound };
}

/** timing-safe 字符串比较（长度不等直接 false，避免不同长度下抛错） */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
