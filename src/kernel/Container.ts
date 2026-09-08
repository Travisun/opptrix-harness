/**
 * Container — 内核 DI 容器（声明式服务装配风格）。
 *
 * 设计要点（minify 安全）：
 * - 不做反射、不做参数名注入、不解析 function.toString；
 *   依赖一律通过显式工厂声明，任何打包/压缩（标识符改名）都不影响解析。
 * - resolve<T>() 的泛型只是调用侧的类型断言；运行时行为完全由登记的工厂/实例决定。
 * - 错误统一走 HarnessError（err('INTERNAL', ...)），禁止裸 throw 穿过 API 边界。
 */
import { err } from './errors/index.js';

/** 服务工厂：接收容器本身，返回服务实例。 */
export type Factory<T> = (c: Container) => T;

/**
 * alias 链最大深度。
 * 超过该深度的别名链视为病态配置（很可能埋着环），在 alias() 登记时即 fail-fast。
 */
const MAX_ALIAS_DEPTH = 10;

/**
 * 一条服务注册记录（判别联合，便于窄化）：
 * - transient：瞬态绑定，每次 resolve 调用工厂产生新实例
 * - singleton：单例绑定，首次 resolve 调用工厂并缓存
 * - instance：直接登记的现成实例（隐式单例）
 */
type Binding =
  | { kind: 'transient'; factory: Factory<any> } // any：容器存异构服务，类型安全由 resolve<T> 调用侧断言提供
  | { kind: 'singleton'; factory: Factory<any> } // any：同上，容器不约束服务形状
  | { kind: 'instance'; value: unknown };

export class Container {
  /** key -> 注册记录（别名 key 不在此表，见 #aliases） */
  #bindings = new Map<string, Binding>();

  /** key -> 已解析的单例实例缓存（与 #bindings 分离，避免 undefined 值歧义） */
  #singletons = new Map<string, unknown>();

  /** 别名表：alias key -> 目标 key（目标本身也可以是别名，链式跟随） */
  #aliases = new Map<string, string>();

  /**
   * 解析栈：resolve 进行中的 key 序列，用于循环依赖检测与报错链路还原。
   * 注意：同步栈语义——若工厂返回 Promise 并在 await 之后才解析依赖，
   * 栈已弹出，该类异步环不在检测范围内（工厂约定为同步组装）。
   */
  #resolving: string[] = [];

  /** 注册瞬态绑定：每次 resolve 都调用工厂产生新实例。 */
  bind(key: string, factory: Factory<any>): this {
    this.#bindings.set(key, { kind: 'transient', factory });
    return this;
  }

  /** 注册单例绑定：首次 resolve 调用工厂并缓存，之后返回同一实例。工厂失败不缓存。 */
  singleton(key: string, factory: Factory<any>): this {
    this.#bindings.set(key, { kind: 'singleton', factory });
    return this;
  }

  /** 直接登记现成实例（隐式单例），resolve 原样返回该值。 */
  instance(key: string, value: unknown): this {
    this.#bindings.set(key, { kind: 'instance', value });
    return this;
  }

  /**
   * 注册别名：resolve(from) 委托给 to；to 本身也可以是别名，链式跟随（a -> b -> c）。
   * 登记时立即沿链校验：环与超深链（> MAX_ALIAS_DEPTH）在此 fail-fast 抛错并回滚登记，
   * 因此注册表始终保持无环；解析时再走同一套校验逻辑做防御性复核。
   * 目标允许先声明别名、后注册真实绑定（前向声明）。
   */
  alias(from: string, to: string): this {
    if (from === to) {
      throw err('INTERNAL', {
        message: `[container] circular alias detected: ${from} -> ${to}`,
      });
    }
    this.#aliases.set(from, to);
    try {
      this.#followAliases(from);
    } catch (e) {
      this.#aliases.delete(from); // 回滚，保持注册表干净
      throw e;
    }
    return this;
  }

  /**
   * 解析服务。
   * - 未知 key（含别名链走不到真实绑定的情况）：抛 INTERNAL，message 含 key 名。
   * - 循环依赖：抛 INTERNAL，message 含完整调用链（如 "a -> b -> a"）。
   * - 单例工厂抛错时不缓存失败结果，栈经 finally 保证回退，容器可继续使用。
   */
  resolve<T>(key: string): T {
    const bound = this.#followAliases(key);
    const binding = this.#bindings.get(bound);
    if (binding === undefined) {
      throw err('INTERNAL', {
        message: `[container] service not registered: ${key}`,
      });
    }
    if (binding.kind === 'instance') {
      return binding.value as T;
    }
    if (binding.kind === 'singleton' && this.#singletons.has(bound)) {
      return this.#singletons.get(bound) as T;
    }

    // 循环依赖检测：解析栈中再次出现同一 key 即为环，报错携带完整链路
    if (this.#resolving.includes(bound)) {
      const chain = [...this.#resolving.slice(this.#resolving.indexOf(bound)), bound];
      throw err('INTERNAL', {
        message: `[container] circular dependency detected: ${chain.join(' -> ')}`,
      });
    }

    const factory = binding.factory;
    this.#resolving.push(bound);
    try {
      const value = factory(this);
      if (binding.kind === 'singleton') {
        this.#singletons.set(bound, value);
      }
      return value as T;
    } finally {
      this.#resolving.pop();
    }
  }

  /** key 是否可用（已注册绑定/实例，或本身是别名）。 */
  has(key: string): boolean {
    return this.#bindings.has(key) || this.#aliases.has(key);
  }

  /**
   * 注销 key：移除其绑定、单例缓存与（若 key 本身是别名）别名记录。
   * 之后 has(key) 为 false，可重新注册新实现（热更新/测试场景）。
   * 注意：指向该 key 的其他别名不会被级联清除，它们会解析为 not registered。
   */
  forget(key: string): void {
    this.#bindings.delete(key);
    this.#singletons.delete(key);
    this.#aliases.delete(key);
  }

  /**
   * 沿别名链向下跟随，返回最终的真实绑定 key。
   * 语义：最多 MAX_ALIAS_DEPTH（10）跳别名；第 11 跳抛"too deep"；
   * 链上回到已访问节点即环，抛错并携带链路。
   */
  #followAliases(key: string): string {
    let cur = key;
    const chain: string[] = [key];
    for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
      const next = this.#aliases.get(cur);
      if (next === undefined) return cur;
      if (chain.includes(next)) {
        chain.push(next);
        throw err('INTERNAL', {
          message: `[container] circular alias detected: ${chain.join(' -> ')}`,
        });
      }
      chain.push(next);
      cur = next;
    }
    throw err('INTERNAL', {
      message: `[container] alias chain too deep (max ${MAX_ALIAS_DEPTH}): ${chain.join(' -> ')}`,
    });
  }
}
