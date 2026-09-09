/**
 * feishu（飞书/Lark 自建应用）平台连接器。
 *
 * 出站：target `{ appId, appSecret, receiveIdType?, receiveId }` →
 *   1) POST open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
 *      `{ app_id, app_secret }` → `{ code: 0, tenant_access_token, expire }`；
 *   2) POST open.feishu.cn/open-apis/im/v1/messages?receive_id_type=<t>
 *      （Bearer tenant_access_token）`{ receive_id, msg_type: 'text',
 *      content: JSON.stringify({ text }) }`。
 *   tenant_access_token 进程内缓存至过期前 5 分钟（key = appId+appSecret）。
 * 入站：飞书事件回调（`{ event: { message: { content }, sender } }`；content 为
 *   JSON 字符串，取 text 字段）；`url_verification` 握手（challenge 直回）由
 *   `parseFeishuChallenge` 承载、统一路由层在 parseInbound 之前处理。
 */
import { z } from 'zod';

import { err } from '../../errors/index.js';
import type { ChatMessagePayload } from '../../channels/types.js';
import type { ConnectorInboundRequest, PlatformConnector, PlatformConnectorDeps } from './types.js';
import { asRecord, contentToText, platformRejected, postJson } from './http.js';

/** 飞书开放平台根地址 */
const API_BASE = 'https://open.feishu.cn';
/** tenant_access_token 端点（自建应用 internal） */
const TOKEN_URL = `${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`;
/** 发消息端点（receive_id_type 经 query 指定） */
const MESSAGE_URL = `${API_BASE}/open-apis/im/v1/messages`;

/** token 过期前的提前刷新余量（毫秒）：过期前 5 分钟即视为失效 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** feishu target 契约（channels.meta.bridges[].target 的 feishu 分支） */
export interface FeishuTarget {
  appId: string;
  appSecret: string;
  /** receive_id 类型，缺省 'chat_id' */
  receiveIdType?: 'chat_id' | 'open_id' | 'union_id' | 'user_id' | 'email';
  receiveId: string;
}

const feishuTargetSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  receiveIdType: z.enum(['chat_id', 'open_id', 'union_id', 'user_id', 'email']).optional(),
  receiveId: z.string().min(1),
});

interface CachedToken {
  token: string;
  /** 失效时刻（UTC epoch ms；= 签发时 now + expire*1000 - 5min） */
  expiresAt: number;
}

/** feishu 连接器工厂（deps.fetchImpl/now 注入便于测试） */
export function createFeishuConnector(deps: PlatformConnectorDeps = {}): PlatformConnector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  /** 进程内 token 缓存：key = appId + '\n' + appSecret（同凭据共用一次获取） */
  const tokenCache = new Map<string, CachedToken>();

  /** 取 tenant_access_token：缓存未过期直接复用；否则重新获取并刷新缓存 */
  async function tenantAccessToken(cfg: FeishuTarget): Promise<string> {
    const cacheKey = `${cfg.appId}\n${cfg.appSecret}`;
    const cached = tokenCache.get(cacheKey);
    if (cached !== undefined && now() < cached.expiresAt) return cached.token;

    const res = await postJson({
      fetchImpl,
      platform: 'feishu',
      url: TOKEN_URL,
      body: { app_id: cfg.appId, app_secret: cfg.appSecret },
    });
    const body = asRecord(res.body);
    const token = body?.['tenant_access_token'];
    if (body?.['code'] !== 0 || typeof token !== 'string' || token === '') {
      const msg = typeof body?.['msg'] === 'string' ? body['msg'] : 'unknown error';
      platformRejected('feishu', TOKEN_URL, res.body, `tenant_access_token rejected: ${msg}`);
    }
    const expireSeconds = typeof body?.['expire'] === 'number' && body!['expire'] > 0 ? body!['expire'] : 3600;
    tokenCache.set(cacheKey, {
      token,
      expiresAt: now() + expireSeconds * 1000 - TOKEN_REFRESH_MARGIN_MS,
    });
    return token;
  }

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = feishuTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `feishu connector: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as FeishuTarget;
    const receiveIdType = cfg.receiveIdType ?? 'chat_id';
    const token = await tenantAccessToken(cfg);
    const url = `${MESSAGE_URL}?receive_id_type=${receiveIdType}`;
    const res = await postJson({
      fetchImpl,
      platform: 'feishu',
      url,
      headers: { authorization: `Bearer ${token}` },
      body: {
        receive_id: cfg.receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text: contentToText(message.content) }),
      },
    });
    const body = asRecord(res.body);
    if (body?.['code'] !== 0) {
      const msg = typeof body?.['msg'] === 'string' ? body['msg'] : 'unknown error';
      platformRejected('feishu', url, res.body, `im/v1/messages rejected: ${msg}`);
    }
  }

  function parseInbound(req: ConnectorInboundRequest) {
    const body = asRecord(req.body);
    const event = asRecord(body?.['event']);
    const message = asRecord(event?.['message']);
    // content 为 JSON 字符串（如 '{"text":"hello"}'）；损坏/非文本 → null
    const content = parseContent(message?.['content']);
    if (content === null || content.text.trim() === '') return null;
    const sender = asRecord(event?.['sender']);
    const senderId = asRecord(sender?.['sender_id']);
    const senderName =
      firstString(senderId?.['open_id'], senderId?.['user_id'], senderId?.['union_id']) ?? undefined;
    return {
      text: content.text,
      senderName,
      meta: {
        chatId: message?.['chat_id'],
        messageId: message?.['message_id'],
        messageType: message?.['message_type'],
      },
    };
  }

  return { platform: 'feishu', deliverOutbound, parseInbound };
}

/**
 * 飞书 url_verification 握手：body `{ type: 'url_verification', challenge }` →
 * 返回 challenge（统一路由层直回 `{ challenge }`）；非握手请求返回 null。
 */
export function parseFeishuChallenge(body: unknown): string | null {
  const rec = asRecord(body);
  if (rec?.['type'] !== 'url_verification') return null;
  const challenge = rec['challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
}

/** 解析 content（JSON 字符串或已是对象）→ `{ text }`；不可解析/缺 text 返回 null */
function parseContent(content: unknown): { text: string } | null {
  let value: unknown = content;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  const rec = asRecord(value);
  const text = rec?.['text'];
  return typeof text === 'string' ? { text } : null;
}

/** 返回首个非空字符串 */
function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}
