/**
 * core-services — 内核核心服务总装配（channels / notification / chat / files / tasks）。
 *
 * 由 Kernel 在 boot 的 cron 装配之后调用 `createCoreServices(kernel)`：
 * - 从容器 resolve 基础设施（config / logger / authChecker / db / settings / secrets /
 *   counters + sseHub + 事件总线 / hook 管理器门面）；
 * - 组装五个领域服务并登记进容器（CONTAINER_KEYS.channels / notify / chat / files / tasks）；
 * - `registerRoutes(app)` 把五个 REST 模块挂到 fastify 实例（由 Kernel 的 registerExtra 调用）；
 * - `start()` / `stop()` 托管 TaskManager 生命周期（core 先于 cron 启动，先于 cron 停止）。
 *
 * 装配图（谁依赖谁）：
 * - registry（ChannelRegistry 单例）← 通知驱动 ×4（inbox/webhook/console/email）
 *   + 聊天桥 ×2（webhook/email）；secrets.get 作为统一密钥解析源
 * - NotificationManager ← store(db) / registry / hooks / publish(sseHub) / logger / secrets
 * - ChatService ← store(db) / hooks / publish(sseHub) / emit(eventBus) / logger /
 *   bridgeDispatch → ChatBridgeDispatcher ← registry / meta.bridges / deliveries 落库
 * - FileService ← createLocalDriver(dataDir/uploads) / db / hooks / emit(eventBus) / logger
 * - TaskManager ← store(db) / pool 懒门面（指向后构造的 TaskWorkerPool，规避互指构造顺序）/
 *   emit(eventBus) / publish(sseHub) / logger
 */
import { join } from 'node:path';
import { HOST_METHODS } from '../../extension-host/protocol.js';

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Logger } from 'pino';

import { registerChatRoutes } from '../../api/chat.js';
import { registerFileRoutes } from '../../api/files.js';
import { registerLlmRoutes } from '../../api/llm.js';
import { registerNotificationRoutes } from '../../api/notifications.js';
import { registerTaskRoutes } from '../../api/tasks.js';
import type { AuthIdentity, AuthVerifyInput } from '../auth/types.js';
import { ChannelRegistry, type ChannelLevel } from '../channels/index.js';
import { type ChannelBridgeConfig, createEmailBridge, createWebhookBridge, ChatBridgeDispatcher } from '../chat/bridges.js';
import { ChatService } from '../chat/service.js';
import { ChatStore } from '../chat/store.js';
import type { HarnessConfig } from '../config/index.js';
import { CONTAINER_KEYS, type Kernel } from '../Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import { FileService, createLocalDriver } from '../files/index.js';
import type { EventBus } from '../events/bus.js';
import type { HookManager } from '../hooks/manager.js';
import { LlmGateway } from '../llm/gateway.js';
import type { LlmChatInput, LlmProviderConfig, LlmStreamEvent } from '../llm/types.js';
import { NotificationStore, NotificationManager, createConsoleDriver, createWebhookDriver, inboxDriver } from '../notification/index.js';
import { createEmailDriver } from '../notification/drivers/email.js';
import { TaskManager, TaskStore, TaskWorkerPool } from '../tasks/index.js';
import type { SecretsService } from '../storage/secrets.js';
import type { SettingsService } from '../storage/settings.js';
import type { SseHub } from '../http/sse/hub.js';

/** 通知默认渠道路由规则的 settings 键（PUT/GET /api/v1/notifications/routes 透传） */
const NOTIFY_ROUTES_KEY = 'notify.routes';

/** LLM 供应商配置数组的 settings 键（PUT/GET /api/v1/llm/providers 落点） */
const LLM_PROVIDERS_KEY = 'llm.providers';

/** chat 桥投递流水表（内核迁移 014） */
const DELIVERIES_TABLE = 'deliveries';

/** TaskManager 默认任务超时（毫秒）：派发任务超过该时长由 sweep 判 failed('timeout') */
const CORE_TASK_TIMEOUT_MS = 600_000;

/** hook 链门面的最小结构视图（内核 HookManager 天然满足） */
type HookPort = {
  apply(name: string, value: unknown, ctx?: { meta?: Record<string, unknown> }): Promise<unknown>;
};

/** 内核统一认证入口（createAuthChecker 产物）的结构视图 */
type AuthChecker = (input: AuthVerifyInput) => Promise<AuthIdentity>;

/** 核心服务总装配面：路由挂载 + 生命周期（TaskManager 托管） */
export interface CoreServices {
  /** 向 fastify 实例挂载 files / notifications / chat / tasks REST 模块（ready 前调用） */
  registerRoutes(app: FastifyInstance): void;
  /** 启动核心服务（TaskManager.start：工作线程池 + 超时 sweep） */
  start(): Promise<void>;
  /** 停止核心服务（TaskManager.stop：排队/在途任务判失败 → 终止线程） */
  stop(): Promise<void>;
}

/**
 * channels.meta.bridges → 桥配置数组。
 * meta 非（对象 + bridges 数组）一律回退 []；单条缺 driver 丢弃；target 形状由桥驱动自校验。
 */
function bridgesFromMeta(meta: unknown): ChannelBridgeConfig[] {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const bridges = (meta as Record<string, unknown>)['bridges'];
  if (!Array.isArray(bridges)) return [];
  const out: ChannelBridgeConfig[] = [];
  for (const item of bridges) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec['driver'] !== 'string' || rec['driver'] === '') continue;
    out.push({ driver: rec['driver'], target: rec['target'] });
  }
  return out;
}

/**
 * 总装配内核核心服务（见模块头注释）。幂等性由 Kernel 保证（boot 一次）。
 * 注册进容器的 key：'channels.registry' / 'notify' / 'chat' / 'files' / 'tasks'。
 */
export function createCoreServices(kernel: Kernel): CoreServices {
  // -------------------------------------------------------------------------
  // 基础设施解析（全部由 Kernel 在 boot 前段登记）
  // -------------------------------------------------------------------------
  const config = kernel.container.resolve<HarnessConfig>(CONTAINER_KEYS.config);
  const logger = kernel.container.resolve<Logger>(CONTAINER_KEYS.logger);
  const checker = kernel.container.resolve<AuthChecker>(CONTAINER_KEYS.authChecker);
  const db = kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
  const settings = kernel.container.resolve<SettingsService>(CONTAINER_KEYS.settings);
  const secrets = kernel.container.resolve<SecretsService>(CONTAINER_KEYS.secrets);
  // 内核级计数器：当前核心服务无直接消费者，随装配解析以保证与 CONTAINER_KEYS 契约一致
  void kernel.container.resolve(CONTAINER_KEYS.counters);
  const hub = kernel.container.resolve<SseHub>(CONTAINER_KEYS.sseHub);
  const eventBus = kernel.container.resolve<EventBus>(FACADE_CONTAINER_KEYS.eventBus);
  const hooks = kernel.container.resolve<HookManager>(FACADE_CONTAINER_KEYS.hookManager);

  /** hook 链门面（各服务共用同一 HookManager） */
  const hookPort: HookPort = { apply: (name, value, ctx) => hooks.apply(name, value, ctx) };
  /** SSE 广播门面（fire-and-forget，同步返回） */
  const publish = (topic: string, event: string, data: unknown): void => hub.publish(topic, event, data);
  /** 事件总线门面（监听器异常已被 EventBus 隔离） */
  const emit = (name: string, payload: unknown, opts?: { source?: string }): Promise<unknown> =>
    eventBus.emit(name, payload, opts);

  // -------------------------------------------------------------------------
  // channels — 渠道驱动注册中心（Notification 与 Chat 共用单例）
  // -------------------------------------------------------------------------
  const registry = new ChannelRegistry();
  registry.registerNotificationDriver(inboxDriver);
  registry.registerNotificationDriver(createWebhookDriver({ resolveSecret: (ref) => secrets.get(ref) }));
  registry.registerNotificationDriver(createConsoleDriver(logger));
  registry.registerNotificationDriver(createEmailDriver({ resolveSecret: (ref) => secrets.get(ref) }));
  // 聊天桥的 resolveSecret 契约是 string | undefined（空/缺失即投递失败），null 归一为 undefined
  const resolveBridgeSecret = async (ref: string): Promise<string | undefined> => (await secrets.get(ref)) ?? undefined;
  registry.registerChatBridgeDriver(createWebhookBridge({ resolveSecret: resolveBridgeSecret }));
  registry.registerChatBridgeDriver(createEmailBridge({ resolveSecret: resolveBridgeSecret }));
  kernel.container.instance(CONTAINER_KEYS.channels, registry);

  // -------------------------------------------------------------------------
  // notification — 通知中心（入库 → SSE created → 渠道投递）
  // -------------------------------------------------------------------------
  const notifyStore = new NotificationStore(db);
  const notifyManager = new NotificationManager({
    store: notifyStore,
    registry,
    hooks: hookPort,
    publish,
    logger,
    secrets,
    // 默认渠道路由规则（settings 'notify.routes'，与 REST routes API 同一落点）：
    // send 未显式传入 channels 时按 level 匹配追加投递计划
    getRoutes: () => settings.get(NOTIFY_ROUTES_KEY, [] as unknown),
  });
  kernel.container.instance(CONTAINER_KEYS.notify, notifyManager);

  // -------------------------------------------------------------------------
  // chat — 聊天服务 + 桥分发器
  // -------------------------------------------------------------------------

  // ChatBridgeDispatcher.getChannelBridges 是同步契约，而频道行（含 meta.bridges）由
  // ChatService 在 bridgeDispatch 时持有。以"同步交接表"桥接两侧：bridgeDispatch 先把
  // meta.bridges 放入表，dispatcher.dispatch 的同步前缀立即读取，结束后清理
  // （set → 同步读发生在同一宏任务内，不存在并发窗口）。
  const dispatchBridges = new Map<string, ChannelBridgeConfig[]>();
  const dispatcher = new ChatBridgeDispatcher({
    registry,
    getChannelBridges: (channelId) => dispatchBridges.get(channelId) ?? [],
    recordDelivery: (entry) => {
      // 投递流水落库（migration 014 deliveries）；失败只记日志，不影响投递结果
      void db(DELIVERIES_TABLE)
        .insert({
          kind: entry.kind,
          target: String(entry.target),
          channel: entry.channel,
          ok: entry.ok ? 1 : 0,
          duration_ms: entry.durationMs ?? null,
          error: entry.error ?? null,
          created_at: Date.now(),
        })
        .catch((e: unknown) => {
          logger.error({ err: e, kind: entry.kind }, '[core-services] delivery record insert failed');
        });
    },
    logger,
  });

  const chatStore = new ChatStore(db);
  const chatService = new ChatService({
    store: chatStore,
    hooks: hookPort,
    publish,
    emit,
    logger,
    bridgeDispatch: (message, channel) => {
      dispatchBridges.set(channel.id, bridgesFromMeta(channel.meta));
      return dispatcher.dispatch(message, { id: channel.id, slug: channel.slug }).finally(() => {
        dispatchBridges.delete(channel.id);
      });
    },
  });
  kernel.container.instance(CONTAINER_KEYS.chat, chatService);

  // -------------------------------------------------------------------------
  // files — 本地磁盘文件存储
  // -------------------------------------------------------------------------
  const fileService = new FileService({
    driver: createLocalDriver(join(config.dataDir, 'uploads')),
    db,
    hooks: hookPort,
    emit,
    logger,
    maxUploadBytes: config.maxUploadBytes,
  });
  kernel.container.instance(CONTAINER_KEYS.files, fileService);

  // -------------------------------------------------------------------------
  // tasks — 长任务（严格按 src/kernel/tasks/index.ts 桶注释的组装示例；
  // manager 先构造、pool 后构造，经懒门面互指；回调以箭头包装保持 this 绑定）
  // -------------------------------------------------------------------------
  const taskStore = new TaskStore(db);
  let pool: TaskWorkerPool;
  const poolFacade = {
    async start(): Promise<void> {
      await pool.start();
    },
    async stop(): Promise<void> {
      await pool.stop();
    },
    run(taskId: string, name: string, args: unknown): Promise<void> {
      return pool.run(taskId, name, args);
    },
  };
  const taskManager = new TaskManager({
    store: taskStore,
    pool: poolFacade,
    emit,
    publish,
    logger,
    defaultTimeoutMs: CORE_TASK_TIMEOUT_MS,
    // 扩展任务执行器：非内置任务改派给扩展线程（host.taskRun），进度/完成经 task.* topic 回流
    externalExecutor:
      kernel === undefined
        ? undefined
        : (extId: string, taskId: string, name: string, args: unknown) => {
            const manager = kernel.container.resolve<import('../../kernel/extensions/manager.js').ExtensionManager>(
              CONTAINER_KEYS.extManager,
            );
            const bridge = manager.bridge;
            if (bridge === null) {
              throw new Error('extension bridge is not available (worker restarting)');
            }
            return bridge.callToWorker(
              extId,
              HOST_METHODS.taskRun,
              { taskId, name, args },
              600_000,
            ).then(() => undefined);
          },
  });
  pool = new TaskWorkerPool({
    size: config.taskWorkers,
    logger,
    onProgress: (taskId, pct, msg) => taskManager.onProgress(taskId, pct, msg),
    onDone: (taskId, result) => taskManager.onDone(taskId, result),
    onFailed: (taskId, error) => taskManager.onFailed(taskId, error),
  });
  kernel.container.instance(CONTAINER_KEYS.tasks, taskManager);

  // -------------------------------------------------------------------------
  // llm — LLM 网关（阶段 10 总装配）
  // 供应商配置存 settings（'llm.providers'），apiKey 明文经 PUT providers 自动转存
  // secrets（键 'llm.<name>'），配置层只留 apiKeySecretRef 引用；密钥永不落配置/日志。
  // -------------------------------------------------------------------------
  const gateway = new LlmGateway({
    getProviders: async () =>
      (await settings.get(LLM_PROVIDERS_KEY, [] as LlmProviderConfig[])) as LlmProviderConfig[],
    resolveSecret: (ref) => secrets.get(ref),
    logger,
  });
  kernel.container.instance(CONTAINER_KEYS.llm, gateway);

  /** gateway.chat(stream:true) 的同步生成器适配：解包 Promise 后 yield* 委派给协议 adapter 流 */
  async function* gatewayStream(input: LlmChatInput): AsyncGenerator<LlmStreamEvent, void, unknown> {
    const inner = (await gateway.chat({ ...input, stream: true })) as AsyncGenerator<LlmStreamEvent>;
    yield* inner;
  }

  return {
    registerRoutes(app: FastifyInstance): void {
      registerFileRoutes(app, {
        checker,
        service: fileService,
        maxUploadBytes: config.maxUploadBytes,
      });
      registerNotificationRoutes(app, {
        checker,
        store: notifyStore,
        getRoutes: () => settings.get(NOTIFY_ROUTES_KEY, [] as unknown),
        setRoutes: (rules) => settings.set(NOTIFY_ROUTES_KEY, rules),
        drivers: () => ({
          notification: registry.listNotificationDrivers(),
          chat: registry.listChatBridgeDrivers(),
        }),
        send: (input) =>
          notifyManager.send({
            title: input.title,
            body: input.body,
            // REST 层 level 为 open string，通知中心内部 zod 复核（非法值 → 400 VALIDATION_FAILED）
            level: input.level as ChannelLevel,
            data: input.data,
            // REST 契约只传驱动名；target 形状由各驱动自行校验（inbox 等无目标驱动天然兼容）
            channels: input.channels.map((driver) => ({ driver, target: {} })),
          }),
      });
      registerChatRoutes(app, { checker, service: chatService });
      registerTaskRoutes(app, { checker, manager: taskManager });
      // LLM 网关 REST（/api/v1/llm/*）：providers 管理的持久化即 settings 读写；
      // secrets 注入使 PUT 支持 apiKey 明文 → 自动转存（键 'llm.<name>'）
      registerLlmRoutes(app, {
        checker,
        gateway,
        gatewayStream: (input) => gatewayStream(input as LlmChatInput),
        providersAdmin: {
          list: async () => settings.get(LLM_PROVIDERS_KEY, [] as unknown),
          set: async (providers) => settings.set(LLM_PROVIDERS_KEY, providers),
        },
        secrets,
      });
    },

    async start(): Promise<void> {
      await taskManager.start();
    },

    async stop(): Promise<void> {
      await taskManager.stop();
    },
  };
}
