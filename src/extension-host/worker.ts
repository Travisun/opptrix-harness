/**
 * worker — 扩展线程入口（由内核以 `new Worker('worker.ts', { execArgv: [] })` 加载）。
 *
 * 职责（全部 HOST_METHODS.* 的线程内实现）：
 * - host.load：createExtVm 装配 VM → 受限 require 执行 manifest.main → 取
 *   module.exports（或 .default）识别 defineExtension → 激活期调用 setup（限时 30s）
 *   → reply { ok: true, contributions: snapshot }；handler Maps 留在本线程内存供
 *   后续 dispatch。失败 → reply { ok: false, err } 并回收 VM 资源。
 * - host.route：找 handler（无 → SERVICE_UNAVAILABLE）→ handler(request) 带
 *   timeoutMs 超时（Promise 竞速；超时回 HARNESS-1002，VM 内继续跑但结果丢弃）→
 *   返回值归一化 { status, headers?, body } → reply。
 * - host.event / host.hook / host.cron / host.call / host.task：按注册表分发；
 *   单个 handler 异常一律隔离（reply err 或 log），绝不击穿线程。
 * - worker→kernel 调用：postMessage call 信封（from ext:<id>），Promise 按 id
 *   关联，超时 30s 拒绝（RPC_TIMEOUT）。
 *
 * 本文件被 worker_threads 加载，必须兼容 Node 24 原生 TS 剥离：仅用可剥离语法
 * （interface / 类型标注，禁 enum / namespace / 构造器参数属性）。作为模块被
 * 主线程导入时（parentPort 为 null，如单测）不挂任何监听器、无副作用。
 */
import { randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';

import { err, HarnessError } from '../kernel/errors/index.js';
import type { ErrorCodeName } from '../kernel/errors/index.js';

import { HOST_METHODS, isRpcEnvelope, KERNEL_TOPICS } from './protocol.js';
import type { RpcEnvelope } from './protocol.js';
import {
  createContributionsCollector,
  createHarnessApi,
  createRestrictedRequire,
  isExtensionDefinition,
} from './sandbox.js';
import type {
  AuthVerifyHandler,
  ContributionsCollector,
  CronHandler,
  RouteHandler,
  RouteRequest,
  ServiceHandler,
  TaskContext,
  TaskHandler,
} from './sandbox.js';
import { createExtVm, createTimerRegistry } from './vm-runtime.js';
import type { ExtVm, KernelCall, SandboxLogger, TimerRegistry } from './vm-runtime.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** worker→kernel 单次调用缺省超时 */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** 扩展 setup() 限时 */
const SETUP_TIMEOUT_MS = 30_000;
/** 路由 handler 未声明 timeoutMs 时的缺省超时 */
const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HookAbort 语义
// ---------------------------------------------------------------------------

/**
 * hook 链中止信号：抛出后 hook 链立即停止，reply { value: e.result, aborted: true }。
 * result 需可结构化克隆。VM 内扩展无法 import 本类，可抛
 * `{ __opptrixHookAbort: true, result }` 形状的对象（isHookAbort 结构识别）。
 */
export class HookAbort extends Error {
  /** 替代链路默认值透传给内核的结果 */
  readonly result: unknown;

  constructor(result: unknown, message = 'hook aborted') {
    super(message);
    this.name = 'HookAbort';
    this.result = result;
  }
}

/** 识别 HookAbort（类实例或 VM 侧的结构等价对象） */
export function isHookAbort(e: unknown): e is HookAbort {
  if (e instanceof HookAbort) return true;
  if (e !== null && typeof e === 'object') {
    const marker = e as { __opptrixHookAbort?: unknown };
    return marker.__opptrixHookAbort === true && 'result' in e;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 纯工具（导出供单测，无副作用）
// ---------------------------------------------------------------------------

/**
 * 事件通配匹配（与内核 EventBus.matchSegments 同款语义）：
 * '.' 分段；`*` 匹配任意单段；`**` 仅末段生效、吞掉剩余全部分段（含 0 段）；
 * 其余段必须字面相等；无 `**` 时段数必须一致。
 */
export function matchPattern(pattern: string, name: string): boolean {
  const patternSegs = pattern.split('.');
  const eventSegs = name.split('.');
  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i];
    if (seg === '**' && i === patternSegs.length - 1) return true;
    if (i >= eventSegs.length) return false;
    if (seg === '*') continue;
    if (seg !== eventSegs[i]) return false;
  }
  return patternSegs.length === eventSegs.length;
}

/**
 * 路由 handler 返回值归一化：
 * - { status: number, body?/headers? } 视为完整响应（缺 body 补 null）；
 * - 其余（含数组/原始值/undefined）包装为 { status: 200, body }（undefined → null）。
 */
export function normalizeResponse(result: unknown): { status: number; headers?: Record<string, string>; body: unknown } {
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (typeof obj['status'] === 'number' && ('body' in obj || 'headers' in obj)) {
      const normalized: { status: number; headers?: Record<string, string>; body: unknown } = {
        status: obj['status'],
        body: obj['body'] === undefined ? null : obj['body'],
      };
      if (obj['headers'] !== undefined && obj['headers'] !== null && typeof obj['headers'] === 'object') {
        normalized.headers = obj['headers'] as Record<string, string>;
      }
      return normalized;
    }
  }
  return { status: 200, body: result === undefined ? null : result };
}

/** detail 的结构化克隆安全化（含 Error/循环结构时降级 String） */
function cloneDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  try {
    return structuredClone(detail);
  } catch {
    return String(detail);
  }
}

/** 任意异常规整为信封 err 形状：HarnessError 保留登记码，其余归 RPC_HANDLER_ERROR */
export function serializeError(e: unknown): { code: string; message: string; detail?: unknown } {
  if (e instanceof HarnessError) {
    return { code: e.code, message: e.message, detail: cloneDetail(e.detail) };
  }
  return { code: err('RPC_HANDLER_ERROR').code, message: e instanceof Error ? e.message : String(e) };
}

/**
 * Promise 竞速超时：超时以指定错误码拒绝；原 Promise 不受影响（VM 内继续跑，
 * 结果由调用方丢弃）。定时器 unref，不阻止线程自然退出。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  code: ErrorCodeName = 'HANDLER_TIMEOUT',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(err(code, { message: `${label} timed out after ${timeoutMs}ms`, detail: { label, timeoutMs } }));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// postMessage 与 worker→kernel RPC
// ---------------------------------------------------------------------------

/** worker_threads 端口；主线程导入（单测）时为 null，此时所有 post 都拒绝 */
function post(message: unknown): void {
  if (parentPort === null) {
    throw new Error('worker.ts must be executed inside a worker_threads Worker');
  }
  try {
    parentPort.postMessage(message);
  } catch {
    // 线程已在关闭（channel closed）：静默丢弃，关停路径不因投递失败而崩
  }
}

/** worker 自身（非扩展）的诊断日志：直接投 log 信封，失败静默 */
function logWorkerError(msg: string, e: unknown): void {
  try {
    post({
      v: 1,
      id: randomUUID(),
      from: 'kernel',
      to: 'kernel',
      type: 'call',
      topic: KERNEL_TOPICS.log,
      payload: { level: 'error', msg, args: [serializeError(e)] },
    });
  } catch {
    /* 线程未运行：无处可投，丢弃 */
  }
}

/** 每扩展一个宿主侧 logger（vm-runtime 降级路径用）：以 ext:<id> 身份投 log 信封 */
function makeLogger(extId: string): SandboxLogger {
  const send = (level: string) => (o: unknown, msg: string): void => {
    try {
      post({
        v: 1,
        id: randomUUID(),
        from: `ext:${extId}`,
        to: 'kernel',
        type: 'call',
        topic: KERNEL_TOPICS.log,
        payload: { level, msg, args: [o] },
      });
    } catch {
      /* 线程未运行：丢弃 */
    }
  };
  return { info: send('info'), warn: send('warn'), error: send('error'), debug: send('debug') };
}

/** 进行中的 worker→kernel 调用（id → 关联表） */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingCall>();

/** 应答回来：按 id 结算关联表；迟到的应答安全丢弃 */
function settleReply(env: RpcEnvelope): void {
  const entry = pending.get(env.id);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  pending.delete(env.id);
  if (env.ok === true) {
    entry.resolve(env.payload);
    return;
  }
  const e = new Error(env.err?.message ?? 'kernel call failed') as Error & { code?: string };
  e.code = env.err?.code ?? err('RPC_HANDLER_ERROR').code;
  entry.reject(e);
}

/** worker→kernel 调用：postMessage call 信封 + Promise 关联（超时 30s 拒绝） */
function makeKernelCall(extId: string): KernelCall {
  return (topic, payload, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) =>
    new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(err('RPC_TIMEOUT', {
          message: `kernel call "${topic}" timed out after ${timeoutMs}ms`,
          detail: { topic, extId, timeoutMs },
        }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      post({ v: 1, id, from: `ext:${extId}`, to: 'kernel', type: 'call', topic, payload });
    });
}

// ---------------------------------------------------------------------------
// 已加载扩展注册表与 HOST_METHODS 实现
// ---------------------------------------------------------------------------

interface LoadedExtension {
  extId: string;
  /** 激活期标志（createHarnessApi 的 activationPhase 闸门读这里） */
  phase: { active: boolean };
  vm: ExtVm;
  timers: TimerRegistry;
  collector: ContributionsCollector;
  kernelCall: KernelCall;
}

const loaded = new Map<string, LoadedExtension>();

function findRouteEntry(routeKey: string): { handler: RouteHandler; timeoutMs?: number } | undefined {
  for (const ext of loaded.values()) {
    const entry = ext.collector.handlers.routes.get(routeKey);
    if (entry !== undefined) return entry;
  }
  return undefined;
}

function findCronHandler(name: string): CronHandler | undefined {
  for (const ext of loaded.values()) {
    const handler = ext.collector.handlers.crons.get(name);
    if (handler !== undefined) return handler;
  }
  return undefined;
}

function findTaskHandler(name: string): { ext: LoadedExtension; handler: TaskHandler } | undefined {
  for (const ext of loaded.values()) {
    const handler = ext.collector.handlers.tasks.get(name);
    if (handler !== undefined) return { ext, handler };
  }
  return undefined;
}

interface Repliers {
  reply: (payload: unknown) => void;
  fail: (e: unknown) => void;
}

/** 构造应答器：type 'call' 才应答（dispatch 单向通知不应答）；fromOverride 供 loadExt 在拿到 extId 后校正 from */
function makeRepliers(env: RpcEnvelope, fromOverride?: string): Repliers {
  if (env.type !== 'call') return { reply: () => {}, fail: () => {} };
  const from = fromOverride ?? env.to;
  return {
    reply: (payload) => post({ v: 1, id: env.id, type: 'reply', from, to: env.from, topic: env.topic, ok: true, payload }),
    fail: (e: unknown) =>
      post({ v: 1, id: env.id, type: 'reply', from, to: env.from, topic: env.topic, ok: false, err: serializeError(e) }),
  };
}

/** 全局 defineExtension 的记录槽（每次 loadExt 一个；扩展在 setup 前调用全局函数时写入） */
interface DefineSlot {
  def: unknown;
}

/**
 * 向扩展 VM 上下文注入全局 `defineExtension`（types/harness.d.ts v1 契约：全局函数）。
 *
 * 记录式语义：调用即把定义写入 slot（函数入参包装为 { setup }，对象入参原样标记），
 * 供 host.load 在 module.exports 未携带定义时兜底识别；同时返回标记对象，
 * 兼容 `module.exports = defineExtension({ setup })` 风格。属性不可写/不可配置，
 * 与 vm-runtime 的全局注入语义一致。
 */
function installDefineExtensionGlobal(context: ExtVm['context'], slot: DefineSlot): void {
  const define = (input: unknown): unknown => {
    const candidate = typeof input === 'function' ? { setup: input } : input;
    const setup = (candidate as { setup?: unknown } | null)?.setup;
    if (typeof setup !== 'function') {
      throw new TypeError('defineExtension(setup): setup must be a function');
    }
    const marked = { __opptrixExtension: true as const, setup };
    slot.def = marked;
    return marked;
  };
  Object.defineProperty(context, 'defineExtension', {
    value: define,
    writable: false,
    enumerable: true,
    configurable: false,
  });
}

/** host.load：装配 VM → 受限 require main → 识别 defineExtension → 激活（setup 限时 30s） */
async function handleLoadExt(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as {
    extId?: unknown;
    manifest?: unknown;
    extDir?: unknown;
    dataDir?: unknown;
    rootToken?: unknown;
  };
  const extId = typeof payload.extId === 'string' ? payload.extId : '';
  const extDir = typeof payload.extDir === 'string' ? payload.extDir : '';
  const manifest = (payload.manifest ?? null) as { main?: unknown; builtin?: unknown; mount?: unknown } | null;
  const main = typeof manifest?.main === 'string' ? manifest.main : '';
  if (extId === '' || extDir === '' || main === '') {
    fail(err('EXT_MANIFEST_INVALID', {
      message: 'host.load requires payload { extId, manifest.main, extDir, dataDir }',
      detail: { extId, extDir, main },
    }));
    return;
  }
  if (loaded.has(extId)) {
    fail(err('EXT_MANIFEST_INVALID', { message: `extension "${extId}" is already loaded in this worker` }));
    return;
  }

  // rootToken 注入闸（worker 侧复核）：仅 builtin && mount==='auth' 的扩展可持有 root 令牌。
  // 内核侧只在给这类扩展的 load payload 里附加 rootToken；此处复核兜底防 payload 伪造向
  // 其余扩展泄露 break-glass 令牌（h.boot.rootToken / setup ctx.rootToken 的唯一来源）。
  const isBuiltinAuth = manifest?.builtin === true && manifest?.mount === 'auth';
  const rootToken =
    isBuiltinAuth && typeof payload.rootToken === 'string' && payload.rootToken !== ''
      ? payload.rootToken
      : undefined;

  const phase = { active: false };
  const timers = createTimerRegistry();
  const kernelCall = makeKernelCall(extId);
  const collector = createContributionsCollector();
  let vmInstance: ExtVm | null = null;
  const recorded: DefineSlot = { def: undefined };
  try {
    vmInstance = createExtVm({ extId, logger: makeLogger(extId), kernelCall, timers });
    installDefineExtensionGlobal(vmInstance.context, recorded);
    const ext: LoadedExtension = { extId, phase, vm: vmInstance, timers, collector, kernelCall };
    const require = createRestrictedRequire({ extDir, context: vmInstance.context });

    // main 归一化为相对形式（manifest.main 常写作 "main.js"）
    const mainSpec = main.startsWith('./') || main.startsWith('../') ? main : `./${main}`;
    const exportsValue: unknown = require(mainSpec);

    let def: unknown = exportsValue;
    if (!isExtensionDefinition(def)) {
      const candidate = (exportsValue as { default?: unknown } | null)?.default;
      if (isExtensionDefinition(candidate)) def = candidate;
    }
    // 全局 defineExtension 记录式兜底（types/harness.d.ts：defineExtension 为扩展全局函数）
    if (!isExtensionDefinition(def) && isExtensionDefinition(recorded.def)) {
      def = recorded.def;
    }
    if (!isExtensionDefinition(def)) {
      throw err('EXT_MANIFEST_INVALID', {
        message: `extension main "${main}" must export defineExtension({ setup }) via module.exports or module.exports.default`,
        detail: { main },
      });
    }

    // h.boot：缺省空冻结对象；rootToken 仅 builtin auth 注入（见上方注入闸）
    const boot: { rootToken?: string } = rootToken === undefined ? {} : { rootToken };
    const harness = createHarnessApi({ extId, kernelCall, contributions: collector, timers, activationPhase: () => phase.active, boot });
    phase.active = true;
    try {
      // setup 第二参 ctx：与 h.boot 同源的引导上下文（向后兼容通道，扩展可忽略）
      await withTimeout(Promise.resolve().then(() => def.setup(harness, { rootToken })), SETUP_TIMEOUT_MS, `setup() of extension "${extId}"`, 'EXT_ACTIVATION_FAILED');
    } finally {
      phase.active = false;
    }
    loaded.set(extId, ext);
    reply({ ok: true, contributions: collector.snapshot() });
  } catch (e) {
    // 激活失败：回收 VM 定时器，注册表不入册（handlers 随局部变量不可达）
    vmInstance?.cleanup();
    timers.clearAll();
    fail(e);
  }
}

/** host.unload：清理 VM 定时器并从注册表摘除（内核负责 cron/任务等内核侧回收） */
function handleUnloadExt(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): void {
  const payload = (env.payload ?? {}) as { extId?: unknown };
  const extId = typeof payload.extId === 'string' ? payload.extId : '';
  const ext = extId === '' ? undefined : loaded.get(extId);
  if (ext === undefined) {
    fail(err('EXT_NOT_FOUND', { message: `extension "${extId}" is not loaded in this worker` }));
    return;
  }
  ext.vm.cleanup();
  ext.timers.clearAll();
  loaded.delete(extId);
  reply({ ok: true, unloaded: extId });
}

/** host.route：按 extId 定位 handler → 超时竞速执行 → 归一化 { status, headers?, body } */
async function handleRouteRequest(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { routeKey?: unknown; request?: unknown; extId?: unknown };
  const routeKey = typeof payload.routeKey === 'string' ? payload.routeKey : '';
  if (routeKey === '' || payload.request === null || typeof payload.request !== 'object') {
    fail(err('BAD_REQUEST', { message: 'host.route requires payload { routeKey, request }' }));
    return;
  }
  // extId 优先：路由命中归属由内核路由表裁决，worker 侧按扩展隔离查找（防跨扩展同名路由遮蔽）
  const targetExt = typeof payload.extId === 'string' && payload.extId !== '' ? loaded.get(payload.extId) : undefined;
  const entry = targetExt !== undefined
    ? targetExt.collector.handlers.routes.get(routeKey)
    : findRouteEntry(routeKey);
  if (entry === undefined) {
    fail(err('SERVICE_UNAVAILABLE', { message: `no handler for route "${routeKey}" (extension disabled or reloading)` }));
    return;
  }
  const request = payload.request as RouteRequest;
  let result: unknown;
  try {
    const timeoutMs = entry.timeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
    result = await withTimeout(Promise.resolve().then(() => entry.handler(request)), timeoutMs, `route handler "${routeKey}"`);
  } catch (e) {
    fail(e); // 含 webhook 验签失败（HARNESS-1006 → 401）、handler 抛错、HARNESS-1002 超时
    return;
  }
  reply(normalizeResponse(result));
}

/** host.event：通配匹配全部已注册订阅，逐个 await；单点异常 log 隔离，不抛 */
async function handleEventDispatch(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { name?: unknown; payload?: unknown; source?: unknown };
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name === '') {
    fail(err('BAD_REQUEST', { message: 'host.event requires payload { name, payload }' }));
    return;
  }
  const meta = { name, source: typeof payload.source === 'string' ? payload.source : 'kernel' };
  let delivered = 0;
  for (const ext of loaded.values()) {
    for (const [pattern, entries] of ext.collector.handlers.events) {
      if (!matchPattern(pattern, name)) continue;
      const sorted = [...entries].sort((a, b) => b.priority - a.priority);
      for (const { handler } of sorted) {
        delivered += 1;
        try {
          await Promise.resolve().then(() => handler(payload.payload, meta));
        } catch (e) {
          // 事件监听器异常与内核 EventBus 同语义：隔离、记日志、继续投递
          void ext.kernelCall(KERNEL_TOPICS.log, {
            level: 'error',
            msg: `event handler failed for "${name}" (pattern "${pattern}"): ${e instanceof Error ? e.message : String(e)}`,
            args: [serializeError(e)],
          }).catch(() => { /* 内核日志不可达：静默 */ });
        }
      }
    }
  }
  reply({ ok: true, delivered });
}

/** host.hook：按优先级链式应用 value → HookAbort 提前终止（aborted: true） */
async function handleHookApply(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { name?: unknown; value?: unknown; ctx?: unknown };
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name === '') {
    fail(err('BAD_REQUEST', { message: 'host.hook requires payload { name, value }' }));
    return;
  }
  let value = payload.value;
  for (const ext of loaded.values()) {
    const entries = ext.collector.handlers.hooks.get(name);
    if (entries === undefined) continue;
    const sorted = [...entries].sort((a, b) => b.priority - a.priority);
    for (const { handler } of sorted) {
      try {
        value = await Promise.resolve().then(() => handler(value, payload.ctx));
      } catch (e) {
        if (isHookAbort(e)) {
          reply({ ok: true, value: e.result, aborted: true });
          return;
        }
        fail(e);
        return;
      }
    }
  }
  reply({ ok: true, value });
}

/** host.cron：按 name 调用本地登记的 cron handler */
async function handleCronFire(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { name?: unknown };
  const name = typeof payload.name === 'string' ? payload.name : '';
  const handler = name === '' ? undefined : findCronHandler(name);
  if (handler === undefined) {
    fail(err('EXT_NOT_FOUND', { message: `cron job "${name}" is not registered in this worker` }));
    return;
  }
  try {
    await Promise.resolve().then(() => handler());
    reply({ ok: true, fired: name });
  } catch (e) {
    fail(e);
  }
}

/** host.call：service.method → 本地 servicesMap 调用，结果原样 reply */
async function handleCallService(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { service?: unknown; method?: unknown; args?: unknown };
  const service = typeof payload.service === 'string' ? payload.service : '';
  const method = typeof payload.method === 'string' ? payload.method : '';
  if (service === '' || method === '') {
    fail(err('BAD_REQUEST', { message: 'host.call requires payload { service, method, args }' }));
    return;
  }
  const key = `${service}.${method}`;
  let handler: ServiceHandler | undefined;
  for (const ext of loaded.values()) {
    const candidate = ext.collector.handlers.services.get(key);
    if (candidate !== undefined) {
      handler = candidate;
      break;
    }
  }
  if (handler === undefined) {
    fail(err('RPC_TARGET_NOT_FOUND', { message: `service "${key}" is not exposed by any loaded extension` }));
    return;
  }
  try {
    const result = await Promise.resolve().then(() => handler(payload.args));
    reply(result);
  } catch (e) {
    fail(e);
  }
}

/** host.task：找到执行器后立即 reply（started），任务体异步执行并自带 task.* 上报 */
function handleTaskRun(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): void {
  const payload = (env.payload ?? {}) as { taskId?: unknown; name?: unknown; args?: unknown };
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
  const name = typeof payload.name === 'string' ? payload.name : '';
  const found = name === '' ? undefined : findTaskHandler(name);
  if (found === undefined) {
    fail(err('EXT_NOT_FOUND', { message: `task "${name}" is not registered in this worker` }));
    return;
  }
  const { ext, handler } = found;
  const ctx: TaskContext = {
    progress: (pct, msg) => ext.kernelCall(KERNEL_TOPICS.taskProgress, { taskId, pct, msg }).then(() => undefined),
    complete: (result) => ext.kernelCall(KERNEL_TOPICS.taskComplete, { taskId, result }).then(() => undefined),
    fail: (error) => ext.kernelCall(KERNEL_TOPICS.taskFail, { taskId, error }).then(() => undefined),
  };
  reply({ ok: true, started: true, taskId });
  // 任务体异步执行：未捕获的失败兜底上报 taskFail，绝不击穿线程
  void Promise.resolve()
    .then(() => handler(payload.args, ctx))
    .catch(async (e: unknown) => {
      try {
        await ctx.fail(serializeError(e));
      } catch {
        void ext.kernelCall(KERNEL_TOPICS.log, {
          level: 'error',
          msg: `task "${name}" (${taskId}) failed and taskFail report also failed: ${e instanceof Error ? e.message : String(e)}`,
          args: [],
        }).catch(() => { /* 双重失败：仅静默 */ });
      }
    });
}

/** host.authVerify：内核 AuthProxy 派发的认证校验 → 扩展经 h.authProvider 登记的 handler。
 *  成功 reply { ok: true, identity: 身份|null }（undefined 归一为 null）；
 *  异常 fail（信封 ok:false + err），绝不击穿线程。 */
async function handleAuthVerify(env: RpcEnvelope, reply: (payload: unknown) => void, fail: (e: unknown) => void): Promise<void> {
  const payload = (env.payload ?? {}) as { token?: unknown; headers?: unknown };
  // 目标扩展：信封 to（'ext:<id>'）优先；缺失/不匹配时回退扫描（单 provider 场景的兼容路径）
  const toExtId = env.to.startsWith('ext:') ? env.to.slice('ext:'.length) : env.to;
  const target = toExtId !== '' ? loaded.get(toExtId) : undefined;
  const ext = target !== undefined && target.collector.handlers.authProvider !== undefined
    ? target
    : [...loaded.values()].find((e) => e.collector.handlers.authProvider !== undefined);
  const handler: AuthVerifyHandler | undefined = ext?.collector.handlers.authProvider;
  if (handler === undefined) {
    fail(err('EXT_NOT_FOUND', {
      message: 'no auth provider handler is registered in this worker (extension disabled, reloading, or never called h.authProvider during setup)',
    }));
    return;
  }
  const token = typeof payload.token === 'string' ? payload.token : undefined;
  const headers = (payload.headers !== null && typeof payload.headers === 'object' && !Array.isArray(payload.headers)
    ? payload.headers
    : {}) as Record<string, string | string[] | undefined>;
  try {
    const identity = await withTimeout(
      Promise.resolve().then(() => handler({ token, headers })),
      DEFAULT_ROUTE_TIMEOUT_MS,
      'auth provider verify',
    );
    // null/undefined 统一为 null（"本 provider 不认识该凭据"）；其余形状由内核接线层校验
    reply({ ok: true, identity: identity ?? null });
  } catch (e) {
    fail(e);
  }
}

/** 按信封 topic 分发到各 HOST_METHODS 实现 */
async function handleCall(env: RpcEnvelope): Promise<void> {
  switch (env.topic) {
    case HOST_METHODS.loadExt: {
      // loadExt 先解析出 extId 再应答（from 需为 ext:<id>）
      const payloadExtId = typeof (env.payload as { extId?: unknown } | undefined)?.extId === 'string'
        ? (env.payload as { extId: string }).extId
        : undefined;
      const repliers = makeRepliers(env, payloadExtId === undefined ? undefined : `ext:${payloadExtId}`);
      await handleLoadExt(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.unloadExt: {
      const repliers = makeRepliers(env);
      handleUnloadExt(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.routeRequest: {
      const repliers = makeRepliers(env);
      await handleRouteRequest(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.eventDispatch: {
      const repliers = makeRepliers(env);
      await handleEventDispatch(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.hookApply: {
      const repliers = makeRepliers(env);
      await handleHookApply(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.cronFire: {
      const repliers = makeRepliers(env);
      await handleCronFire(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.callService: {
      const repliers = makeRepliers(env);
      await handleCallService(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.taskRun: {
      const repliers = makeRepliers(env);
      handleTaskRun(env, repliers.reply, repliers.fail);
      return;
    }
    case HOST_METHODS.authVerify: {
      const repliers = makeRepliers(env);
      await handleAuthVerify(env, repliers.reply, repliers.fail);
      return;
    }
    default:
      makeRepliers(env).fail(err('INTERNAL', { message: `unknown host method: ${env.topic}` }));
  }
}

// ---------------------------------------------------------------------------
// 收包闸与线程装配
// ---------------------------------------------------------------------------

/** 统一收包：信封闸（伪造/损坏直接丢弃）→ reply 结算 / call+dispatch 分发 */
function onMessage(message: unknown): void {
  if (!isRpcEnvelope(message)) return;
  if (message.type === 'reply') {
    settleReply(message);
    return;
  }
  if (message.type === 'call' || message.type === 'dispatch') {
    void handleCall(message).catch((e: unknown) => {
      logWorkerError(`host call "${message.topic}" failed`, e);
    });
  }
}

// 主线程导入（单测）时 parentPort 为 null：不挂监听、无副作用
if (parentPort !== null) {
  parentPort.on('message', onMessage);
  // 最后防线：扩展代码漏网的未捕获拒绝不允许击穿扩展线程
  process.on('unhandledRejection', (reason: unknown) => {
    logWorkerError('unhandled rejection in extension worker', reason);
  });
}
