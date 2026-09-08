/**
 * Hook 拦截器（filter 链语义，可短路）。
 *
 * - `apply(name, value)` 按 priority 降序（默认 0，同序按添加序）逐层调用 handler，
 *   上一个 handler 的返回值作为下一个的入参，最终值作为 apply 的返回值
 * - handler 返回 `undefined` 视为"不改写"，保持上一个值不变（防御性约定）。
 *   需要显式向下传递 undefined 的场景，请用返回值包装对象（如 `{ value: undefined }`）解决
 * - handler 抛 `HookAbort(result)` → apply 立即短路并返回 result（后续 handler 不执行，不抛出）
 * - 其他异常 → 包装 `err('INTERNAL', { message: '[hook:<name>] handler failed', cause })` 上抛。
 *   hook 是内核契约，失败即 bug，禁止静默吞错
 */
import type { Logger } from 'pino';

import { err } from '../errors/index.js';

/** apply 传给每个 handler 的上下文（冻结对象） */
export interface HookContext {
  /** 埋点名（取值来自 HOOK_POINTS） */
  name: string;
  /** 调用方附加元数据（浅冻结后透传；未提供时为 undefined） */
  meta?: Readonly<Record<string, unknown>>;
}

/** hook 处理器：同步或异步；返回 `undefined` 表示不改写当前值 */
export type HookHandler<T = unknown> = (value: T, ctx: HookContext) => Promise<T> | T;

/**
 * hook 短路信号：handler 抛出 `new HookAbort(result)` 使 apply 立即结束并返回 result，
 * 剩余 handler 不再执行、不抛出。仅作控制流用途，不代表错误。
 */
export class HookAbort extends Error {
  /** 短路时 apply 的返回值（可为任意值，含 undefined） */
  constructor(public readonly result: unknown) {
    super('hook aborted (short-circuit)');
    this.name = 'HookAbort';
  }
}

export interface HookManagerOptions {
  /**
   * kernel logger（可选）。仅在注册/短路/失败路径打 debug/warn；
   * 绝不记录 value 与短路 result（密钥永不入日志）。
   */
  logger?: Logger;
}

/** 同名 hook 的单条注册记录 */
interface HookEntry {
  /** T 收窄后的 handler 无法直接赋给 HookHandler<unknown>（参数逆变），经 unknown 中转收拢存储 */
  handler: HookHandler<unknown>;
  priority: number;
}

/**
 * Hook 管理器：全系统埋点的 filter 链注册与执行中心。
 *
 * 每个埋点名（HOOK_POINTS 中的值）下可挂任意多个 handler，形成链；
 * `apply` 时按 priority 降序逐层执行，任何一层可改写值或抛 HookAbort 短路。
 */
export class HookManager {
  #entries = new Map<string, HookEntry[]>();
  #logger: Logger | undefined;

  constructor(opts?: HookManagerOptions) {
    this.#logger = opts?.logger;
  }

  /**
   * 注册 handler 到指定埋点链。
   * @param name 埋点名（建议取 HOOK_POINTS 常量，禁止手写字符串）
   * @param handler 处理器；返回 `undefined` 表示不改写当前值（保持上一层结果）
   * @param opts.priority 执行优先级，降序执行，默认 0；同 priority 按添加顺序执行
   * @returns 取消函数：调用后该 handler 不再参与后续 apply；重复调用幂等
   */
  add<T = unknown>(name: string, handler: HookHandler<T>, opts?: { priority?: number }): () => void {
    const entry: HookEntry = {
      // HookHandler<T>（T 收窄）与 HookHandler<unknown> 因参数逆变互不直接可赋值，经 unknown 中转
      handler: handler as unknown as HookHandler<unknown>,
      priority: opts?.priority ?? 0,
    };
    let list = this.#entries.get(name);
    if (!list) {
      list = [];
      this.#entries.set(name, list);
    }
    // 已按 priority 降序维护；插入到第一个 priority 更小的条目前，同 priority 自然保持添加序
    let at = list.length;
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      if (cur && cur.priority < entry.priority) {
        at = i;
        break;
      }
    }
    list.splice(at, 0, entry);
    this.#logger?.debug({ hook: name, priority: entry.priority }, `[hook:${name}] handler registered`);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#removeEntry(name, entry);
    };
  }

  /** 按引用移除指定埋点下的 handler（同名多次注册会一并移除）；未注册时静默返回 */
  remove(name: string, handler: HookHandler): void {
    const list = this.#entries.get(name);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const cur = list[i];
      if (cur && cur.handler === handler) list.splice(i, 1);
    }
    if (list.length === 0) this.#entries.delete(name);
  }

  /**
   * 执行指定埋点的 handler 链（filter 链语义）。
   *
   * - 按 priority 降序（默认 0，同序按添加序）逐层执行，上一层返回值作为下一层入参
   * - handler 返回 `undefined` 时保持上一个值不变（防御性；显式透传 undefined 请用包装对象）
   * - handler 抛 `HookAbort(result)` → 立即短路并返回 result（不抛出）
   * - 其他异常 → 包装 `err('INTERNAL', { message: '[hook:<name>] handler failed', cause })` 上抛
   * - handler 列表在进入时快照：链中途 add/remove 不影响本次执行，只影响下一次
   *
   * @param name 埋点名（建议取 HOOK_POINTS 常量）
   * @param value 初始值；无 handler 时原样返回
   * @param ctx.meta 附加元数据，浅冻结后挂到 HookContext.meta 透传给每个 handler
   */
  async apply<T>(name: string, value: T, ctx?: { meta?: Record<string, unknown> }): Promise<T> {
    const list = this.#entries.get(name);
    if (!list || list.length === 0) return value;
    const snapshot = list.slice();
    const meta = ctx?.meta === undefined ? undefined : Object.freeze(ctx.meta);
    const hookCtx: HookContext = Object.freeze(meta === undefined ? { name } : { name, meta });

    let current: unknown = value;
    for (const entry of snapshot) {
      let next: unknown;
      try {
        next = await entry.handler(current, hookCtx);
      } catch (e) {
        if (e instanceof HookAbort) {
          // 只记埋点名，不记 result（任意调用方值，可能含密钥）
          this.#logger?.debug({ hook: name }, `[hook:${name}] aborted, short-circuit`);
          return e.result as T;
        }
        this.#logger?.warn(
          { hook: name, reason: e instanceof Error ? e.message : String(e) },
          `[hook:${name}] handler failed`,
        );
        throw err('INTERNAL', { message: `[hook:${name}] handler failed`, cause: e });
      }
      if (next !== undefined) current = next;
    }
    return current as T;
  }

  /** 是否存在指定埋点的 handler */
  has(name: string): boolean {
    const list = this.#entries.get(name);
    return list !== undefined && list.length > 0;
  }

  /**
   * handler 数量统计。
   * @param name 省略时返回全部埋点的 handler 总数
   */
  handlerCount(name?: string): number {
    if (name !== undefined) return this.#entries.get(name)?.length ?? 0;
    let total = 0;
    for (const list of this.#entries.values()) total += list.length;
    return total;
  }

  /** 清空所有埋点下的全部 handler */
  clear(): void {
    this.#entries.clear();
  }

  #removeEntry(name: string, entry: HookEntry): void {
    const list = this.#entries.get(name);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.#entries.delete(name);
  }
}
