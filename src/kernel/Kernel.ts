          /**
 * Kernel — 内核生命周期编排（服务提供者两阶段引导）。
 *
 * 职责：
 * - 持有 DI 容器、配置与 logger，并把它们以 'config' / 'logger' 单例注入容器
 * - boot 开头先就绪鉴权挂点（root 令牌 / auth.registry / auth.checker / sse.hub），
 *   使 provider 在 register/boot 阶段即可 resolve('auth.registry') 并注册 AuthProvider
 * - 依次执行 ServiceProvider.register → ServiceProvider.boot → 创建并启动 HTTP 服务器
 * - 阶段 11 接线：沙箱 SandboxManager（'sandbox'）+ 升级器 Updater（REST /api/v1/system/update*）
 *   + boot 期 settlePendingUpdate 在途升级收尾 + updateAuto 时的 kernel:auto-update cron
 * - 优雅关停：HTTP 停止 → 逆序 provider stop；shutdown 幂等，且可与进行中的 boot 互斥
 *   （等待 boot 落定后再正常关停）
 *
 * 注意：内核本身不挂进程信号处理（那是入口 main.ts 的职责，保证 Kernel 可嵌入任意宿主）；
 * 宿主可通过 handleSignal(sig) 委托关停。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Knex } from 'knex';
import type { Logger } from 'pino';
import { Container } from './Container.js';
import { ServiceProvider } from './ServiceProvider.js';
import { createHttpServer } from './http/server.js';
import { loadConfig } from './config/index.js';
import type { HarnessConfig } from './config/index.js';
import { createLogger } from './logging/index.js';
import { err } from './errors/HarnessError.js';
import type { AuthIdentity } from './auth/types.js';
import { ensureRootToken } from './auth/root-token.js';
import { AuthProviderRegistry } from './auth/AuthProviderRegistry.js';
import { createAuthChecker, extractToken } from './auth/authProxy.js';
import { SseHub } from './http/sse/hub.js';
import { openSqlite, kernelDbPath, closeDb } from './storage/db.js';
import { Migrator } from './storage/migrator.js';
import { KERNEL_MIGRATIONS } from './storage/kernel-migrations.js';
import { SettingsService } from './storage/settings.js';
import { SecretsService } from './storage/secrets.js';
import { loadOrCreateSecretKey } from './storage/secretkey.js';
import { createBackup } from './storage/backup.js';
import { Counters } from './system/info.js';
import { registerSystemRoutes } from '../api/system.js';
import { registerSandboxRoutes } from '../api/sandbox.js';
import { registerUpdateRoutes } from '../api/update.js';
import { EventBus } from './events/bus.js';
import { HookManager } from './hooks/manager.js';
import { HOOK_POINTS, EVENT_NS } from './hooks/points.js';
import { CronScheduler, type CronJobRecord, type CronFireContext } from './cron/scheduler.js';
import { CronJobStore } from './cron/store.js';
import { registerCronRoutes } from '../api/cron.js';
import { createCoreServices, type CoreServices } from './providers/core-services.js';
import { ExtensionManager, type ExtRouteTableEntry } from './extensions/manager.js';
import { ExtRouteRegistry, sanitizeExtHeaders, type ExtDispatchResult } from './extensions/routes.js';
import { ExtensionServiceRegistry } from './extensions/registry.js';
import { createKernelHandlers, type AuthProviderRegistration, type KernelBridgeHandlers } from './extensions/kernel-handlers.js';
import { UiRegistry } from './extensions/ui-registry.js';
import { registerExtensionRoutes, type ExtensionsApiDeps } from '../api/extensions.js';
import { installExtensionZip } from './extensions/installer.js';
import { registerExtAssets, type ExtAssetDir } from './extensions/assets.js';
import { HOST_METHODS } from '../extension-host/protocol.js';
import { createWorkerFactory } from '../extension-host/worker-factory.js';
import { bindFacadeKernel, FACADE_CONTAINER_KEYS } from './Facades.js';
import { attachSystemRuntime, SystemMcpServer, SYSTEM_TOOLS_CONTAINER_KEY } from './mcp/system-server.js';
import { createBootLogger } from './logging/index.js';
import { createSqliteLogSink, type SqliteLogSink } from './logging/sqlite-sink.js';
import { SandboxManager, createDockerClient, type DockerClient } from './sandbox/index.js';
import {
  settlePendingUpdate,
  Updater,
  type UpdateApplyResult,
  type UpdateCheckResult,
  type UpdateHistoryEntry,
  type UpdaterNotifier,
} from './update/index.js';

/** 仓库内置扩展目录（受信第一方；与数据卷用户扩展目录隔离） */
const REPO_EXTENSIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extensions');

/** 内核生命周期状态机：created → registering → booting → ready → stopping → stopped */
export type KernelState = 'created' | 'registering' | 'booting' | 'ready' | 'stopping' | 'stopped';

/**
 * 容器内核心服务的登记 key（内核登记，provider/扩展统一引用，避免魔法字符串漂移）。
 * - 'auth.identity'：ensureRootToken 的产物 { token, source }
 * - 'auth.registry'：AuthProviderRegistry（provider 在 register 阶段即可注册）
 * - 'auth.checker'：createAuthChecker 的统一验证入口
 * - 'sse.hub'：SseHub（服务端事件广播）
 */
export const CONTAINER_KEYS = {
  config: 'config',
  logger: 'logger',
  http: 'http',
  authIdentity: 'auth.identity',
  authRegistry: 'auth.registry',
  authChecker: 'auth.checker',
  sseHub: 'sse.hub',
  db: 'db',
  settings: 'settings',
  secrets: 'secrets',
  counters: 'counters',
  // ---- 核心领域服务（createCoreServices 总装配登记，见 ./providers/core-services.ts）----
  /** ChannelRegistry 单例（Notification 与 Chat 共用的渠道驱动注册中心） */
  channels: 'channels.registry',
  /** NotificationManager（通知中心） */
  notify: 'notify',
  /** ChatService（聊天领域服务） */
  chat: 'chat',
  /** FileService（文件存储） */
  files: 'files',
  /** TaskManager（长任务编排） */
  tasks: 'tasks',
  /** LlmGateway（LLM 网关：provider 配置存 settings，密钥经 secrets 引用解析） */
  llm: 'llm',
  // ---- 升级与沙箱（阶段 11 总装配登记，见 #runBoot 的接线段）----
  /** SandboxManager（Docker 工作区沙箱编排；kernel-handlers 的 sandbox.exec 懒解析此键） */
  sandbox: 'sandbox',
  // ---- Skills / MCP / 插件（OS 能力目录，createCoreServices 总装配登记）----
  /** SkillRegistry（技能目录事实聚合读模型；REST /api/v1/skills 与扩展桥 skills.* 共用） */
  skillsRegistry: 'skills.registry',
  /** McpConfigStore（<dataDir>/mcp/config.json 原子持久化） */
  mcpConfig: 'mcp.config',
  /** McpRegistry（MCP Host/Client 连接编排；REST /api/v1/mcp/* 与扩展桥 mcp.* 共用） */
  mcpRegistry: 'mcp.registry',
  /** PluginRegistry（插件包发现/聚合/贡献注入；REST /api/v1/plugins* 与扩展桥 plugins.* 共用） */
  pluginsRegistry: 'plugins.registry',
  // ---- 记忆 / 语音识别 / 文件提取（OS 能力层，createCoreServices 总装配登记）----
  /** MemoryManager（全局 LLM 记忆系统；REST /api/v1/memory* 与扩展桥 memory.* 共用） */
  memoryManager: 'memory.manager',
  /** AsrManager（语音识别状态机；REST /api/v1/asr* 与扩展桥 asr.* 共用） */
  asrManager: 'asr.manager',
  /** FileExtractService（文件内容提取；REST /api/v1/extract* 与扩展桥 extract.* 共用） */
  fileExtract: 'fileextract.service',
  /** skills/mcp/plugins 三桥 handler 并表（createKernelHandlers 的 extraBridges 懒解析源） */
  extBridges: 'ext.bridges',
  // ---- 扩展子系统（阶段 9 总装配登记，见 #runBoot 的扩展接线段）----
  /** ExtensionManager（扩展生命周期编排/自愈） */
  extManager: 'ext.manager',
  /** ExtRouteRegistry（/ext/* 通配兜底 + 路由表） */
  extRoutes: 'ext.routes',
  /** ExtensionServiceRegistry（h.expose/h.call 注册中心） */
  extRegistrySvc: 'ext.services',
  /** UiRegistry（扩展 UI 贡献：菜单/页面/小部件/渲染器） */
  uiRegistry: 'ui.registry',
} as const;

/**
 * Kernel 对真实 HTTP 服务器的最小依赖形状（便于测试注入轻量 stub，避免真实监听端口）。
 * 真实实现（createHttpServer 的返回值）天然满足该接口。
 */
export interface HttpServerLike {
  app?: unknown;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * 升级器门面的最小结构视图（内核内建 Updater 与测试注入的替身都满足该形状，
 * 与 api/update.ts 的 UpdateRoutesDeps['updater'] 同一契约；#onCronFire 的自动升级只依赖 apply）。
 */
export interface UpdaterFacade {
  check(): Promise<UpdateCheckResult>;
  apply(target?: { version?: string; url?: string; sha256?: string }): Promise<UpdateApplyResult>;
  history(): Promise<UpdateHistoryEntry[]>;
}

/** serverFactory 收到的依赖：由 Kernel 提供，真实实现透传给 createHttpServer */
export interface ServerFactoryDeps {
  config: HarnessConfig;
  logger: Logger;
  /** 内核是否就绪（/readyz 用） */
  isReady: () => boolean;
  /** 内核生命周期状态标签 */
  state: () => KernelState;
  /** 额外路由挂载钩子（内核聚合系统 API 与宿主自定义路由后传入） */
  registerExtra?: (app: FastifyInstance) => void;
}

/** HTTP 服务器工厂：默认走 createHttpServer，测试可注入 stub */
export type ServerFactory = (deps: ServerFactoryDeps) => HttpServerLike | Promise<HttpServerLike>;

/** Kernel 构造选项（全部可选，用于测试注入与宿主定制） */
export interface KernelOptions {
  /** 覆盖默认 loadConfig()（测试注入临时 dataDir / 固定端口用） */
  config?: HarnessConfig;
  /** 覆盖默认 HTTP 服务器工厂（测试注入 HttpServerLike stub 用） */
  serverFactory?: ServerFactory;
  /** 宿主自定义路由挂载钩子（在内核系统 API 之后执行；app 为 fastify 实例） */
  registerExtra?: (app: FastifyInstance) => void;
  /**
   * 升级提交成功后的重启回调（Updater.apply 的 requestRestart 依赖）。
   * 缺省 = 优雅关停（reason 'update:applied'）后 process.exit(0)，由 bootstrap.mjs 拉起新 slot；
   * 测试注入 spy 替代，避免真实退出进程。
   */
  requestRestart?: () => void | Promise<void>;
  /**
   * Docker 客户端工厂（默认 createDockerClient；返回 null = Docker 不可用 → 沙箱优雅降级）。
   * 测试注入内存 stub，避免依赖真实 Docker daemon。
   */
  sandboxClientFactory?: (cfg: { dockerHost: string }) => DockerClient | null;
  /** 测试专用：替换内核内建的 Updater（自动升级 cron 注册等用例的替身，绕开真实网络/子进程） */
  updaterOverride?: UpdaterFacade;
}

/** 默认 HTTP 服务器工厂：委托给真实 createHttpServer */
function defaultServerFactory(deps: ServerFactoryDeps): HttpServerLike {
  return createHttpServer({
    config: deps.config,
    logger: deps.logger,
    isReady: deps.isReady,
    state: deps.state,
    registerExtra: deps.registerExtra,
  });
}

/** builtin auth 扩展 AuthProvider 校验的 RPC 预算（host.authVerify 往返；scrypt/SQLite 查询足够） */
const AUTH_VERIFY_TIMEOUT_MS = 10_000;

/**
 * 仓库根目录（与 extension-host/worker-factory.ts 同款推导：本文件向上两级）。
 * src/kernel/Kernel.ts → 仓库根；dist/kernel/Kernel.js → 仓库根。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * SEC-3：受信第一方扩展目录（随镜像交付的 repoRoot/extensions）。
 * builtin / mount 声明仅对该目录下的扩展放行——/tmp 等任意目录自声明
 * builtin/mount 一律拒绝（rootToken 与 /api/v1 挂载的防线）。
 */
const TRUSTED_EXTENSIONS_DIR = join(REPO_ROOT, 'extensions');

/** 目录是否位于受信第一方扩展目录内（resolve 后前缀比对） */
function isTrustedExtensionDir(dir: string): boolean {
  const resolved = resolve(dir);
  return resolved === TRUSTED_EXTENSIONS_DIR || resolved.startsWith(TRUSTED_EXTENSIONS_DIR + sep);
}

/**
 * builtin mount 'auth' 的路由挂载规则：扩展声明相对路径（'/auth/*'、'/users*'），
 * 内核映射到 '/api/v1' 前缀（AGENTS.md mount 白名单：auth → /api/v1/auth|users）。
 * 只挂这两条静态 catch-all 前缀（fastify 不支持运行时注销路由，enable/disable
 * 一律走运行时查 manager 路由表，与 /ext/* 通配兜底同一设计）。
 */
const AUTH_MOUNT_PREFIXES = ['auth', 'users'] as const;

/**
 * mount 路由的声明路径匹配（':param' 提取；段数一致 + 字面量段精确比较）。
 * 返回提取的 params（供派发到扩展 handler）；未命中返回 null。
 */
function matchMountPath(pattern: string, actual: string): Record<string, string> | null {
  const ps = pattern.split('/').filter((s) => s !== '');
  const as = actual.split('/').filter((s) => s !== '');
  if (ps.length !== as.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as string;
    const a = as[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = a;
    else if (p !== a) return null;
  }
  return params;
}

/**
 * 内核主类。
 *
 * @example
 * const kernel = new Kernel();
 * kernel.useProvider(new AuthProvider());
 * await kernel.boot();          // state === 'ready'
 * await kernel.shutdown();      // state === 'stopped'（幂等；boot 期间调用会等待 boot 落定）
 */
export class Kernel {
  /** 内核 DI 容器（CONTAINER_KEYS 列出的核心服务由内核登记） */
  readonly container = new Container();

  /** 内核配置（构造时确定；boot 前即可用） */
  readonly config: HarnessConfig;

  /** 内核 pino logger（构造时创建，带脱敏层；boot 前即可用） */
  readonly logger: Logger;

  #state: KernelState = 'created';
  #providers: ServiceProvider[] = [];
  /** boot 已完成（或进行中已完成）的 provider，关停时逆序 stop */
  #booted: ServiceProvider[] = [];
  #http: HttpServerLike | undefined;
  #hub: SseHub | undefined;
  #db: Knex | undefined;
  #eventBus: EventBus | undefined;
  #hooks: HookManager | undefined;
  #cron: CronScheduler | undefined;
  #cronStore: CronJobStore | undefined;
  /** 核心领域服务总装配（channels/notify/chat/files/tasks；boot 期间创建，关停时先于 cron 停止） */
  #core: CoreServices | undefined;
  /** 沙箱管理器（boot 期间创建并登记 'sandbox'；关停时在 core 附近停止） */
  #sandbox: SandboxManager | undefined;
  /** 升级器（boot 期间创建；#onCronFire 的 kernel:auto-update 触发 apply） */
  #updater: UpdaterFacade | undefined;
  /** 升级提交后的重启回调（构造期确定；缺省 = 优雅关停 + exit(0)，生产由 bootstrap.mjs 拉起新 slot） */
  readonly #requestRestart: () => void | Promise<void>;
  /** 扩展生命周期管理器（boot 期间创建；先于 cron 启动、先于 cron 停止） */
  #extManager: ExtensionManager | undefined;
  /** 扩展 UI 贡献注册表（boot 期间创建；GET /api/v1/ui 数据源） */
  #uiRegistry: UiRegistry | undefined;
  #logSink: SqliteLogSink | undefined;
  #addLogSink: ((stream: import('pino').DestinationStream, level?: import('pino').Level) => void) | undefined;
  readonly #serverFactory: ServerFactory;
  readonly #registerExtra: ((app: FastifyInstance) => void) | undefined;
  readonly #sandboxClientFactory: (cfg: { dockerHost: string }) => DockerClient | null;
  readonly #updaterOverride: UpdaterFacade | undefined;
  /** 进行中的 boot promise（shutdown 与 boot 互斥的等待锚点；boot 落定后保留引用） */
  #bootPromise: Promise<void> | undefined;

  constructor(opts: KernelOptions = {}) {
    this.config = opts.config ?? loadConfig();
    // createBootLogger：multistream 底座，db 打开后可 addSink(sqlite 环形日志汇)；
    // 脱敏层（token/authorization/password/secret/apiKey 一律 [REDACTED]）同样生效
    const boot = createBootLogger(this.config);
    this.logger = boot.logger;
    this.#addLogSink = boot.addSink;
    this.#serverFactory = opts.serverFactory ?? defaultServerFactory;
    this.#registerExtra = opts.registerExtra;
    this.#sandboxClientFactory = opts.sandboxClientFactory ?? createDockerClient;
    this.#updaterOverride = opts.updaterOverride;
    // 缺省实现：优雅关停后退出进程，由 bootstrap.mjs 拉起新提交的 slot；
    // 测试必须注入 requestRestart（否则升级演练会真实退出 vitest 进程）
    this.#requestRestart =
      opts.requestRestart ??
      (async () => {
        await this.shutdown('update:applied');
        process.exit(0);
      });

    // 核心服务以现成实例登记为容器单例；provider 在 register/boot 阶段即可 resolve
    this.container.instance(CONTAINER_KEYS.config, this.config);
    this.container.instance(CONTAINER_KEYS.logger, this.logger);
    // Facades 静态门面绑定（App/Config/Log/Event/Hook/Cron 经容器延迟解析）
    bindFacadeKernel(this);
  }

  /** 当前生命周期状态 */
  state(): KernelState {
    return this.#state;
  }

  /** 是否就绪（可对外服务） */
  isReady(): boolean {
    return this.#state === 'ready';
  }

  /** 便捷读取配置（等价 container.resolve('config')） */
  getConfig(): HarnessConfig {
    return this.config;
  }

  /** 便捷读取 logger（等价 container.resolve('logger')） */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * 注册服务提供者（只能在本 boot() 之前调用；保持注册顺序）。
   * 返回 this 以支持链式调用。
   */
  useProvider(p: ServiceProvider): this {
    if (this.#state !== 'created') {
      throw err('INTERNAL', {
        message: `[kernel] useProvider() is only allowed before boot() (current state: "${this.#state}")`,
        detail: { provider: p.constructor?.name },
      });
    }
    this.#providers.push(p);
    return this;
  }

  /**
   * 启动内核：先就绪鉴权挂点（root 令牌 / auth.registry / auth.checker / sse.hub 登记进容器）
   * → registering（依次 provider.register）→ booting（依次 provider.boot）
   * → 创建并登记 'http' 单例 → attach SSE Hub（app 存在时）→ start → ready（日志含监听端口）。
   *
   * 任何步骤抛错：先优雅中止（停止已启动的 HTTP / 逆序 stop 已 boot 的 provider，
   * 落到 stopped），再把原始错误原样 rethrow。
   * 只能从 'created' 状态调用一次；重复调用抛 INTERNAL。
   */
  boot(): Promise<void> {
    if (this.#state !== 'created') {
      return Promise.reject(
        err('INTERNAL', {
          message: `[kernel] boot() can only be called once from state "created" (current state: "${this.#state}")`,
        }),
      );
    }
    this.#state = 'registering';
    this.#bootPromise = this.#runBoot();
    return this.#bootPromise;
  }

  /** boot 实际执行体（由 boot() 包装为 #bootPromise，供 shutdown 等待） */
  async #runBoot(): Promise<void> {
    try {
      // 鉴权挂点前移：在 provider 注册前就绪，provider 的 register/boot 阶段即可
      // container.resolve('auth.registry') 并注册 AuthProvider
      const identity = await ensureRootToken(this.config);
      if (identity.source === 'generated') {
        // bootRootToken 刻意不在 redact 列表（'token' 等会被脱敏）：
        // 生成令牌仅此一次输出给运维保存，之后永不复现
        this.logger.warn(
          { bootRootToken: identity.token },
          'generated root token (printed once, will not be shown again)',
        );
      } else {
        this.logger.info({ source: identity.source }, 'root token resolved');
      }
      const authRegistry = new AuthProviderRegistry();
      const authChecker = createAuthChecker({ rootToken: identity.token, registry: authRegistry });
      const hub = new SseHub({ checker: authChecker, logger: this.logger });
      this.#hub = hub;
      this.container.instance(CONTAINER_KEYS.authIdentity, identity);
      this.container.instance(CONTAINER_KEYS.authRegistry, authRegistry);
      this.container.instance(CONTAINER_KEYS.authChecker, authChecker);
      this.container.instance(CONTAINER_KEYS.sseHub, hub);

      // 数据层：打开 kernel.sqlite → 执行内核迁移（fail-fast）→ 登记 settings/secrets/counters
      const db = await openSqlite(kernelDbPath(this.config));
      this.#db = db;
      const applied = await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
      if (applied > 0) {
        this.logger.info({ applied }, 'kernel migrations applied');
      }
      this.container.instance(CONTAINER_KEYS.db, db);
      this.container.instance(CONTAINER_KEYS.settings, new SettingsService(db));
      const secretKey = await loadOrCreateSecretKey(this.config);
      this.container.instance(CONTAINER_KEYS.secrets, new SecretsService(db, secretKey));
      const counters = new Counters();
      this.container.instance(CONTAINER_KEYS.counters, counters);

      // 事件总线 / Hook 拦截器 / Cron（provider 注册前就绪，provider 可直接订阅与注册任务）
      const eventBus = new EventBus({ logger: this.logger });
      const hooks = new HookManager({ logger: this.logger });
      const cronStore = new CronJobStore(db);
      const cron = new CronScheduler({ store: cronStore, logger: this.logger, defaultTimezone: this.config.timezone, onFire: (ctx) => this.#onCronFire(hooks, eventBus, cronStore, ctx) });
      this.#eventBus = eventBus;
      this.#hooks = hooks;
      this.#cron = cron;
      this.#cronStore = cronStore;
      this.container.instance(FACADE_CONTAINER_KEYS.eventBus, eventBus);
      this.container.instance(FACADE_CONTAINER_KEYS.hookManager, hooks);
      this.container.instance(FACADE_CONTAINER_KEYS.cronScheduler, cron);

      // 核心领域服务总装配（channels/notify/chat/files/tasks 登记进容器；
      // REST 路由在下方 serverFactory 的 registerExtra 中挂载）
      const core = createCoreServices(this);
      this.#core = core;

      // ------------------------------------------------------------------
      // 升级与沙箱总装配（阶段 11）。时序契约：
      // - notifier（container 'notify'）由 createCoreServices 刚登记，此刻才可解析；
      // - sandbox / updater 必须在 serverFactory 之前创建（registerExtra 闭包引用二者）；
      // - settlePendingUpdate（在途升级收尾）放在 core.start() 之后执行（见下方启动段）。
      // ------------------------------------------------------------------
      const notifier = this.container.has(CONTAINER_KEYS.notify)
        ? this.container.resolve<UpdaterNotifier>(CONTAINER_KEYS.notify)
        : undefined;

      // 升级器：A/B slot 下载 → 校验 → 预检 → 原子提交；requestRestart 走构造期回调
      const updater =
        this.#updaterOverride ??
        new Updater({
          config: this.config,
          db,
          logger: this.logger,
          ...(notifier !== undefined ? { notifier } : {}),
          requestRestart: () => this.#requestRestart(),
        });
      this.#updater = updater;

      // 沙箱：client 为 null（Docker 不可用）或配置禁用时优雅降级（操作抛 SANDBOX_DISABLED）
      const sandbox = new SandboxManager({
        config: this.config,
        client: this.#sandboxClientFactory({ dockerHost: this.config.dockerHost }),
        logger: this.logger,
      });
      this.#sandbox = sandbox;
      this.container.instance(CONTAINER_KEYS.sandbox, sandbox);

      // 自动升级窗口：updateAuto + updateFeed 同时配置才注册内核级 cron 任务
      // （extId=null 即 store 约定的内核任务——cron_jobs.ext_id IS NULL）；触发动作在 #onCronFire
      if (this.config.updateAuto && this.config.updateFeed !== '') {
        // REL-4：boot 可能多次发生（同库重启/测试）——查 **store**（此刻调度器内存态尚未
        // 从库水合）摘掉旧的 kernel:auto-update 行，再按新配置重排，防每次 boot 重复插行
        const staleAutoUpdate = (await cronStore.list({ extId: null })).filter(
          (job) => job.name === 'kernel:auto-update',
        );
        for (const stale of staleAutoUpdate) {
          await cron.unschedule(stale.id); // store.delete 先行：内存未水合也生效
        }
        await cron.schedule({
          extId: null,
          name: 'kernel:auto-update',
          expr: this.config.updateWindow,
          tz: this.config.timezone,
          payload: { kind: 'auto-update' },
        });
        this.logger.info(
          { expr: this.config.updateWindow, channel: this.config.updateChannel, superseded: staleAutoUpdate.length },
          'auto-update scheduled on kernel cron',
        );
      }

      // ------------------------------------------------------------------
      // 扩展子系统总装配（阶段 9）：UI 注册表 → 内核服务处理器表 → 服务注册中心
      // → 生命周期管理器。路由注册表要等 registerExtra 拿到 fastify app 才能创建
      // （其构造即挂 /ext/* 通配兜底路由），此前的路由表变更先整表缓存、创建后重放。
      // manager.start() 在 core.start() 之后、cron.start() 之前执行（见下方启动段）。
      // ------------------------------------------------------------------
      const uiRegistry = new UiRegistry();
      this.#uiRegistry = uiRegistry;
      this.container.instance(CONTAINER_KEYS.uiRegistry, uiRegistry);

      // 先声明后赋值：auth provider 回调 / 路由派发的闭包都引用 manager（请求期才会解引用）
      let extManager: ExtensionManager | undefined;

      // ------------------------------------------------------------------
      // auth 接线（阶段 10）：AuthProvider 落 AuthProviderRegistry（provider 名 = 扩展 id）。
      // verify 经 host.authVerify 派发回扩展线程；headers 仅透传 authorization
      // （安全裁剪：原始请求头的其余键不下发给扩展）。worker 未运行/无身份 → null
      // （registry 会继续尝试下一个 provider；worker 不可达由 rootToken 直连兜底）。
      // ------------------------------------------------------------------
      const authProviderCallbacks: AuthProviderRegistration = {
        registerProvider: (extId) => {
          authRegistry.register({
            name: extId,
            verify: async ({ token, headers }) => {
              const bridge = extManager?.bridgeFor(extId);
              if (bridge === undefined || bridge === null) return null;
              const reply = (await bridge.callToWorker(
                extId,
                HOST_METHODS.authVerify,
                { token, headers: { authorization: headers.authorization } },
                AUTH_VERIFY_TIMEOUT_MS,
              )) as { identity?: unknown } | null | undefined;
              // worker 应答形状 { ok: true, identity }；identity null/undefined = 拒绝该凭据
              const identity = reply?.identity;
              return (identity ?? null) as AuthIdentity | null;
            },
          });
        },
        unregisterProvider: (extId) => {
          authRegistry.unregister(extId);
        },
      };

      // worker→kernel 的内核服务实现表（KERNEL_TOPICS 的落点；经桥透传）。
      // extraBridges 用懒代理：skills/mcp/plugins 三桥的并表由 createCoreServices 登记
      // 容器 'ext.bridges'，属性取值时才 resolve（与 kernel-handlers 的 llmGateway 懒
      // 解析同款模式——装配顺序变化或裸装配缺桥时都不会炸）。
      const extraBridgesProxy: KernelBridgeHandlers = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== 'string') return undefined;
            if (!this.container.has(CONTAINER_KEYS.extBridges)) return undefined;
            return this.container.resolve<KernelBridgeHandlers>(CONTAINER_KEYS.extBridges)[prop];
          },
        },
      );
      const bridgeHandlers = createKernelHandlers({
        kernel: this,
        auth: authProviderCallbacks,
        extraBridges: extraBridgesProxy,
      });

      const extSvcRegistry = new ExtensionServiceRegistry({
        dispatcher: {
          callService: async (targetExtId, service, method, args, timeoutMs) => {
            const bridge = extManager?.bridgeFor(targetExtId);
            if (bridge === undefined || bridge === null) {
              throw err('SERVICE_UNAVAILABLE', {
                detail: { targetExtId, service, cause: 'extension worker is not running' },
              });
            }
            // 注册中心的 service 是全名 'ext.<targetExtId>.<service>'；worker 侧
            // handlers.services 的键是裸 '<service>.<method>'，此处剥掉前缀再下发
            const bareService = service.slice(service.lastIndexOf('.') + 1);
            return await bridge.callToWorker(
              targetExtId,
              HOST_METHODS.callService,
              { service: bareService, method, args },
              timeoutMs,
            );
          },
        },
        logger: this.logger,
      });
      this.container.instance(CONTAINER_KEYS.extRegistrySvc, extSvcRegistry);

      // 路由表 diff 应用器：manager.onRoutesChanged 全表 → 逐扩展 commit/remove
      let routeRegistry: ExtRouteRegistry | undefined;
      let committedByExt = new Map<string, ExtRouteTableEntry[]>();
      let pendingTable: ExtRouteTableEntry[] | null = null;
      const routeSignature = (routes: ExtRouteTableEntry[]): string =>
        JSON.stringify(routes.map((r) => [r.method, r.path, r.auth, r.scope ?? null, r.timeoutMs ?? null]));
      const applyRoutes = (table: ExtRouteTableEntry[]): void => {
        if (routeRegistry === undefined) {
          pendingTable = table; // app 未就绪：整表缓存，registerExtra 创建注册表后重放
          return;
        }
        const next = new Map<string, ExtRouteTableEntry[]>();
        for (const entry of table) {
          const list = next.get(entry.extId) ?? [];
          list.push({
            extId: entry.extId,
            method: entry.method,
            path: entry.path,
            auth: entry.auth,
            scope: entry.scope,
            timeoutMs: entry.timeoutMs,
          });
          next.set(entry.extId, list);
        }
        for (const [extId, routes] of next) {
          const prev = committedByExt.get(extId);
          if (prev === undefined || routeSignature(prev) !== routeSignature(routes)) {
            routeRegistry.commit(extId, routes);
          }
        }
        for (const extId of committedByExt.keys()) {
          if (!next.has(extId)) routeRegistry.remove(extId);
        }
        committedByExt = next;
      };

      extManager = new ExtensionManager({
        config: this.config,
        db,
        logger: this.logger,
        workerFactory: createWorkerFactory(this.logger),
        bridgeHandlers,
        scheduler: cron,
        eventBus,
        hooks,
        extensionsDirs: [join(this.config.dataDir, 'extensions'), join(process.cwd(), 'extensions')],
        onRoutesChanged: applyRoutes,
        onServicesChanged: (extId, services) => {
          if (services === null) {
            extSvcRegistry.suspend(extId);
            // skills 贡献生命周期联动：扩展禁用/崩溃本地摘除时，同步摘除其经
            // skills.register 贡献的技能（幂等；未贡献过的 extId 静默）。容器键由
            // createCoreServices 登记——裸装配缺该服务时跳过，不阻断 disable 流程。
            if (this.container.has(CONTAINER_KEYS.skillsRegistry)) {
              this.container
                .resolve<{ removeContributed(extId: string): void }>(CONTAINER_KEYS.skillsRegistry)
                .removeContributed(extId);
            }
            return;
          }
          extSvcRegistry.register(extId, services);
        },
        // AuthProvider 生命周期同步：enable 注册 / disable·崩溃注销（provider 名 = extId）
        onAuthProvider: (extId, cmd) => {
          if (cmd === 'register') authProviderCallbacks.registerProvider(extId);
          else authProviderCallbacks.unregisterProvider(extId);
        },
        // SEC-3：builtin/mount 声明的受信闸——仅 repoRoot/extensions（随镜像交付的
        // 第一方目录）下的扩展放行；其余目录自声明一律拒绝（rootToken / 挂载防线）
        authMounts: {
          validateMount: (_manifest, dir) => isTrustedExtensionDir(dir),
        },
        // 第三方信任闸：同款目录裁决——repoRoot/extensions 之下的第一方扩展免人工授信，
        // 其余目录（dataDir/extensions 等）首次 enable 须经 confirmTrust 授信
        isTrustedExtDir: (dir) => isTrustedExtensionDir(dir),
        // UI 贡献生命周期同步：enable 提交合并片段进 UiRegistry（GET /api/v1/ui 数据源）/
        // disable·崩溃整扩展摘除（remove 对未登记 extId 幂等）
        onUiChanged: (extId, ui) => {
          if (ui === null) {
            uiRegistry.remove(extId);
            return;
          }
          uiRegistry.register(extId, ui);
        },
        // 引导态注入：仅 builtin auth 扩展携带 rootToken（worker 侧另有注入闸复核）。
        // SEC-3：目录不受信时同样不下发（fail-closed，rootToken 不出受信目录）
        loadBootstrap: (manifest, dir) =>
          manifest.builtin === true && manifest.mount === 'auth' && isTrustedExtensionDir(dir)
            ? { rootToken: identity.token }
            : undefined,
        // 双池化：内置池崩溃/恢复通知——懒解析 container 'notify' 的包装（此刻 core
        // 服务已登记，仍按 has+try/catch 兜底：notify 缺失或投递失败静默，不阻断自愈）
        notifier: {
          send: async (input) => {
            try {
              if (!this.container.has(CONTAINER_KEYS.notify)) return undefined;
              return await this.container.resolve<UpdaterNotifier>(CONTAINER_KEYS.notify).send(input);
            } catch (cause) {
              this.logger.warn({ err: cause }, 'extension host notification delivery failed');
              return undefined;
            }
          },
        },
      });
      this.#extManager = extManager;
      this.container.instance(CONTAINER_KEYS.extManager, extManager);

      // cron 触发 → 扩展线程派发：job.extId 非空的任务按内部名（extId:name）还原原名后下发
      eventBus.on(`${EVENT_NS.kernel}.cron.fired`, async (payload) => {
        try {
          const fired = (payload ?? {}) as { jobId?: unknown };
          if (typeof fired.jobId !== 'string') return;
          const job = cron.get(fired.jobId);
          if (job === null || job.extId === null || job.extId === '') return;
          const originalName = job.name.startsWith(`${job.extId}:`)
            ? job.name.slice(job.extId.length + 1)
            : job.name;
          const bridge = extManager?.bridgeFor(job.extId);
          if (bridge === undefined || bridge === null) return;
          await bridge.callToWorker(job.extId, HOST_METHODS.cronFire, { name: originalName });
        } catch (e) {
          this.logger.warn({ err: e }, 'extension cron fire dispatch failed');
        }
      });

      // SQLite 日志环形汇（内核日志镜像入库，供管理台查看；failure-tolerant）
      const logSink = createSqliteLogSink(db, { minLevel: 'info' });
      this.#logSink = logSink;
      this.#addLogSink?.(logSink.stream, 'info');

      // 生命周期埋点：kernel.boot（filter 语义，可改写启动上下文）
      await hooks.apply(HOOK_POINTS.kernelBoot, { config: this.config }, { meta: { kernel: 'opptrix-harness' } });
      await eventBus.emit(EVENT_NS.kernel + '.boot', { config: this.config }, { source: 'kernel' });

      for (const p of this.#providers) {
        await p.register(this.container);
      }

      this.#state = 'booting';
      for (const p of this.#providers) {
        await p.boot(this.container);
        this.#booted.push(p);
      }

      const http = await this.#serverFactory({
        config: this.config,
        logger: this.logger,
        isReady: () => this.isReady(),
        state: () => this.state(),
        registerExtra: (extra) => {
          // 内核系统 API（/api/v1/system/*）与 Cron API 先挂，宿主 registerExtra 再追加
          registerSystemRoutes(extra, {
            config: this.config,
            checker: authChecker,
            counters,
            runDbBackup: (cfg) => createBackup(cfg, db),
            // GET /api/v1/system/logs — SQLite 日志汇查询（logs 表倒序；data 损坏 JSON → null）
            logs: {
              list: async (opts) => {
                const base = db('logs');
                const filtered = opts.level !== undefined ? base.where('level', opts.level) : base;
                const rows = (await filtered
                  .select('ts', 'level', 'scope', 'message', 'data')
                  .orderBy('id', 'desc')
                  .limit(opts.limit)) as Array<{
                  ts: number;
                  level: string;
                  scope: string | null;
                  message: string;
                  data: string | null;
                }>;
                return rows.map((row) => {
                  let data: unknown = null;
                  if (typeof row.data === 'string' && row.data !== '') {
                    try {
                      data = JSON.parse(row.data);
                    } catch {
                      data = null; // 损坏行不拖垮整个列表
                    }
                  }
                  return {
                    ts: Number(row.ts),
                    level: String(row.level),
                    scope: row.scope == null ? '' : String(row.scope),
                    message: row.message == null ? '' : String(row.message),
                    data,
                  };
                });
              },
            },
          });
          registerCronRoutes(extra, {
            checker: authChecker,
            scheduler: cron,
            history: (jobId, limit) => cronStore.history(jobId, limit),
          });
          // 核心领域 API（files / notifications / chat / tasks）在系统与 Cron API 之后挂载
          core.registerRoutes(extra);

          // ---- 系统操作 MCP Server（/mcp，无状态 Streamable HTTP）----
          // 全部系统操作以标准 MCP 工具暴露（目录见 mcp/system-tools.ts）：外部 LLM/系统
          // 经 /mcp（Bearer/query token → root|admin 或 'mcp:call' scope）调用；内部扩展
          // 经 h.mcp 桥（serverId='system'）调用——运行时同时挂入容器（规范事实来源）与
          // 进程槽（桥的默认解析路径），桥在请求期懒读，挂入时序无关。/mcp 独立前缀，
          // 与 auth mount（/api/v1/auth|users）、/ext/* 通配、/api/v1/mcp/* 互不冲突。
          const systemMcp = new SystemMcpServer({
            kernel: this,
            checker: authChecker,
            updater,
            cronHistory: (jobId, limit) => cronStore.history(jobId, limit),
          });
          this.container.instance(SYSTEM_TOOLS_CONTAINER_KEY, systemMcp.runtime);
          attachSystemRuntime(systemMcp.runtime);
          const mcpEndpointOptions = { schema: { tags: ['mcp'] } };
          extra.post('/mcp', mcpEndpointOptions, (request, reply) => systemMcp.handleRequest(request, reply));
          // GET/DELETE：无状态模式无会话流（独立 SSE 流 / 会话关闭不存在）→ 统一 405
          extra.get('/mcp', mcpEndpointOptions, (request, reply) => systemMcp.handleRequest(request, reply));
          extra.delete('/mcp', mcpEndpointOptions, (request, reply) => systemMcp.handleRequest(request, reply));

          // 沙箱工作区 API（/api/v1/sandbox/*）与升级 API（/api/v1/system/update*，阶段 11）
          registerSandboxRoutes(extra, { checker: authChecker, manager: sandbox });
          registerUpdateRoutes(extra, { checker: authChecker, updater });

          // ---- 扩展子系统（阶段 9）----
          // 扩展管理 API（/api/v1/extensions*，root|admin）。
          // ExtSummary 是 ExtSummaryLike 的结构子集（仅缺 TS 索引签名，运行时形状一致）
          registerExtensionRoutes(extra, {
            checker: authChecker,
            manager: extManager as unknown as ExtensionsApiDeps['manager'],
            registry: extSvcRegistry,
            // 本地扩展包安装（zip → 数据卷 extensions 目录，受信内置目录不受影响）
            install: {
              installZip: (cfg, zipPath, opts) => installExtensionZip(cfg, zipPath, opts),
              dataDir: this.config.dataDir,
              extensionsRepoDir: REPO_EXTENSIONS_DIR,
              onInstalled: (id) => {
                void extManager.rescan().catch((e) => {
                  this.logger.error({ err: e, id }, '[kernel] rescan after extension install failed');
                });
              },
            },
          });

          // GET /api/v1/ui — UI 贡献目录（认证任意角色；管理台/宿主前端消费）
          extra.get('/api/v1/ui', { schema: { tags: ['extensions'] } }, async (request) => {
            const query = (request.query ?? {}) as Record<string, unknown>;
            await authChecker({ token: extractToken(request.headers, query), headers: request.headers });
            return uiRegistry.snapshot();
          });

          // 扩展路由注册表（app 就绪；构造即挂 /ext/* 通配兜底路由）→ 重放缓存的路由表
          const extRouteRegistry = new ExtRouteRegistry({
            app: extra,
            checker: authChecker,
            dispatcher: {
              dispatch: async (routeKey, request, timeoutMs, extId): Promise<ExtDispatchResult> => {
                // 路由归属 extId 由路由注册表随行（查表裁决结果），跨扩展同名路由以此消歧
                const entry = extManager?.getRoutes().find(
                  (r) =>
                    (extId === undefined || r.extId === extId) &&
                    `${r.method.toUpperCase()} ${r.path}` === routeKey,
                );
                if (entry === undefined) {
                  throw err('ROUTE_NOT_FOUND', { detail: { routeKey } });
                }
                const bridge = extManager?.bridgeFor(entry.extId);
                if (bridge === undefined || bridge === null) {
                  throw err('SERVICE_UNAVAILABLE', {
                    detail: { routeKey, cause: 'extension worker is not running' },
                  });
                }
                return (await bridge.callToWorker(
                  entry.extId,
                  HOST_METHODS.routeRequest,
                  { routeKey, request, extId: entry.extId },
                  timeoutMs,
                )) as ExtDispatchResult;
              },
            },
            defaultTimeoutMs: this.config.routeTimeoutMs,
            maxConcurrentPerExt: this.config.maxConcurrentPerExt,
            isBuiltinExt: (extId) =>
              extManager.list().find((x) => x.id === extId)?.host === 'builtin',
            isExtEnabled: (extId) => extManager?.list().some((s) => s.id === extId && s.enabled) === true,
            counters,
            logger: { warn: (msg, obj) => this.logger.warn(obj ?? {}, msg) },
          });
          routeRegistry = extRouteRegistry;
          this.container.instance(CONTAINER_KEYS.extRoutes, extRouteRegistry);
          // 重放：app 就绪前累积的路由表（或 manager 当前表）此刻一次性挂上
          applyRoutes(pendingTable ?? extManager?.getRoutes() ?? []);

          // 注意：扩展 UI 静态资产（registerExtAssets）**不在此处挂载**——此刻
          // extManager.start() 尚未运行（发现/激活未发生），manager.list() 恒为空，
          // 在此挂载会让所有 /ext/{id}/ui/** 永远 404。资产挂载已下移至 #runBoot 的
          // manager.start() 之后（listen 前直接在 app 上补挂，fastify 允许该时序）。

          // ---- builtin mount:'ui'（/admin 接线）----
          // AGENTS.md 内置扩展白名单：webui → /admin。仅注册一条静态入口路由，
          // 请求期查 manager（enabled + manifest.mount==='ui' 的扩展，首个命中）：
          // 命中 → 302 重定向到 /ext/{id}/ui/（资产由补挂的静态插件服务）；
          // 无已启用 ui-mount 扩展 → 404（与内核现状兼容，/ 根路径的应急页语义不变）。
          extra.get('/admin', async (_request, reply) => {
            const uiMount = extManager?.list().find((s) => {
              if (!s.enabled) return false;
              const m = extManager.getManifest(s.id);
              return m?.builtin === true && m?.mount === 'ui';
            });
            if (uiMount === undefined) {
              throw err('ROUTE_NOT_FOUND', { detail: { method: 'GET', url: '/admin' } });
            }
            return reply.redirect(`/ext/${uiMount.id}/ui/`, 302);
          });

          // ---- builtin mount:'auth'（阶段 10）----
          // auth 内置扩展声明相对路径（'/auth/*'、'/users*'），内核按 mount 白名单映射到
          // '/api/v1' 前缀（AGENTS.md：auth → /api/v1/auth|users）。仅注册静态 catch-all，
          // 运行时查 manager 路由表（enable/disable 即表变更；fastify 不支持注销路由）。
          const makeAuthMountHandler = (prefix: string) => {
            return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
              const wildcard = (request.params as Record<string, string | undefined>)['*'] ?? '';
              const declaredPath = wildcard === '' ? `/${prefix}` : `/${prefix}/${wildcard}`;
              const method = request.method.toUpperCase();
              const isAuthMount = (extId: string): boolean => {
                const m = extManager?.getManifest(extId);
                return m?.builtin === true && m?.mount === 'auth';
              };
              // 查表：仅匹配 auth-mount 扩展的路由（method + 声明路径，':param' 提取）
              let matched: { entry: ExtRouteTableEntry; params: Record<string, string> } | undefined;
              for (const entry of extManager?.getRoutes() ?? []) {
                if (!isAuthMount(entry.extId) || entry.method.toUpperCase() !== method) continue;
                const params = matchMountPath(entry.path, declaredPath);
                if (params !== null) {
                  matched = { entry, params };
                  break;
                }
              }
              if (matched === undefined) {
                // 有 auth-mount 扩展但路由不可用（禁用/重载中）→ 503 墓碑；从未部署 → 404
                const known = extManager?.list().some((s) => isAuthMount(s.id)) ?? false;
                throw err(known ? 'SERVICE_UNAVAILABLE' : 'ROUTE_NOT_FOUND', {
                  detail: { path: `/api/v1${declaredPath}`, method: request.method },
                });
              }
              const { entry, params } = matched;
              // 鉴权前置（与 /ext/* 同规则；auth 扩展路由全部声明 public，此分支为后续 mount 语义保留）
              if (entry.auth !== 'public') {
                const query = (request.query ?? {}) as Record<string, unknown>;
                const identity = await authChecker({
                  token: extractToken(request.headers, query),
                  headers: request.headers,
                });
                if (entry.auth === 'admin' && identity.role !== 'root' && identity.role !== 'admin') {
                  throw err('FORBIDDEN', { detail: { route: `${entry.method} ${entry.path}`, role: identity.role } });
                }
                if (entry.scope !== undefined && !identity.scopes.includes('*') && !identity.scopes.includes(entry.scope)) {
                  throw err('FORBIDDEN', { detail: { route: `${entry.method} ${entry.path}`, scope: entry.scope } });
                }
              }
              const bridge = extManager?.bridgeFor(entry.extId);
              if (bridge === undefined || bridge === null) {
                throw err('SERVICE_UNAVAILABLE', {
                  detail: { route: `${entry.method} ${entry.path}`, cause: 'extension worker is not running' },
                });
              }
              // 派发信封与 /ext/* 的 buildDispatchRequest 同形状（body 仅解析 POST/PUT/PATCH）；
              // SEC-7：headers 白名单裁剪（authorization/cookie 等凭据头不下发给扩展）
              const dispatchRequest = {
                method: request.method,
                params,
                query: (request.query ?? {}) as Record<string, unknown>,
                headers: sanitizeExtHeaders(request.headers as Record<string, string | string[] | undefined>, {
                  // auth 为受信第一方：保留 authorization（标准 Bearer 凭据通道）
                  keepAuthorization: true,
                }),
                body:
                  method === 'POST' || method === 'PUT' || method === 'PATCH'
                    ? (request.body ?? null)
                    : null,
                requestId: String(request.id),
              };
              const result = (await bridge.callToWorker(
                entry.extId,
                HOST_METHODS.routeRequest,
                { routeKey: `${entry.method.toUpperCase()} ${entry.path}`, request: dispatchRequest, extId: entry.extId },
                entry.timeoutMs ?? this.config.routeTimeoutMs,
              )) as { status?: unknown; headers?: unknown; body?: unknown } | null | undefined;
              // worker 侧已 normalizeResponse：应答为 { status, headers?, body }
              const status = typeof result?.status === 'number' ? result.status : 200;
              reply.code(status);
              if (
                result !== null &&
                typeof result === 'object' &&
                result.headers !== null &&
                typeof result.headers === 'object'
              ) {
                for (const [name, value] of Object.entries(result.headers as Record<string, string>)) {
                  reply.header(name, value);
                }
              }
              return result !== null && typeof result === 'object' && 'body' in result ? result.body : result;
            };
          };
          for (const prefix of AUTH_MOUNT_PREFIXES) {
            extra.all(`/api/v1/${prefix}`, makeAuthMountHandler(prefix));
            extra.all(`/api/v1/${prefix}/*`, makeAuthMountHandler(prefix));
          }

          this.#registerExtra?.(extra);
        },
      });
      this.#http = http;
      this.container.instance(CONTAINER_KEYS.http, http);

      // fastify app（真实 createHttpServer 暴露；测试 stub 可能没有）：
      // SSE Hub 挂载此刻用；扩展 UI 资产在 manager.start() 后也在此补挂
      const app = (http as { app?: FastifyInstance }).app;
      if (app !== undefined) {
        hub.attach(app);
      }

      // 核心服务先启动（任务线程池就绪）→ 在途升级收尾 → 沙箱（恢复扫描）→ 扩展子系统（worker + 已启用扩展）→ 扩展 UI 资产补挂 → Cron 调度器（含 misfire 裁决）→ ready
      await core.start();

      // settle 在途升级：上一进程 commit 新 slot 并重启后，能执行到这里即新 slot 可启动
      // → markUpdateSettled(ok) + 成功通知。必须在 core.start() 之后（notifier 此刻才存在）；
      // 函数自身吞异常，绝不阻塞 boot。
      await settlePendingUpdate({
        config: this.config,
        logger: this.logger,
        ...(notifier !== undefined ? { notifier } : {}),
      });

      // 沙箱启动：家目录恢复扫描 + 空闲停机定时器（优雅降级：无 Docker 仅 warn 一次）
      await sandbox.start();
      await extManager.start();

      // ------------------------------------------------------------------
      // 扩展 UI 静态资产补挂（时序契约）：registerExtra（serverFactory 装配期）执行时
      // manager 尚未 start，list() 为空——资产挂载必须等发现/激活完成后直接在 app 上
      // 补挂。fastify 允许 listen 前 register（插件在 listen 触发的 ready 时统一加载），
      // 因此此刻 register 合法且请求期即可用。app 为 undefined（stub server）时跳过。
      // ------------------------------------------------------------------
      if (app !== undefined) {
        const assetDirs: ExtAssetDir[] = [];
        for (const summary of extManager.list()) {
          if (summary.manifest?.ui === undefined || summary.dir === undefined) continue;
          const uiRoot = join(summary.dir, 'ui');
          if (!existsSync(uiRoot)) {
            this.logger.warn(
              { extId: summary.id, uiRoot },
              'extension declared ui assets but the ui/ directory is missing; static mount skipped',
            );
            continue;
          }
          assetDirs.push({ extId: summary.id, uiRoot });
        }
        if (assetDirs.length > 0) registerExtAssets(app, assetDirs);
      }

      await cron.start();

      const port = await http.start();
      this.#state = 'ready';
      await hooks.apply(HOOK_POINTS.kernelReady, { port }, { meta: { kernel: 'opptrix-harness' } });
      await eventBus.emit(EVENT_NS.kernel + '.ready', { port }, { source: 'kernel' });
      this.logger.info(
        { port, host: this.config.host, env: this.config.env },
        `kernel ready: listening on ${this.config.host}:${port}`,
      );
    } catch (e) {
      await this.#gracefulAbort();
      throw e;
    }
  }

  /**
   * 优雅关停：stopping → 停止 HTTP → 逆序 provider stop → stopped。
   * 幂等：stopping/stopped 状态下重复调用直接返回；未 boot 过（created）直接落 stopped。
   * 与 boot 互斥：registering/booting 期间调用会先等待 boot 落定（boot 失败不在此 rethrow，
   * 由 boot() 的调用方处理），boot 成功则按正常流程关停，boot 已失败中止（stopped）则直接返回。
   * 单个 provider stop 抛错只记日志，不阻断其余关停步骤。
   */
  async shutdown(reason?: string): Promise<void> {
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      return; // 幂等
    }
    if (this.#state === 'registering' || this.#state === 'booting') {
      const bootPromise = this.#bootPromise;
      if (bootPromise !== undefined) {
        try {
          await bootPromise;
        } catch {
          // boot 失败：其内部已优雅中止落 stopped；错误归 boot() 的调用方，这里不 rethrow
        }
      }
      // 经 state() 读取：#state 在 await 期间会被 boot 流程改写，不能沿用入参前的窄化
      const stateAfterBoot = this.state();
      if (stateAfterBoot === 'stopping' || stateAfterBoot === 'stopped') {
        return; // boot 已失败中止（或并发 shutdown 已接管），无资源需要再释放
      }
    }
    if (this.#state === 'created') {
      // 从未 boot：没有任何已启动资源需要释放
      this.#state = 'stopped';
      return;
    }
    await this.#drain(reason);
  }

  /**
   * 信号处理入口（由宿主 main.ts 挂接；内核自身不注册进程信号监听）。
   * 等价于 shutdown(`signal:${sig}`)。
   */
  handleSignal(sig: string): Promise<void> {
    return this.shutdown(`signal:${sig}`);
  }

  /** 关停执行体：停 Cron → 停 HTTP → 关 SSE Hub → 关日志汇 → 关 DB → 逆序 stop provider → 落 stopped */
  async #drain(reason: string | undefined): Promise<void> {
    this.#state = 'stopping';
    this.logger.info({ reason: reason ?? 'unspecified' }, 'kernel shutting down');

    // shutdown 埋点：资源拆除前广播（监听方还有机会收尾）
    if (this.#hooks !== undefined) {
      try {
        await this.#hooks.apply(HOOK_POINTS.kernelShutdown, { reason: reason ?? 'unspecified' }, { meta: { kernel: 'opptrix-harness' } });
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] shutdown hook failed');
      }
    }
    if (this.#eventBus !== undefined) {
      try {
        await this.#eventBus.emit(`${EVENT_NS.kernel}.shutdown`, { reason: reason ?? 'unspecified' }, { source: 'kernel' });
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] shutdown event failed');
      }
    }

    // 扩展子系统最先停（terminate worker，拒新调用），随后核心服务 → cron → http…
    if (this.#extManager !== undefined) {
      try {
        await this.#extManager.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] extension manager stop failed during shutdown');
      }
      this.#extManager = undefined;
    }

    if (this.#core !== undefined) {
      try {
        await this.#core.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] core services stop failed during shutdown');
      }
      this.#core = undefined;
    }
    if (this.#sandbox !== undefined) {
      try {
        await this.#sandbox.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] sandbox manager stop failed during shutdown');
      }
      this.#sandbox = undefined;
    }
    if (this.#cron !== undefined) {
      try {
        await this.#cron.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] cron scheduler stop failed during shutdown');
      }
      this.#cron = undefined;
    }
    if (this.#http !== undefined) {
      try {
        await this.#http.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] http server stop failed during shutdown');
      }
      this.#http = undefined;
    }
    if (this.container.has(CONTAINER_KEYS.http)) {
      this.container.forget(CONTAINER_KEYS.http);
    }
    if (this.#hub !== undefined) {
      try {
        await this.#hub.close();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] sse hub close failed during shutdown');
      }
      this.#hub = undefined;
    }
    // 日志汇先于数据库关闭：把缓冲日志刷尽再关库，避免关停期写库失败告警
    if (this.#logSink !== undefined) {
      try {
        await this.#logSink.close();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] log sink close failed during shutdown');
      }
      this.#logSink = undefined;
    }
    if (this.#db !== undefined) {
      try {
        await closeDb(this.#db);
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] database close failed during shutdown');
      }
      this.#db = undefined;
      if (this.container.has(CONTAINER_KEYS.db)) this.container.forget(CONTAINER_KEYS.db);
    }

    for (const p of [...this.#booted].reverse()) {
      try {
        await p.stop(this.container);
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] provider stop failed during shutdown');
      }
    }
    this.#booted = [];
    this.#state = 'stopped';
  }

  /**
   * Cron 触发管线：beforeRun hook → 内核级任务分派（kernel:auto-update → Updater.apply，
   * 刻意不等待）→ 广播事件（扩展任务由扩展子系统在阶段 9 注册的监听派发）
   * → onError/afterRun 埋点 → 运行历史落库。任何环节失败不影响调度器继续运行。
   */
  async #onCronFire(hooks: HookManager, eventBus: EventBus, store: CronJobStore, ctx: CronFireContext): Promise<void> {
    const { job, startedAt } = ctx;
    let ok = true;
    let error: string | undefined;
    try {
      await hooks.apply(HOOK_POINTS.cronBeforeRun, job, { meta: { jobId: job.id } });
      // 内核自动升级窗口（job.name === 'kernel:auto-update'，boot 期注册的 extId=null 内核任务）：
      // 升级动作在内核侧执行。apply 全链路（下载/校验/预检）耗时长，刻意不等待——
      // fire-and-forget + 兜底 catch；触发事件照常广播，监听方仍可观测。
      if (job.name === 'kernel:auto-update') {
        this.#updater?.apply().catch((e: unknown) => {
          this.logger.warn({ err: e, jobId: job.id }, '[kernel] auto-update apply failed');
        });
      }
      await eventBus.emit(
        `${EVENT_NS.kernel}.cron.fired`,
        { jobId: job.id, name: job.name, payload: job.payload },
        { source: 'kernel' },
      );
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      try {
        await hooks.apply(HOOK_POINTS.cronOnError, { job, error }, { meta: { jobId: job.id } });
        await eventBus.emit(`${EVENT_NS.kernel}.cron.error`, { jobId: job.id, error }, { source: 'kernel' });
      } catch (hookErr) {
        this.logger.error({ err: hookErr }, '[kernel] cron onError hook failed');
      }
    } finally {
      const finishedAt = Date.now();
      try {
        await hooks.apply(
          HOOK_POINTS.cronAfterRun,
          { job, ok, durationMs: finishedAt - startedAt },
          { meta: { jobId: job.id } },
        );
      } catch (hookErr) {
        this.logger.error({ err: hookErr }, '[kernel] cron afterRun hook failed');
      }
      try {
        await store.recordRun({ jobId: job.id, startedAt, finishedAt, ok, durationMs: finishedAt - startedAt, error });
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] cron run history record failed');
      }
    }
  }

  /**
   * boot 中途失败的优雅中止：停 Cron、停止已启动的 HTTP、关日志汇、逆序 stop 已 boot 的
   * provider，清理绑定，落到 stopped。之后由 boot() 把原始错误 rethrow。
   */
  async #gracefulAbort(): Promise<void> {
    if (this.#extManager !== undefined) {
      try {
        await this.#extManager.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] extension manager stop failed while aborting boot');
      }
      this.#extManager = undefined;
    }
    if (this.#core !== undefined) {
      try {
        await this.#core.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] core services stop failed while aborting boot');
      }
      this.#core = undefined;
    }
    if (this.#sandbox !== undefined) {
      try {
        await this.#sandbox.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] sandbox manager stop failed while aborting boot');
      }
      this.#sandbox = undefined;
    }
    if (this.#cron !== undefined) {
      try {
        await this.#cron.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] cron scheduler stop failed while aborting boot');
      }
      this.#cron = undefined;
    }
    if (this.#http !== undefined) {
      try {
        await this.#http.stop();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] http server stop failed while aborting boot');
      }
      this.#http = undefined;
    }
    if (this.container.has(CONTAINER_KEYS.http)) {
      this.container.forget(CONTAINER_KEYS.http);
    }
    if (this.#hub !== undefined) {
      try {
        await this.#hub.close();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] sse hub close failed while aborting boot');
      }
      this.#hub = undefined;
    }
    // 日志汇先于数据库关闭（同 #drain）
    if (this.#logSink !== undefined) {
      try {
        await this.#logSink.close();
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] log sink close failed while aborting boot');
      }
      this.#logSink = undefined;
    }
    if (this.#db !== undefined) {
      try {
        await closeDb(this.#db);
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] database close failed while aborting boot');
      }
      this.#db = undefined;
      if (this.container.has(CONTAINER_KEYS.db)) this.container.forget(CONTAINER_KEYS.db);
    }
    for (const p of [...this.#booted].reverse()) {
      try {
        await p.stop(this.container);
      } catch (e) {
        this.logger.error({ err: e }, '[kernel] provider stop failed while aborting boot');
      }
    }
    this.#booted = [];
    this.#state = 'stopped';
  }
}
