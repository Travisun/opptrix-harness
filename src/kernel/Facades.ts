/**
 * Facades — 静态门面（App / Config / Log / Event / Hook / Cron）。
 *
 * 设计要点：
 * - 模块级持有当前 Kernel：`bindFacadeKernel()` 在宿主 boot 时绑定一次；
 *   重复绑定会经 `process.emitWarning` warn 一次并覆盖为新内核（覆盖语义，便于测试/热替换）。
 * - 所有服务解析延迟到调用时：每个静态方法在被调用时才从当前内核容器 resolve 目标服务，
 *   因此门面可以在服务登记（provider register/boot 阶段）之前被 import，不会在模块加载期耦合实现。
 * - 服务未登记：统一抛 `HarnessError('KERNEL_NOT_READY')`，detail 携带 `{ service: key }`，
 *   message 说明"哪个服务、要怎么修"（ENGINEERING.md：错误信息面向开发者可操作）。
 * - 返回 Promise 的门面方法（Event.emit / Hook.apply / Cron.*）：服务缺失时以
 *   rejected promise 表达（不同步抛），调用方 `await`/`.catch()` 均可捕获。
 * - 内核未绑定：`getFacadeKernel()` 抛 `HarnessError('INTERNAL')`，message 指引先调用 bindFacadeKernel。
 *
 * 集成契约：总控在内核 provider 阶段按 {@link FACADE_CONTAINER_KEYS} 登记三个并行包实现：
 * - `events.bus`     → EventBus      （src/kernel/events/bus.ts）
 * - `hooks.manager`  → HookManager   （src/kernel/hooks/manager.ts）
 * - `cron.scheduler` → CronScheduler （src/kernel/cron/scheduler.ts）
 */
import type { Logger as PinoLogger } from 'pino';

import type { Container } from './Container.js';
import type { Kernel } from './Kernel.js';
import { configGet } from './config/index.js';
import { err } from './errors/index.js';
import type { EventBus, EmitResult, EventHandler, SubscribeOptions } from './events/bus.js';
import type { HookManager, HookHandler } from './hooks/manager.js';
import type { CronScheduler, CronJobRecord, CronScheduleInput } from './cron/scheduler.js';

/**
 * 门面专用容器 key（与 CONTAINER_KEYS 同风格的常量表）。
 * Event/Hook/Cron 门面按这些 key 从内核容器延迟 resolve 服务；
 * 集成时由总控按此登记，key 漂移会在门面调用期以 KERNEL_NOT_READY fail-fast 暴露。
 */
export const FACADE_CONTAINER_KEYS = {
  eventBus: 'events.bus',
  hookManager: 'hooks.manager',
  cronScheduler: 'cron.scheduler',
} as const;

// ---------------------------------------------------------------------------
// 内核绑定（模块级状态）
// ---------------------------------------------------------------------------

/** 当前绑定的内核；门面全部行为以它为根（调用时读取，支持覆盖重绑） */
let current: Kernel | undefined;

/**
 * 绑定门面使用的内核实例（宿主 boot 时调用一次）。
 * 重复绑定：warn 一次（process.emitWarning，code=HARNESS_FACADES_REBIND）并覆盖为新内核。
 * @param kernel 宿主创建并启动的内核实例
 */
export function bindFacadeKernel(kernel: Kernel): void {
  if (current !== undefined) {
    process.emitWarning(
      '[facades] a kernel is already bound; the previous binding has been overwritten. ' +
        'Call bindFacadeKernel(kernel) exactly once at boot.',
      { code: 'HARNESS_FACADES_REBIND' },
    );
  }
  current = kernel;
}

/**
 * 读取当前绑定的内核（门面内部使用；宿主/测试也可用于断言绑定状态）。
 * @throws HarnessError('INTERNAL') 内核尚未绑定
 */
export function getFacadeKernel(): Kernel {
  if (current === undefined) {
    throw err('INTERNAL', {
      message: '[facades] kernel not bound; call bindFacadeKernel(kernel) at boot',
    });
  }
  return current;
}

/**
 * 从当前内核容器延迟解析服务；任何 resolve 失败统一规整为 KERNEL_NOT_READY。
 * @param key 容器服务 key
 * @throws HarnessError('KERNEL_NOT_READY') detail 携带 { service: key }
 */
function resolveFacadeService<T>(key: string): T {
  try {
    return getFacadeKernel().container.resolve<T>(key);
  } catch (e) {
    throw err('KERNEL_NOT_READY', {
      message:
        `[facades] container service "${key}" is not available. ` +
        'Facades resolve lazily at call time: register the service under FACADE_CONTAINER_KEYS ' +
        'during kernel boot (provider register/boot) before calling facade methods.',
      detail: { service: key },
      cause: e,
    });
  }
}

// ---------------------------------------------------------------------------
// App — 容器门面
// ---------------------------------------------------------------------------

/**
 * `App` — 内核 DI 容器的静态访问入口。
 *
 * @example
 * const settings = App.resolve<SettingsService>('settings');
 * if (App.has('secrets')) { ... }
 * App.container.instance('my.service', svc);
 */
export class App {
  /**
   * 解析容器服务。
   * @param key 容器服务 key（CONTAINER_KEYS / FACADE_CONTAINER_KEYS 或扩展登记的 key）
   * @throws HarnessError('KERNEL_NOT_READY') 内核未绑定或 key 未登记
   */
  static resolve<T = unknown>(key: string): T {
    return resolveFacadeService<T>(key);
  }

  /** key 是否已在当前内核容器可用（不触发解析） */
  static has(key: string): boolean {
    return getFacadeKernel().container.has(key);
  }

  /** 当前内核容器（getter：跟随最新绑定的内核，支持运行期重绑） */
  static get container(): Container {
    return getFacadeKernel().container;
  }
}

// ---------------------------------------------------------------------------
// Config — 配置门面
// ---------------------------------------------------------------------------

/**
 * `Config` — 内核配置的点号读取入口。
 *
 * @example
 * Config.get<number>('port');            // 3000
 * Config.get('a.b.c', 'fallback');       // 路径缺失时返回 fallback
 */
export class Config {
  /**
   * 点号路径读取内核配置。
   * @param path 点号路径（如 'port'、'a.b.c'）
   * @param fallback 路径不存在/断链时的兜底值；缺省为 undefined
   */
  static get<T = unknown>(path: string, fallback?: T): T | undefined {
    return configGet(getFacadeKernel().config, path, fallback);
  }
}

// ---------------------------------------------------------------------------
// Log — 日志门面
// ---------------------------------------------------------------------------

/**
 * `Log` — 内核 pino logger 的静态门面（转发 kernel.logger，天然带脱敏层）。
 *
 * @example
 * Log.info('service started', { port: 3000 });
 * const log = Log.child('my-extension');   // 带 scope 字段的 child logger
 */
export class Log {
  /** debug 级别：`Log.debug(msg, obj?)` */
  static debug(msg: string, obj?: object): void {
    const logger = getFacadeKernel().logger;
    if (obj === undefined) logger.debug(msg);
    else logger.debug(obj, msg);
  }

  /** info 级别：`Log.info(msg, obj?)` */
  static info(msg: string, obj?: object): void {
    const logger = getFacadeKernel().logger;
    if (obj === undefined) logger.info(msg);
    else logger.info(obj, msg);
  }

  /** warn 级别：`Log.warn(msg, obj?)` */
  static warn(msg: string, obj?: object): void {
    const logger = getFacadeKernel().logger;
    if (obj === undefined) logger.warn(msg);
    else logger.warn(obj, msg);
  }

  /** error 级别：`Log.error(msg, obj?)` */
  static error(msg: string, obj?: object): void {
    const logger = getFacadeKernel().logger;
    if (obj === undefined) logger.error(msg);
    else logger.error(obj, msg);
  }

  /**
   * 创建带 `scope` 绑定的 child logger（模块/子系统标注，配合日志检索）。
   * @param scope 作用域名（如 'my-extension'）
   */
  static child(scope: string): PinoLogger {
    return getFacadeKernel().logger.child({ scope });
  }
}

// ---------------------------------------------------------------------------
// Event — 事件门面
// ---------------------------------------------------------------------------

/**
 * `Event` — EventBus 门面：进程内事件的发布/订阅入口。
 * 每次调用都延迟 resolve `events.bus`，服务未登记时抛 KERNEL_NOT_READY。
 *
 * @example
 * const off = Event.on('user.*', (payload) => { ... });
 * await Event.emit('user.created', { id: 1 });
 * off();
 */
export class Event {
  /** 订阅匹配 pattern 的事件；返回退订函数（幂等） */
  static on(pattern: string, handler: EventHandler, opts?: SubscribeOptions): () => void {
    return resolveFacadeService<EventBus>(FACADE_CONTAINER_KEYS.eventBus).on(pattern, handler, opts);
  }

  /** 订阅一次性事件（首次命中后自动移除）；返回退订函数（幂等） */
  static once(pattern: string, handler: EventHandler, opts?: SubscribeOptions): () => void {
    return resolveFacadeService<EventBus>(FACADE_CONTAINER_KEYS.eventBus).once(pattern, handler, opts);
  }

  /** 显式退订指定 pattern 上的 handler（安全 no-op） */
  static off(pattern: string, handler: EventHandler): void {
    resolveFacadeService<EventBus>(FACADE_CONTAINER_KEYS.eventBus).off(pattern, handler);
  }

  /**
   * 发布事件；返回投递结果（delivered 计数 + 被隔离的监听器异常）。
   * 服务缺失时以 rejected promise 表达（不同步抛），调用方 await/.catch 均可捕获。
   */
  static async emit(name: string, payload: unknown, opts?: { source?: string }): Promise<EmitResult> {
    return resolveFacadeService<EventBus>(FACADE_CONTAINER_KEYS.eventBus).emit(name, payload, opts);
  }

  /** 指定 pattern（或缺省全部）的监听器数量 */
  static listenerCount(pattern?: string): number {
    return resolveFacadeService<EventBus>(FACADE_CONTAINER_KEYS.eventBus).listenerCount(pattern);
  }
}

// ---------------------------------------------------------------------------
// Hook — 钩子门面
// ---------------------------------------------------------------------------

/**
 * `Hook` — HookManager 门面：管道式钩子（filter 链）的注册与执行入口。
 * 每次调用都延迟 resolve `hooks.manager`，服务未登记时抛 KERNEL_NOT_READY。
 *
 * @example
 * const off = Hook.add('user.created', async (value) => ({ ...value, touched: true }));
 * const result = await Hook.apply('user.created', { id: 1 });
 */
export class Hook {
  /** 注册 handler 到指定埋点链；返回移除函数（幂等） */
  static add<T = unknown>(name: string, handler: HookHandler<T>, opts?: { priority?: number }): () => void {
    return resolveFacadeService<HookManager>(FACADE_CONTAINER_KEYS.hookManager).add(name, handler, opts);
  }

  /** 按引用移除指定埋点下的 handler（未注册时静默返回） */
  static remove(name: string, handler: HookHandler): void {
    resolveFacadeService<HookManager>(FACADE_CONTAINER_KEYS.hookManager).remove(name, handler);
  }

  /**
   * 执行钩子管道（值依次流过各 handler），返回最终值。
   * 服务缺失时以 rejected promise 表达（不同步抛），调用方 await/.catch 均可捕获。
   */
  static async apply<T = unknown>(name: string, value: unknown, ctx?: { meta?: Record<string, unknown> }): Promise<T> {
    return resolveFacadeService<HookManager>(FACADE_CONTAINER_KEYS.hookManager).apply(name, value, ctx) as Promise<T>;
  }

  /** 是否存在指定名称的钩子 */
  static has(name: string): boolean {
    return resolveFacadeService<HookManager>(FACADE_CONTAINER_KEYS.hookManager).has(name);
  }

  /** 指定钩子（或缺省全部）的 handler 数量 */
  static handlerCount(name?: string): number {
    return resolveFacadeService<HookManager>(FACADE_CONTAINER_KEYS.hookManager).handlerCount(name);
  }
}

// ---------------------------------------------------------------------------
// Cron — 定时任务门面
// ---------------------------------------------------------------------------

/**
 * `Cron` — CronScheduler 门面：定时任务的登记与管理入口。
 * 每次调用都延迟 resolve `cron.scheduler`，服务未登记时抛 KERNEL_NOT_READY。
 *
 * @example
 * const job = await Cron.schedule({ name: 'nightly-backup', expr: '0 4 * * *' });
 * await Cron.disable(job.id);
 * await Cron.runNow(job.id);
 */
export class Cron {
  /** 登记定时任务，返回任务记录。服务缺失时以 rejected promise 表达（不同步抛） */
  static async schedule(input: CronScheduleInput): Promise<CronJobRecord> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).schedule(input);
  }

  /** 注销任务；任务存在且被移除返回 true */
  static async unschedule(id: string): Promise<boolean> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).unschedule(id);
  }

  /** 启用任务（转发 setEnabled(id, true)） */
  static async enable(id: string): Promise<CronJobRecord | null> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).setEnabled(id, true);
  }

  /** 停用任务（转发 setEnabled(id, false)） */
  static async disable(id: string): Promise<CronJobRecord | null> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).setEnabled(id, false);
  }

  /** 部分更新任务（name/expr/tz/payload/overlap/misfire；enabled 走 enable/disable） */
  static async update(id: string, patch: Partial<CronScheduleInput>): Promise<CronJobRecord | null> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).update(id, patch);
  }

  /** 列出任务（可按 extId 过滤） */
  static list(opts?: { extId?: string }): CronJobRecord[] {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).list(opts);
  }

  /** 按 id 读取任务；不存在返回 null */
  static get(id: string): CronJobRecord | null {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).get(id);
  }

  /** 立即触发一次任务（不等下一个表达式触发点） */
  static async runNow(id: string): Promise<void> {
    return resolveFacadeService<CronScheduler>(FACADE_CONTAINER_KEYS.cronScheduler).runNow(id);
  }
}
