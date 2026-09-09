/**
 * NotificationManager — 通知中心编排器（入库 → SSE 发布 → 渠道投递）。
 *
 * send() 流程：
 * 1. zod 校验入参（level 缺省 'info'，body 缺省 ''，data 缺省 null）；
 * 2. hook `notification.beforeSend`（filter 链，可改写 title/body/level/data）；
 * 3. 生成 uuid → persist（channels 字段落"本次投递计划"JSON，secret 类字段脱敏为 '***'）；
 * 4. publish('notifications', 'notification.created', record)（SSE 实时推送，入库即 inbox）；
 * 5. 对投递计划逐个投递：registry.getNotificationDriver → deliver(payload, target)。
<<<<<<< Updated upstream
 *    投递计划 = 显式传入的 input.channels（优先）；未显式传入且注入了 getRoutes 时，
 *    读取默认路由规则（settings 'notify.routes'）按 level 匹配追加 channels。
 *    投递统一走指数退避重试（retry.ts 的 withDeliveryRetry）：口径按
 *    resolveChannelRetry 解析（settings 'notify.retry' 覆盖 > webhook target.retries >
 *    每驱动缺省表——webhook 3 次 500ms/1s/2s、email 2 次 2s/4s、其余不重试）；
 *    VALIDATION_FAILED 等不可重试错误（HarnessError.retryable=false）立即抛出不重试。
 *    单渠道失败**不抛出**：logger.error 记录 + 失败计数，deliver 前后计 duration（含重试）；
=======
 *    投递计划 = 显式传入的 input.channels（优先）；未显式传入时先读默认路由规则
 *    （settings 'notify.routes'，经 deps.getRoutes 注入）按 level 匹配追加 channels；
 *    路由也没有配置（未注入/无命中/读取失败）且注入了 deps.getChannelConfigs 时，
 *    自动回落为**全部启用的渠道配置**（多渠道管理：settings 'notify.channelConfigs'
 *    里 enabled=true 的 webhook/email/console 实例，driver=type、target=配置原值）——
 *    用户创建多个 webhook/email 后，所有通知自动分发到全部启用渠道。
 *    单渠道失败**不抛出**：logger.error 记录 + 失败计数，deliver 前后计 duration；
>>>>>>> Stashed changes
 *    未知驱动名同样跳过不抛；
 * 6. 每渠道结果经可选的 deps.recordDelivery 回调落投递流水（集成方写 deliveries 表，
 *    kind='notification'，target 脱敏摘要；同 chat 桥 DeliveryRecord 形状），随后把
 *    结果数组作为第二事件 publish('notifications', 'notification.delivered',
 *    { id, results })（仅当投递计划非空时发布）。
 *
 * 注意：`notification.beforeSend` 埋点名已收编进 HOOK_POINTS
 * （`src/kernel/hooks/points.ts` 的 `notificationBeforeSend`），本管理器经常量引用；
 * 本文件保留的 `NOTIFICATION_HOOK_POINTS` 常量仅为既有导出兼容（值同源）。
 */
import { randomUUID } from 'node:crypto';

import type {
  ChannelRegistry,
  ChannelTargetConfig,
  ChannelLevel,
  NotificationPayload,
} from '../channels/index.js';
import { err, HarnessError } from '../errors/index.js';
import type { Logger } from 'pino';
import { z } from 'zod';

import { HOOK_POINTS } from '../hooks/index.js';
<<<<<<< Updated upstream
import {
  normalizeRetryOverride,
  resolveChannelRetry,
  withDeliveryRetry,
  type DeliveryRetryConfig,
  type SleepFn,
} from './retry.js';
=======
import type { NotificationChannelConfig } from './channel-store.js';
import { parseChannelConfigs } from './channel-store.js';
>>>>>>> Stashed changes
import type { NotificationRecord, NotificationStore } from './store.js';

/** notification 域 hook 埋点（收编进 HOOK_POINTS 前的本地单一事实来源） */
export const NOTIFICATION_HOOK_POINTS = {
  /** send 入库/投递前：可改写 { title, body, level, data }（返回 undefined 视为不改写） */
  beforeSend: 'notification.beforeSend',
} as const;

/** SSE 主题名（notifications 域） */
const TOPIC = 'notifications';

/** 单渠道投递结果（channels 包 DeliveryResult 语义 + 驱动名） */
export interface ChannelDeliveryResult {
  /** 渠道驱动名 */
  driver: string;
  /** 是否成功（未知驱动名/抛错均为 false） */
  ok: boolean;
  /** deliver 前后耗时（毫秒，含统一重试的退避等待；未知驱动名为 0） */
  durationMs: number;
  /** 失败摘要（成功时省略） */
  error?: string;
}

/**
 * 投递流水条目（与 chat 桥 ChatBridgeDispatcher 的 DeliveryRecord 同形状；
 * 集成方写 deliveries 表：kind='notification'、channel=驱动名、created_at=写入时刻）。
 */
export interface NotificationDeliveryEntry {
  /** 渠道类型（本管理器固定 'notification'） */
  kind: string;
  /** 接收方标识（target 的脱敏 JSON 摘要；secret 类字段替换为 '***'） */
  target: string;
  /** 发送通道标识（本管理器 = 渠道驱动名） */
  channel: string;
  /** 是否成功 */
  ok: boolean;
  /** 投递耗时（毫秒，含重试退避；未知驱动名为 0） */
  durationMs?: number;
  /** 失败摘要（成功时省略） */
  error?: string;
}

/** 单个渠道投递目标（target 形状由各驱动自行 zod 校验） */
export interface NotificationChannel {
  /** 驱动名（registry 注册名，如 'inbox' / 'webhook' / 'email'） */
  driver: string;
  /** 驱动语义内的目标配置（如 { url, secret }） */
  target: unknown;
}

/** NotificationManager 依赖集合（结构化契约，测试可注入替身） */
export interface NotificationManagerDeps {
  /** 通知持久化存储 */
  store: NotificationStore;
  /** 渠道驱动注册中心（Notification 与 Chat 共用） */
  registry: ChannelRegistry;
  /** hook 链执行器（HookManager 结构契约）；send 前应用 beforeSend 埋点 */
  hooks: {
    apply(name: string, value: unknown, ctx?: { meta?: Record<string, unknown> }): Promise<unknown>;
  };
  /** 事件发布（SSE hub publish 契约）：fire-and-forget，同步返回 */
  publish(topic: string, event: string, data: unknown): void;
  /** kernel logger（pino）；仅记录渠道投递失败，密钥永不入日志 */
  logger: Logger;
  /**
   * 密钥解析（kernel secrets）。本管理器自身不消费（webhook 等驱动在装配期经
   * createWebhookDriver({ resolveSecret }) 注入同一来源）；保留在依赖契约中，
   * 供路由规则解析 target.secretRef 使用。
   */
  secrets?: { get(name: string): Promise<string | null> };
  /**
   * 默认渠道路由规则读取器（可选；集成方接 settings('notify.routes')，与
   * GET/PUT /api/v1/notifications/routes 同一落点）。提供后：send 未显式传入
   * channels 时按 level 匹配规则取投递计划（显式传入优先——input.channels 一经
   * 给出即不读路由）。规则读取失败/形状非法仅 warn 并忽略（通知入库不受影响）。
   */
  getRoutes?: () => Promise<unknown>;
  /**
<<<<<<< Updated upstream
   * 重试口径覆盖读取器（可选；集成方接 settings('notify.retry')）。返回值经
   * normalizeRetryOverride 校验：形状 {retries, baseMs} 合法即整体替代每驱动缺省
   * 口径（见 retry.ts）；未注入/读取失败/形状非法均回落默认，仅 warn 不阻断。
   */
  getRetry?: () => Promise<unknown>;
  /**
   * 投递流水回调（可选；集成方接 core-services 的 db('deliveries') 落库手法，
   * 同 chat 桥 dispatcher 的 recordDelivery）。每渠道投递结束（成功/失败/未知驱动）
   * 各回调一次，target 为脱敏摘要；回调同步抛错仅 warn，不影响投递结果。
   */
  recordDelivery?: (entry: NotificationDeliveryEntry) => void;
  /**
   * 等待实现（可选；缺省 setTimeout）。供统一重试的指数退避使用，测试注入
   * 记录器即可断言退避序列而无需真实等待。
   */
  sleep?: SleepFn;
=======
   * 渠道实例配置读取器（可选；集成方接 NotificationChannelStore.list()，settings
   * 'notify.channelConfigs'）。多渠道管理回落计划的数据源：send 未显式传入 channels
   * 且路由规则未命中任何投递渠道时，自动投递到**全部 enabled=true** 的渠道实例
   * （driver=type、target=配置原值，逐条经 parseChannelConfigs 校验、非法条目跳过）。
   * 读取失败/形状非法仅 warn 不阻断（通知照常入库）。
   */
  getChannelConfigs?: () => Promise<NotificationChannelConfig[]>;
>>>>>>> Stashed changes
}

/** send() 入参 */
export interface NotificationSendInput {
  /** 标题（单行摘要，必填） */
  title: string;
  /** 正文（纯文本；缺省 ''） */
  body?: string;
  /** 级别（缺省 'info'） */
  level?: ChannelLevel;
  /** 结构化附加数据（缺省 null） */
  data?: unknown;
  /** 渠道投递计划（缺省/空 = 只入库 + SSE，不外发） */
  channels?: NotificationChannel[];
}

/** 级别枚举（与 channels 包 ChannelLevel 一致） */
const levelSchema = z.enum(['info', 'success', 'warn', 'error']);

/** send 入参 zod schema（标题必填非空；target 形状留给各驱动自校验） */
const sendInputSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  level: levelSchema.optional(),
  data: z.unknown().optional(),
  channels: z
    .array(z.object({ driver: z.string().min(1), target: z.unknown() }))
    .optional(),
});

/**
 * hook 改写后的值形状校验：hook 只允许改写通知内容（title/body/level/data），
 * 渠道投递计划（channels）由调用方决定，hook 不可注入。
 */
const hookValueSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  level: levelSchema.optional(),
  data: z.unknown().optional(),
});

/**
 * 默认渠道路由规则（settings 'notify.routes' 的形状，与 REST routes API 的
 * routeRuleSchema 同形）：match.level 缺省 = 匹配全部级别。settings 属外部入参，
 * 读取后经 zod 校验才可使用；非法/缺失规则整体忽略（不阻断通知创建）。
 */
const routeRulesSchema = z
  .array(
    z.object({
      match: z.object({ level: z.string().min(1).optional() }).optional(),
      channels: z
        .array(z.object({ driver: z.string().min(1), target: z.unknown() }))
        .min(1)
        .max(16),
    }),
  )
  .max(100);

/** 持久化投递计划时需要脱敏的键（secretRef 是引用指针非凭据，不脱敏） */
const SECRET_KEY_PATTERN = /^(secret|password|token|api[-_]?key)$/i;

/** 脱敏递归深度上限（防循环引用；更深的部分原样保留） */
const REDACT_MAX_DEPTH = 4;

/**
 * 深度脱敏：把对象/数组中键名命中 SECRET_KEY_PATTERN 的字符串值替换为 '***'。
 * 仅用于落库与 SSE 的投递计划副本；驱动实际收到的仍是原始 target。
 */
function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth >= REDACT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) && typeof val === 'string' ? '***' : redactSecrets(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** 任意异常规整为可读摘要（logger/结果里的 error 字段；不携带堆栈） */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 统一重试的口径判定：HarnessError 按自身 retryable 标志（VALIDATION_FAILED 等
 * 配置类错误不重试），非 HarnessError（驱动内部裸抛的意外异常）按可重试处理。
 */
function isRetryableDeliveryError(e: unknown): boolean {
  return !(e instanceof HarnessError) || e.retryable;
}

/** target → 脱敏 JSON 摘要（投递流水用；secret 类字段替换为 '***'，序列化失败有兜底） */
function deliveryTargetLabel(target: unknown): string {
  try {
    return JSON.stringify(redactSecrets(target)) ?? '[unserializable target]';
  } catch {
    return '[unserializable target]';
  }
}

/**
 * 通知中心编排器：通知生命周期 = 入库（inbox）→ SSE created 事件 → 渠道投递 →
 * SSE delivered 事件。投递永远不反向影响入库结果：send() 的成功即"通知已创建"。
 */
export class NotificationManager {
  constructor(private readonly deps: NotificationManagerDeps) {}

  /**
   * 创建并投递一条通知。
   *
   * @returns 已落库的通知记录（channels 字段为脱敏后的投递计划；每渠道投递结果
   *   经 'notification.delivered' 事件异步可见，并经可选的 deps.recordDelivery
   *   落投递流水；v1 不回写记录）
   * @throws HarnessError（VALIDATION_FAILED）入参非法，或 beforeSend hook 返回了
   *   非法形状；store 落库失败按原样上抛（DB_ERROR）。渠道投递失败不上抛。
   */
  async send(input: NotificationSendInput): Promise<NotificationRecord> {
    // 1. 入参校验
    const parsed = sendInputSchema.safeParse(input);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'notification send input invalid (require non-empty title)',
        detail: parsed.error.issues,
      });
    }
    const draft = {
      title: parsed.data.title,
      body: parsed.data.body ?? '',
      level: parsed.data.level ?? ('info' as ChannelLevel),
      data: parsed.data.data ?? null,
    };

    // 2. beforeSend hook（filter 链；handler 未注册时原值透传，返回 undefined 视为不改写）
    const id = randomUUID();
    const hooked = await this.deps.hooks.apply(HOOK_POINTS.notificationBeforeSend, draft, { meta: { id } });
    let value = draft;
    if (hooked !== undefined && hooked !== null && typeof hooked === 'object' && !Array.isArray(hooked)) {
      const hookParsed = hookValueSchema.safeParse(hooked);
      if (!hookParsed.success) {
        throw err('VALIDATION_FAILED', {
          message: `hook "${NOTIFICATION_HOOK_POINTS.beforeSend}" returned an invalid value (need { title, body?, level?, data? })`,
          detail: hookParsed.error.issues,
        });
      }
      value = {
        title: hookParsed.data.title,
        body: hookParsed.data.body ?? '',
        level: hookParsed.data.level ?? ('info' as ChannelLevel),
        data: hookParsed.data.data ?? null,
      };
    }

    // 3. 投递计划：显式传入的 channels 优先；未显式传入时先读默认路由规则按
    //    level 匹配（规则读取失败/非法仅 warn）；路由未命中任何渠道且注入了
    //    getChannelConfigs 时，回落为全部启用的渠道实例（多渠道自动分发）
    let plan = parsed.data.channels;
    if (plan === undefined) {
      plan = await this.#routedChannelsFor(value.level);
      if (plan.length === 0) plan = await this.#enabledChannelPlan();
    }

    // 4. persist：channels 字段落"本次投递计划"（secret 类字段脱敏；驱动仍收原始 target）
    const record: NotificationRecord = {
      id,
      level: value.level,
      title: value.title,
      body: value.body,
      data: value.data,
      channels: plan.map((ch) => ({ driver: ch.driver, target: redactSecrets(ch.target) })),
      readAt: null,
      createdAt: Date.now(),
    };
    await this.deps.store.create(record);

    // 5. SSE：created（入库即 inbox；站内信消费此事件渲染通知中心）
    this.deps.publish(TOPIC, 'notification.created', record);

    // 6. 渠道投递：逐渠道隔离，单渠道失败不抛出（logger.error + 失败计数）。
    //    投递统一走 withDeliveryRetry 指数退避（口径解析见 retry.ts），
    //    每渠道结果经 recordDelivery 落投递流水（deliveries 表，target 脱敏）。
    const channels = plan;
    if (channels.length > 0) {
      const payload: NotificationPayload = {
        id,
        level: value.level,
        title: value.title,
        body: value.body,
        data: value.data,
        createdAt: record.createdAt,
      };
      const retryOverride = await this.#readRetryOverride();
      const results: ChannelDeliveryResult[] = [];
      for (const channel of channels) {
        const targetLabel = deliveryTargetLabel(channel.target);
        const driver = this.deps.registry.getNotificationDriver(channel.driver);
        if (driver === undefined) {
          // 未知驱动名：跳过不抛，结果计失败，便于上层排查路由配置
          const missing =
            `driver "${channel.driver}" not found (HARNESS-7002); register it via registry.registerNotificationDriver()`;
          results.push({ driver: channel.driver, ok: false, durationMs: 0, error: missing });
          this.#recordDelivery({
            kind: 'notification',
            target: targetLabel,
            channel: channel.driver,
            ok: false,
            durationMs: 0,
            error: missing,
          });
          this.deps.logger.warn(
            { driver: channel.driver, notificationId: id },
            '[notification] unknown channel driver, delivery skipped',
          );
          continue;
        }
        const start = performance.now();
        const retry = resolveChannelRetry(channel.driver, channel.target, retryOverride);
        try {
          // target 在本 API 边界为 unknown（形状由各驱动 deliver 入口自行 zod 校验，
          // 见 channels 包 ChannelTargetConfig 契约），此处归一为契约类型
          await withDeliveryRetry(() => driver.deliver(payload, channel.target as ChannelTargetConfig), {
            ...retry,
            sleep: this.deps.sleep,
            retryOn: isRetryableDeliveryError,
          });
          const durationMs = Math.round(performance.now() - start);
          results.push({ driver: channel.driver, ok: true, durationMs });
          this.#recordDelivery({
            kind: 'notification',
            target: targetLabel,
            channel: channel.driver,
            ok: true,
            durationMs,
          });
        } catch (e) {
          const durationMs = Math.round(performance.now() - start);
          const failure = errorMessage(e);
          results.push({ driver: channel.driver, ok: false, durationMs, error: failure });
          this.#recordDelivery({
            kind: 'notification',
            target: targetLabel,
            channel: channel.driver,
            ok: false,
            durationMs,
            error: failure,
          });
          this.deps.logger.error(
            { err: e, driver: channel.driver, notificationId: id, durationMs },
            `[notification] channel delivery failed via "${channel.driver}" (notification ${id})`,
          );
        }
      }
      // 7. SSE：delivered（每渠道结果；投递计划非空时发布）
      this.deps.publish(TOPIC, 'notification.delivered', { id, results });
    }

    return record;
  }

  /**
   * settings 'notify.retry' → 重试口径覆盖：未注入/读取失败/形状非法均返回 null
   * （用每驱动缺省口径），仅 warn 不阻断投递。
   */
  async #readRetryOverride(): Promise<DeliveryRetryConfig | null> {
    const getRetry = this.deps.getRetry;
    if (getRetry === undefined) return null;
    let raw: unknown;
    try {
      raw = await getRetry();
    } catch (e) {
      this.deps.logger.warn({ err: e }, '[notification] retry settings read failed, default retry policy in effect');
      return null;
    }
    const parsed = normalizeRetryOverride(raw);
    if (parsed === null) {
      this.deps.logger.warn(
        { value: raw },
        '[notification] retry settings invalid (need { retries: 0-10, baseMs: 0-60000 }), default retry policy in effect',
      );
      return null;
    }
    return parsed;
  }

  /** 投递流水回调（fire-and-forget）：未注入即 no-op；同步抛错仅 warn，不影响投递结果 */
  #recordDelivery(entry: NotificationDeliveryEntry): void {
    const recordDelivery = this.deps.recordDelivery;
    if (recordDelivery === undefined) return;
    try {
      recordDelivery(entry);
    } catch (e) {
      this.deps.logger.warn(
        { err: e, channel: entry.channel },
        '[notification] delivery record callback failed (delivery result unaffected)',
      );
    }
  }

  /**
   * 默认路由规则 → 投递计划：读 deps.getRoutes()，按 level 匹配规则
   * （match.level 缺省 = 匹配全部），拼接全部命中规则的 channels。
   * 读取失败/形状非法：warn + 返回 []（通知照常入库，只是不外发）。
   */
  async #routedChannelsFor(level: ChannelLevel): Promise<NotificationChannel[]> {
    const getRoutes = this.deps.getRoutes;
    if (getRoutes === undefined) return [];
    let raw: unknown;
    try {
      raw = await getRoutes();
    } catch (e) {
      this.deps.logger.warn({ err: e }, '[notification] route rules read failed, delivery plan skipped');
      return [];
    }
    const parsed = routeRulesSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.logger.warn(
        { issues: parsed.error.issues },
        '[notification] route rules invalid, delivery plan skipped (fix via PUT /api/v1/notifications/routes)',
      );
      return [];
    }
    const plan: NotificationChannel[] = [];
    for (const rule of parsed.data) {
      const ruleLevel = rule.match?.level;
      if (ruleLevel !== undefined && ruleLevel !== level) continue;
      plan.push(...rule.channels);
    }
    return plan;
  }

  /**
   * 多渠道回落计划：读 deps.getChannelConfigs()（NotificationChannelStore.list()），
   * 取全部 enabled=true 的渠道实例 → { driver: type, target }。逐条经
   * parseChannelConfigs 校验（非法条目跳过并 warn）；读取失败 warn + 返回 []
   * （通知照常入库，只是不外发）。
   */
  async #enabledChannelPlan(): Promise<NotificationChannel[]> {
    const getChannelConfigs = this.deps.getChannelConfigs;
    if (getChannelConfigs === undefined) return [];
    let raw: NotificationChannelConfig[];
    try {
      raw = await getChannelConfigs();
    } catch (e) {
      this.deps.logger.warn({ err: e }, '[notification] channel configs read failed, fallback plan skipped');
      return [];
    }
    const valid = parseChannelConfigs(raw);
    const configs = valid.filter((c) => c.enabled);
    if (valid.length < raw.length) {
      this.deps.logger.warn(
        { total: raw.length, valid: valid.length },
        '[notification] some channel configs invalid, skipped from fallback plan',
      );
    }
    return configs.map((c) => ({ driver: c.type, target: c.target }));
  }
}
