/**
 * NotificationManager — 通知中心编排器（入库 → SSE 发布 → 渠道投递）。
 *
 * send() 流程：
 * 1. zod 校验入参（level 缺省 'info'，body 缺省 ''，data 缺省 null）；
 * 2. hook `notification.beforeSend`（filter 链，可改写 title/body/level/data）；
 * 3. 生成 uuid → persist（channels 字段落"本次投递计划"JSON，secret 类字段脱敏为 '***'）；
 * 4. publish('notifications', 'notification.created', record)（SSE 实时推送，入库即 inbox）；
 * 5. 对投递计划逐个投递：registry.getNotificationDriver → deliver(payload, target)。
 *    投递计划 = 显式传入的 input.channels（优先）；未显式传入且注入了 getRoutes 时，
 *    读取默认路由规则（settings 'notify.routes'）按 level 匹配追加 channels。
 *    单渠道失败**不抛出**：logger.error 记录 + 失败计数，deliver 前后计 duration；
 *    未知驱动名同样跳过不抛；
 * 6. 每渠道结果数组作为第二事件 publish('notifications', 'notification.delivered',
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
import { err } from '../errors/index.js';
import type { Logger } from 'pino';
import { z } from 'zod';

import { HOOK_POINTS } from '../hooks/index.js';
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
  /** deliver 前后耗时（毫秒；未知驱动名为 0） */
  durationMs: number;
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
 * 通知中心编排器：通知生命周期 = 入库（inbox）→ SSE created 事件 → 渠道投递 →
 * SSE delivered 事件。投递永远不反向影响入库结果：send() 的成功即"通知已创建"。
 */
export class NotificationManager {
  constructor(private readonly deps: NotificationManagerDeps) {}

  /**
   * 创建并投递一条通知。
   *
   * @returns 已落库的通知记录（channels 字段为脱敏后的投递计划；每渠道投递结果
   *   经 'notification.delivered' 事件异步可见，v1 不回写记录）
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

    // 3. 投递计划：显式传入的 channels 优先；未显式传入且注入了 getRoutes 时
    //    读默认路由规则按 level 匹配（规则读取失败/非法仅 warn，不阻断创建）
    const plan =
      parsed.data.channels ?? (await this.#routedChannelsFor(value.level));

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

    // 6. 渠道投递：逐渠道隔离，单渠道失败不抛出（logger.error + 失败计数）
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
      const results: ChannelDeliveryResult[] = [];
      for (const channel of channels) {
        const driver = this.deps.registry.getNotificationDriver(channel.driver);
        if (driver === undefined) {
          // 未知驱动名：跳过不抛，结果计失败，便于上层排查路由配置
          results.push({
            driver: channel.driver,
            ok: false,
            durationMs: 0,
            error: `driver "${channel.driver}" not found (HARNESS-7002); register it via registry.registerNotificationDriver()`,
          });
          this.deps.logger.warn(
            { driver: channel.driver, notificationId: id },
            '[notification] unknown channel driver, delivery skipped',
          );
          continue;
        }
        const start = performance.now();
        try {
          // target 在本 API 边界为 unknown（形状由各驱动 deliver 入口自行 zod 校验，
          // 见 channels 包 ChannelTargetConfig 契约），此处归一为契约类型
          await driver.deliver(payload, channel.target as ChannelTargetConfig);
          results.push({ driver: channel.driver, ok: true, durationMs: Math.round(performance.now() - start) });
        } catch (e) {
          const durationMs = Math.round(performance.now() - start);
          results.push({ driver: channel.driver, ok: false, durationMs, error: errorMessage(e) });
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
}
