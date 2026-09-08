/**
 * vm-runtime — 扩展专属 vm.Context 装配。
 *
 * 每个扩展一个独立 context（Extension Worker 线程内隔离单元）。职责：
 * - 注入扩展所需的最小全局面：console（受控转发内核 log topic）、
 *   setTimeout / setInterval / clearTimeout / clearInterval（受控登记表，
 *   cleanup() 全清）、queueMicrotask、structuredClone、TextEncoder / TextDecoder、
 *   URL、crypto.getRandomValues(+randomUUID，globalThis.crypto 子集)；
 * - **SEC-1 realm 加固**：凡递入 VM 的宿主函数一律经 realm.ts 的桥包装成 VM realm
 *   函数，凡暴露对象一律建成 VM realm 对象——扩展代码 `x.constructor.constructor(...)`
 * 无法再触达宿主 Function 构造器（四条实测逃逸链的根因修复在本文件与 realm.ts）：
 *   · console 各方法、定时器包装器、queueMicrotask、structuredClone、
 *     TextEncoder/TextDecoder/URL/crypto 的可调用成员全部是 VM realm 函数；
 *   · 定时器句柄改为 VM 侧数字令牌（宿主 Timeout 对象不再进入 VM）；
 *   · structuredClone 即 VM 内编译的深拷贝器（输出 VM realm 对象）；
 *   · TextEncoder/TextDecoder/URL 为 VM 内编译的委托类（编译产物即 VM realm 类，
 *     编码结果经深拷贝入 VM realm）。
 * - 所有全局绑定不可写、不可配置（严格模式改写抛 TypeError，宽松模式静默无效）；
 *   自建对象（console / crypto / 定时器包装器等）在 VM 侧 Object.freeze；
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

import { realmBridgeFor } from './realm.js';
import type { RealmBridge } from './realm.js';
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

/** 装配产物：context 供 sandbox/worker 继续装配；bridge 供宿主向 VM 递函数/数据；cleanup 清全部受控定时器 */
export interface ExtVm {
  context: vm.Context;
  /** 宿主 ⇄ VM realm 边界包装工厂（SEC-1：宿主函数/数据经它包装后才能进 VM） */
  readonly bridge: RealmBridge;
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
 * 装配受控定时器（SEC-1：句柄是 VM 侧数字令牌，宿主 Timeout 对象不进 VM；
 * 包装函数本身是 VM realm 函数）。返回 id → 实际定时器的宿主侧映射。
 */
function installTimers(
  deps: VmRuntimeDeps,
  timers: TimerRegistry,
  bridge: RealmBridge,
  sandbox: Record<string, unknown>,
): void {
  let nextId = 1;
  const timerById = new Map<number, NodeJS.Timeout>();

  const schedule = (callback: unknown, delay: unknown, args: unknown[], interval: boolean): number => {
    if (typeof callback !== 'function') {
      throw new TypeError('setTimeout/setInterval: callback must be a function (string code is not allowed in the sandbox)');
    }
    const ms = normalizeDelay(delay);
    const id = nextId++;
    const invoke = (): unknown => (callback as (...a: unknown[]) => unknown)(...args);
    const timer = interval
      ? setInterval(() => guardCallback(deps, 'setInterval', invoke), ms)
      : setTimeout(() => {
          timerById.delete(id);
          timers.untrack(timer);
          guardCallback(deps, 'setTimeout', invoke);
        }, ms);
    timerById.set(id, timer);
    timers.track(timer);
    return id;
  };

  const clear = (token: unknown, interval: boolean): void => {
    const id = typeof token === 'number' ? token : Number(token);
    if (!Number.isInteger(id) || id <= 0) return;
    const timer = timerById.get(id);
    if (timer === undefined) return;
    timerById.delete(id);
    timers.untrack(timer);
    if (interval) clearInterval(timer);
    else clearTimeout(timer);
  };

  defineGlobal(sandbox, 'setTimeout', bridge.toVmFn((callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(callback, delay, args, false)));
  defineGlobal(sandbox, 'setInterval', bridge.toVmFn((callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(callback, delay, args, true)));
  defineGlobal(sandbox, 'clearTimeout', bridge.toVmFn((token: unknown) => clear(token, false)));
  defineGlobal(sandbox, 'clearInterval', bridge.toVmFn((token: unknown) => clear(token, true)));
}

/**
 * 装配扩展专属 VM 上下文。
 *
 * 注入面（全部不可改写；自建对象 VM 侧冻结；全部成员为 VM realm 函数/类）见文件头注释；
 * 未注入的宿主能力（process/require/Buffer/performance 等）在 context 内为 undefined。
 */
export function createExtVm(deps: VmRuntimeDeps): ExtVm {
  const timers = deps.timers ?? createTimerRegistry();
  const sandbox: Record<string, unknown> = {};
  const context = vm.createContext(sandbox);
  const bridge = realmBridgeFor(context);

  // 诊断标记（只读；便于内核侧日志/调试定位 context 归属）
  defineGlobal(sandbox, '__opptrixExtId', deps.extId);

  // console：受控转发（VM realm 冻结对象 + VM realm 方法绑定；SEC-1 console 链根除）
  defineGlobal(
    sandbox,
    'console',
    bridge.makeVmObject({
      debug: bridge.toVmFn((msg: unknown, ...rest: unknown[]): void => {
        const payload = {
          level: 'debug',
          msg: typeof msg === 'string' ? msg : truncateLogArg(msg),
          args: rest.slice(0, LOG_MAX_ARGS).map(truncateLogArg),
        };
        deps.kernelCall(KERNEL_TOPICS.log, payload, LOG_RPC_TIMEOUT_MS).catch(() => {
          deps.logger.error({ extId: deps.extId, level: 'debug' }, 'sandbox console forward failed');
        });
      }),
      info: bridge.toVmFn((msg: unknown, ...rest: unknown[]): void => {
        const payload = {
          level: 'info',
          msg: typeof msg === 'string' ? msg : truncateLogArg(msg),
          args: rest.slice(0, LOG_MAX_ARGS).map(truncateLogArg),
        };
        deps.kernelCall(KERNEL_TOPICS.log, payload, LOG_RPC_TIMEOUT_MS).catch(() => {
          deps.logger.error({ extId: deps.extId, level: 'info' }, 'sandbox console forward failed');
        });
      }),
      warn: bridge.toVmFn((msg: unknown, ...rest: unknown[]): void => {
        const payload = {
          level: 'warn',
          msg: typeof msg === 'string' ? msg : truncateLogArg(msg),
          args: rest.slice(0, LOG_MAX_ARGS).map(truncateLogArg),
        };
        deps.kernelCall(KERNEL_TOPICS.log, payload, LOG_RPC_TIMEOUT_MS).catch(() => {
          deps.logger.error({ extId: deps.extId, level: 'warn' }, 'sandbox console forward failed');
        });
      }),
      error: bridge.toVmFn((msg: unknown, ...rest: unknown[]): void => {
        const payload = {
          level: 'error',
          msg: typeof msg === 'string' ? msg : truncateLogArg(msg),
          args: rest.slice(0, LOG_MAX_ARGS).map(truncateLogArg),
        };
        deps.kernelCall(KERNEL_TOPICS.log, payload, LOG_RPC_TIMEOUT_MS).catch(() => {
          deps.logger.error({ extId: deps.extId, level: 'error' }, 'sandbox console forward failed');
        });
      }),
    }),
  );

  // 定时器：受控登记表（数字令牌句柄），cleanup() 全清
  installTimers(deps, timers, bridge, sandbox);

  // 微任务：同样加防护（queueMicrotask 回调抛出会成为宿主未捕获异常）
  defineGlobal(
    sandbox,
    'queueMicrotask',
    bridge.toVmFn((callback: unknown): void => {
      if (typeof callback !== 'function') {
        throw new TypeError('queueMicrotask: callback must be a function');
      }
      queueMicrotask(() => guardCallback(deps, 'microtask', callback as () => unknown));
    }),
  );

  // structuredClone：VM 内编译的深拷贝器本体（SEC-1：必须是 VM realm 函数原身，
  // 不能用宿主侧箭头包装——否则 .constructor.constructor 重新打开逃逸链）
  defineGlobal(sandbox, 'structuredClone', bridge.vmToVmValue as unknown);

  // TextEncoder / TextDecoder：VM 内编译的委托类（类本体即 VM realm；
  // encode 结果经深拷贝入 VM realm，VM 代码无法触达宿主构造器）
  const hostTextEncoder = new TextEncoder();
  const hostTextDecoder = new TextDecoder();
  const makeEncoderClass = vm.runInContext(
    String.raw`(host) => class TextEncoder {
      encode(input) { return host.encode(input === undefined ? '' : String(input)); }
      get encoding() { return 'utf-8'; }
      encodeInto() { throw new Error('TextEncoder.encodeInto is not supported in the sandbox'); }
    }`,
    context,
  ) as (host: { encode(input: string): unknown }) => unknown;
  defineGlobal(sandbox, 'TextEncoder', makeEncoderClass({ encode: (input: string) => bridge.toVmValue(hostTextEncoder.encode(input)) }));

  const makeDecoderClass = vm.runInContext(
    String.raw`(host) => class TextDecoder {
      get encoding() { return host.encoding; }
      decode(input, options) { return host.decode(input, options); }
    }`,
    context,
  ) as (host: {
    encoding: string;
    decode(input: unknown, options?: { stream?: boolean }): string;
  }) => unknown;
  defineGlobal(
    sandbox,
    'TextDecoder',
    makeDecoderClass({
      encoding: 'utf-8',
      decode: (input: unknown, options?: { stream?: boolean }): string =>
        hostTextDecoder.decode(input as unknown as Uint8Array, options),
    }),
  );

  // URL：VM 内编译的委托类（只读访问器 + 常用方法；不暴露宿主 URL 实例）
  const makeUrlClass = vm.runInContext(
    String.raw`(host, toVm) => class URL {
      #u;
      constructor(input, base) {
        this.#u = base === undefined ? host.parse(String(input)) : host.parse(String(input), String(base));
      }
      get href() { return this.#u.href; }
      get origin() { return this.#u.origin; }
      get protocol() { return this.#u.protocol; }
      get username() { return this.#u.username; }
      get password() { return this.#u.password; }
      get host() { return this.#u.host; }
      get hostname() { return this.#u.hostname; }
      get port() { return this.#u.port; }
      get pathname() { return this.#u.pathname; }
      get search() { return this.#u.search; }
      get hash() { return this.#u.hash; }
      get searchParams() {
        const out = {};
        for (const [k, v] of this.#u.searchParams.entries()) out[k] = v;
        return toVm(out);
      }
      toString() { return this.#u.toString(); }
      toJSON() { return this.#u.toJSON(); }
      static canParse(input, base) {
        return base === undefined ? host.canParse(String(input)) : host.canParse(String(input), String(base));
      }
    }`,
    context,
  ) as (host: {
    parse(input: string, base?: string): URL;
    canParse(input: string, base?: string): boolean;
  }, toVm: (v: unknown) => unknown) => unknown;
  defineGlobal(
    sandbox,
    'URL',
    makeUrlClass(
      {
        parse: (input: string, base?: string): URL => new URL(input, base),
        canParse: (input: string, base?: string): boolean =>
          base === undefined
            ? URL.canParse(input)
            : URL.canParse(input, base),
      },
      (v: unknown): unknown => bridge.toVmValue(v),
    ),
  );

  // crypto 子集：getRandomValues（恒等返回传入的同一 VM 侧视图）+ randomUUID；
  // 对象本体在 VM 内构建并冻结（SEC-1：不递宿主对象）
  const getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
  defineGlobal(
    sandbox,
    'crypto',
    bridge.makeVmObject({
      getRandomValues: bridge.toVmPassthroughFn(
        ((array: ArrayBufferView): ArrayBufferView => {
          getRandomValues(array as unknown as Parameters<typeof getRandomValues>[0]);
          return array;
        }) as unknown as (...args: unknown[]) => unknown,
      ),
      randomUUID: bridge.toVmFn((): string => randomUUID()),
    }),
  );

  return {
    context,
    bridge,
    cleanup: () => timers.clearAll(),
  };
}
