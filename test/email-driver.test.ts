/**
 * email 通知驱动单测（transportFactory 注入 nodemailer mock，不发真实 SMTP）。
 *
 * 覆盖：name 契约、sendMail 参数（subject 前缀/text/html/to/headers）、
 * passSecretRef 解析（注入 auth）、无密码时省略 auth、target zod 校验
 * （缺 host → VALIDATION_FAILED）、sendMail/resolveSecret 失败 → DELIVERY_FAILED、
 * 多收件人 join(',')、html 转义（<script> 被转义）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Transporter } from 'nodemailer';

import { createEmailDriver, type EmailDriverDeps } from '../src/kernel/notification/drivers/email.js';

/** deliver 的 payload（NotificationDriver 契约字段的最小集） */
const PAYLOAD = {
  id: 'ntf-0001',
  title: 'Backup finished',
  body: 'All 12 jobs succeeded',
  level: 'info',
  data: null,
};

const BASE_TARGET = {
  smtp: { host: 'smtp.example.com' },
  from: 'harness@example.com',
  to: 'ops@example.com',
};

/** 组装被测驱动：mock transport 工厂 + 可覆盖的 deps */
function makeDriver(depsOverrides: Partial<EmailDriverDeps> = {}) {
  const sendMail = vi.fn(async () => ({ messageId: '<mock@opptrix>' }));
  const transportFactory = vi.fn((opts: object) => ({ sendMail }) as unknown as Transporter);
  const driver = createEmailDriver({ transportFactory, ...depsOverrides });
  return { driver, sendMail, transportFactory };
}

describe('createEmailDriver — 契约与参数', () => {
  it('name 为 "email"（NotificationDriver 契约）', () => {
    const { driver } = makeDriver();
    expect(driver.name).toBe('email');
  });

  it('sendMail 收到完整参数：from/to/subject(含前缀)/text/html/headers', async () => {
    const { driver, sendMail } = makeDriver();
    await driver.deliver(PAYLOAD, {
      ...BASE_TARGET,
      subjectPrefix: '[Opptrix] ',
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'harness@example.com',
      to: 'ops@example.com',
      subject: '[Opptrix] Backup finished',
      text: 'All 12 jobs succeeded',
      html: '<p>All 12 jobs succeeded</p>',
      headers: { 'X-Harness-Notification-Id': 'ntf-0001' },
    });
  });

  it('无 subjectPrefix 时 subject 不带前缀；port 缺省 587、secure 缺省 false', async () => {
    const { driver, sendMail, transportFactory } = makeDriver();
    await driver.deliver(PAYLOAD, BASE_TARGET);
    const mail = sendMail.mock.calls[0]?.[0] as { subject: string };
    expect(mail.subject).toBe('Backup finished');
    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
    });
  });

  it('target 的 port/secure 显式值原样透传给 transport 工厂', async () => {
    const { driver, transportFactory } = makeDriver();
    await driver.deliver(PAYLOAD, {
      ...BASE_TARGET,
      smtp: { host: 'smtp.example.com', port: 465, secure: true },
    });
    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
    });
  });

  it('多收件人数组以逗号 join 后作为 to 传给 sendMail', async () => {
    const { driver, sendMail } = makeDriver();
    await driver.deliver(PAYLOAD, {
      ...BASE_TARGET,
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
    });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com,b@example.com,c@example.com' }));
  });

  it('html 正文对 < > & " \' 全量转义（<script> 注入被中和）', async () => {
    const { driver, sendMail } = makeDriver();
    await driver.deliver(
      { ...PAYLOAD, body: '<script>alert("x&y")</script>' },
      BASE_TARGET,
    );
    const mail = sendMail.mock.calls[0]?.[0] as { html: string; text: string };
    expect(mail.html).toBe(
      '<p>&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;</p>',
    );
    expect(mail.html).not.toContain('<script>');
    // text 保持原文（纯文本通道无需转义）
    expect(mail.text).toBe('<script>alert("x&y")</script>');
  });
});

describe('createEmailDriver — 密钥解析', () => {
  it('passSecretRef 经 resolveSecret 解析后与 user 一起注入 SMTP auth', async () => {
    const resolveSecret = vi.fn(async (ref: string) => (ref === 'smtp/ops' ? 's3cret-pass' : null));
    const { driver, transportFactory } = makeDriver({ resolveSecret });
    await driver.deliver(PAYLOAD, {
      ...BASE_TARGET,
      smtp: { host: 'smtp.example.com', user: 'ops@example.com', passSecretRef: 'smtp/ops' },
    });
    expect(resolveSecret).toHaveBeenCalledWith('smtp/ops');
    expect(transportFactory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'ops@example.com', pass: 's3cret-pass' },
    });
  });

  it('resolveSecret 返回 null（未配置）时不附 auth，也不失败', async () => {
    const { driver, transportFactory } = makeDriver({
      resolveSecret: async () => null,
    });
    await driver.deliver(PAYLOAD, {
      ...BASE_TARGET,
      smtp: { host: 'smtp.example.com', user: 'ops@example.com', passSecretRef: 'smtp/ops' },
    });
    const opts = transportFactory.mock.calls[0]?.[0] as { auth?: unknown };
    expect(opts.auth).toBeUndefined();
  });

  it('resolveSecret 抛错 → DELIVERY_FAILED（HARNESS-7001）', async () => {
    const { driver } = makeDriver({
      resolveSecret: async () => {
        throw new Error('secrets backend down');
      },
    });
    await expect(
      driver.deliver(PAYLOAD, {
        ...BASE_TARGET,
        smtp: { host: 'smtp.example.com', user: 'u', passSecretRef: 'smtp/ops' },
      }),
    ).rejects.toMatchObject({ name: 'HarnessError', code: 'HARNESS-7001', status: 502 });
  });
});

describe('createEmailDriver — 失败语义', () => {
  it('target 缺 smtp.host → VALIDATION_FAILED（HARNESS-1009，status 400）', async () => {
    const { driver, sendMail, transportFactory } = makeDriver();
    await expect(driver.deliver(PAYLOAD, { from: 'harness@example.com', to: 'ops@example.com' })).rejects.toMatchObject({
      name: 'HarnessError',
      code: 'HARNESS-1009',
      status: 400,
    });
    // 校验失败不应触碰 transport
    expect(transportFactory).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sendMail 抛错 → DELIVERY_FAILED（HARNESS-7001，cause 保留原始错误）', async () => {
    const boom = new Error('ECONNREFUSED');
    const sendMail = vi.fn(async () => {
      throw boom;
    });
    const driver = createEmailDriver({
      transportFactory: () => ({ sendMail }) as unknown as Transporter,
    });
    const err = await driver.deliver(PAYLOAD, BASE_TARGET).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'HarnessError', code: 'HARNESS-7001', status: 502 });
    expect((err as { cause?: unknown }).cause).toBe(boom);
    // detail 不含密码等敏感信息
    expect(JSON.stringify((err as { detail?: unknown }).detail)).not.toContain('s3cret');
  });

  it('deliver 正常完成时返回 undefined 且不抛（Promise<void>）', async () => {
    const { driver } = makeDriver();
    await expect(driver.deliver(PAYLOAD, BASE_TARGET)).resolves.toBeUndefined();
  });
});
