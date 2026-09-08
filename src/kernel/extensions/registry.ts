/**
 * ExtensionServiceRegistry — 扩展服务注册中心（h.expose / h.call 的内核侧账本）。
 *
 * 职责边界（热插拔语义的"注册中心"半边；实际 RPC 执行由 ExtCallDispatcher/bridge 负责）：
 * - register：扩展激活时登记其 expose 的服务（原子注册：先全校验再生效；重复注册=整扩展覆盖）；
 * - suspend / activate / remove：disable、崩溃、卸载时摘除服务（摘除 fail-fast 的账本基础）；
 * - list：服务目录（管理台/内省只读视图；输出稳定排序 + 防御性拷贝）；
 * - resolveCaller：为调用方扩展生成受权限约束的 h.call 门面。
 *
 * 服务命名约定：`ext.{extId}.{service}`（h.expose('parse') → 注册为 ext.doc.parse）。
 * 调用方必须以全名作为目标服务名；权限按 targetExtId 粒度判定。
 *
 * 错误契约（resolveCaller 产物，fail-fast 绝不悬挂）：
 * - 目标服务名不符合 `ext.{extId}.{service}` 约定 → SERVICE_UNAVAILABLE；
 * - 无权限（permissions 不含 'rpc:call' / 'rpc:call:<targetExtId>' 且非自调用）→ RPC_PERMISSION_DENIED；
 * - 目标不存在 / suspended → SERVICE_UNAVAILABLE；
 * - method 不在该服务 methods 清单 → RPC_TARGET_NOT_FOUND；
 * - dispatcher 在 timeoutMs 内未返回 → RPC_TIMEOUT（账本侧兜底竞速，bridge 亦持有同一 timeoutMs 可自行取消）；
 * - dispatcher 抛出 HarnessError → 原样透传；其余异常规整为 RPC_HANDLER_ERROR。
 * - 自调用豁免：callerExtId === targetExtId 时免权限（扩展内部编排不受 manifest 授权牵制）。
 *
 * 校验失败（编程性误用 / manifest 非法）fail-fast：
 * - 构造参数、resolveCaller 入参非法 → INTERNAL（内核内部误用）；
 * - register 登记数据非法 → EXT_MANIFEST_INVALID（来源是扩展 manifest，错误面向扩展开发者可操作）。
 */
import type { Logger } from 'pino';

import { err, HarnessError } from '../errors/index.js';

/** 服务目录条目（list() 只读视图） */
export interface ServiceEntry {
  extId: string;
  /** 服务全名：ext.{extId}.{service} */
  service: string;
  methods: string[];
  status: 'active' | 'suspended';
}

/** 扩展经 h.expose 登记的单个服务声明（register 的入参单元） */
export interface ExposedService {
  name: string;
  methods: string[];
}

/** bridge 门面：注册中心把解析/鉴权后的调用委托给它执行（集成注入） */
export interface ExtCallDispatcher {
  callService(
    targetExtId: string,
    service: string,
    method: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
}

/** ExtensionServiceRegistry 依赖集合 */
export interface ExtRegistryDeps {
  /** RPC 执行门面（bridge 注入）；注册中心只做解析、鉴权与超时兜底 */
  dispatcher: ExtCallDispatcher;
  /** 强制超时（ms），缺省 30_000；同时透传给 dispatcher 供其取消底层调用 */
  timeoutMs?: number;
  /** 可选 kernel logger（pino）；日志不含调用参数（可能携带密钥/业务敏感数据） */
  logger?: Logger;
}

/** 服务全名前缀 */
const SERVICE_PREFIX = 'ext.';
/** 目标服务名解析：ext.{targetExtId}.{service}（extId 允许含点，贪婪匹配取最后一个点分段） */
const TARGET_SERVICE_RE = /^ext\.(.+)\.([a-z][a-z0-9]*)$/i;
/**
 * 服务名/方法名标识符规则（规格 `/^a-z$/i` 的落地：字母开头 + 字母/数字，大小写不敏感）。
 * 刻意不放行 `-`/`_`/`.`，保证 `ext.{extId}.{service}` 可按最后一个点无歧义分段。
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9]*$/i;
/** 缺省 RPC 强制超时（ms） */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 单个扩展的登记记录（services：裸服务名 -> 方法清单） */
interface ExtRecord {
  status: 'active' | 'suspended';
  services: Map<string, string[]>;
}

export class ExtensionServiceRegistry {
  readonly #dispatcher: ExtCallDispatcher;
  readonly #timeoutMs: number;
  readonly #logger: Logger | undefined;
  /** extId -> 登记记录 */
  readonly #exts = new Map<string, ExtRecord>();

  constructor(deps: ExtRegistryDeps) {
    if (typeof deps.dispatcher?.callService !== 'function') {
      throw err('INTERNAL', {
        message: '[extensions] ExtensionServiceRegistry: deps.dispatcher.callService 必须是函数',
      });
    }
    this.#dispatcher = deps.dispatcher;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw err('INTERNAL', {
        message: `[extensions] ExtensionServiceRegistry: timeoutMs 必须为正的有限数（收到 ${String(deps.timeoutMs)}）`,
      });
    }
    this.#timeoutMs = timeoutMs;
    this.#logger = deps.logger;
  }

  /**
   * 登记扩展暴露的服务（原子注册）。
   *
   * - 先全校验：extId、每个服务名、每个方法名都合法（字母开头 + 字母/数字；
   *   methods 非空且无重复），任一非法 → EXT_MANIFEST_INVALID，整体不生效（不产生半套登记）；
   * - 重复注册 = 整扩展覆盖：以本次声明完整替换该扩展的全部服务，
   *   且 status 重置为 active（适配 disable→enable、崩溃自愈后的拓扑重注册）；
   * - services 为空数组合法（等价于清除该扩展全部服务登记）。
   */
  register(extId: string, services: ExposedService[]): void {
    if (typeof extId !== 'string' || extId === '') {
      throw err('EXT_MANIFEST_INVALID', {
        message: '[extensions] register: extId 必须是非空字符串',
        detail: { extId },
      });
    }
    if (!Array.isArray(services)) {
      throw err('EXT_MANIFEST_INVALID', {
        message: `[extensions] register("${extId}"): services 必须是数组`,
        detail: { extId },
      });
    }
    const validated = new Map<string, string[]>();
    for (const svc of services) {
      const name = svc?.name;
      if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
        throw err('EXT_MANIFEST_INVALID', {
          message: `[extensions] register("${extId}"): 服务名非法（${JSON.stringify(name ?? null)}）— 须以字母开头，仅含字母/数字，如 "parse"`,
          detail: { extId, service: name ?? null },
        });
      }
      const methods = svc.methods;
      if (!Array.isArray(methods) || methods.length === 0) {
        throw err('EXT_MANIFEST_INVALID', {
          message: `[extensions] register("${extId}"): 服务 "${name}" 的 methods 必须是非空字符串数组`,
          detail: { extId, service: name },
        });
      }
      const seen = new Set<string>();
      for (const method of methods) {
        if (typeof method !== 'string' || !IDENTIFIER_RE.test(method)) {
          throw err('EXT_MANIFEST_INVALID', {
            message: `[extensions] register("${extId}"): 服务 "${name}" 的方法名非法（${JSON.stringify(method ?? null)}）— 须以字母开头，仅含字母/数字，如 "parseFile"`,
            detail: { extId, service: name, method: method ?? null },
          });
        }
        if (seen.has(method)) {
          throw err('EXT_MANIFEST_INVALID', {
            message: `[extensions] register("${extId}"): 服务 "${name}" 的方法名重复（"${method}"）`,
            detail: { extId, service: name, method },
          });
        }
        seen.add(method);
      }
      validated.set(name, [...seen]);
    }
    // 全部合法 → 一次性生效
    this.#exts.set(extId, { status: 'active', services: validated });
    this.#logger?.debug({ extId, services: [...validated.keys()] }, 'extension services registered');
  }

  /** 该扩展全部服务置 suspended（disable / 崩溃时调用）；未知 extId 幂等 no-op */
  suspend(extId: string): void {
    const record = this.#exts.get(extId);
    if (record !== undefined) {
      record.status = 'suspended';
      this.#logger?.debug({ extId }, 'extension services suspended');
    }
  }

  /** 恢复该扩展全部服务为 active（enable / 自愈成功后调用）；未知 extId 幂等 no-op */
  activate(extId: string): void {
    const record = this.#exts.get(extId);
    if (record !== undefined) {
      record.status = 'active';
      this.#logger?.debug({ extId }, 'extension services activated');
    }
  }

  /** 摘除该扩展全部登记（uninstall 时调用）；未知 extId 幂等 no-op */
  remove(extId: string): void {
    if (this.#exts.delete(extId)) {
      this.#logger?.debug({ extId }, 'extension services removed');
    }
  }

  /** 服务目录（按服务全名字典序稳定输出；返回副本，外部修改不影响内部状态） */
  list(): ServiceEntry[] {
    const entries: ServiceEntry[] = [];
    for (const [extId, record] of this.#exts) {
      for (const [bare, methods] of record.services) {
        entries.push({
          extId,
          service: `${SERVICE_PREFIX}${extId}.${bare}`,
          methods: [...methods],
          status: record.status,
        });
      }
    }
    entries.sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
    return entries;
  }

  /**
   * 为调用方扩展生成受权限约束的 h.call 门面。
   *
   * 调用语义（按序判定，全部 fail-fast）：
   * 1. 目标服务名须匹配 `ext.{targetExtId}.{service}`，否则 SERVICE_UNAVAILABLE；
   * 2. 权限：callerExtId === targetExtId（自调用）豁免；否则 permissions 须含
   *    'rpc:call'（全量）或 'rpc:call:<targetExtId>'（定向），均无 → RPC_PERMISSION_DENIED；
   * 3. 目标不存在 / suspended → SERVICE_UNAVAILABLE；
   * 4. method 不在该服务 methods 清单 → RPC_TARGET_NOT_FOUND；
   * 5. 委托 dispatcher 执行并施加 timeoutMs 强制超时 → 超时 RPC_TIMEOUT；
   *    dispatcher 的 HarnessError 原样透传，其余异常规整为 RPC_HANDLER_ERROR。
   */
  resolveCaller(
    callerExtId: string,
    permissions: readonly string[],
  ): (targetService: string, method: string, args: unknown) => Promise<unknown> {
    if (typeof callerExtId !== 'string' || callerExtId === '') {
      throw err('INTERNAL', { message: '[extensions] resolveCaller: callerExtId 必须是非空字符串' });
    }
    const perms = Array.isArray(permissions) ? permissions : [];
    return async (targetService: string, method: string, args: unknown): Promise<unknown> => {
      // 1. 服务名约定
      const parsed = TARGET_SERVICE_RE.exec(targetService);
      const targetExtId = parsed?.[1];
      const bare = parsed?.[2];
      if (parsed === null || targetExtId === undefined || bare === undefined) {
        throw err('SERVICE_UNAVAILABLE', { detail: { service: targetService } });
      }
      // 2. 权限门（自调用豁免 → 'rpc:call' 全量 → 'rpc:call:<targetExtId>' 定向）
      if (
        callerExtId !== targetExtId &&
        !perms.includes('rpc:call') &&
        !perms.includes(`rpc:call:${targetExtId}`)
      ) {
        throw err('RPC_PERMISSION_DENIED', { detail: { target: targetService } });
      }
      // 3. 目标存在且 active
      const record = this.#exts.get(targetExtId);
      const methods = record?.services.get(bare);
      if (record === undefined || methods === undefined || record.status !== 'active') {
        throw err('SERVICE_UNAVAILABLE', { detail: { service: targetService } });
      }
      // 4. 方法在清单内
      if (!methods.includes(method)) {
        throw err('RPC_TARGET_NOT_FOUND', { detail: { service: targetService, method } });
      }
      // 5. 委托 dispatcher（含强制超时）
      return await this.#dispatch(targetExtId, targetService, method, args);
    };
  }

  /**
   * 委托 dispatcher 执行，账本侧以 timeoutMs 兜底竞速（bridge 未及时返回也不悬挂）。
   * timeoutMs 同时透传给 dispatcher，bridge 可据此取消底层调用。
   */
  async #dispatch(targetExtId: string, service: string, method: string, args: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const call = this.#dispatcher.callService(targetExtId, service, method, args, this.#timeoutMs);
    // 防超时竞速胜出后 dispatcher 迟到拒绝变成 unhandledRejection：败者错误只留日志线索
    call.catch(() => {
      this.#logger?.debug({ service, method }, 'rpc dispatcher settled after registry timeout');
    });
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.#logger?.warn({ service, method, timeoutMs: this.#timeoutMs }, 'rpc call timed out');
          reject(err('RPC_TIMEOUT', { detail: { service, method, timeoutMs: this.#timeoutMs } }));
        }, this.#timeoutMs);
      });
      timer?.unref();
      return await Promise.race([call, timeout]);
    } catch (e: unknown) {
      if (e instanceof HarnessError) throw e;
      throw HarnessError.wrap(e, 'RPC_HANDLER_ERROR');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
