/**
 * Email Chat Bridge：把出站聊天消息渲染为纯文本邮件并经 SMTP 投递。
 *
 * - target 契约（zod 校验，非法即 DELIVERY_FAILED）：
 *   `{ to, from, smtp: { host, port?, secure?, user?, passSecretRef? } }`；
 *   `passSecretRef` 经 deps.resolveSecret 解析为 SMTP 密码明文（不入日志）。
 * - 默认 transport 为 nodemailer.createTransport；deps.transportFactory 可注入 mock。
 * - 正文为纯文本：含频道 / 发送者 / 时间 / 内容与 payload JSON 摘要。
 * - 任何失败（target 非法、密钥解析失败、SMTP 出错）一律抛 DELIVERY_FAILED（HARNESS-701）。
 */
import nodemailer from 'nodemailer';
import { z } from 'zod';

import { err } from '../../errors/HarnessError.js';
import type { ChatBridgeDriver } from '../../channels/types.js';
import type { ChatMessagePayload } from '../../channels/types.js';

/** secure=true 且未显式给 port 时的 SMTPS 端口 */
const SMTPS_DEFAULT_PORT = 465;
/** 默认 SMTP 端口（STARTTLS 常用） */
const SMTP_DEFAULT_PORT = 587;
/** 正文与 JSON 摘要的分隔标记（稳定契约，供下游/测试解析） */
const PAYLOAD_MARKER = '--- payload (JSON) ---';

/** 最小传输接口：nodemailer Transporter 结构性兼容；测试可注入 mock */
export interface EmailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** 传输工厂入参（SMTP 连接参数 + 已解析凭据） */
export interface EmailTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

/** 依赖注入 */
export interface EmailBridgeDeps {
  /** 按 ref 名解析密钥明文；返回 undefined/空串视为解析失败（DELIVERY_FAILED） */
  resolveSecret?: (ref: string) => string | undefined | Promise<string | undefined>;
  /** 传输工厂；默认 nodemailer.createTransport */
  transportFactory?: (opts: EmailTransportOptions) => EmailTransport;
}

/** email target 契约（channels.meta.bridges[].target 的 email 分支） */
export interface EmailBridgeTarget {
  to: string;
  from: string;
  smtp: {
    host: string;
    port?: number;
    secure?: boolean;
    user?: string;
    passSecretRef?: string;
  };
}

const emailTargetSchema = z.object({
  to: z.email(),
  from: z.string().min(1),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).optional(),
    passSecretRef: z.string().min(1).optional(),
  }),
});

/**
 * 创建 email 桥驱动（name 'email'）。
 *
 * @example
 * registry.registerChatBridgeDriver(createEmailBridge({ resolveSecret: (ref) => secrets.get(ref) }));
 */
export function createEmailBridge(deps?: EmailBridgeDeps): ChatBridgeDriver {
  const transportFactory =
    deps?.transportFactory ??
    ((opts: EmailTransportOptions) =>
      nodemailer.createTransport({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        ...(opts.auth ? { auth: opts.auth } : {}),
      }));

  async function deliverOutbound(message: ChatMessagePayload, target: unknown): Promise<void> {
    const parsed = emailTargetSchema.safeParse(target);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw err('DELIVERY_FAILED', {
        message: `email bridge: invalid target config (${first?.path.join('.') || 'target'}: ${first?.message || 'validation failed'})`,
        detail: parsed.error.issues,
      });
    }
    const cfg = parsed.data as EmailBridgeTarget;

    const pass = await resolveSmtpPass(cfg, deps);
    const transport = transportFactory({
      host: cfg.smtp.host,
      port: cfg.smtp.port ?? (cfg.smtp.secure === true ? SMTPS_DEFAULT_PORT : SMTP_DEFAULT_PORT),
      secure: cfg.smtp.secure ?? false,
      auth: cfg.smtp.user !== undefined && pass !== undefined ? { user: cfg.smtp.user, pass } : undefined,
    });

    try {
      await transport.sendMail({
        from: cfg.from,
        to: cfg.to,
        subject: subjectOf(message),
        text: renderTextBody(message),
      });
    } catch (e) {
      throw err('DELIVERY_FAILED', {
        message: `email bridge: delivery to ${cfg.to} via ${cfg.smtp.host} failed: ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      });
    }
  }

  return { name: 'email', deliverOutbound };
}

/** 解析 SMTP 密码：配置了 passSecretRef 时必须解析出非空明文，否则 DELIVERY_FAILED */
async function resolveSmtpPass(
  cfg: EmailBridgeTarget,
  deps?: EmailBridgeDeps,
): Promise<string | undefined> {
  const ref = cfg.smtp.passSecretRef;
  if (ref === undefined) return undefined;
  const resolveSecret = deps?.resolveSecret;
  if (!resolveSecret) {
    throw err('DELIVERY_FAILED', {
      message: `email bridge: smtp.passSecretRef "${ref}" configured but no resolveSecret dep provided`,
    });
  }
  const resolved = await resolveSecret(ref);
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw err('DELIVERY_FAILED', {
      message: `email bridge: secret "${ref}" could not be resolved (missing or empty)`,
    });
  }
  return resolved;
}

/** 邮件主题：`[<channel>] new chat message from <senderType>/<senderId>` */
function subjectOf(message: ChatMessagePayload): string {
  return `[${message.channelSlug}] new chat message from ${message.senderType}/${message.senderId}`;
}

/** 纯文本正文：频道 / 发送者 / 时间 / 内容 + payload JSON 摘要 */
function renderTextBody(message: ChatMessagePayload): string {
  const contentText = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) ?? '';
  const payload = {
    channel: message.channelSlug,
    senderType: message.senderType,
    senderId: message.senderId,
    content: message.content,
    createdAt: message.createdAt,
  };
  return [
    `New chat message in channel "${message.channelSlug}".`,
    '',
    `Sender: ${message.senderType}/${message.senderId}`,
    `Time:   ${String(message.createdAt)}`,
    '',
    contentText,
    '',
    PAYLOAD_MARKER,
    JSON.stringify(payload, null, 2),
    '',
  ].join('\n');
}
