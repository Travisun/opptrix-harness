/**
 * vm-runtime — 扩展专属 vm.Context 装配。
 *
 * 每个扩展一个独立 context（Extension Worker 线程内隔离单元）。职责：
 * - 注入扩展所需的最小全局面：console（受控转发内核 log topic）、
 *   setTimeout / setInterval / clearTimeout / clearInterval（受控登记表，
 *   cleanup() 全清）、queueMicrotask、structuredClone、TextEncoder / TextDecoder、
 *   URL、crypto.getRandomValues(+randomUUID，globalThis.crypto 子集)；
 * - 所有全局绑定不可写、不可配置（严格模式改写抛 TypeError，宽松模式静默无效）；
 *   自建对象（console / crypto / 定时器包装器等）额外 Object.freeze；
 * - 刻意不注入：process / require / Buffer / performance —— 受限 require 由
 *   sandbox.ts 装配，模块在宿主侧编译进本 context；宿主自身禁止 console.*。
 * - 定时器 / 微任务回调异常一律 try/catch + kernelCall log error 转发，
 *   单个扩展的回调异常绝不击穿线程。
 *
 * 注意：本文件经 Node 24 原生 TS 剥离加载（execArgv: []），只能使用可剥离语法
 * （interface / 类型标注 / as const 等），禁用 enum / namespace / 构造器参数属性。
 */
import { randomUUID, webcrypto } from 'node:crypto';
import vm from 'node:vm';

import { KERNEL_TOPICS } from './protocol.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 宿主侧结构化 logger（对齐内核 pino 可调用子集，用于 kernelCall 失败时的降级记录） */
export interface SandboxLogger {
  info(o: unknown, msg: string): void;
  warn(o: unknown, msg: string): void;
  error(o: unknown, msg: string): void;
  debug(o: unknown, msg: string): void;
}

/** 扩展线程调用内核服务的统一入口（worker.ts 装配，测试可注入 mock） */
export type KernelCall = (topic: string, payload: unknown, timeoutMs?: number) => Promise<unknown>;

/**
 * 受控定时器登记表：VM 内创建的全部定时器都登记在册，
 * `clearAll()` 一次性清空（扩展卸载 / cleanup 时调用，防止句柄泄漏）。
 */
export interface TimerRegistry {
  /** 当前在册定时器数量（诊断用） */
  readonly size: number;
  /** 登记一个定时器 */
  track(timer: NodeJS.Timeout): void;
  /** 摘除登记（触发完毕或已清除时；未知对象安全 no-op） */
  untrack(timer: NodeJS.Timeout): void;
  /** 清空并清除全部在册定时器 */
  clearAll(): void;
}

/** 创建独立的定时器登记表 */
export function createTimerRegistry(): TimerRegistry {
  const timers = new Set<NodeJS.Timeout>();
  return {
    get size() {
      return timers.size;
    },
    track(timer) {
      timers.add(timer);
    },
    untrack(timer) {
      timers.delete(timer);
    },
    clearAll() {
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.clear();
    },
  };
}

/** createExtVm 依赖集合 */
export interface VmRuntimeDeps {
  /** 扩展 id（日志定位用） */
  extId: string;
  /** 宿主侧降级 logger */
  logger: SandboxLogger;
  /** 内核 RPC 入口（console → log topic 转发） */
  kernelCall: KernelCall;
  /** 外部共享定时器登记表；不传时内部自建（cleanup 只清内部表） */
  timers?: TimerRegistry;
}

/** 装配产物：context 供 sandbox/worker 继续装配；cleanup 清全部受控定时器 */
export interface ExtVm {
  context: vm.Context;
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** console 转发单次最多携带的参数个数（超出截断，fail-open 但保上限） */
const LOG_MAX_ARGS = 20;
/** console 转发每个参数序列化后的最大字符数（约 2KB） */
const LOG_MAX_ARG_CHARS = 2048;
/** console 转发 RPC 的超时（日志不应长时间占用扩展线程的调用预算） */
const LOG_RPC_TIMEOUT_MS = 5_000;
/** Node 定时器延迟上限（毫秒），超出按 Node 语义收敛为 1ms */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// console 转发
// ---------------------------------------------------------------------------

/**
 * 单参数序列化并截断：字符串原样截断；其余 JSON.stringify（循环结构等
 * 序列化失败降级 String()）。截断到 {@link LOG_MAX_ARG_CHARS}。
 */
function truncateLogArg(arg: unknown): string {
  let text: string;
  if (typeof arg === 'string') {
    text = arg;
  } else {
    try {
      text = JSON.stringify(arg) ?? String(arg);
    } catch {
      text = String(arg);
    }
  }
  return text.length <= LOG_MAX_ARG_CHARS ? text : text.slice(0, LOG_MAX_ARG_CHARS);
}

/**
 * 构造 VM 内 console（冻结）：info/warn/error/debug 全部转发到
 * kernelCall(KERNEL_TOPICS.log, { level, msg, args })；scope（ext:<id>）
 * 由内核侧按信封 from 处理，这里不重复携带。
 * kernelCall 失败降级 deps.logger，绝不向 VM 抛错。
 */
function makeConsole(deps: VmRuntimeDeps): unknown {
  const forward = (level: string) => (msg: unknown, ...rest: unknown[]): void => {
    const payload = {
      level,
      msg: typeof msg === 'string' ? msg : truncateLogArg(msg),
      args: rest.slice(0, LOG_MAX_ARGS).map(truncateLogArg),
    };
    deps.kernelCall(KERNEL_TOPICS.log, payload, LOG_RPC_TIMEOUT_MS).catch(() => {
      deps.logger.error({ extId: deps.extId, level }, 'sandbox console forward failed');
    });
  };
  return Object.freeze({
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  });
}

// ---------------------------------------------------------------------------
// 受控定时器与异步回调防护
// ---------------------------------------------------------------------------

/** 定时器/微任务回调异常：kernelCall log error 转发；再失败降级宿主 logger */
function reportCallbackFailure(deps: VmRuntimeDeps, label: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  deps.kernelCall(KERNEL_TOPICS.log, {
    level: 'error',
    msg: `sandbox ${label} callback failed: ${message}`,
    args: [truncateLogArg(e)],
  }, LOG_RPC_TIMEOUT_MS).catch(() => {
    deps.logger.error({ extId: deps.extId, err: message }, `sandbox ${label} callback failed`);
  });
}

/**
 * 执行回调并兜住同步抛出与 Promise 拒绝：
 * setTimeout 回调抛异常 / 返回值 reject 都不会变成未捕获异常击穿线程。
 */
function guardCallback(deps: VmRuntimeDeps, label: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
      (result as Promise<unknown>).then(undefined, (e: unknown) => reportCallbackFailure(deps, label, e));
    }
  } catch (e) {
    reportCallbackFailure(deps, label, e);
  }
}

/** 延迟毫秒规整：非法/负值归 0，超上限收敛（对齐 Node 1ms 溢出语义的精神） */
function normalizeDelay(delay: unknown): number {
  const n = Number(delay ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > MAX_TIMER_DELAY_MS ? 1 : n;
}

/** 构造 VM 内 setTimeout/setInterval（冻结、登记表受控、回调异常防护） */
function makeScheduleTimer(deps: VmRuntimeDeps, timers: TimerRegistry, interval: boolean): unknown {
  return Object.freeze((callback: unknown, delay?: unknown, ...args: unknown[]): NodeJS.Timeout => {
    if (typeof callback !== 'function') {
      throw new TypeError('setTimeout/setInterval: callback must be a function (string code is not allowed in the sandbox)');
    }
    const ms = normalizeDelay(delay);
    const invoke = (): unknown => (callback as (...a: unknown[]) => unknown)(...args);
    const timer = interval
      ? setInterval(() => guardCallback(deps, 'setInterval', invoke), ms)
      : setTimeout(() => {
          timers.untrack(timer);
          guardCallback(deps, 'setTimeout', invoke);
        }, ms);
    timers.track(timer);
    return timer;
  });
}

/** 构造 VM 内 clearTimeout/clearInterval（冻结；顺手从登记表摘除，未知对象安全） */
function makeClearTimer(timers: TimerRegistry, interval: boolean): unknown {
  return Object.freeze((timer: unknown): void => {
    if (timer === null || (typeof timer !== 'object' && typeof timer !== 'function')) return;
    if (interval) clearInterval(timer as NodeJS.Timeout);
    else clearTimeout(timer as NodeJS.Timeout);
    timers.untrack(timer as NodeJS.Timeout);
  });
}

// ---------------------------------------------------------------------------
// 全局注入
// ---------------------------------------------------------------------------

/**
 * 以不可写、不可配置、可枚举的属性描述符注入全局：
 * VM 内严格模式改写抛 TypeError，宽松模式静默无效（测试两条路径都覆盖）。
 */
function defineGlobal(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, { value, writable: false, enumerable: true, configurable: false });
}

/**
 * 装配扩展专属 VM 上下文。
 *
 * 注入面（全部不可改写；自建对象冻结）见文件头注释；未注入的宿主能力
 * （process/require/Buffer/performance 等）在 context 内为 undefined。
 */
export function createExtVm(deps: VmRuntimeDeps): ExtVm {
  const timers = deps.timers ?? createTimerRegistry();
  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);

  // 诊断标记（只读；便于内核侧日志/调试定位 context 归属）
  defineGlobal(sandbox, '__opptrixExtId', deps.extId);

  // console：受控转发（冻结对象 + 冻结方法绑定）
  defineGlobal(sandbox, 'console', makeConsole(deps));

  // 定时器：受控登记表，cleanup() 全清
  defineGlobal(sandbox, 'setTimeout', makeScheduleTimer(deps, timers, false));
  defineGlobal(sandbox, 'setInterval', makeScheduleTimer(deps, timers, true));
  defineGlobal(sandbox, 'clearTimeout', makeClearTimer(timers, false));
  defineGlobal(sandbox, 'clearInterval', makeClearTimer(timers, true));

  // 微任务：同样加防护（queueMicrotask 回调抛出会成为宿主未捕获异常）
  defineGlobal(sandbox, 'queueMicrotask', Object.freeze((callback: unknown): void => {
    if (typeof callback !== 'function') {
      throw new TypeError('queueMicrotask: callback must be a function');
    }
    queueMicrotask(() => guardCallback(deps, 'microtask', callback as () => unknown));
  }));

  // 结构化数据与编码：以子类/包装函数冻结 shim，避免冻结共享宿主构造器污染宿主 realm
  defineGlobal(sandbox, 'structuredClone', Object.freeze(
    (value: unknown, options?: { transfer?: ArrayBuffer[] }): unknown => structuredClone(value, options),
  ));
  class TextEncoderShim extends TextEncoder {}
  Object.freeze(TextEncoderShim);
  defineGlobal(sandbox, 'TextEncoder', TextEncoderShim);
  class TextDecoderShim extends TextDecoder {}
  Object.freeze(TextDecoderShim);
  defineGlobal(sandbox, 'TextDecoder', TextDecoderShim);
  class UrlShim extends URL {}
  Object.freeze(UrlShim);
  defineGlobal(sandbox, 'URL', UrlShim);

  // crypto 子集：getRandomValues（对齐 globalThis.crypto 语义，含 65536 上限）+ randomUUID
  const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
  const randomUUID = (): string => randomUUID();
  defineGlobal(sandbox, 'crypto', Object.freeze({
    getRandomValues: (array: ArrayBufferView): ArrayBufferView =>
      getRandomValues(array as unknown as Parameters<typeof getRandomValues>[0]) as ArrayBufferView,
    randomUUID,
  }));

  return {
    context,
    cleanup: () => timers.clearAll(),
  };
}
