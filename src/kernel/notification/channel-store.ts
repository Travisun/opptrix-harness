/**
 * notification — 多渠道配置持久化（NotificationChannelStore）。
 *
 * 背景：既有通知渠道配置是 settings 里的单一 webhook / 单一 email 两键
 * （'notify.channels.webhook' / 'notify.channels.email'），无法表达"多个 webhook
 * 实例 + 多个 email 实例、各自独立启停"。本存储把渠道实例数组整体落在
 * settings 单键 'notify.channelConfigs' 下（JSON 数组），每条配置：
 * - id：uuid（create 时生成）；
 * - type：驱动名（'webhook' | 'email' | 'console'，与 registry 注册名一致）；
 * - name：人类可读名称（同 type 可重复，用于 UI 区分多个实例）；
 * - enabled：独立启停（NotificationManager 派发时只取 enabled=true 的渠道）；
 * - target：驱动语义内的目标配置（webhook: {url, secret?…}；email: {smtp, from, to}；
 *   console: 空对象），create/update 入口按 type 经 zod 校验（与各驱动 target 契约同形）；
 * - createdAt：创建时刻（UTC epoch ms）。
 *
 * 容错语义（settings 属外部入参，可能与本存储版本不一致）：
 * - 读取到的值非数组 / 单条形状非法：跳过非法条目（整体非数组则视为空），
 *   不抛错——脏配置不应让通知中心整体不可用；
 * - 写入整体覆盖（读-改-写），由调用方保证并发场景下无交叉写。
 *
 * 密钥安全：target.webhook.secret / target.email.smtp.passSecretRef 按各驱动既有
 * 契约存储（secret 明文或 secretRef 引用名）。本存储不做脱敏改写——脱敏发生在
 * NotificationManager 落库/SSE 层（redactSecrets），与路由规则 channels 同口径。
 */
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 渠道类型（= 驱动注册名；可按需扩充，zod enum 与 UI 选项同源此处） */
export const NOTIFY_CHANNEL_TYPES = ['webhook', 'email', 'console'] as const;

/** 单个通知渠道实例配置（settings 'notify.channelConfigs' 数组元素） */
export interface NotificationChannelConfig {
  /** 唯一 ID（uuid） */
  id: string;
  /** 渠道类型（驱动名） */
  type: (typeof NOTIFY_CHANNEL_TYPES)[number];
  /** 人类可读名称 */
  name: string;
  /** 启停（派发时只取 enabled=true） */
  enabled: boolean;
  /** 驱动语义内的目标配置（形状由 {@link channelTargetSchemaFor} 按 type 校验） */
  target: Record<string, unknown>;
  /** 创建时刻（UTC epoch ms） */
  createdAt: number;
}

/** settings 键：渠道实例配置数组 */
export const NOTIFY_CHANNEL_CONFIGS_KEY = 'notify.channelConfigs';

// ---------------------------------------------------------------------------
// target 按类型 zod 契约（与各驱动 deliver 入口的 target schema 同形；驱动文件
// 不导出 schema，此处为 REST/存储校验的单一事实来源——形状漂移由驱动 zod 兜底）
// ---------------------------------------------------------------------------

/** webhook target：url 必填；secret/secretRef/timeoutMs/retries 可选（同 drivers/webhook.ts） */
export const webhookChannelTargetSchema = z.object({
  url: z.url(),
  secret: z.string().min(1).optional(),
  secretRef: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().min(0).max(10).optional(),
});

/** email target：smtp.host / from / to 必填，其余可选（同 drivers/email.ts） */
export const emailChannelTargetSchema = z.object({
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

/** console target：无必填字段（console 驱动不消费 target），仅约束为对象 */
export const consoleChannelTargetSchema = z.object({}).loose();

/** 渠道类型 → target zod schema（未知类型返回 null） */
export function channelTargetSchemaFor(type: string): z.ZodType | null {
  switch (type) {
    case 'webhook':
      return webhookChannelTargetSchema;
    case 'email':
      return emailChannelTargetSchema;
    case 'console':
      return consoleChannelTargetSchema;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// zod：create/update 入参与持久化形状
// ---------------------------------------------------------------------------

/**
 * create 入参：type enum + name 必填 + target 先按对象形状收口（enabled 缺省 true）。
 * type 相关的 target 严格校验（url / smtp.host 等）在 create() 内用
 * {@link channelTargetSchemaFor} 二段执行——zod v4 无同对象引用，两段式最直白。
 */
const createInputSchema = z.object({
  type: z.enum(NOTIFY_CHANNEL_TYPES),
  name: z.string().trim().min(1).max(128),
  target: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});

/** update 入参：全部可选（部分更新）；给出即校验（name 不可置空） */
const updatePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    enabled: z.boolean().optional(),
    target: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'update patch is empty' });

/** 持久化条目形状（读取容错用：逐条 safeParse，非法条目跳过） */
const storedConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NOTIFY_CHANNEL_TYPES),
  name: z.string().min(1),
  enabled: z.boolean(),
  target: z.record(z.string(), z.unknown()),
  createdAt: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// 读取容错（本存储与 NotificationManager 共用）
// ---------------------------------------------------------------------------

/** 外部入参（settings 原值 / 集成方注入值）→ 合法配置数组：非数组视为空，逐条 safeParse、非法条目跳过 */
export function parseChannelConfigs(value: unknown): NotificationChannelConfig[] {
  if (!Array.isArray(value)) return [];
  const out: NotificationChannelConfig[] = [];
  for (const entry of value) {
    const parsed = storedConfigSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** settings 最小契约（SettingsService 结构子集，测试可注入内存替身） */
export interface ChannelStoreSettings {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** create() 入参 */
export interface ChannelCreateInput {
  type: NotificationChannelConfig['type'];
  name: string;
  target: Record<string, unknown>;
  /** 缺省 true */
  enabled?: boolean;
}

/** update() 入参（全部可选，部分更新） */
export interface ChannelUpdatePatch {
  name?: string;
  enabled?: boolean;
  target?: Record<string, unknown>;
}

/**
 * 多渠道配置存储：settings 单键 JSON 数组的读-改-写门面。
 * 由 REST 渠道 CRUD（src/api/notifications.ts）与 NotificationManager 的
 * deps.getChannelConfigs（经集成方 list() 过滤 enabled）共用。
 */
export class NotificationChannelStore {
  constructor(private readonly settings: ChannelStoreSettings) {}

  /** 全部渠道配置（含 enabled=false；非法条目容错跳过）。 */
  async list(): Promise<NotificationChannelConfig[]> {
    return this.#readAll();
  }

  /** 全部启用渠道（NotificationManager 自动派发计划的数据源） */
  async listEnabled(): Promise<NotificationChannelConfig[]> {
    return (await this.#readAll()).filter((c) => c.enabled);
  }

  /** 按 ID 读取；不存在返回 null */
  async get(id: string): Promise<NotificationChannelConfig | null> {
    const all = await this.#readAll();
    return all.find((c) => c.id === id) ?? null;
  }

  /**
   * 创建渠道实例：生成 uuid、enabled（缺省 true）与 createdAt，按 type 校验 target。
   *
   * @throws HarnessError（VALIDATION_FAILED）type/name/target 非法
   */
  async create(input: ChannelCreateInput): Promise<NotificationChannelConfig> {
    const parsed = createInputSchema.safeParse(input);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'channel config invalid (require type enum / non-empty name / target per type)',
        detail: parsed.error.issues,
      });
    }
    const targetSchema = channelTargetSchemaFor(parsed.data.type);
    if (targetSchema !== null) {
      const targetCheck = targetSchema.safeParse(parsed.data.target);
      if (!targetCheck.success) {
        throw err('VALIDATION_FAILED', {
          message: `channel target invalid for type "${parsed.data.type}"`,
          detail: targetCheck.error.issues,
        });
      }
    }
    const config: NotificationChannelConfig = {
      id: randomUUID(),
      type: parsed.data.type,
      name: parsed.data.name,
      enabled: parsed.data.enabled ?? true,
      target: parsed.data.target,
      createdAt: Date.now(),
    };
    const all = await this.#readAll();
    await this.#writeAll([...all, config]);
    return config;
  }

  /**
   * 部分更新（name/enabled/target）。target 给出即整体替换并按 type 校验。
   *
   * @returns 更新后的配置；id 不存在返回 null
   * @throws HarnessError（VALIDATION_FAILED）patch 为空 / 字段非法
   */
  async update(id: string, patch: ChannelUpdatePatch): Promise<NotificationChannelConfig | null> {
    const parsed = updatePatchSchema.safeParse(patch);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'channel update patch invalid (need at least one of name / enabled / target)',
        detail: parsed.error.issues,
      });
    }
    const all = await this.#readAll();
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return null;
    const current = all[index] as NotificationChannelConfig;
    if (parsed.data.target !== undefined) {
      const targetSchema = channelTargetSchemaFor(current.type);
      if (targetSchema !== null) {
        const targetCheck = targetSchema.safeParse(parsed.data.target);
        if (!targetCheck.success) {
          throw err('VALIDATION_FAILED', {
            message: `channel target invalid for type "${current.type}"`,
            detail: targetCheck.error.issues,
          });
        }
      }
    }
    const next: NotificationChannelConfig = {
      ...current,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.target !== undefined ? { target: parsed.data.target } : {}),
    };
    all.splice(index, 1, next);
    await this.#writeAll(all);
    return next;
  }

  /**
   * 删除渠道配置。
   *
   * @returns 是否确有配置被删除（id 不存在返回 false）
   */
  async remove(id: string): Promise<boolean> {
    const all = await this.#readAll();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    await this.#writeAll(next);
    return true;
  }

  /** settings → 配置数组（容错：非数组视为空；非法条目跳过） */
  async #readAll(): Promise<NotificationChannelConfig[]> {
    try {
      const raw = await this.settings.get(NOTIFY_CHANNEL_CONFIGS_KEY);
      return parseChannelConfigs(raw);
    } catch {
      return []; // settings 读取失败按未配置处理（与 routes 读取容错同口径）
    }
  }

  /** 配置数组 → settings（JSON 序列化失败原样上抛，交由 settings 层归一为 DB_ERROR） */
  async #writeAll(configs: NotificationChannelConfig[]): Promise<void> {
    await this.settings.set(NOTIFY_CHANNEL_CONFIGS_KEY, configs);
  }
}
