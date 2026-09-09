/**
 * 内核数据库迁移 —— 全系统权威 Schema（后续模块按此开发，不得擅自偏离）。
 *
 * 全局约定：
 * - 时间列一律 INTEGER，存 UTC epoch ms（展示/时区转换只在边界层做）；
 * - 布尔语义列一律 INTEGER（0/1）；
 * - JSON 类字段（meta/payload/data/attachments/args/result/content/channels）
 *   一律 TEXT，存 JSON 字符串（序列化/反序列化由各模块边界负责）；
 * - 每个迁移都提供 down（dropTable），全部迁移可逆序完整回滚。
 *
 * 运行器契约见 `src/kernel/storage/migrator.ts`（`Migration`）。
 */
import { type Migration } from './migrator.js';
import type { Knex } from 'knex';

/** 001 — settings：内核键值配置（key TEXT 主键，value 为 TEXT）。 */
const m001Settings: Migration = {
  name: '001_settings',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('settings', (t) => {
      t.text('key').primary();
      t.text('value').notNullable();
      t.integer('updated_at').notNullable(); // UTC epoch ms
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('settings');
  },
};

/** 002 — secrets：敏感凭据存储（name TEXT 主键；value 永不入日志）。 */
const m002Secrets: Migration = {
  name: '002_secrets',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('secrets', (t) => {
      t.text('name').primary();
      t.text('value').notNullable();
      t.integer('updated_at').notNullable(); // UTC epoch ms
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('secrets');
  },
};

/** 003 — logs：内核结构化日志（data 为 TEXT，JSON 字符串）。 */
const m003Logs: Migration = {
  name: '003_logs',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('logs', (t) => {
      t.increments('id'); // INTEGER PK AUTOINCREMENT
      t.integer('ts').notNullable(); // UTC epoch ms
      t.text('level').notNullable();
      t.text('scope').notNullable().defaultTo('');
      t.text('message').notNullable();
      t.text('data'); // JSON 字符串（结构化日志附加数据）
      t.index(['ts'], 'logs_ts_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('logs');
  },
};

/** 004 — extensions：已安装扩展登记（启用状态/挂载点/自愈计数）。 */
const m004Extensions: Migration = {
  name: '004_extensions',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('extensions', (t) => {
      t.text('id').primary();
      t.text('version').notNullable();
      t.integer('enabled').notNullable().defaultTo(0); // 0/1
      t.integer('builtin').notNullable().defaultTo(0); // 0/1
      t.text('mount'); // 挂载白名单路径，可空
      t.text('uninstall').notNullable().defaultTo('keep'); // keep | remove 等
      t.integer('crash_count').notNullable().defaultTo(0); // 自愈惯犯熔断计数
      t.text('last_error'); // 最近一次错误摘要
      t.integer('installed_at').notNullable(); // UTC epoch ms
      t.integer('updated_at').notNullable(); // UTC epoch ms
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('extensions');
  },
};

/** 005 — ext_kv：扩展私有 KV 存储（复合主键 ext_id+key；value 为 TEXT）。 */
const m005ExtKv: Migration = {
  name: '005_ext_kv',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('ext_kv', (t) => {
      t.text('ext_id').notNullable();
      t.text('key').notNullable();
      t.text('value').notNullable();
      t.integer('updated_at').notNullable(); // UTC epoch ms
      t.primary(['ext_id', 'key']);
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('ext_kv');
  },
};

/** 006 — cron_jobs：定时任务定义（payload 为 TEXT，JSON 字符串）。 */
const m006CronJobs: Migration = {
  name: '006_cron_jobs',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('cron_jobs', (t) => {
      t.text('id').primary();
      t.text('ext_id'); // 空 = 内核级任务
      t.text('name').notNullable();
      t.text('expr').notNullable(); // cron 表达式
      t.text('tz').notNullable(); // IANA 时区
      t.text('payload'); // JSON 字符串（任务负载）
      t.integer('enabled').notNullable().defaultTo(1); // 0/1
      t.text('overlap').notNullable().defaultTo('skip'); // skip | allow 等
      t.text('misfire').notNullable().defaultTo('skip'); // skip | run 等
      t.integer('last_run'); // UTC epoch ms
      t.integer('next_run'); // UTC epoch ms
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.index(['ext_id'], 'cron_jobs_ext_id_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('cron_jobs');
  },
};

/** 007 — cron_runs：定时任务执行记录（error 为 TEXT）。 */
const m007CronRuns: Migration = {
  name: '007_cron_runs',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('cron_runs', (t) => {
      t.increments('id'); // INTEGER PK AUTOINCREMENT
      t.text('job_id').notNullable();
      t.integer('started_at').notNullable(); // UTC epoch ms
      t.integer('finished_at'); // UTC epoch ms
      t.integer('ok').notNullable(); // 0/1
      t.integer('duration_ms'); // 执行耗时
      t.text('error'); // 失败原因
      t.index(['job_id', 'started_at'], 'cron_runs_job_id_started_at_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('cron_runs');
  },
};

/** 008 — notifications：通知中心（data/channels 为 TEXT，JSON 字符串）。 */
const m008Notifications: Migration = {
  name: '008_notifications',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('notifications', (t) => {
      t.text('id').primary();
      t.text('level').notNullable().defaultTo('info'); // info | warn | error 等
      t.text('title').notNullable();
      t.text('body').notNullable().defaultTo('');
      t.text('data'); // JSON 字符串（附加数据）
      t.text('channels'); // JSON 字符串（投递渠道列表，如 ["ui","webhook"]）
      t.integer('read_at'); // UTC epoch ms；空 = 未读
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.index(['read_at', 'created_at'], 'notifications_read_at_created_at_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('notifications');
  },
};

/** 009 — channels：消息渠道（slug 唯一；webhook_token 唯一；meta 为 TEXT，JSON 字符串）。 */
const m009Channels: Migration = {
  name: '009_channels',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('channels', (t) => {
      t.text('id').primary();
      t.text('slug').notNullable().unique();
      t.text('name').notNullable();
      t.text('type').notNullable().defaultTo('public'); // public | private 等
      t.text('webhook_token').unique(); // 入站 webhook 令牌，可空
      t.text('meta'); // JSON 字符串（渠道元信息）
      t.integer('created_at').notNullable(); // UTC epoch ms
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('channels');
  },
};

/** 010 — channel_members：渠道成员关系（复合主键 channel_id+member_type+member_id）。 */
const m010ChannelMembers: Migration = {
  name: '010_channel_members',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('channel_members', (t) => {
      t.text('channel_id').notNullable();
      t.text('member_type').notNullable(); // user | bot | ext 等
      t.text('member_id').notNullable();
      t.integer('joined_at').notNullable(); // UTC epoch ms
      t.primary(['channel_id', 'member_type', 'member_id']);
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('channel_members');
  },
};

/** 011 — messages：渠道消息（content/attachments 为 TEXT，JSON 字符串）。 */
const m011Messages: Migration = {
  name: '011_messages',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('messages', (t) => {
      t.text('id').primary();
      t.text('channel_id').notNullable();
      t.text('sender_type').notNullable(); // user | bot | ext 等
      t.text('sender_id').notNullable();
      t.text('content').notNullable(); // JSON 字符串（消息体）
      t.text('attachments'); // JSON 字符串（附件引用列表）
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.integer('updated_at').notNullable(); // UTC epoch ms
      t.index(['channel_id', 'created_at'], 'messages_channel_id_created_at_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('messages');
  },
};

/** 012 — files：文件登记（path 唯一；visibility 默认 private）。 */
const m012Files: Migration = {
  name: '012_files',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('files', (t) => {
      t.text('id').primary();
      t.text('ext_id'); // 空 = 内核上传
      t.text('orig_name').notNullable(); // 原始文件名
      t.text('mime').notNullable();
      t.integer('size').notNullable(); // 字节
      t.text('path').notNullable().unique(); // 磁盘存储路径
      t.text('visibility').notNullable().defaultTo('private'); // private | public
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.index(['ext_id'], 'files_ext_id_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('files');
  },
};

/** 013 — tasks：长任务登记（args/result 为 TEXT，JSON 字符串）。 */
const m013Tasks: Migration = {
  name: '013_tasks',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('tasks', (t) => {
      t.text('id').primary();
      t.text('ext_id').notNullable();
      t.text('name').notNullable();
      t.text('args'); // JSON 字符串（任务入参）
      t.text('status').notNullable().defaultTo('queued'); // queued | running | done | failed 等
      t.integer('progress').notNullable().defaultTo(0); // 0-100
      t.text('progress_msg'); // 进度文案
      t.text('result'); // JSON 字符串（任务结果）
      t.text('error'); // 失败原因
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.integer('started_at'); // UTC epoch ms
      t.integer('finished_at'); // UTC epoch ms
      t.index(['ext_id', 'status'], 'tasks_ext_id_status_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('tasks');
  },
};

/** 014 — deliveries：外发投递流水（kind 渠道类型，target 接收方，channel 通道标识）。 */
const m014Deliveries: Migration = {
  name: '014_deliveries',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('deliveries', (t) => {
      t.increments('id'); // INTEGER PK AUTOINCREMENT
      t.text('kind').notNullable(); // email | webhook 等
      t.text('target').notNullable(); // 接收方标识
      t.text('channel').notNullable(); // 发送通道标识
      t.integer('ok').notNullable(); // 0/1
      t.integer('duration_ms'); // 投递耗时
      t.text('error'); // 失败原因
      t.integer('created_at').notNullable(); // UTC epoch ms
      t.index(['kind', 'created_at'], 'deliveries_kind_created_at_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('deliveries');
  },
};

/** 015 — extensions 信任确认列：第三方扩展首次 enable 需人工授信（产品层信任闸的持久化）。 */
const m015ExtensionsTrust: Migration = {
  name: '015_extensions_trust',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.alterTable('extensions', (t) => {
      t.integer('trusted_at'); // UTC epoch ms；空 = 未曾人工授信
      t.text('trusted_by'); // 授信主体（当前固定 'admin'）
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.alterTable('extensions', (t) => {
      t.dropColumn('trusted_at');
      t.dropColumn('trusted_by');
    });
  },
};

/** 016 — subagents：子代理记录（严格父子树；prompt/tool_names/transcript 为 TEXT，JSON 字符串）。 */
const m016Subagents: Migration = {
  name: '016_subagents',
  up: async (knex: Knex): Promise<void> => {
    await knex.schema.createTable('subagents', (t) => {
      t.text('id').primary();
      t.text('parent_id').notNullable(); // 'main' = 主会话；否则为父 subagent id
      t.integer('depth').notNullable(); // 树深度：main 直接子代 = 1
      t.text('model'); // 模型标识（可空 = 用 LLM 网关默认）
      t.text('system_prompt'); // 系统提示词（可空）
      t.text('prompt').notNullable(); // 任务提示词
      t.text('tool_names'); // JSON 字符串（工具白名单数组）
      t.text('status').notNullable().defaultTo('running'); // queued | running | done | failed | cancelled
      t.text('result'); // 最终结果文本
      t.text('error'); // 失败原因
      t.text('transcript'); // JSON 字符串（消息数组）
      t.integer('usage_in'); // 输入 token 用量
      t.integer('usage_out'); // 输出 token 用量
      t.integer('created_at'); // UTC epoch ms
      t.integer('started_at'); // UTC epoch ms
      t.integer('finished_at'); // UTC epoch ms
      t.index(['parent_id'], 'subagents_parent_id_index');
      t.index(['status'], 'subagents_status_index');
    });
  },
  down: async (knex: Knex): Promise<void> => {
    await knex.schema.dropTableIfExists('subagents');
  },
};

/** 内核全部迁移（按版本号升序执行；回滚时逆序）。 */
export const KERNEL_MIGRATIONS: Migration[] = [
  m001Settings,
  m002Secrets,
  m003Logs,
  m004Extensions,
  m005ExtKv,
  m006CronJobs,
  m007CronRuns,
  m008Notifications,
  m009Channels,
  m010ChannelMembers,
  m011Messages,
  m012Files,
  m013Tasks,
  m014Deliveries,
  m015ExtensionsTrust,
  m016Subagents,
];
