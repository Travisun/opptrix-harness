/**
 * realm — 宿主 ⇄ VM realm 边界的包装工厂（SEC-1 加固的单一落点）。
 *
 * 背景缺陷（审计实测）：把宿主 realm 的函数/对象直接递入 vm.Context 后，扩展代码
 * `x.constructor.constructor('return process')()` 即可拿到宿主 Function 构造器 →
 * 宿主 process → getBuiltinModule 执行任意命令（宿主 RCE）。四条同根链：
 * CJS 顶层 this、h 门面对象、console.* 方法、setTimeout 包装器。
 *
 * 修复手法（本模块提供原语）：
 * - `toVmFn(hostFn)`：把宿主函数包成 **VM realm 函数**（在 context 内编译包装器），
 *   返回值经 VM 内深拷贝器转为 VM realm 对象；抛出的宿主 Error 转为 VM realm Error。
 * - `toVmAsyncFn(hostFn)`：async 包装器，返回 **VM realm Promise**（VM 内 async 函数），
 *   await 宿主 Promise 后同样深拷贝入 VM realm。
 * - `toVmPassthroughFn(hostFn)`：同 toVmFn 但不拷贝返回值（用于恒等返回场景，
 *   如 crypto.getRandomValues 必须返回传入的同一 VM 侧视图）。
 * - `toVmValue(value)`：纯 VM intrinsics 实现的深拷贝器（跨 realm 感知：
 *   用 Object.prototype.toString 标签分派，不用 instanceof），宿主数据进入 VM 前统一转换；
 *   函数/宿主类实例等不可克隆值按 fail-closed 处理（函数抛 TypeError，其余置 null）。
 * - `makeVmObject(spec)`：在 VM 内建对象并 Object.freeze（值必须已是 VM 安全值），
 *   暴露对象一律建成 VM realm 对象，杜绝把宿主冻结对象直接递入。
 *
 * 包装器内的 `toVm` / `toVmError` 都是 VM realm 函数；宿主仅持有工厂返回的包装函数
 * 与 `toVmValue` 的宿主侧句柄——扩展代码拿到的全部可触达值均产自 VM realm。
 */
import vm from 'node:vm';

/**
 * VM 内编译的深拷贝器：输出全部使用当前 context 的 intrinsics 构建。
 * 跨 realm 判型必须用 Object.prototype.toString（宿主 Date/Map/TypedArray 对
 * VM 的 instanceof 恒为 false）。函数 → 抛 TypeError（对齐 structuredClone 的
 * DataCloneError 精神）；其余无法识别的宿主对象 → null（保守截断，不递宿主对象）。
 */
const TO_VM_VALUE_SRC = String.raw`(value) => {
  const seen = new Map();
  const tagOf = (v) => Object.prototype.toString.call(v);
  const clone = (v) => {
    if (v === null) return null;
    const t = typeof v;
    if (t !== 'object' && t !== 'function') return v;
    if (t === 'function') {
      throw new TypeError('value is not cloneable: functions cannot cross the sandbox boundary');
    }
    if (seen.has(v)) return seen.get(v);
    const tag = tagOf(v);
    if (tag === '[object Array]') {
      const out = [];
      seen.set(v, out);
      for (let i = 0; i < v.length; i++) out[i] = clone(v[i]);
      return out;
    }
    if (tag === '[object Date]') return new Date(v.getTime());
    if (tag === '[object RegExp]') return new RegExp(v.source, v.flags);
    if (tag === '[object Map]') {
      const out = new Map();
      seen.set(v, out);
      for (const entry of v.entries()) out.set(clone(entry[0]), clone(entry[1]));
      return out;
    }
    if (tag === '[object Set]') {
      const out = new Set();
      seen.set(v, out);
      for (const item of v.values()) out.add(clone(item));
      return out;
    }
    if (tag === '[object ArrayBuffer]') return v.slice(0);
    if (tag === '[object SharedArrayBuffer]') return null;
    if (tag === '[object DataView]') {
      const out = new DataView(clone(v.buffer), v.byteOffset, v.byteLength);
      seen.set(v, out);
      return out;
    }
    const typed = /^\[object (Uint8Array|Uint8ClampedArray|Uint16Array|Uint32Array|Int8Array|Int16Array|Int32Array|Float16Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array)\]$/.exec(tag);
    if (typed !== null) {
      const Ctor = globalThis[typed[1]];
      if (typeof Ctor === 'function') {
        const out = new Ctor(v);
        seen.set(v, out);
        return out;
      }
      return null;
    }
    if (tag === '[object Object]' || tag === '[object Arguments]') {
      const out = {};
      seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = clone(v[k]);
      return out;
    }
    return null;
  };
  return clone(value);
}`;

/** VM 内编译的错误转换器：宿主 Error → VM realm Error（保 message/code/name，不递宿主对象） */
const TO_VM_ERROR_SRC = String.raw`(e) => {
  let message;
  if (e === null || e === undefined) message = String(e);
  else if (typeof e === 'object' && typeof e.message === 'string' && e.message !== '') message = e.message;
  else message = String(e);
  const out = new Error(message);
  if (e !== null && typeof e === 'object') {
    if (typeof e.code === 'string') out.code = e.code;
    if (typeof e.name === 'string') out.name = e.name;
  }
  return out;
}`;

/** 在 VM 内编译的工厂：同步包装（返回值拷贝入 VM realm + 异常转 VM Error） */
const MAKE_VM_FN_SRC = String.raw`(toVm, toVmError) => (hostFn) => (...args) => {
  try {
    return toVm(hostFn(...args));
  } catch (e) {
    throw toVmError(e);
  }
}`;

/** 在 VM 内编译的工厂：恒等包装（不拷贝返回值；用于恒等返回/纯副作用场景） */
const MAKE_VM_PASSTHROUGH_FN_SRC = String.raw`(toVmError) => (hostFn) => (...args) => {
  try {
    return hostFn(...args);
  } catch (e) {
    throw toVmError(e);
  }
}`;

/** 在 VM 内编译的工厂：异步包装（返回 VM realm Promise；结果拷贝入 VM realm） */
const MAKE_VM_ASYNC_FN_SRC = String.raw`(toVm, toVmError) => (hostFn) => async (...args) => {
  try {
    return toVm(await hostFn(...args));
  } catch (e) {
    throw toVmError(e);
  }
}`;

/** 在 VM 内编译的对象工厂：从 spec（值须已是 VM 安全值）建冻结对象 */
const MAKE_VM_OBJECT_SRC = String.raw`(spec) => {
  const out = {};
  for (const k of Object.keys(spec)) out[k] = spec[k];
  return Object.freeze(out);
}`;

/** RealmBridge：一个 vm.Context 一份；由 {@link createRealmBridge} 构建 */
export interface RealmBridge {
  /** 所属 context（只读引用，供调用方按需扩展） */
  readonly context: vm.Context;
  /**
   * 深拷贝器的 **VM realm 函数本体**（可直接注入 VM 全局面，如 structuredClone）。
   * 注意：绝不能把宿主侧箭头包装递入 VM——那会重新打开 `.constructor.constructor`
   * 逃逸链；凡要进 VM 的函数一律取本字段或 toVmFn/toVmPassthroughFn/toVmAsyncFn 的产物。
   */
  readonly vmToVmValue: (value: unknown) => unknown;
  /** 宿主值 → VM realm 值（深拷贝；函数抛 TypeError，未知宿主对象 → null） */
  toVmValue(value: unknown): unknown;
  /** 宿主函数 → VM realm 函数（返回值拷贝入 VM realm） */
  toVmFn(hostFn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
  /** 宿主函数 → VM realm 函数（返回值原样透传；仅恒等返回场景使用） */
  toVmPassthroughFn(hostFn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
  /** 宿主函数 → VM realm async 函数（返回 VM realm Promise；结果拷贝入 VM realm） */
  toVmAsyncFn(hostFn: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown>;
  /** 在 VM 内建冻结对象；spec 的值必须已是 VM realm 值（函数经 toVmFn 包装、数据经 toVmValue 拷贝） */
  makeVmObject(spec: Record<string, unknown>): unknown;
}

/**
 * 为 context 构建 realm 桥（每 context 一份）。编译产物缓存在桥实例内，
 * 同一桥上重复调用 toVmFn 只创建包装闭包，不重复编译工厂源码。
 */
export function createRealmBridge(context: vm.Context): RealmBridge {
  const toVmValueFn = vm.runInContext(`(${TO_VM_VALUE_SRC})`, context) as (v: unknown) => unknown;
  const toVmErrorFn = vm.runInContext(`(${TO_VM_ERROR_SRC})`, context) as (e: unknown) => unknown;
  const makeSync = vm.runInContext(`(${MAKE_VM_FN_SRC})`, context) as (
    toVm: unknown,
    toVmError: unknown,
  ) => (hostFn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  const makePassthrough = vm.runInContext(`(${MAKE_VM_PASSTHROUGH_FN_SRC})`, context) as (
    toVmError: unknown,
  ) => (hostFn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  const makeAsync = vm.runInContext(`(${MAKE_VM_ASYNC_FN_SRC})`, context) as (
    toVm: unknown,
    toVmError: unknown,
  ) => (hostFn: (...args: unknown[]) => unknown) => (...args: unknown[]) => Promise<unknown>;
  const makeObject = vm.runInContext(`(${MAKE_VM_OBJECT_SRC})`, context) as (
    spec: Record<string, unknown>,
  ) => unknown;

  return {
    context,
    vmToVmValue: toVmValueFn,
    toVmValue: (value: unknown): unknown => toVmValueFn(value),
    toVmFn: (hostFn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown =>
      makeSync(toVmValueFn, toVmErrorFn)(hostFn),
    toVmPassthroughFn: (hostFn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown =>
      makePassthrough(toVmErrorFn)(hostFn),
    toVmAsyncFn: (hostFn: (...args: unknown[]) => unknown): ((...args: unknown[]) => Promise<unknown>) =>
      makeAsync(toVmValueFn, toVmErrorFn)(hostFn),
    makeVmObject: (spec: Record<string, unknown>): unknown => makeObject(spec),
  };
}

/**
 * 每 context 的共享桥缓存：同 context 多次装配（受限 require 的每模块包装、
 * 测试直调 sandbox.ts 而未显式传 bridge）复用同一份编译产物，避免重复编译。
 */
const bridgeCache = new WeakMap<vm.Context, RealmBridge>();

/** 取（或建）context 的共享 realm 桥 */
export function realmBridgeFor(context: vm.Context): RealmBridge {
  const cached = bridgeCache.get(context);
  if (cached !== undefined) return cached;
  const created = createRealmBridge(context);
  bridgeCache.set(context, created);
  return created;
}
