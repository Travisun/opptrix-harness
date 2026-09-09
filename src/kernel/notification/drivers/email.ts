/**
 * email — SMTP 邮件通知驱动（NotificationDriver 契约实现）。
 *
 * target（渠道路由里的 target 字段，经 zod 校验）：
 * - smtp.host 必填；port 缺省 587；secure 缺省 false
 * - smtp.user + smtp.passSecretRef（secrets 引用，明文密码永不入配置）共同决定 SMTP auth；
 *   passSecretRef 经 deps.resolveSecret 解析，解析失败/无解析器时省略 auth
 * - from 发件人；to 单地址或多收件人数组（sendMail 时 join(',')）
 * - subjectPrefix 可选主题前缀
 *
 * 失败重试：sendMail 失败由 NotificationManager 的统一重试封装（retry.ts
 * withDeliveryRetry，指数退避）编排——email 缺省重试 2 次（退避 2s/4s），可经
 * settings 键 'notify.retry' 整体覆盖；本驱动每次 deliver 恰好一次 sendMail 尝试。
 *
 * 失败语义：target 非法 → VALIDATION_FAILED；解析密码/sendMail 任一环节失败 →
 * DELIVERY_FAILED（携带原始错误为 cause）。detail 只含 host/to 等非敏感字段。
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { NotificationDriver } from '../../channels/types.js';
import { err } from '../../errors/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** createEmailDriver 依赖集合（全部可选，便于最小装配与测试注入） */
export interface EmailDriverDeps {
  /** 密钥解析（kernel secrets）：passSecretRef → 明文密码；返回 null 视作未配置 */
  resolveSecret?: (ref: string) => Promise<string | null>;
  /** kernel logger（pino）；缺省时静默 */
  logger?: Logger;
  /** transport 工厂（默认 nodemailer.createTransport）；测试注入 mock 用 */
  transportFactory?: (opts: object) => Transporter;
}

// ---------------------------------------------------------------------------
// target zod schema
// ---------------------------------------------------------------------------

const emailTargetSchema = z.object({
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().min(1).optional(),
    passSecretRef: z.string().min(1).optional(),
  }),
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  subjectPrefix: z.string().optional(),
});

/** SMTP 端口缺省值（明文 587 / STARTTLS 惯例） */
const DEFAULT_SMTP_PORT = 587;

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 本地 HTML 转义（body 仅作为纯文本段落渲染，防注入） */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// 驱动工厂
// ---------------------------------------------------------------------------

/**
 * 创建 email 通知驱动（name: 'email'）。
 *
 * deliver(payload, target)：
 * 1. zod 校验 target（缺 smtp.host 等即抛 VALIDATION_FAILED，detail = issues）；
 * 2. target.smtp.passSecretRef 存在且有 resolveSecret 时解析 SMTP 密码；
 * 3. transportFactory（缺省 nodemailer.createTransport）按 {host, port, secure, auth?} 建 transport；
 * 4. sendMail({ from, to: join(','), subject: prefix+title, text: body,
 *    html: '<p>转义后的 body</p>', headers: { 'X-Harness-Notification-Id': payload.id } })；
 * 5. 任一环节失败抛 DELIVERY_FAILED（原始错误挂 cause）。
 */
export function createEmailDriver(deps: EmailDriverDeps = {}): NotificationDriver {
  const factory = deps.transportFactory ?? ((opts: object) => createTransport(opts));

  return {
    name: 'email',

    deliver: async (payload, target) => {
      const parsed = emailTargetSchema.safeParse(target);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'email driver target invalid (require smtp.host / from / to)',
          detail: parsed.error.issues,
        });
      }
      const targetValue = parsed.data;

      // 密码解析：仅 passSecretRef 存在且有解析器时进行；失败统一按投递失败处理
      let pass: string | null = null;
      if (targetValue.smtp.passSecretRef !== undefined) {
        if (deps.resolveSecret === undefined) {
          deps.logger?.warn(
            { secretRef: targetValue.smtp.passSecretRef },
            '[email-driver] passSecretRef set but no resolveSecret provided; SMTP auth omitted',
          );
        } else {
          try {
            pass = await deps.resolveSecret(targetValue.smtp.passSecretRef);
          } catch (e) {
            throw err('DELIVERY_FAILED', {
              message: `email driver failed to resolve smtp secret "${targetValue.smtp.passSecretRef}"`,
              detail: { host: targetValue.smtp.host, to: targetValue.to },
              cause: e,
            });
          }
        }
      }

      const transport = factory({
        host: targetValue.smtp.host,
        port: targetValue.smtp.port ?? DEFAULT_SMTP_PORT,
        secure: targetValue.smtp.secure ?? false,
        // user 与已解析密码齐备才附 auth，避免半配置触发 nodemailer 运行时错误
        ...(targetValue.smtp.user !== undefined && pass !== null
          ? { auth: { user: targetValue.smtp.user, pass } }
          : {}),
      });

      const toList = Array.isArray(targetValue.to) ? targetValue.to : [targetValue.to];
      const title = payload.title ?? '';
      const body = payload.body ?? '';

      try {
        await transport.sendMail({
          from: targetValue.from,
          to: toList.join(','),
          subject: `${targetValue.subjectPrefix ?? ''}${title}`,
          text: body,
          html: `<p>${escapeHtml(body)}</p>`,
          headers: { 'X-Harness-Notification-Id': payload.id },
        });
      } catch (e) {
        throw err('DELIVERY_FAILED', {
          message: `email delivery failed via smtp://${targetValue.smtp.host}`,
          detail: { host: targetValue.smtp.host, to: toList },
          cause: e,
        });
      }
    },
  } satisfies NotificationDriver;
}
