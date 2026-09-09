/**
 * notification — 多渠道实例配置（NotificationChannelConfig + 配置存取）。
 *
 * 背景：既有通知渠道配置是 settings 里的单一 webhook / 单一 email 两键
 *（'notify.channels.webhook' / 'notify.channels.email'），无法表达"多个 webhook
 * 实例 + 多个 email 实例、各自独立启停"。本模块把渠道实例数组整体落在 settings
 * 单键 'notify.channelConfigs' 下（JSON 数组），每条配置：
 * - id：uuid（create 时生成）；
 * - type：渠道类型（'webhook' | 'email' | 'console'，与 registry 驱动注册名一致）；
 * - name：人类可读名（如"运维群机器人"）；同 type 可重复，用于 UI 区分多实例；
 * - enabled：独立启停（NotificationManager 派发时只取 enabled=true 的实例）；
 * - target：驱动语义内的目标配置（webhook: {url, secret?…}；email: {smtp, from, to}；
 *   console: 空对象），create/update 入口按 type 经 zod 校验（与各驱动 target 契约
 *   同形——驱动 deliver 入口仍有自身 zod 兜底，形状漂移不会静默）；
 * - createdAt：创建时刻（UTC epoch ms）。
 *
 * 容错语义（settings 属外部入参，可能与本模块版本不一致）：
 * - 读取到的值非数组视为空；数组内单条形状非法逐条跳过，不抛错——脏配置不应让
 *   通知中心整体不可用；
 * - 写入整体覆盖（读-改-写），由调用方保证并发场景下无交叉写。
 *
 * 密钥安全：target.webhook.secret / target.email.smtp.passSecretRef 按各驱动既有
 * 契约存储（secret 明文或 secretRef 引用名）。本模块不做脱敏改写——脱敏发生在
 * NotificationManager 落库/SSE 层（redactSecrets），与路由规则 channels 同口径。
 */
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

/** 渠道类型（= 驱动注册名；扩充时同步 channelTargetSchemaFor 分支与 REST zod） */
export const NOTIFY_CHANNEL_TYPES = ['webhook', 'email', 'console'] as const;

/** 单个通知渠道实例配置（settings 'notify.channelConfigs' 数组元素） */
export interface NotificationChannelConfig {
  /** 唯一 ID（uuid） */
  id: string;
  /** 渠道类型（驱动名） */
  type: (typeof NOTIFY_CHANNEL_TYPES)[number];
  /** 人类可读名称（如"运维群机器人"） */
  name: string;
  /** 启停（派发时只取 enabled=true） */
  enabled: boolean;
  /** 驱动语义内的目标配置（形状按 type 经 {@link channelTargetSchemaFor} 校验） */
  target: Record<string, unknown>;
  /** 创建时刻（UTC epoch ms） */
  createdAt: number;
}

/** 渠道类型别名（create 入参用） */
export type NotificationChannelType = NotificationChannelConfig['type'];

/** settings 键：渠道实例配置数组 */
export const NOTIFY_CHANNEL_CONFIGS_KEY = 'notify.channelConfigs';

// ---------------------------------------------------------------------------
// target 按类型 zod 契约（与各驱动 deliver 入口的 target schema 同形；驱动文件
// 不导出 schema，此处为 create/update 校验的单一事实来源——形状漂移由驱动 zod 兜底）
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
 * create 入参：type enum + name 必填 + target 按对象形状收口。type 相关的 target
 * 严格校验（url / smtp.host 等）在 create() 内用 {@link channelTargetSchemaFor}
 * 二段执行——zod v4 无同对象引用，两段式最直白。
 */
const createInputSchema = z.object({
  type: z.enum(NOTIFY_CHANNEL_TYPES),
  name: z.string().trim().min(1).max(128),
  target: z.record(z.string(), z.unknown()),
});

/** update 入参：全部可选（部分更新）；给出即校验（name 不可置空），空 patch 拒绝 */
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
// 读取容错
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
export interface ChannelConfigStoreSettings {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** update() 入参（全部可选，部分更新） */
export interface ChannelConfigUpdatePatch {
  name?: string;
  enabled?: boolean;
  target?: Record<string, unknown>;
}

/** 渠道配置存取门面（REST 渠道 CRUD 与 NotificationManager 数据源共用同一实例） */
export interface ChannelConfigStore {
  /** 全部渠道配置（含 enabled=false；非法条目容错跳过） */
  list(): Promise<NotificationChannelConfig[]>;
  /** 全部启用渠道（NotificationManager 自动派发计划的数据源） */
  listEnabled(): Promise<NotificationChannelConfig[]>;
  /** 按 ID 读取；不存在返回 null */
  get(id: string): Promise<NotificationChannelConfig | null>;
  /** 创建渠道实例（生成 uuid / enabled 缺省 true / createdAt；target 按 type 校验） */
  create(type: NotificationChannelType, name: string, target: Record<string, unknown>): Promise<NotificationChannelConfig>;
  /** 部分更新（name/enabled/target）；id 不存在返回 null */
  update(id: string, patch: ChannelConfigUpdatePatch): Promise<NotificationChannelConfig | null>;
  /** 删除；返回是否确有配置被删除（id 不存在 false） */
  remove(id: string): Promise<boolean>;
  /** 启停切换：enabled 缺省 = 取反当前值；id 不存在返回 null */
  toggle(id: string, enabled?: boolean): Promise<NotificationChannelConfig | null>;
}

/**
 * 创建多渠道实例配置存取门面（settings 单键 JSON 数组的读-改-写）。
 *
 * 入参校验失败抛 HarnessError（VALIDATION_FAILED → 400 HARNESS-1009），
 * REST 层原样透传给全局错误处理器；settings 读取失败按未配置处理（容错不抛）。
 */
export function createChannelConfigStore(settings: ChannelConfigStoreSettings): ChannelConfigStore {
  /** settings → 配置数组（容错：非数组视为空；非法条目跳过；读取失败按未配置） */
  async function readAll(): Promise<NotificationChannelConfig[]> {
    try {
      return parseChannelConfigs(await settings.get(NOTIFY_CHANNEL_CONFIGS_KEY));
    } catch {
      return []; // settings 读取失败按未配置处理（与 routes 读取容错同口径）
    }
  }

  /** 配置数组 → settings（序列化失败原样上抛，交由 settings 层归一为 DB_ERROR） */
  async function writeAll(configs: NotificationChannelConfig[]): Promise<void> {
    await settings.set(NOTIFY_CHANNEL_CONFIGS_KEY, configs);
  }

  /** target 按 type 严格校验；非法抛 VALIDATION_FAILED（detail = issues） */
  function assertTarget(type: NotificationChannelType, target: Record<string, unknown>): void {
    const targetSchema = channelTargetSchemaFor(type);
    if (targetSchema === null) return;
    const check = targetSchema.safeParse(target);
    if (!check.success) {
      throw err('VALIDATION_FAILED', {
        message: `channel target invalid for type "${type}"`,
        detail: check.error.issues,
      });
    }
  }

  return {
    async list(): Promise<NotificationChannelConfig[]> {
      return readAll();
    },

    async listEnabled(): Promise<NotificationChannelConfig[]> {
      return (await readAll()).filter((c) => c.enabled);
    },

    async get(id: string): Promise<NotificationChannelConfig | null> {
      const all = await readAll();
      return all.find((c) => c.id === id) ?? null;
    },

    async create(type, name, target): Promise<NotificationChannelConfig> {
      const parsed = createInputSchema.safeParse({ type, name, target });
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'channel config invalid (require type enum / non-empty name / target object)',
          detail: parsed.error.issues,
        });
      }
      assertTarget(parsed.data.type, parsed.data.target);
      const config: NotificationChannelConfig = {
        id: randomUUID(),
        type: parsed.data.type,
        name: parsed.data.name,
        enabled: true,
        target: parsed.data.target,
        createdAt: Date.now(),
      };
      await writeAll([...(await readAll()), config]);
      return config;
    },

    async update(id, patch): Promise<NotificationChannelConfig | null> {
      const parsed = updatePatchSchema.safeParse(patch);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'channel update patch invalid (need at least one of name / enabled / target)',
          detail: parsed.error.issues,
        });
      }
      const all = await readAll();
      const index = all.findIndex((c) => c.id === id);
      if (index === -1) return null;
      const current = all[index] as NotificationChannelConfig;
      if (parsed.data.target !== undefined) assertTarget(current.type, parsed.data.target);
      const next: NotificationChannelConfig = {
        ...current,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.target !== undefined ? { target: parsed.data.target } : {}),
      };
      all.splice(index, 1, next);
      await writeAll(all);
      return next;
    },

    async remove(id): Promise<boolean> {
      const all = await readAll();
      const next = all.filter((c) => c.id !== id);
      if (next.length === all.length) return false;
      await writeAll(next);
      return true;
    },

    async toggle(id, enabled): Promise<NotificationChannelConfig | null> {
      const current = await this.get(id);
      if (current === null) return null;
      return this.update(id, { enabled: enabled ?? !current.enabled });
    },
  };
}
