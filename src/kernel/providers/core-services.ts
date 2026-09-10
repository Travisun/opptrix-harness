/**
 * core-services — 内核核心服务总装配（channels / notification / chat / files / tasks /
 * skills / mcp / plugins）。
 *
 * 由 Kernel 在 boot 的 cron 装配之后调用 `createCoreServices(kernel)`：
 * - 从容器 resolve 基础设施（config / logger / authChecker / db / settings / secrets /
 *   counters + sseHub + 事件总线 / hook 管理器门面）；
 * - 组装领域服务并登记进容器（CONTAINER_KEYS.channels / notify / chat / files / tasks /
 *   skills.registry / mcp.config / mcp.registry / plugins.registry / ext.bridges）；
 * - `registerRoutes(app)` 把 REST 模块挂到 fastify 实例（由 Kernel 的 registerExtra 调用）；
 * - `start()` / `stop()` 托管 TaskManager 生命周期 + skills/plugins 聚合 + MCP 连接
 *   （core 先于 cron 启动，先于 cron 停止）。
 *
 * 装配图（谁依赖谁）：
 * - registry（ChannelRegistry 单例）← 通知驱动 ×4（inbox/webhook/console/email）
 *   + 聊天桥 ×2（webhook/email）+ 平台连接器 ×5（telegram/slack/feishu/dingtalk/wecom，
 *   兼出站驱动与 /hooks/connector/* 入站回调）；secrets.get 作为统一密钥解析源
 * - NotificationManager ← store(db) / registry / hooks / publish(sseHub) / logger / secrets
 * - ChatService ← store(db) / hooks / publish(sseHub) / emit(eventBus) / logger /
 *   bridgeDispatch → ChatBridgeDispatcher ← registry / meta.bridges / deliveries 落库
 * - FileService ← createLocalDriver(dataDir/uploads) / db / hooks / emit(eventBus) / logger
 * - TaskManager ← store(db) / pool 懒门面（指向后构造的 TaskWorkerPool，规避互指构造顺序）/
 *   emit(eventBus) / publish(sseHub) / logger
 * - SkillRegistry ← roots(repoRoot/skills=builtin + dataDir/skills=data) / logger；
 *   McpConfigStore(dataDir) + McpRegistry ← configStore / logger；PluginRegistry ←
 *   dataDir / logger / skillsRegistry（直接透传） / mcpRegistry 适配器（configStore +
 *   connect 编排，id 冠前缀归一）/ scriptRunner（沙箱容器执行，未启用 → NOT_IMPLEMENTED）
 * - MemoryManager ← MemoryStore(db) + createMemoryExtractor({ gateway })；AsrManager ←
 *   modelDir(<dataDir>/models/asr)；FileExtractService ← files / db / 任务池适配器
 *   （TaskManager.dispatch('file-extract') → 线程池，完成态经事件总线回流）
 * - AgentSessionManager ← AgentSessionStore(db) + gateway(chat/getProviders 绑定) + settings +
 *   systemRuntime(currentSystemRuntime 懒解析) + publish(sseHub)——会话子系统
 *   （'agents.sessionManager'；REST /api/v1/agents/sessions*）
 * - FlowManager ← FlowEndpointStore(db) + secrets + gateway/notifications 调用期懒解析 +
 *   publish(sseHub)（'flows.manager'；REST /api/v1/flows/endpoints* + 公开入站 /hooks/flow/:slug）
 * - 三桥（skills.* / mcp.* / plugins.*）+ 三能力桥（memory.* / asr.* / extract.*）并表
 *   登记容器 'ext.bridges'，由 Kernel 经 createKernelHandlers({ extraBridges }) 懒合入
 *   worker→kernel 分发表；权限由桥工厂自查（'skills' / 'mcp:client' / 'plugins' /
 *   'memory' / 'asr' / 'files:read'），kernel-handlers 的 TOPIC_PERMISSIONS
 *   矩阵刻意不重复收口（避免双闸口径漂移）。
 */
import { cpSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { Logger } from 'pino';

import { registerAsrRoutes } from '../../api/asr.js';
import { registerAgentRoutes } from '../../api/agents.js';
import { registerChatRoutes } from '../../api/chat.js';
import { registerExtractRoutes } from '../../api/extract.js';
import { registerFileRoutes } from '../../api/files.js';
import { registerFlowRoutes } from '../../api/flows.js';
import { registerLlmRoutes } from '../../api/llm.js';
import { registerMemoryRoutes } from '../../api/memory.js';
import { registerMcpRoutes } from '../../api/mcp.js';
import { registerNotificationRoutes } from '../../api/notifications.js';
import { createChannelConfigStore } from '../notification/channel-configs.js';
import { runAgentLoop, type AgentLoopToolRuntime } from '../agents/runner.js';
import { AgentSessionManager } from '../agents/session.js';
import { AgentSessionStore } from '../agents/session-store.js';
import { SUBAGENT_MANAGER_CONTAINER_KEYS } from '../mcp/system-tools.js';
import { SubagentManager } from '../agents/manager.js';
import { SubagentStore } from '../agents/store.js';
import { currentSystemRuntime, type SystemToolRuntime } from '../mcp/system-server.js';
import { SYSTEM_TOOLS_CONTAINER_KEY } from '../mcp/system-tools.js';
import { registerPluginRoutes } from '../../api/plugins.js';
import { registerSkillRoutes } from '../../api/skills.js';
import { registerSubagentRoutes } from '../../api/subagents.js';
import { registerTaskRoutes } from '../../api/tasks.js';
import { HOST_METHODS, KERNEL_TOPICS } from '../../extension-host/protocol.js';
import type { ExtensionManager } from '../extensions/manager.js';
import type { AuthIdentity, AuthVerifyInput } from '../auth/types.js';
import { ChannelRegistry, type ChannelLevel } from '../channels/index.js';
import { type ChannelBridgeConfig, createEmailBridge, createWebhookBridge, ChatBridgeDispatcher } from '../chat/bridges.js';
import { createPlatformConnectors } from '../chat/connectors/index.js';
import { ChatService } from '../chat/service.js';
import { ChatStore } from '../chat/store.js';
import { createLlmJobRunner } from '../cron/llm-job.js';
import type { HarnessConfig } from '../config/index.js';
import { CONTAINER_KEYS, type Kernel } from '../Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import { err } from '../errors/index.js';
import { FileService, createLocalDriver } from '../files/index.js';
import { FlowManager } from '../flow/index.js';
import type { FlowLlmGatewayLike, FlowNotifierLike } from '../flow/types.js';
import type { EventBus } from '../events/bus.js';
import type { HookManager } from '../hooks/manager.js';
import { EVENT_NS } from '../hooks/points.js';
import { LlmGateway } from '../llm/gateway.js';
import type { LlmChatInput, LlmProviderConfig, LlmStreamEvent, LlmChatResult } from '../llm/types.js';
import { createMcpBridge, McpConfigStore, McpRegistry, MCP_CLIENT_PERMISSION } from '../mcp/index.js';
import {
  createMemoryBridge,
  createMemoryExtractor,
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTINGS_KEY,
  MemoryManager,
  MemoryStore,
  mergeMemorySettings,
} from '../memory/index.js';
import { NotificationStore, NotificationManager, createConsoleDriver, createWebhookDriver, inboxDriver } from '../notification/index.js';
import { createEmailDriver } from '../notification/drivers/email.js';
import {
  createPluginsBridge,
  installPluginZip,
  isSafePluginRelativePath,
  PluginRegistry,
} from '../plugins/index.js';
import type { McpRegistryLike, PluginMcpServerConfig, ScriptRunnerLike } from '../plugins/types.js';
import { createFileExtractBridge, EXTRACT_TASK_NAME, FileExtractService } from '../fileextract/index.js';
import type { ExtractResult, ExtractTaskArgs, ExtractTaskPool } from '../fileextract/types.js';
import { CodingEngine, createCodingBridge } from '../coding/index.js';
import { createAsrBridge, AsrManager } from '../asr/index.js';
import { BrowserEngine, createBrowserBridge } from '../browser/index.js';
import type { SandboxManager } from '../sandbox/manager.js';
import { createSkillsBridge, deleteSkill, SkillRegistry, writeSkill } from '../skills/index.js';
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

/** 提取任务池派发的等待上限（毫秒）：与提取主线程整体超时（EXTRACT_SYNC_TIMEOUT_MS）同量级 */
const EXTRACT_POOL_WAIT_MS = 300_000;

// ---- Skills / MCP / 插件（OS 能力目录）----

/** 仓库根目录（本文件位于 src/kernel/providers/ → 向上三级；dist/kernel/providers/ 同理） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** skills 桥读面的 manifest 权限（skills.list/get/refresh；skills.register 贡献面免权限） */
const SKILLS_PERMISSION = 'skills';

/** plugins 桥的 manifest 权限（plugins.list） */
const PLUGINS_PERMISSION = 'plugins';

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
  // 平台连接器（telegram / slack / feishu / dingtalk / wecom）：主流 IM 接入框架——
  // 入站统一回调 /hooks/connector/:platform/:token + 出站平台 API 投递（与上面
  // webhook/email 纯出站桥并存）。出站投递目标 target 形状见各驱动 zod
  // （文档站 docs/chat-platforms.mdx 平台矩阵）；iMessage 无运行时驱动（文档「探索结论」）。
  const platformConnectors = createPlatformConnectors();
  for (const driver of platformConnectors.bridgeDrivers()) {
    registry.registerChatBridgeDriver(driver);
  }
  kernel.container.instance(CONTAINER_KEYS.channels, registry);

  // -------------------------------------------------------------------------
  // notification — 通知中心（入库 → SSE created → 渠道投递）
  // -------------------------------------------------------------------------
  const notifyStore = new NotificationStore(db);
  const channelConfigStore = createChannelConfigStore(settings);
  const notifyManager = new NotificationManager({
    store: notifyStore,
    registry,
    hooks: hookPort,
    publish,
    logger,
    secrets,
    getChannelConfigs: async () => {
      const configs = await channelConfigStore.listEnabled();
      return configs.map((ch) => ({ driver: ch.type, target: ch.target }));
    },
    // 默认渠道路由规则（settings 'notify.routes'，与 REST routes API 同一落点）：
    // send 未显式传入 channels 时按 level 匹配追加投递计划
    getRoutes: () => settings.get(NOTIFY_ROUTES_KEY, [] as unknown),
    // 投递重试覆盖（settings 'notify.retry'，缺省走驱动缺省表）
    getRetry: () => settings.get('notify.retry', null as unknown),
    // 投递记录落库（deliveries 表，migration 014）：kind='notification'
    recordDelivery: (entry) => {
      void db(DELIVERIES_TABLE)
        .insert({
          kind: 'notification',
          target: String(entry.target),
          channel: entry.channel,
          ok: entry.ok ? 1 : 0,
          duration_ms: entry.durationMs ?? null,
          error: entry.error ?? null,
          created_at: Date.now(),
        })
        .catch((e: unknown) => {
          logger.error({ err: e }, '[core-services] notification delivery record insert failed');
        });
    },
  });
  kernel.container.instance(CONTAINER_KEYS.notify, notifyManager);

  // -------------------------------------------------------------------------
  // flow — 传入 Webhook / FlowTrigger（公开入站 /hooks/flow/:slug → log/notify/llm 分派）。
  // gateway / notifications 走**调用期懒解析**（装配时序无关——此刻部分容器键虽已登记，
  // 但保持与子代理 agentToolsRuntime 同款懒门面，测试亦可在 boot 后替换容器实现注入
  // mock）；SSE 广播复用与通知同一 publish 绑定（topic `flow:{endpointId}`）。
  // -------------------------------------------------------------------------
  const flowGateway: () => FlowLlmGatewayLike | undefined = () => {
    if (!kernel.container.has(CONTAINER_KEYS.llm)) return undefined;
    const gw = kernel.container.resolve<LlmGateway>(CONTAINER_KEYS.llm);
    return {
      chat: async (input) =>
        (await gw.chat({ ...(input as LlmChatInput), stream: false })) as LlmChatResult,
      getProviders: () => gw.getProviders(),
    };
  };
  const flowNotifier: () => FlowNotifierLike | undefined = () => {
    if (!kernel.container.has(CONTAINER_KEYS.notify)) return undefined;
    const nm = kernel.container.resolve<NotificationManager>(CONTAINER_KEYS.notify);
    return {
      send: (input) =>
        nm.send({
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          // level 交通知中心 zod 复核（非法值 → VALIDATION_FAILED → 事件标 failed）
          ...(input.level !== undefined ? { level: input.level as ChannelLevel } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
        }),
    };
  };
  const flowManager = new FlowManager({
    db,
    secrets,
    logger,
    gateway: flowGateway,
    notifications: flowNotifier,
    publish,
  });
  kernel.container.instance(CONTAINER_KEYS.flows, flowManager);

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
            // 双池化：按扩展归属池取桥（跨线程 RPC 必须发到扩展所在的 worker）
            const bridge = manager.bridgeFor(extId);
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

  // -------------------------------------------------------------------------
  // memory — 全局 LLM 记忆系统（内核全局库 memories 表 + FTS5；LLM 抽取管线走网关）。
  // REST /api/v1/memory*（settings 面读 settings 'memory.settings'，PUT 联动容量上限）
  // 与扩展桥 memory.*（manifest 'memory' 权限）共用同一 manager。
  // -------------------------------------------------------------------------
  const memoryManager = new MemoryManager({
    store: new MemoryStore(db),
    extractor: createMemoryExtractor({ gateway }),
  });
  kernel.container.instance(CONTAINER_KEYS.memoryManager, memoryManager);
  // 容量上限以持久化设置为准（缺省 10000；PUT /api/v1/memory/settings 运行期再联动）。
  // settings 预读失败不阻塞装配（按缺省容量运行，REST 层读取设置另有兜底）。
  void settings
    .get<unknown>(MEMORY_SETTINGS_KEY, DEFAULT_MEMORY_SETTINGS)
    .then((raw) => {
      memoryManager.setMaxMemories(mergeMemorySettings(raw).maxMemories);
    })
    .catch((cause: unknown) => {
      logger.warn({ err: cause }, '[core-services] memory settings preload failed (defaults apply)');
    });

  // -------------------------------------------------------------------------
  // asr — 语音识别（Whisper；模型目录 <dataDir>/models/asr，boot 期后台静默下载）。
  // env 透传：HARNESS_ASR_ENABLED=false 整体关闭；HARNESS_ASR_AUTO_DOWNLOAD=0 关自动下载；
  // HARNESS_ASR_MODEL / 镜像链 base 由 downloader/manager 自行读取，不在此重复裁决。
  // -------------------------------------------------------------------------
  const asrManager = new AsrManager({
    modelDir: join(config.dataDir, 'models', 'asr'),
    logger,
    // 缺省开启后台静默下载（env HARNESS_ASR_AUTO_DOWNLOAD=0 显式关闭）
    autoDownload: process.env['HARNESS_ASR_AUTO_DOWNLOAD'] !== '0',
  });
  kernel.container.instance(CONTAINER_KEYS.asrManager, asrManager);

  // -------------------------------------------------------------------------
  // fileextract — 文件内容提取（级联引擎 + OCR 升级 + file_extracts 惰性落库）。
  // OCR 模型目录 <dataDir>/models/ocr；HARNESS_OCR_AUTO_DOWNLOAD=1 才允许提取时自动下载
  // （缺省关，模型四件套不外联）。CPU 密集提取优先派任务线程池（name 'file-extract'，
  // task-worker fn 表注册执行器），派发失败由服务回退主线程执行并附警告。
  // -------------------------------------------------------------------------
  /**
   * TaskManager → ExtractTaskPool 适配器：dispatch 落库 + 线程池执行（REST /api/v1/tasks
   * 同款管线，任务可观测可取消），完成态经事件总线回流为池结果。run 的 reject 语义
   * 供 FileExtractService 回退主线程执行（附警告），不存在未处理 rejection。
   */
  const extractTaskPool: ExtractTaskPool = {
    run(_jobId: string, args: ExtractTaskArgs): Promise<ExtractResult> {
      return taskManager.dispatch({ name: EXTRACT_TASK_NAME, args }).then(
        (record) =>
          new Promise<ExtractResult>((resolve, reject) => {
            let offDone: () => void = () => {};
            let offFailed: () => void = () => {};
            const settle = (finish: () => void): void => {
              clearTimeout(timer);
              offDone();
              offFailed();
              finish();
            };
            const timer = setTimeout(() => {
              settle(() =>
                reject(new Error(`file-extract task ${record.id} timed out after ${EXTRACT_POOL_WAIT_MS}ms`)),
              );
            }, EXTRACT_POOL_WAIT_MS);
            offDone = eventBus.on('task.completed', (payload) => {
              const p = (payload ?? {}) as { id?: unknown; result?: unknown };
              if (p.id !== record.id) return;
              settle(() => resolve(p.result as ExtractResult));
            });
            offFailed = eventBus.on('task.failed', (payload) => {
              const p = (payload ?? {}) as { id?: unknown; error?: unknown };
              if (p.id !== record.id) return;
              settle(() =>
                reject(
                  new Error(
                    typeof p.error === 'string' && p.error !== '' ? p.error : 'file-extract task failed',
                  ),
                ),
              );
            });
          }),
      );
    },
  };

  const fileExtractService = new FileExtractService({
    dataDir: config.dataDir,
    autoDownload: process.env['HARNESS_OCR_AUTO_DOWNLOAD'] === '1',
    logger,
    files: fileService,
    db,
    taskPool: extractTaskPool,
  });
  kernel.container.instance(CONTAINER_KEYS.fileExtract, fileExtractService);

  // -------------------------------------------------------------------------
  // coding — 沙箱化代码执行会话（受控子进程路径：会话目录 + 命令白名单 + argv 直传）。
  // 引擎无独立生命周期（目录即事实、无定时器）；扩展桥 coding.* 与系统 MCP 工具
  // coding_* 共用同一实例（容器 'coding.engine'）。选型依据见 src/kernel/coding/index.ts。
  // -------------------------------------------------------------------------
  const codingEngine = new CodingEngine({ dataDir: config.dataDir, logger });
  kernel.container.instance(CONTAINER_KEYS.coding, codingEngine);

  // -------------------------------------------------------------------------
  // browser — 浏览器自动化内核引擎（Playwright 跑内核主线程；方案 B，doc-extract 同款）。
  // 扩展沙箱（worker_threads + vm.Context 受限 require）无法加载 Playwright——探针
  // 证据见 extensions/browser/README.md。浏览器二进制默认不下载（~150MB 重依赖）：
  // 未安装时工具/桥统一收敛 browser_not_installed 结构化错误，POST /ext/browser/install
  // 触发后台安装。扩展桥 browser.*（manifest 'browser' 权限）与系统 MCP 工具 browser_*
  // 共用同一实例（容器 'browser.engine'）。
  // -------------------------------------------------------------------------
  const browserEngine = new BrowserEngine({ dataDir: config.dataDir, logger });
  kernel.container.instance(CONTAINER_KEYS.browserEngine, browserEngine);

  // -------------------------------------------------------------------------
  // agents —— LLM 子代理运行时（严格父子树；工具循环 = 系统 MCP 工具目录）
  // -------------------------------------------------------------------------
  // 系统工具运行时由 Kernel 在 /mcp 接线时创建并 attach（共享槽）；
  // core-services 装配早于该时点，故此处只做懒解析（调用期必然已 attach）
  const agentToolsRuntime: AgentLoopToolRuntime = {
    listSchemas: () => {
      const rt = currentSystemRuntime();
      return rt ? rt.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [];
    },
    execute: async (name: string, args: unknown, ctx: { agentId: string; depth: number }) => {
      const rt = currentSystemRuntime();
      if (rt === undefined) return { isError: true, error: 'system tool runtime is not attached yet' };
      return rt.call(name, args ?? {}, { agentId: ctx.agentId, depth: ctx.depth });
    },
  };
  const subagentStore = new SubagentStore(db);
  // 并发缺省不在此显式传入：maxConcurrent / maxChildrenPerParent 未传 → manager 缺省吃
  // runtime-profile 画像值（按核数自适应）；显式覆盖仍以 deps 传入为准。
  const subagentManager = new SubagentManager({
    store: subagentStore,
    runner: async (input, onEvent) => {
      // 模型解析链：显式 model → settings 'subagents.defaultModel' → 第一可用 provider 缺省模型
      let model = input.model;
      if (model === undefined || model === '') {
        const configured = (await settings.get('subagents.defaultModel', '' as unknown)) as string;
        if (typeof configured === 'string' && configured !== '') model = configured;
      }
      if (model === undefined || model === '') {
        const providers = await gateway.getProviders();
        model = providers.find((p) => p.models.length > 0)?.models[0];
      }
      const result = await runAgentLoop(
        {
          gateway: {
            chat: (chatInput) =>
              gateway.chat({ ...(chatInput as LlmChatInput), stream: false }) as Promise<LlmChatResult>,
          },
          tools: agentToolsRuntime satisfies AgentLoopToolRuntime,
          logger,
        },
        {
          agentId: input.agentId,
          depth: input.depth,
          systemPrompt: input.systemPrompt,
          prompt: input.prompt,
          model,
          toolNames: input.toolNames,
          maxIterations: input.maxIterations,
          signal: input.signal,
        },
      );
      await onEvent({
        type: 'done',
        result: result.finalText,
        usageIn: result.usage.inputTokens,
        usageOut: result.usage.outputTokens,
        transcript: result.messages,
      } as never);
    },
    notify: { send: (i) => notifyManager.send(i as never) },
    logger,
  });
  kernel.container.instance('subagents.manager', subagentManager);

  /** gateway.chat(stream:true) 的同步生成器适配：解包 Promise 后 yield* 委派给协议 adapter 流 */
  async function* gatewayStream(input: LlmChatInput): AsyncGenerator<LlmStreamEvent, void, unknown> {
    const inner = (await gateway.chat({ ...input, stream: true })) as AsyncGenerator<LlmStreamEvent>;
    yield* inner;
  }

  // -------------------------------------------------------------------------
  // cron × llm — LLM 提示词定时任务（payload.kind==='llm'）派发。
  // 内核 #onCronFire 触发管线广播 `kernel.cron.fired`（EventBus 顺序 await 监听器、
  // 单点异常隔离），本监听对 llm 负载执行提示词并投递结果通知（runNow / 定时触发
  // 均在事件投递内同步完成，运行历史落库晚于本执行）。kind 缺省的任务维持现状
  // （v1 普通任务=仅事件广播），扩展任务照旧由扩展子系统按名派发。执行语义与
  // 模型回退（指定模型失败 → 第一可用 provider 缺省模型重试一次）见 cron/llm-job.ts。
  // -------------------------------------------------------------------------
  const llmJobRunner = createLlmJobRunner({
    gateway,
    getProviders: async () => {
      const providers = (await settings.get(LLM_PROVIDERS_KEY, [] as LlmProviderConfig[])) as LlmProviderConfig[];
      return providers.map((provider) => ({
        name: provider.name,
        models: Array.isArray(provider.models) ? provider.models : [],
      }));
    },
    notify: notifyManager,
    logger,
  });

  /** cron 负载是否为 LLM 提示词自动化形状（对象且 kind === 'llm'） */
  const isLlmJobPayload = (payload: unknown): payload is Record<string, unknown> =>
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>)['kind'] === 'llm';

  eventBus.on(`${EVENT_NS.kernel}.cron.fired`, async (raw) => {
    const fired = (raw ?? {}) as { jobId?: unknown; name?: unknown; payload?: unknown };
    if (typeof fired.name !== 'string' || fired.name === '' || !isLlmJobPayload(fired.payload)) return;
    const jobPayload = fired.payload;
    try {
      const result = await llmJobRunner.run(
        {
          prompt: typeof jobPayload['prompt'] === 'string' ? jobPayload['prompt'] : '',
          ...(typeof jobPayload['model'] === 'string' && jobPayload['model'] !== ''
            ? { model: jobPayload['model'] }
            : {}),
          ...(typeof jobPayload['notify'] === 'boolean' ? { notify: jobPayload['notify'] } : {}),
        },
        { jobName: fired.name },
      );
      logger.info(
        { jobId: fired.jobId, jobName: fired.name, ok: result.ok },
        'core-services: llm prompt cron job finished',
      );
    } catch (cause) {
      // 兜底（runner.run 约定不抛）：意外异常 → error 通知，绝不外溢到事件总线之外
      logger.error({ err: cause, jobId: fired.jobId, jobName: fired.name }, 'core-services: llm prompt cron job crashed');
      if (jobPayload['notify'] !== false) {
        try {
          await notifyManager.send({
            title: `自动化「${fired.name}」完成`,
            body: `执行失败：${cause instanceof Error ? cause.message : String(cause)}`,
            level: 'error',
          });
        } catch (notifyErr) {
          logger.warn({ err: notifyErr, jobId: fired.jobId }, 'core-services: llm job crash notification failed');
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // skills — 技能注册表（builtin=repoRoot/skills + data=<dataDir>/skills；均可选，
  // 目录缺失即空库）。扩展贡献走 skills.register 桥（按 extId 记名），扩展禁用时由
  // Kernel 的 onServicesChanged(null) 分支联动 removeContributed。
  // -------------------------------------------------------------------------
  const skillsRegistry = new SkillRegistry({
    roots: [
      { root: join(REPO_ROOT, 'skills'), source: 'builtin' },
      { root: join(config.dataDir, 'skills'), source: 'data' },
    ],
    logger,
  });
  kernel.container.instance(CONTAINER_KEYS.skillsRegistry, skillsRegistry);

  // -------------------------------------------------------------------------
  // mcp — MCP 客户端（配置持久化 + 连接编排）。refreshAll 的单点失败标 error 不阻塞
  // boot（见 start()）；REST /api/v1/mcp/* 与扩展桥 mcp.* 共用同一 registry。
  // -------------------------------------------------------------------------
  const mcpConfigStore = new McpConfigStore({ dataDir: config.dataDir });
  const mcpRegistry = new McpRegistry({ configStore: mcpConfigStore, logger });
  kernel.container.instance(CONTAINER_KEYS.mcpConfig, mcpConfigStore);
  kernel.container.instance(CONTAINER_KEYS.mcpRegistry, mcpRegistry);

  // -------------------------------------------------------------------------
  // plugins — 插件包注册表（<dataDir>/plugins/ 发现聚合 + 贡献注入 skills/mcp）。
  // -------------------------------------------------------------------------
  /**
   * PluginRegistry 的 server id（`plugin:<pid>:<sid>`，含 ':'）→ MCP 配置面合法 id。
   * McpServerConfig 的 id 形态（^[a-z0-9][a-z0-9_-]*$）不含 ':'，而插件/子资源 id 的
   * 字符集（^[a-z0-9][a-z0-9_-]*$）永不产生 ':'，故 ':'→'--' 映射可逆、无碰撞。
   */
  const toMcpConfigId = (pluginServerId: string): string => pluginServerId.replaceAll(':', '--');

  /** 插件贡献注入的适配队列：串行化 configStore/connect 编排，避免 refresh 的
   * detachAll→inject 与磁盘原子写交错（McpRegistryLike 是同步契约，这里 fire-and-forget） */
  let mcpAdapterChain: Promise<void> = Promise.resolve();

  /** McpRegistryLike 适配器：addServer = 落配置（enabled:true）+ 连接；失败 warn 不抛 */
  const mcpRegistryAdapter: McpRegistryLike = {
    addServer: (cfg: PluginMcpServerConfig): unknown => {
      mcpAdapterChain = mcpAdapterChain.then(async () => {
        const configId = toMcpConfigId(cfg.id);
        try {
          if ((await mcpConfigStore.get(configId)) === undefined) {
            await mcpConfigStore.add({ ...cfg, id: configId, enabled: true });
          }
          // boot 期 refreshAll 可能已连上同 id 配置：已连接则不重复重建会话
          if ((await mcpRegistry.status(configId)).state !== 'connected') {
            await mcpRegistry.connect(configId);
          }
        } catch (cause) {
          logger.warn(
            { err: cause instanceof Error ? cause.message : String(cause), serverId: cfg.id },
            'plugins: mcp server injection failed (non-fatal; see /api/v1/mcp/servers status)',
          );
        }
      });
      return undefined;
    },
    removeServer: (id: string): boolean => {
      mcpAdapterChain = mcpAdapterChain.then(async () => {
        const configId = toMcpConfigId(id);
        try {
          await mcpRegistry.disconnect(configId);
          await mcpConfigStore.remove(configId);
        } catch (cause) {
          logger.warn(
            { err: cause instanceof Error ? cause.message : String(cause), serverId: id },
            'plugins: mcp server detach failed (non-fatal)',
          );
        }
      });
      return true; // McpRegistryLike 同步契约：实际摘除异步完成（失败只 warn）
    },
  };

  /**
   * scriptRunner — 插件脚本执行（v1 简约契约，JSDoc 即契约文档）：
   * - 仅经 SandboxManager 在工作区 `plugin-<pluginId>` 内执行（家目录 bind 到容器
   *   /home/dev；执行前把插件包整目录同步进工作区家目录——家目录即事实），绝不在宿主进程运行；
   * - 传参：`node scripts/<file> --args <JSON.stringify(args)>`（argv 追加，末参为 JSON 文本；
   *   v1 不走 stdin——docker exec 在本沙箱实现中不开 stdin）；
   * - 返回：脚本退出码 0 且未超时 → `{ ok:true, result }`，result = stdout 的 JSON 解析
   *   （解析失败回退原文）；否则 `{ ok:false, error }`（stderr 优先，截尾 4KB）；
   * - 容器无 SandboxManager（裸装配）或沙箱未启用（无 Docker/配置关闭）→ 抛
   *   NOT_IMPLEMENTED（HARNESS-9004）；沙箱基础设施故障（SANDBOX_*）原样上抛。
   */
  const scriptRunner: ScriptRunnerLike = {
    async run(pluginId: string, scriptId: string, args: unknown) {
      const manager = kernel.container.has(CONTAINER_KEYS.sandbox)
        ? kernel.container.resolve<SandboxManager>(CONTAINER_KEYS.sandbox)
        : undefined;
      if (manager === undefined || !manager.enabled()) {
        const why =
          manager === undefined
            ? 'the kernel has no SandboxManager registered (container "sandbox")'
            : 'the sandbox is not enabled (Docker unavailable or disabled by config)';
        throw err('NOT_IMPLEMENTED', {
          message: `plugin script execution is unavailable: ${why} (scripts never run on the host process)`,
          detail: { pluginId, scriptId },
        });
      }

      // 从安装目录的 plugin.json 解析 script 声明（registry 校验过；此处防御性复核路径）
      const pluginDir = join(config.dataDir, 'plugins', pluginId);
      let scriptFile: string | undefined;
      try {
        const raw = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')) as {
          scripts?: Array<{ id?: unknown; file?: unknown }>;
        };
        const declared = Array.isArray(raw.scripts) ? raw.scripts.find((s) => s?.id === scriptId) : undefined;
        scriptFile = typeof declared?.file === 'string' ? declared.file : undefined;
      } catch {
        scriptFile = undefined;
      }
      if (
        scriptFile === undefined ||
        !scriptFile.startsWith('scripts/') ||
        !isSafePluginRelativePath(scriptFile)
      ) {
        throw err('EXT_NOT_FOUND', {
          message: `plugin "${pluginId}" has no runnable script "${scriptId}" under scripts/`,
          detail: { pluginId, scriptId },
        });
      }

      const workspaceId = `plugin-${pluginId}`;
      if (manager.get(workspaceId) === null) {
        await manager.createWorkspace({ id: workspaceId });
      }
      const workspace = manager.get(workspaceId);
      if (workspace === null) {
        throw err('INTERNAL', {
          message: `sandbox workspace "${workspaceId}" disappeared right after creation`,
          detail: { pluginId, scriptId },
        });
      }
      // 插件包同步进工作区家目录（宿主侧 cp；家目录 bind 挂载点，容器内即 /home/dev）
      cpSync(pluginDir, workspace.homeDir, { recursive: true });

      const execResult = await manager.exec(workspaceId, [
        'node',
        scriptFile,
        '--args',
        JSON.stringify(args ?? null),
      ]);
      const ok = execResult.exitCode === 0 && !execResult.timedOut;
      let parsed: unknown;
      try {
        parsed = execResult.stdout.trim() === '' ? null : JSON.parse(execResult.stdout.trim());
      } catch {
        parsed = execResult.stdout;
      }
      if (!ok) {
        const detail =
          execResult.stderr.trim() !== ''
            ? execResult.stderr
            : execResult.stdout.trim() !== ''
              ? execResult.stdout
              : `node ${scriptFile} exited with code ${execResult.exitCode}`;
        return { ok: false, error: detail.slice(-4096) };
      }
      return { ok: true, result: parsed };
    },
  };

  const pluginsRegistry = new PluginRegistry({
    dataDir: config.dataDir,
    logger,
    // 贡献技能签名一致（PluginContributedSkill ≅ ContributedSkillInput）：直接透传
    skillsRegistry,
    mcpRegistry: mcpRegistryAdapter,
    scriptRunner,
  });
  kernel.container.instance(CONTAINER_KEYS.pluginsRegistry, pluginsRegistry);

  // -------------------------------------------------------------------------
  // agents.session —— 会话子系统（类 Codex 全屏 Chat：会话/消息持久化 + sendMessage
  // 驱动 Agent 循环 + SSE `agent:{sessionId}` 实时推送）。
  // 生命周期：core.start()/stop() 无额外动作——表由 store 惰性建（首次使用时），
  // 会话/消息持久化在 SQLite，生成中的 AbortController 为进程内存态。
  // -------------------------------------------------------------------------
  const agentSessionStore = new AgentSessionStore(db);
  const agentSessionManager = new AgentSessionManager({
    store: agentSessionStore,
    gateway: {
      chat: (input) => gateway.chat({ ...(input as LlmChatInput), stream: false }) as Promise<LlmChatResult>,
      getProviders: () => gateway.getProviders(),
    },
    settings,
    logger,
    // 系统工具运行时由 Kernel 在 /mcp 接线时创建并 attach（共享槽）；装配早于该时点，
    // 与上方子代理 agentToolsRuntime 同款懒解析——调用期必然已 attach
    systemRuntime: currentSystemRuntime,
    publish,
  });
  // 键名隔离守卫：'agents.sessionManager'（会话运行时）刻意不在 SUBAGENT_MANAGER_CONTAINER_KEYS
  // （subagent_* 工具的委派运行时解析候选）之内——两个面不得混装。
  if ((SUBAGENT_MANAGER_CONTAINER_KEYS as readonly string[]).includes('agents.sessionManager')) {
    throw err('INTERNAL', {
      message: 'container key collision: "agents.sessionManager" must not be a subagent manager key',
    });
  }
  kernel.container.instance('agents.sessionManager', agentSessionManager);

  // -------------------------------------------------------------------------
  // skills / mcp / plugins 扩展桥并表（容器 'ext.bridges'）。
  // 权限决策：**矩阵不加、桥工厂自查**——skills 读面（list/get/refresh）与 plugins.list
  // 由下方 gatedBridge 以 'skills' / 'plugins' 收口；mcp 三 topic 由 createMcpBridge
  // 的 requirePermission 闭包以 'mcp:client' 收口；skills.register（贡献）免权限——
  // 贡献按调用方 extId 记名、扩展禁用即由内核摘除，无跨扩展读写面。kernel-handlers
  // 的 TOPIC_PERMISSIONS 矩阵刻意不含这些 topic（避免双闸口径漂移）。
  // -------------------------------------------------------------------------
  const requireExtPermission = (extId: string, topic: string, permission: string): void => {
    const manager = kernel.container.has(CONTAINER_KEYS.extManager)
      ? kernel.container.resolve<ExtensionManager>(CONTAINER_KEYS.extManager)
      : undefined;
    const permissions = manager?.getManifest(extId)?.permissions ?? [];
    if (!permissions.includes(permission)) {
      throw err('FORBIDDEN', {
        message: `kernel service "${topic}" requires the "${permission}" permission in the extension manifest (add it to manifest.permissions)`,
        detail: { topic, extId, requiredPermission: permission },
      });
    }
  };

  /** 非扩展端点闸（与 kernel-handlers.extIdFrom 同规则）：'kernel'/空 → RPC_PERMISSION_DENIED */
  const requireExtCaller = (from: string, topic: string): string => {
    const extId = from === 'kernel' ? null : from.startsWith('ext:') ? from.slice('ext:'.length) : from;
    if (extId === null || extId === '') {
      throw err('RPC_PERMISSION_DENIED', {
        message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
        detail: { topic, from },
      });
    }
    return extId;
  };

  /** 给桥 handler 表统一包一层「扩展端点 + manifest 权限」闸（exempt 内的 topic 免权限） */
  const gatedBridge = (
    handlers: Record<string, (payload: unknown, from: string) => Promise<unknown>>,
    permission: string,
    exempt: readonly string[] = [],
  ): Record<string, (payload: unknown, from: string) => Promise<unknown>> =>
    Object.fromEntries(
      Object.entries(handlers).map(([topic, handler]) => [
        topic,
        async (payload: unknown, from: string) => {
          const extId = requireExtCaller(from, topic);
          if (!exempt.includes(topic)) requireExtPermission(extId, topic, permission);
          return handler(payload, from);
        },
      ]),
    );

  kernel.container.instance(CONTAINER_KEYS.extBridges, {
    ...gatedBridge(createSkillsBridge({ registry: skillsRegistry }), SKILLS_PERMISSION, [
      KERNEL_TOPICS.skillsRegister,
    ]),
    ...createMcpBridge({
      registry: mcpRegistry,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
    ...gatedBridge(createPluginsBridge({ registry: pluginsRegistry }), PLUGINS_PERMISSION),
    // memory / asr / extract 三桥（OS 能力层）：自带扩展端点闸，权限经 requirePermission
    // 闭包以 'memory' / 'asr' / 'files:read' 收口（权限名在 extensions/manifest.ts 白名单）。
    ...createMemoryBridge({
      manager: memoryManager,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
    ...createAsrBridge({
      manager: asrManager,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
    ...createFileExtractBridge({
      service: fileExtractService,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
    // coding 桥（OS 能力层）：自带扩展端点闸，权限经 requirePermission 闭包以
    // 'sandbox' 收口（进程/文件类高危能力，与 sandbox.exec 同门；权限名在
    // extensions/manifest.ts 白名单）。
    ...createCodingBridge({
      engine: codingEngine,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
    // browser 桥（OS 能力层）：自带扩展端点闸，权限经 requirePermission 闭包以
    // 'browser' 收口（权限名在 extensions/manifest.ts 白名单）。引擎在内核主线程，
    // 扩展壳（extensions/browser）经它把 status/install/screenshots 暴露为扩展路由。
    ...createBrowserBridge({
      service: browserEngine,
      requirePermission: (extId, topic, permission) => requireExtPermission(extId, topic, permission),
    }),
  });

  return {
    registerRoutes(app: FastifyInstance): void {
      // files 与 plugins 两个 REST 模块都在各自内部执行 `app.register(multipart)`
      // （@fastify/multipart 为 fp 包装、无封装边界——同一 fastify 上下文注册两次会撞
      // 装饰器；子上下文又会克隆父上下文的 content-type parser，先注册的一侧会污染
      // 后注册的子上下文）。故各自挂到**兄弟封装上下文**：装饰器/parser 互不可见，
      // 路由照常全局暴露。
      app.register((filesCtx) => {
        registerFileRoutes(filesCtx, {
          checker,
          service: fileService,
          maxUploadBytes: config.maxUploadBytes,
        });
      });
      registerNotificationRoutes(app, {
        channelConfigs: channelConfigStore,
        checker,
        store: notifyStore,
        getRoutes: () => settings.get(NOTIFY_ROUTES_KEY, [] as unknown),
        setRoutes: (rules) => settings.set(NOTIFY_ROUTES_KEY, rules),
        drivers: () => ({
          notification: registry.listNotificationDrivers(),
          chat: registry.listChatBridgeDrivers(),
        }),
        getChannels: async () => ({
          webhook: await settings.get('notify.channels.webhook', {} as unknown),
          email: await settings.get('notify.channels.email', {} as unknown),
        }),
        setChannels: (next) => settings.set('notify.channels.webhook', next),
        send: (input) =>
          notifyManager.send({
            title: input.title,
            body: input.body,
            // REST 层 level 为 open string，通知中心内部 zod 复核（非法值 → 400 VALIDATION_FAILED）
            level: input.level as ChannelLevel,
            data: input.data,
            // REST 契约：字符串形只传驱动名；对象形（渠道配置 UI 测试发送）随行 target
            channels: input.channels.map((driver, i) => ({
              driver,
              target: input.channelTargets?.[i] ?? {},
            })),
          }),
      });
      registerChatRoutes(app, { checker, service: chatService, connectors: platformConnectors });
      registerTaskRoutes(app, { checker, manager: taskManager });
      registerSubagentRoutes(app, { checker, manager: subagentManager });
      // FlowTrigger 管理 API（/api/v1/flows/endpoints*，admin）+ 公开入站回调
      // （POST /hooks/flow/:slug，路由模块内部以兄弟封装上下文注册 Buffer 解析器）
      registerFlowRoutes(app, { checker, manager: flowManager });
      // Agent 会话 API（/api/v1/agents/sessions*）：与子代理面独立的会话 REST
      registerAgentRoutes(app, { checker, sessionManager: agentSessionManager });
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
      // Skills / MCP / 插件 REST（/api/v1/skills* · /api/v1/mcp/* · /api/v1/plugins*）：
      // 与扩展桥共用同一批 registry/configStore 实例（单一事实来源）。
      // writer：受控写面（POST/DELETE /api/v1/skills，admin）→ data 源目录
      // `<dataDir>/skills/<id>/`；builtinRoot 供删除时判定 builtin 源（只读不可删）。
      registerSkillRoutes(app, {
        checker,
        registry: skillsRegistry,
        writer: {
          write: (input) => writeSkill({ dataDir: config.dataDir }, input),
          remove: (id, opts) =>
            deleteSkill({ dataDir: config.dataDir, builtinRoot: join(REPO_ROOT, 'skills') }, id, opts),
        },
      });
      registerMcpRoutes(app, { checker, registry: mcpRegistry, configStore: mcpConfigStore });
      // 记忆 / 语音识别 / 文件提取 REST（/api/v1/memory* · /api/v1/asr* · /api/v1/extract*）。
      // 三组前缀独立，与 auth mount（/api/v1/auth|users）、/api/v1/system|cron|sandbox 等互不冲突。
      registerMemoryRoutes(app, { checker, manager: memoryManager, settings });
      // asr 二进制直传（application/octet-stream）需要 **Buffer** 解析器，而根上下文稍后由
      // ExtRouteRegistry 再注册同 content-type 的 **string** 解析器（同一 fastify 上下文每个
      // content-type 仅允许一个 parser，后注册者直接抛错）——挂到**兄弟封装上下文**隔离：
      // asr 子上下文自带 Buffer parser，根上下文维持 ExtRouteRegistry 的注册权。
      app.register((asrCtx) => {
        registerAsrRoutes(asrCtx, { checker, manager: asrManager });
      });
      // extract 路由自注册 multipart（extract.ts 内部 `app.register(multipart)`）：与 files/
      // plugins 同款手法挂到兄弟封装上下文——根上下文一旦被注册 multipart parser，会污染
      // 其后加载的子上下文（extensions 安装路由的 installCtx 克隆父表后二次注册即抛错）。
      app.register((extractCtx) => {
        registerExtractRoutes(extractCtx, { checker, service: fileExtractService, files: fileService });
      });
      // plugins 路由自带 `app.register(multipart)`（与 files 路由同款手法）。同一 fastify
      // 实例上两次注册同一个 fp 包装插件会撞装饰器（FST_ERR_DEC_ALREADY_PRESENT）——
      // 这里挂到子上下文隔离：multipart 装饰器只对本上下文路由可见，路由照常暴露。
      app.register((child) => {
        registerPluginRoutes(child, {
          checker,
          registry: pluginsRegistry,
          // 原始形态（fn.length>=2）：REST 层以 { dataDir: registry.dataDir } 绑定首参后调用
          installerZip: (cfg, zipPath, opts) => installPluginZip(cfg, zipPath, opts),
        });
      });
    },

    async start(): Promise<void> {
      await taskManager.start();
      // ASR boot 钩子：autoDownload 开启且模型未缓存时后台静默下载（fire-and-forget，
      // 失败只落状态与日志——绝不阻塞内核启动）
      asrManager.init();
      // skills / plugins 聚合：磁盘扫描 + 贡献重建（目录缺失即空库，绝不抛）
      await skillsRegistry.refresh();
      await pluginsRegistry.refresh();
      // MCP boot 重连：enabled 配置全部（重）连接；单点失败标 error（status 可见），
      // 绝不抛——启动期不被单个 server 拖垮
      const mcpReport = await mcpRegistry.refreshAll();
      if (mcpReport.failed.length > 0) {
        logger.warn(
          { failed: mcpReport.failed },
          'core-services: some mcp servers failed to connect at boot (marked error; boot continues)',
        );
      }
    },

    async stop(): Promise<void> {
      await taskManager.stop();
      // ASR pipeline 卸载（幂等；失败不阻断关停）
      try {
        await asrManager.unloadEngine();
      } catch (cause) {
        logger.warn({ err: cause }, 'core-services: asr engine unload during shutdown warned');
      }
      // OCR 引擎单例释放（幂等不抛；失败不阻断关停）
      try {
        await fileExtractService.close();
      } catch (cause) {
        logger.warn({ err: cause }, 'core-services: fileextract ocr close during shutdown warned');
      }
      // 浏览器单例释放 + 后台安装子进程终止（幂等不抛；失败不阻断关停）
      try {
        await browserEngine.stop();
      } catch (cause) {
        logger.warn({ err: cause }, 'core-services: browser engine close during shutdown warned');
      }
      // 优雅断开全部 MCP 连接（stdio 子进程/HTTP 会话）；配置损坏等异常不阻断关停
      try {
        for (const cfg of await mcpConfigStore.load()) {
          await mcpRegistry.disconnect(cfg.id);
        }
      } catch (cause) {
        logger.warn({ err: cause }, 'core-services: mcp disconnect during shutdown warned');
      }
    },
  };
}
