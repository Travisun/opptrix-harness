/**
 * 渠道驱动统一契约 — Notification 与 Chat 共用同一注册中心（见 ./registry.ts）。
 *
 * 语义速览：
 * - NotificationDriver：单向通知投递（站内信/邮件/webhook 等），由通知中心调用；
 * - ChatBridgeDriver：双向聊天桥的外发方向（Slack/飞书/webhook 等），入站方向由
 *   各桥自行以 webhook 形式接入内核 HTTP，不经本契约；
 * - 两者都只做"投递"，目标渠道的连接参数（url/token/secret…）由调用方传入
 *   ChannelTargetConfig，各驱动自行 zod 校验（内核不做统一 schema）；
 * - signedPost 是供各驱动复用的通用投递助手：HMAC 签名头 + 超时 + 指数退避重试。
 */
import { createHmac } from 'node:crypto';
import { err } from '../errors/index.js';

/** 通知级别（通知中心与 UI 渲染共用） */
export type ChannelLevel = 'info' | 'success' | 'warn' | 'error';

/** 通知投递载荷（NotificationDriver.deliver 的输入） */
export interface NotificationPayload {
  /** 通知唯一 ID（notifications 表主键，幂等投递依据） */
  id: string;
  /** 通知级别 */
  level: ChannelLevel;
  /** 标题（单行摘要） */
  title: string;
  /** 正文（纯文本；富文本由 data 承载） */
  body: string;
  /** 结构化扩展数据（形状由业务方与驱动约定，驱动自行校验） */
  data?: unknown;
  /** 创建时间（UTC epoch ms） */
  createdAt: number;
}

/** 聊天消息载荷（ChatBridgeDriver.deliverOutbound 的输入；入站消息同形复用） */
export interface ChatMessagePayload {
  /** 消息唯一 ID */
  id: string;
  /** 内核渠道 ID（channels 表主键） */
  channelId: string;
  /** 内核渠道 slug（唯一短名，便于日志与桥路由） */
  channelSlug: string;
  /** 发送方类型：用户 / 扩展 / webhook */
  senderType: 'user' | 'ext' | 'webhook';
  /** 发送方标识（用户 ID / 扩展名 / webhook 名） */
  senderId: string;
  /** 消息内容（文本或结构化块，形状由桥与业务方约定） */
  content: unknown;
  /** 附件列表（形状由桥约定；无附件可省略） */
  attachments?: unknown;
  /** 创建时间（UTC epoch ms） */
  createdAt: number;
}

/**
 * 渠道目标配置：一次投递所需的连接参数（如 { url, secret }）。
 * 内核不做统一 schema —— 各驱动在 deliver 入口自行 zod 校验并给出可操作错误。
 */
export interface ChannelTargetConfig {
  readonly [key: string]: unknown;
}

/** 一次投递助手调用的结果；驱动抛错时由错误通道承载，不落入本结果 */
export interface DeliveryResult {
  /** 是否 2xx 成功 */
  ok: boolean;
  /** 全程耗时（含重试与退避，毫秒） */
  durationMs: number;
  /** 失败摘要（最终成功时省略） */
  error?: string;
}

/** 通知渠道驱动：把 NotificationPayload 投递到目标渠道 */
export interface NotificationDriver {
  /** 驱动名（注册中心主键，如 'webhook' / 'smtp'） */
  name: string;
  /** 投递一条通知；失败抛 HarnessError（DELIVERY_FAILED 等），不得静默吞错 */
  deliver(payload: NotificationPayload, target: ChannelTargetConfig): Promise<void>;
}

/** 聊天桥驱动：把 ChatMessagePayload 外发到外部 IM / webhook */
export interface ChatBridgeDriver {
  /** 驱动名（注册中心主键，如 'slack' / 'feishu'） */
  name: string;
  /** 外发一条消息；失败抛 HarnessError（DELIVERY_FAILED 等），不得静默吞错 */
  deliverOutbound(message: ChatMessagePayload, target: ChannelTargetConfig): Promise<void>;
}

/** signedPost 选项 */
export interface SignedPostOptions {
  /** 目标 URL（完整 http(s) 地址） */
  url: string;
  /** 请求体（任意可 JSON 序列化值；以 JSON.stringify 后的原文发送与签名） */
  body: unknown;
  /** HMAC 共享密钥；提供时附加 x-harness-timestamp / x-harness-signature 头 */
  secret?: string;
  /** 单次尝试超时（毫秒），默认 10000；到时中止本次请求并计入重试 */
  timeoutMs?: number;
  /** 首次失败后的重试次数，默认 3（指数退避 500ms/1s/2s…） */
  retries?: number;
  /** 附加请求头（覆盖默认头，如自定义 content-type） */
  headers?: Record<string, string>;
}

/** 单次尝试默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 默认重试次数（不含首次尝试；总尝试 = retries + 1） */
const DEFAULT_RETRIES = 3;

/** 指数退避基准（毫秒）：第 n 次重试前等待 500 * 2^(n-1) → 500/1s/2s… */
const BACKOFF_BASE_MS = 500;

/** 签名请求头名（接收方按同名头取时间戳与签名验签） */
const TIMESTAMP_HEADER = 'x-harness-timestamp';
const SIGNATURE_HEADER = 'x-harness-signature';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 通用投递助手：带 HMAC 签名头的 POST，超时 + 指数退避重试。
 *
 * - 签名（secret 提供时）：`x-harness-signature: hex(hmac_sha256(secret, timestamp + '.' + rawBody))`，
 *   配套 `x-harness-timestamp`（epoch ms 十进制字符串）；每次尝试重新取时间戳重算，
 *   保证重试期间签名不过期；接收方自行校验时间戳新鲜度。
 * - 判定：2xx 即成功返回 { ok: true, durationMs }；非 2xx 与网络/超时错误同视为
 *   失败，按 retries（默认 3）指数退避重试（500ms/1s/2s…）。
 * - 最终失败：抛 HarnessError(DELIVERY_FAILED)，detail 含
 *   { url, status, error, durationMs, attempts } 供上层告警与日志定位。
 *
 * @throws HarnessError(DELIVERY_FAILED) 全部尝试失败后
 */
export async function signedPost(opts: SignedPostOptions): Promise<DeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const rawBody = JSON.stringify(opts.body);
  // 默认头在前，调用方 headers 可覆盖（如自定义 content-type）
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...opts.headers,
  };

  const start = performance.now();
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));

    const headers = { ...baseHeaders };
    if (opts.secret !== undefined) {
      const timestamp = Date.now().toString();
      headers[TIMESTAMP_HEADER] = timestamp;
      headers[SIGNATURE_HEADER] = createHmac('sha256', opts.secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true, durationMs: Math.round(performance.now() - start) };
      }
      lastError = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      // 排空 body 释放连接回池；失败不影响结果判定
      await res.arrayBuffer().catch(() => undefined);
    } catch (e) {
      if (controller.signal.aborted) {
        lastError = `timeout after ${timeoutMs}ms`;
      } else {
        lastError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw err('DELIVERY_FAILED', {
    message: `channel delivery failed after ${retries + 1} attempt(s) to ${opts.url}: ${lastError ?? 'unknown error'}`,
    detail: {
      url: opts.url,
      status: lastStatus,
      error: lastError,
      durationMs: Math.round(performance.now() - start),
      attempts: retries + 1,
    },
  });
}
