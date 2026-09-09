/**
 * ExtensionManager — 扩展生命周期编排 + 热插拔自愈（双池化：内置池 / 社区池）。
 *
 * 职责（服务提供者两阶段心智的扩展版）：
 * - 发现：扫描 extensionsDirs 下含 manifest.json 的一级子目录，validateManifest 过闸；
 * - 放置（分池）：placement(manifest, dir) = manifest.builtin===true 且目录受信
 *   （isTrustedExtDir !== false）→ builtin 池；其余 → community 池。两个池各自持有
 *   独立的 worker 线程 + ExtensionBridge + 崩溃窗口 + 退避重启 + 拓扑重注册
 *   （HostRuntime，每池一份），互不传染——第三方扩展的崩溃循环不再陪葬 auth/webui。
 * - 拓扑：按 manifest.requires 做 Kahn 拓扑排序，**池内独立**进行（环 →
 *   EXT_DEPENDENCY_MISSING fail-fast）；硬依赖缺失/未启用的依赖者被单独拒绝
 *   （记录 last_error），不影响其他扩展；
 * - 激活（enable）：host.load（RPC，带 manifest/mainPath/dataDir）→ validateContributions
 *   → API 兼容与权限复核（routes→http / crons→cron / events→events / hooks→hooks /
 *   services⊆provides / mount 白名单）→ 原子提交：事件订阅、hook 处理器、cron 任务、
 *   路由表条目、extensions 表 enabled=1；任一步失败逆序回滚已提交部分（无半活）；
 *   提交后同步服务目录（onServicesChanged）、UI 贡献（onUiChanged → UiRegistry）与
 *   AuthProvider（onAuthProvider）；第三方扩展（isTrustedExtDir false 的目录）首次
 *   enable 需人工授信（confirmTrust=true → 持久化 trusted_at/trusted_by，此后免确认；
 *   builtin 池必为受信目录，天然免确认）。
 * - 停用（disable）：逆序摘除（路由→cron→hook→事件）→ host.unload → enabled=0；幂等；
 * - 自愈（handleWorkerExit，per-host 策略）：
 *   · community 池：指数退避重启 worker（restartBackoffMs，默认 [500,1000,2000,4000,8000]）→
 *     池内按拓扑重启用原 enabled 扩展 → onWorkerRestart 回调；crash 滑动窗口
 *     （crashLoopWindowMs 内 > crashLoopMax 次）→ 熔断：该池全部扩展保持停用、
 *     EXT_CRASH_LOOP 记 last_error，等待人工 enable（人工 enable 清除该池熔断态）；
 *   · builtin 池：**永不自动禁用**——崩溃 → 退避重启（500ms×2^n 封顶 30s，无限次）→
 *     重注册内置扩展；每次崩溃/恢复经 deps.notifier 通知（5 分钟节流防刷屏）。
 * - 路由表：getRoutes() 只读快照（两池共享一张表）；每次原子变更后回调
 *   onRoutesChanged（路由模块据此重挂）。
 *
 * 注入边界：worker 线程由 workerFactory 注入（默认 worker_threads 实现由集成接线提供，
 * 工厂每调用产出一个新 worker，入参为池类别）；内核服务处理器（KERNEL_TOPICS 的实现）
 * 经 bridgeHandlers 透传给两个池的桥；本模块不做领域语义。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import semver from 'semver';
import type { Knex } from 'knex';
import type { Logger } from 'pino';

import type { HarnessConfig } from '../config/index.js';
import { err, HarnessError } from '../errors/index.js';
import { extDbPath } from '../storage/db.js';
import { HookAbort } from '../hooks/manager.js';
import { HOST_METHODS } from '../../extension-host/protocol.js';
import { ExtensionBridge, type WorkerLike } from './bridge.js';
import { validateContributions, type ExtensionContributions } from './contributions.js';
import { checkApiCompat, validateManifest, validatePermissions, type ExtensionManifest } from './manifest.js';
import type { UiContribution } from './ui-registry.js';

// ---------------------------------------------------------------------------
// 公开契约
// ---------------------------------------------------------------------------

/** 一条已提交的扩展路由（递交路由模块的表条目；auth 缺省兜底 'user'） */
export interface ExtRouteTableEntry {
  extId: string;
  method: string;
  path: string;
  auth: 'public' | 'user' | 'admin';
  scope?: string;
  timeoutMs?: number;
}

/** 贡献点计数（list() 的只读摘要用） */
export interface ExtContributionsSummary {
  routes: number;
  crons: number;
  events: number;
  hooks: number;
  services: number;
}

/** 扩展宿主池类别：builtin = 受信第一方（随镜像交付）；community = 第三方/其余 */
export type HostKind = 'builtin' | 'community';

/** 全部池类别（稳定顺序：builtin 先于 community） */
const HOST_KINDS: readonly HostKind[] = ['builtin', 'community'];

/** 扩展摘要（管理台/内省只读视图） */
export interface ExtSummary {
  id: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  /** 扩展所在的宿主池（放置规则：builtin 声明 + 受信目录 → builtin，否则 community） */
  host: HostKind;
  mount: string | null;
  manifest?: ExtensionManifest;
  contributions?: ExtContributionsSummary;
  /** 扩展目录绝对路径（仅已发现的扩展携带；extensions 表残留行无目录） */
  dir?: string;
  /** 所在池滑动窗口内的 worker 崩溃次数（池级，非单扩展） */
  crashCount: number;
  /** 第三方扩展人工授信时间（epoch ms）；受信第一方恒为 null */
  trustedAt?: number | null;
  lastError: string | null;
}

/** cron 调度器契约（CronScheduler 的结构子集，测试可注入 stub） */
export interface SchedulerLike {
  schedule(input: {
    extId?: string | null;
    name: string;
    expr: string;
    tz?: string;
    payload?: unknown;
    enabled?: boolean;
    overlap?: 'skip' | 'queue';
    misfire?: 'skip' | 'runOnce';
  }): Promise<unknown>;
  unschedule(id: string): Promise<boolean>;
  list(opts?: { extId?: string }): unknown[];
}

/** 事件总线契约（EventBus 的结构子集） */
export interface EventBusLike {
  on(
    pattern: string,
    handler: (payload: unknown, meta: { name: string; source: string }) => Promise<void> | void,
    opts?: { priority?: number },
  ): () => void;
  off(pattern: string, handler: unknown): void;
}

/** hook 管理器契约（HookManager 的结构子集） */
export interface HooksLike {
  add(
    name: string,
    handler: (value: unknown, ctx: unknown) => Promise<unknown> | unknown,
    opts?: { priority?: number },
  ): () => void;
}

/** ExtensionManager 构造依赖（全部注入，manager 不自建线程/不实现内核服务） */
export interface ExtensionManagerDeps {
  config: HarnessConfig;
  db: Knex;
  logger: Logger;
  /**
   * worker 工厂：默认 worker_threads 实现由集成接线提供；测试注入 stub。
   * 入参为池类别（'builtin' | 'community'）——工厂每调用产出一个新 worker，
   * 两个池各持独立线程（测试可按池分发不同 stub）。
   */
  workerFactory: (pool?: HostKind) => WorkerLike;
  /** KERNEL_TOPICS 的内核服务实现（集成方注入；manager 只透传给桥） */
  bridgeHandlers: Record<string, (payload: unknown, from: string) => Promise<unknown>>;
  scheduler: SchedulerLike;
  eventBus: EventBusLike;
  hooks: HooksLike;
  /** builtin mount 受信校验（可选；SEC-3 fail-closed：未注入时 builtin/mount 声明一律拒绝） */
  authMounts?: { validateMount?(manifest: ExtensionManifest, dir: string): boolean };
  /**
   * 受信第一方扩展目录裁决（可选；生产由 Kernel 接线：dir 位于 repoRoot/extensions 之下）。
   * 第三方扩展信任闸的输入：返回 false 的目录下的扩展首次 enable 必须人工授信
   * （confirmTrust=true → 激活并持久化 trusted_at）；未注入时信任闸关闭（视为受信，
   * 单测 stub 场景向后兼容）。
   */
  isTrustedExtDir?: (dir: string) => boolean;
  /** 发现目录（如 [<dataDir>/extensions, <repo>/extensions]） */
  extensionsDirs: string[];
  /** 路由表原子变更回调（路由模块据此重挂） */
  onRoutesChanged?: (table: ExtRouteTableEntry[]) => void;
  /** worker 自愈重启完成回调（可选） */
  onWorkerRestart?: (info: { attempt: number; delayMs: number; reenabled: string[] }) => void;
  /**
   * 服务目录变更回调（可选，集成方接 ExtensionServiceRegistry 用）：
   * 激活成功时携带贡献点 services（整扩展覆盖注册），disable/崩溃摘除时为 null。
   */
  onServicesChanged?: (extId: string, services: { name: string; methods: string[] }[] | null) => void;
  /**
   * AuthProvider 注册同步回调（可选，集成方接 AuthProviderRegistry 用）：
   * enable 提交完成后，若 manifest.permissions 含 'auth:provider' 触发 'register'；
   * disable/worker 崩溃本地摘除时触发 'unregister'（provider 名 = extId）。
   */
  onAuthProvider?: (extId: string, cmd: 'register' | 'unregister') => void;
  /**
   * UI 贡献同步回调（可选，集成方接 UiRegistry 用，容器键 'ui.registry'）：
   * enable 提交完成后携带合并后的 ui 片段（manifest.ui ∪ 贡献点 ui，register 语义）；
   * disable/worker 崩溃本地摘除时为 null（remove）。
   */
  onUiChanged?: (extId: string, ui: UiContribution | null) => void;
  /**
   * 激活期 load payload 追加器（可选，集成方按 manifest 决定附加字段）：
   * 阶段 10 内核仅对 builtin && mount==='auth' 且目录受信的扩展附加 rootToken
   * （worker 侧另有注入闸复核；其余扩展不携带任何引导态）。dir 为扩展目录
   * （SEC-3：受信目录裁决的输入之一）。
   */
  loadBootstrap?: (manifest: ExtensionManifest, dir: string) => Record<string, unknown> | undefined;
  /** 测试注入：worker 崩溃重启的退避序列（ms；两池共用，缺省按池各自推导） */
  restartBackoffMs?: number[];
  /**
   * 通知器（可选；Kernel 注入懒解析 container 'notify' 的包装）：内置池崩溃/恢复
   * 事件经它下发（5 分钟节流，重启风暴合并为一条）。community 池熔断不经通知器
   * （熔断态本身落 last_error，人工 enable 是恢复出口）。
   */
  notifier?: HostNotifier;
}

/** 一个已发现扩展（manifest 校验通过的目录） */
export interface DiscoveredExt {
  manifest: ExtensionManifest;
  /** 扩展目录（manifest.json 所在） */
  dir: string;
  /** 入口文件绝对路径（dir + manifest.main） */
  mainPath: string;
}

// ---------------------------------------------------------------------------
// 内部常量与类型
// ---------------------------------------------------------------------------

/** hook 处理器的 RPC 预算（filter 链语义下给足但有限） */
const HOOK_APPLY_TIMEOUT_MS = 30_000;

/** worker 崩溃重启默认退避序列（ms；community 池缺省） */
const DEFAULT_RESTART_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

/** 内置池默认重启退避基线（ms）：500ms×2^n，封顶 30s，无限次重启 */
const BUILTIN_RESTART_BASE_MS = 500;

/** 内置池重启退避上限（ms） */
const BUILTIN_RESTART_MAX_MS = 30_000;

/** 内置池崩溃/恢复通知节流（重启风暴合并为一条，不刷屏） */
const BUILTIN_NOTIFY_THROTTLE_MS = 5 * 60_000;

/** 退避序列越界/为空时的兜底重启延迟（ms） */
const FALLBACK_RESTART_DELAY_MS = 500;

/** last_error 摘要最大长度（防错误刷屏撑爆行） */
const MAX_LAST_ERROR_LEN = 500;

/** 通知器契约（NotificationManager 的结构子集；Kernel 注入懒解析包装，测试注入 spy） */
export interface HostNotifier {
  send(input: { title: string; body: string; level?: string }): Promise<unknown>;
}

/**
 * 一个宿主池的运行态（单 worker + 单桥 + 崩溃窗口 + 退避重启 + 拓扑重注册的全部
 * 机制按池各持一份；bridge 为 null = 该池未 spawn 或已停）。
 */
interface HostRuntime {
  kind: HostKind;
  bridge: ExtensionBridge | null;
  /** 本池 worker 累计 spawn 次数（观测用） */
  workerSpawnCount: number;
  /** 本池已激活扩展（贡献点/undo 函数） */
  active: Map<string, ActiveExt>;
  /** 本池 worker 崩溃时间窗口（epoch ms 滑动窗口） */
  crashTimestamps: number[];
  /** 熔断态（仅 community 池会置位）：置位后不再自动重启，等待人工 enable 清除 */
  crashLoopTripped: boolean;
  /** handleWorkerExit 重入闸（per-pool） */
  restarting: boolean;
  /** restarting 窗口内到达的 exit 事件排队标志（respawn 完成后补处理一次） */
  exitQueued: boolean;
  /** exit 后、respawn 前桥不可用（enable 据此重建） */
  bridgeDead: boolean;
  /** 最近一次退避索引（观测用；attempt = crashTimestamps.length 为权威） */
  restartBackoffIndex: number;
}

/** 一个已激活扩展的运行态（undo 为提交句柄，逆序执行即完整摘除） */
interface ActiveExt {
  manifest: ExtensionManifest;
  dir: string;
  contributions: ExtensionContributions;
  undo: Array<() => void | Promise<void>>;
}

/** extensions 行的内存快照（list() 同步输出的数据源；所有写路径负责同步） */
interface RowSnapshot {
  version: string;
  enabled: boolean;
  builtin: boolean;
  mount: string | null;
  lastError: string | null;
  /** 人工授信时间（UTC epoch ms；null = 未授信） */
  trustedAt: number | null;
}

/** extensions 表行（DB 读取形状） */
interface ExtRow {
  id: string;
  version: string;
  enabled: number;
  builtin: number;
  mount: string | null;
  last_error: string | null;
  trusted_at: number | null;
}

/** last_error 摘要规整：HARNESS-xxxx 前缀 + 根因消息 + 截断（面向开发者可定位） */
function lastErrorOf(e: HarnessError): string {
  const cause = e.cause;
  const causeText =
    cause instanceof Error && cause.message !== '' && cause.message !== e.message
      ? ` < ${cause.message}`
      : '';
  return `${e.code}: ${e.message}${causeText}`.slice(0, MAX_LAST_ERROR_LEN);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/** 硬依赖声明 'id' 或 'id@semver-range' → { id, range } */
function parseRequire(req: string): { id: string; range?: string } {
  const at = req.lastIndexOf('@');
  if (at > 0) return { id: req.slice(0, at), range: req.slice(at + 1) };
  return { id: req };
}

/**
 * 合并声明式（manifest.ui）与运行期（贡献点 ui）UI 贡献为单个 UiRegistry 片段。
 * 两条通道是对同一声明面的等价入口（webui 的 SPA 即双通道声明），合并按稳定键去重、
 * 后者（运行期贡献）优先——与菜单「最后提供者生效」语义一致：
 * pages 按 path、widgets 按 id、renderers 按值去重；菜单为单值语义，
 * 运行期贡献（worker 线格式为数组）取最后一项，缺省回退 manifest 声明。
 * 完全为空（两通道均无任何 UI 声明）返回 null（不产生登记）。
 */
function mergedUiFragment(
  manifest: ExtensionManifest,
  contributions: ExtensionContributions,
): UiContribution | null {
  const manifestUi = manifest.ui;
  const contribUi = contributions.ui;
  const menu =
    contribUi.menu.length > 0 ? contribUi.menu[contribUi.menu.length - 1] : manifestUi?.menu;
  // pages/widgets：manifest 在前、贡献在后，按稳定键去重（后者覆盖前者）
  const pages = dedupeBy(
    [...(manifestUi?.pages ?? []), ...contribUi.pages],
    (p) => p.path,
  );
  const widgets = dedupeBy(
    [...(manifestUi?.widgets ?? []), ...contribUi.widgets],
    (w) => w.id,
  );
  const renderers = [...new Set([...(manifestUi?.renderers ?? []), ...contribUi.renderers])];
  if (menu === undefined && pages.length === 0 && widgets.length === 0 && renderers.length === 0) {
    return null;
  }
  return {
    ...(menu !== undefined ? { menu } : {}),
    pages,
    widgets,
    renderers,
  };
}

/** 按键去重（保持首次出现顺序；后出现的同键项覆盖先前的值并留在原首次位置之后） */
function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(keyOf(item), item);
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// ExtensionManager
// ---------------------------------------------------------------------------

export class ExtensionManager {
  /** 发现结果（manifest.json 校验通过；id → 目录） */
  #discovered = new Map<string, DiscoveredExt>();
  /** 已提交路由表（原子换表；两池共享一张表，路由模块单点消费） */
  #routes: ExtRouteTableEntry[] = [];
  /** extensions 行内存快照（与 DB 写路径同步维护） */
  #rowCache = new Map<string, RowSnapshot>();
  /** 双池运行态：内置池 / 社区池（bridge、崩溃窗口、退避重启、激活态各一份） */
  readonly #runtimes: Record<HostKind, HostRuntime>;
  /** 内置池通知节流锚点（epoch ms；距上次通知 <5min 不重发） */
  #lastHostNotifyAt = 0;
  /** stop 后不再自愈/激活 */
  #stopping = false;
  /** per-ext 生命周期锁（enable/disable/reload/uninstall 串行化） */
  #locks = new Map<string, Promise<void>>();

  constructor(deps: ExtensionManagerDeps) {
    this.deps = deps;
    this.#runtimes = {
      builtin: {
        kind: 'builtin',
        bridge: null,
        workerSpawnCount: 0,
        active: new Map(),
        crashTimestamps: [],
        crashLoopTripped: false,
        restarting: false,
        exitQueued: false,
        bridgeDead: false,
        restartBackoffIndex: 0,
      },
      community: {
        kind: 'community',
        bridge: null,
        workerSpawnCount: 0,
        active: new Map(),
        crashTimestamps: [],
        crashLoopTripped: false,
        restarting: false,
        exitQueued: false,
        bridgeDead: false,
        restartBackoffIndex: 0,
      },
    };
  }

  /** 构造依赖（protected 供子类/测试观察） */
  protected readonly deps: ExtensionManagerDeps;

  // ------------------------------------------------------------------ 启动/停止

  /**
   * 启动：发现 → 行登记 → 读表状态 → **按池分别**拓扑排序（环 fail-fast）→
   * 各池 spawn 自己的 worker/桥（空池懒 spawn：无线程就无崩溃面）→ 各池依次 enable
   * 表中 enabled=1 的扩展（单个失败不阻断后续，记录 last_error）。
   */
  async start(): Promise<void> {
    this.#stopping = false;
    this.#discover();

    // 行登记：新发现插入（内置扩展默认启用——auth/webui 开箱即用语义；其余 enabled=0，
    // 用户显式 disable 的行经 update 路径保留 enabled=0，不会每次 boot 复位）；
    // 已有行刷新 version/builtin/mount（磁盘 manifest 为准）
    for (const [id, found] of this.#discovered) {
      const existing = await this.#getRow(id);
      if (existing === undefined) {
        await this.#insertRow(id, found.manifest, { enabled: found.manifest.builtin === true, lastError: null });
      } else {
        await this.#updateRow(id, {
          version: found.manifest.version,
          builtin: found.manifest.builtin,
          mount: found.manifest.mount ?? null,
        });
      }
    }

    // 拾取内存快照之外的残留行（源目录已被删除的扩展：list 可见但不可激活）
    const rows = await this.deps.db<ExtRow>('extensions').select(
      'id',
      'version',
      'enabled',
      'builtin',
      'mount',
      'last_error',
      'trusted_at',
    );
    for (const row of rows) {
      if (!this.#rowCache.has(row.id)) {
        this.#rowCache.set(row.id, {
          version: row.version,
          enabled: Number(row.enabled) === 1,
          builtin: Number(row.builtin) === 1,
          mount: row.mount ?? null,
          lastError: row.last_error ?? null,
          trustedAt: row.trusted_at ?? null,
        });
      }
    }

    // 分池计划：先对两池分别做拓扑排序（环 → EXT_DEPENDENCY_MISSING，启动期 fail-fast，
    // 此时还未 spawn 任何线程），再逐池 spawn + 启用
    const plans: Array<{ rt: HostRuntime; order: string[] }> = [];
    for (const kind of HOST_KINDS) {
      const ids = this.#poolIds(kind);
      if (ids.length === 0) continue;
      plans.push({ rt: this.#runtimes[kind], order: this.#topoOrder(ids) });
    }

    for (const { rt, order } of plans) {
      this.#spawnBridge(rt);
      for (const id of order) {
        const row = this.#rowCache.get(id);
        if (row === undefined || !row.enabled) continue;
        try {
          await this.#enableLocked(id);
        } catch (cause) {
          // 单个扩展激活失败不阻断后续（含硬依赖缺失的拒绝路径）；last_error 已记录
          this.deps.logger.error(
            { err: cause, extId: id, host: rt.kind },
            'extension enable failed during start (other extensions continue)',
          );
        }
      }
    }
  }

  /** 停止：两池停桥（拒新调用/拒挂起/terminate worker）；不再自愈。幂等。 */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const kind of HOST_KINDS) {
      const rt = this.#runtimes[kind];
      const bridge = rt.bridge;
      rt.bridge = null;
      await bridge?.stop();
    }
  }

  // ------------------------------------------------------------------ 查询

  /** 全部已知扩展摘要（发现目录 ∪ extensions 表残留行），同步只读 */
  list(): ExtSummary[] {
    const ids = new Set<string>([...this.#discovered.keys(), ...this.#rowCache.keys()]);
    const out: ExtSummary[] = [];
    for (const id of ids) {
      const found = this.#discovered.get(id);
      const rt = this.#runtimeForId(id);
      const active = rt.active.get(id);
      const row = this.#rowCache.get(id);
      const manifest = found?.manifest;
      const contributions =
        active === undefined
          ? undefined
          : {
              routes: active.contributions.routes.length,
              crons: active.contributions.crons.length,
              events: active.contributions.events.length,
              hooks: active.contributions.hooks.length,
              services: active.contributions.services.length,
            };
      out.push({
        id,
        version: manifest?.version ?? row?.version ?? '',
        enabled: row?.enabled ?? false,
        builtin: manifest?.builtin ?? row?.builtin ?? false,
        host: rt.kind,
        mount: manifest?.mount ?? row?.mount ?? null,
        manifest,
        contributions,
        // 目录仅对已发现的扩展可见（extensions 表残留行无目录信息）
        ...(found !== undefined ? { dir: found.dir } : {}),
        crashCount: rt.crashTimestamps.length,
        lastError: row?.lastError ?? null,
      });
    }
    return out;
  }

  /** 当前已提交路由表（只读快照，深拷贝防外部改写；两池共享一张表） */
  getRoutes(): ExtRouteTableEntry[] {
    return this.#routes.map((r) => ({ ...r }));
  }

  /**
   * 扩展 manifest 只读视图（host.call 权限判定等集成方用）：
   * 优先已发现目录，其次激活态缓存；未发现/未激活返回 undefined。
   */
  getManifest(id: string): ExtensionManifest | undefined {
    return this.#discovered.get(id)?.manifest ?? this.#runtimeForId(id).active.get(id)?.manifest;
  }

  /**
   * 兼容视图：community 池的桥（无则回退 builtin 池）。新代码请用
   * bridgeFor(extId) 按扩展归属池取桥——跨线程 RPC 必须发给扩展所在的线程。
   */
  get bridge(): ExtensionBridge | null {
    return this.#runtimes.community.bridge ?? this.#runtimes.builtin.bridge;
  }

  /** 扩展所在池的桥（跨线程 RPC 入口；池未 spawn/已停/扩展未知时可能为 null） */
  bridgeFor(extId: string): ExtensionBridge | null {
    return this.#runtimeForId(extId).bridge;
  }

  // ------------------------------------------------------------------ 生命周期

  /**
   * 激活扩展（load → 校验 → 权限复核 → 原子提交）。已激活时幂等 no-op。
   * 池路由：按 manifest/dir 的放置规则落 builtin 或 community 池；该池 bridge 未
   * spawn 则先 spawn，dead/stopped 则重建（REL-3 泛化路径，per-pool）。
   * community 熔断态下的人工 enable 是唯一的自动恢复出口：清除该池熔断与崩溃窗口，
   * 并起新 worker（崩溃后的旧 worker 已死，不重启则激活必然超时）。builtin 池永不
   * 进入熔断态。
   *
   * 第三方信任闸：目录不受信（isTrustedExtDir false）且未曾授信（trusted_at 为空）时，
   * 必须显式传入 input.confirmTrust=true 才能激活——首次授信会持久化 trusted_at/trusted_by，
   * 后续 enable/reload（含内核重启）不再要求确认；受信第一方目录（builtin 池全部）恒免确认。
   */
  async enable(id: string, input?: { confirmTrust?: boolean }): Promise<void> {
    const rt = this.#runtimeForId(id);
    if (rt.crashLoopTripped) {
      rt.crashLoopTripped = false;
      rt.crashTimestamps = [];
      rt.restartBackoffIndex = 0;
      const stale = rt.bridge;
      rt.bridge = null;
      await stale?.stop();
      this.#spawnBridge(rt);
      this.deps.logger.info(
        { extId: id, host: rt.kind },
        'extension manager: crash-loop state cleared by manual enable, worker respawned',
      );
    }
    // REL-3：桥不可用（worker 已死但 exit 落在 restarting 窗口被吞 / 桥已停）→
    // 重建 worker + 桥再走激活——把熔断态重建桥的路径泛化为「桥不可用即重建」。
    // stop() 之后（#stopping）不重建：关停语义保留，enable 仍被 KERNEL_NOT_READY 拒绝。
    if (!this.#stopping && (rt.bridge === null || rt.bridge.stopped || rt.bridgeDead)) {
      const stale = rt.bridge;
      rt.bridge = null;
      await stale?.stop();
      this.#spawnBridge(rt);
      this.deps.logger.info(
        { extId: id, host: rt.kind },
        'extension manager: bridge unavailable, worker respawned before enable',
      );
    }
    return this.#withLock(id, () => this.#enableLocked(id, input));
  }

  /** 停用扩展（逆序摘除 → host.unload → enabled=0）。未激活时幂等 no-op。 */
  async disable(id: string): Promise<void> {
    // 核心内置扩展保护：auth/webui 等随镜像交付的第一方扩展不可停用/卸载
    // （停用 auth = 全员 401、停用 webui = 管理台消失；恢复只能进数据目录改库）
    const summary = this.list().find((x) => x.id === id);
    if (summary?.builtin === true) {
      throw err('FORBIDDEN', {
        message: `builtin extension "${id}" cannot be disabled (core extensions are locked)`,
        detail: { id, reason: 'core-builtin' },
      });
    }
    return this.#withLock(id, () => this.#disableLocked(id));
  }

  /**
   * 重载扩展：disable → enable；enable 失败时保持 disabled
   * （内核侧已回滚、enabled=0、last_error 已记录），原始错误向调用方抛出。
   *
   * reload 仅对 enabled 扩展有意义：disabled（或未知/无表行）扩展 reload → no-op
   * （保持当前 disabled 状态原样返回，不做隐式 disable→enable 的「重载即启用」）。
   * 已停用的扩展要重新激活必须走显式 enable（含第三方信任闸的人工确认语义）。
   */
  async reload(id: string): Promise<void> {
    return this.#withLock(id, async () => {
      const row = this.#rowCache.get(id) ?? (await this.#getRow(id));
      if (row === undefined || !row.enabled) {
        this.deps.logger.info(
          { extId: id },
          'extension reload skipped: extension is not enabled (reload is a no-op for disabled extensions)',
        );
        return;
      }
      try {
        await this.#disableLocked(id);
      } catch (cause) {
        // disable 失败（多为 worker 侧卸载告警）不阻断重载；内核侧摘除仍以 enable 的回滚兜底
        this.deps.logger.warn({ err: cause, extId: id }, 'extension reload: disable step warned');
      }
      await this.#enableLocked(id);
    });
  }

  /**
   * 卸载扩展：disable + 删 extensions 表记录。
   * purge=true 时同时删除 <dataDir>/db/ext/<id>.sqlite（含 wal/shm）与运行时目录
   * <dataDir>/extensions/<id>/（仓库内置扩展目录不受影响）；keep（默认）保留全部文件。
   */
  async uninstall(id: string, opts?: { purge?: boolean }): Promise<void> {
    const summary = this.list().find((x) => x.id === id);
    if (summary?.builtin === true) {
      throw err('FORBIDDEN', {
        message: `builtin extension "${id}" cannot be uninstalled (core extensions are locked)`,
        detail: { id, reason: 'core-builtin' },
      });
    }
    return this.#withLock(id, async () => {
      try {
        await this.#disableLocked(id);
      } catch (cause) {
        this.deps.logger.warn({ err: cause, extId: id }, 'extension uninstall: disable step warned');
      }
      await this.deps.db('extensions').where({ id }).del();
      this.#rowCache.delete(id);
      this.#discovered.delete(id);
      if (opts?.purge === true) {
        const dbFile = extDbPath(this.deps.config, id);
        for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
          try {
            rmSync(file, { force: true });
          } catch (cause) {
            this.deps.logger.warn({ err: cause, file }, 'extension uninstall: sqlite file removal failed');
          }
        }
        const runtimeDir = join(this.deps.config.dataDir, 'extensions', id);
        try {
          rmSync(runtimeDir, { recursive: true, force: true });
        } catch (cause) {
          this.deps.logger.warn({ err: cause, dir: runtimeDir }, 'extension uninstall: runtime dir removal failed');
        }
      }
      this.deps.logger.info({ extId: id, purge: opts?.purge === true }, 'extension uninstalled');
    });
  }

  // ------------------------------------------------------------------ 自愈

  /**
   * worker 崩溃路径（由桥的 exit 转发触发，也可手动调用注入崩溃；kind 缺省
   * 'community' 兼容旧直接调用方——桥回调一律显式传池别）：
   * 1. 崩溃记入该池滑动窗口；2. 内核侧本地摘除该池全部激活态（worker 已死，跳过
   *   unload RPC；另一池的路由与激活态原样保留）；
   * 3. community 池：窗口内崩溃数 > crashLoopMax → 熔断：该池全部扩展保持停用 +
   *   EXT_CRASH_LOOP 记 last_error；
   * 4. 否则按退避重启该池 worker → 池内按拓扑重启用原 enabled 扩展 →
   *   onWorkerRestart 回调。builtin 池永不熔断（无限次退避重启 + 节流通知）。
   */
  async handleWorkerExit(kind: HostKind = 'community'): Promise<void> {
    await this.#handleWorkerExitFor(this.#runtimes[kind]);
  }

  /** handleWorkerExit 的池实现（#restarting/#exitQueued/崩溃窗口均为池私有） */
  async #handleWorkerExitFor(rt: HostRuntime): Promise<void> {
    if (this.#stopping) return;
    if (rt.restarting) {
      // REL-3：restarting 窗口内的 exit 不再吞掉——排队，respawn 完成后补处理一次
      //（否则第二次 exit 对应的死桥无人认领，人工 enable 会永久 EXT_ACTIVATION_FAILED）
      rt.exitQueued = true;
      return;
    }
    rt.restarting = true;
    try {
      const now = Date.now();
      const windowMs = this.deps.config.crashLoopWindowMs;
      rt.crashTimestamps = rt.crashTimestamps.filter((ts) => now - ts < windowMs);
      rt.crashTimestamps.push(now);
      const attempt = rt.crashTimestamps.length;
      rt.restartBackoffIndex = attempt;

      // 重启用集合：本池 discovered 且表中 enabled=1 的扩展（池内拓扑序）
      let order: string[] = [];
      try {
        order = this.#topoOrder(this.#poolIds(rt.kind)).filter(
          (id) => this.#rowCache.get(id)?.enabled === true,
        );
      } catch (cause) {
        this.deps.logger.error({ err: cause, host: rt.kind }, 'extension restart: topo order failed');
      }

      // worker 已死：本池内核侧全部本地摘除（事件/hook/cron/路由），另一池不受影响
      await this.#deactivatePoolLocal(rt);

      if (rt.kind === 'community' && rt.crashTimestamps.length > this.deps.config.crashLoopMax) {
        // 惯犯熔断（仅 community 池）：该池全部扩展保持停用，等待人工 enable
        rt.crashLoopTripped = true;
        const summary = lastErrorOf(
          err('EXT_CRASH_LOOP', {
            detail: {
              crashes: rt.crashTimestamps.length,
              windowMs,
              max: this.deps.config.crashLoopMax,
            },
          }),
        );
        for (const id of order) {
          await this.#writeRow(id, undefined, { enabled: false, lastError: summary });
        }
        this.deps.logger.error(
          {
            crashes: rt.crashTimestamps.length,
            windowMs,
            max: this.deps.config.crashLoopMax,
            host: rt.kind,
          },
          'extension worker crash loop: pool extensions stay disabled, manual enable required',
        );
        return;
      }

      // builtin 池：崩溃即通知（节流），随后照常退避重启——永不自动禁用
      if (rt.kind === 'builtin') {
        this.#notifyHost(
          'warn',
          '内置扩展宿主重启',
          `内置扩展宿主异常退出（窗口内第 ${attempt} 次），正在退避重启；auth/webui 等内置扩展短暂不可用后自动恢复。`,
        );
      }

      // 退避重启（community 池熔断态在上方已提前 return，不会走到这里）
      const delay = this.#restartDelay(rt, attempt);
      await sleep(delay);
      if (this.#stopping || rt.crashLoopTripped) return;
      this.#spawnBridge(rt);

      const reenabled: string[] = [];
      for (const id of order) {
        try {
          await this.#enableLocked(id);
          reenabled.push(id);
        } catch (cause) {
          this.deps.logger.error(
            { err: cause, extId: id, host: rt.kind },
            'extension re-enable after worker restart failed',
          );
        }
      }
      this.deps.onWorkerRestart?.({ attempt, delayMs: delay, reenabled });
      if (rt.kind === 'builtin') {
        this.#notifyHost(
          'success',
          '内置扩展宿主已恢复',
          `内置扩展宿主重启完成（第 ${attempt} 次），${reenabled.length} 个内置扩展已重新激活。`,
        );
      }
    } finally {
      rt.restarting = false;
      // REL-3：respawn 完成后补处理 restarting 窗口内排队的 exit（合并为一次）
      if (rt.exitQueued && !this.#stopping) {
        rt.exitQueued = false;
        void this.handleWorkerExit(rt.kind).catch((cause) => {
          this.deps.logger.error(
            { err: cause, host: rt.kind },
            'extension manager: queued worker exit replay failed',
          );
        });
      }
    }
  }

  // ------------------------------------------------------------------ 激活编排（内部）

  /** enable 的锁内实现；错误分阶段保留各自错误码，统一记录 last_error 并强制 enabled=0 */
  async #enableLocked(id: string, input?: { confirmTrust?: boolean }): Promise<void> {
    const found = this.#discovered.get(id);
    if (found === undefined) {
      // REL-7：未发现扩展给出可操作指引（运行中新增目录可 rescan 免重启发现）
      throw err('EXT_NOT_FOUND', {
        message: `extension "${id}" not found — call POST /api/v1/extensions/rescan (admin) to discover new extension directories`,
        detail: {
          id,
          cause: 'extension is not discovered under extensionsDirs',
          hint: 'call POST /api/v1/extensions/rescan (admin) to discover new extension directories',
        },
      });
    }
    const { manifest, dir } = found;
    const rt = this.#runtimeForId(id);
    const bridge = rt.bridge;
    if (bridge === null) {
      // 先于幂等 no-op 判定：stop 后（桥为 null）即使残留 active 态也不可再激活
      throw err('KERNEL_NOT_READY', { detail: { id, cause: 'extension worker is not running' } });
    }
    if (rt.active.has(id)) return; // 幂等

    // 第三方信任闸（产品层人工授信）：目录不受信且 extensions 表行 trusted_at 为空时，
    // 首次 enable 拒绝激活并返回 EXT_TRUST_REQUIRED（detail 携带声明权限与确认指引）；
    // confirmTrust=true 视为人工授信——先落库 trusted_at/trusted_by 再继续激活（授信是
    // 用户对来源的确认，激活后续失败不回滚授信）。已授信扩展后续 enable/reload 不再询问；
    // 受信第一方目录恒免确认。isTrustedExtDir 未注入时信任闸关闭（视为受信）。
    if (this.deps.isTrustedExtDir?.(dir) === false) {
      const trustedAt = this.#rowCache.get(id)?.trustedAt ?? (await this.#getRow(id))?.trustedAt ?? null;
      if (trustedAt === null) {
        if (input?.confirmTrust === true) {
          await this.#updateRow(id, { trustedAt: Date.now(), trustedBy: 'admin' });
          this.deps.logger.info({ extId: id }, 'extension trust confirmed by admin (trusted_at persisted)');
        } else {
          return await this.#failStage(id, manifest, err('EXT_TRUST_REQUIRED', {
            detail: {
              id,
              permissions: [...manifest.permissions],
              confirmHint: `POST /api/v1/extensions/${id}/enable {"confirmTrust":true}`,
            },
          }));
        }
      }
    }

    // SEC-3：builtin/mount 声明是随镜像交付的第一方扩展的特权——激活路径统一过受信闸。
    // validateMount 未注入（deps.authMounts 缺失）时一律拒绝（fail-closed），
    // 防 /tmp 等任意目录的 manifest 自声明 builtin/mount 骗取 rootToken 或 /api/v1 挂载。
    if (manifest.builtin === true || manifest.mount !== undefined) {
      const validateMount = this.deps.authMounts?.validateMount;
      const trusted = typeof validateMount === 'function' ? validateMount(manifest, dir) === true : false;
      if (!trusted) {
        return await this.#failStage(id, manifest, err('EXT_PERMISSION_DENIED', {
          message:
            `extension "${id}" declares builtin/mount which is reserved for trusted first-party extensions ` +
            '(the extension directory is not a kernel-trusted directory)',
          detail: { id, reason: 'builtin/mount reserved for trusted first-party extensions' },
        }));
      }
    }

    // manifest 层复核：API 兼容 + 权限白名单（发现后的激活前检查）
    try {
      checkApiCompat(manifest);
      validatePermissions(manifest);
    } catch (cause) {
      return await this.#failStage(id, manifest, HarnessError.wrap(cause, 'EXT_ACTIVATION_FAILED'));
    }

    // 硬依赖：缺失/未启用/版本不符 → 拒绝激活（不影响其他扩展）
    const missing = this.#missingHardDeps(manifest);
    if (missing.length > 0) {
      return await this.#failStage(id, manifest, err('EXT_DEPENDENCY_MISSING', { detail: { id, missing } }));
    }

    // 1. load：worker 加载扩展并回报贡献点
    //    （payload 契约以 worker.ts host.load 为准：{ extId, manifest, extDir, dataDir }；
    //      mainPath 冗余携带供诊断/未来 worker 版本使用；loadBootstrap 按 manifest
    //      追加引导态——内核仅对 builtin auth 注入 rootToken）
    let reply: unknown;
    try {
      reply = await bridge.callToWorker(id, HOST_METHODS.loadExt, {
        extId: id,
        manifest,
        extDir: found.dir,
        mainPath: found.mainPath,
        dataDir: this.deps.config.dataDir,
        ...(this.deps.loadBootstrap?.(manifest, found.dir) ?? {}),
      });
    } catch (cause) {
      return await this.#failActivation(id, manifest, cause);
    }
    // 回执形状兼容：payload 为 { contributions } 或直接为贡献点对象
    const rawContributions =
      reply !== null && typeof reply === 'object' && 'contributions' in (reply as object)
        ? (reply as { contributions: unknown }).contributions
        : reply;
    // 2. 贡献点校验（形状/路由上限/重复路由）
    let contributions: ExtensionContributions;
    try {
      contributions = validateContributions(rawContributions ?? {}, this.deps.config.maxRoutesPerExt);
    } catch (cause) {
      return await this.#failActivation(id, manifest, cause);
    }
    // 3. 权限复核：贡献点必须被 manifest 权限/provides/mount 白名单覆盖
    try {
      this.#assertContributionPermissions(id, manifest, contributions);
    } catch (cause) {
      return await this.#failStage(id, manifest, HarnessError.wrap(cause, 'EXT_PERMISSION_DENIED'));
    }

    // 4. 原子提交：事件 → hook → cron → 路由 → DB；任一步失败逆序回滚（无半活）
    const routesBefore = this.#routes;
    const undo: Array<() => void | Promise<void>> = [];
    try {
      for (const sub of contributions.events) {
        const off = this.deps.eventBus.on(
          sub.pattern,
          // worker 契约（host.event）：payload { name, payload, source }，topic 固定 HOST_METHODS.eventDispatch
          (payload) => {
            bridge.dispatchToExt(id, HOST_METHODS.eventDispatch, {
              name: sub.pattern,
              payload,
              source: 'kernel',
            });
          },
          { priority: sub.priority },
        );
        undo.push(off);
      }
      for (const hook of contributions.hooks) {
        // worker 契约（host.hook）：请求 payload { name, value, ctx }，
        // 应答 payload { ok: true, value, aborted? }（信封 ok 已由桥结算，此处是业务回执）。
        // 必须解包回执再接入 filter 链：直接把信封当下一值会让改写型 hook
        // 把 { value } 包装物当消息透传（如 chat.beforeSend 被误判 blocked）。
        const handler = async (value: unknown, ctx: unknown): Promise<unknown> => {
          const res = (await bridge.callToWorker(
            id,
            HOST_METHODS.hookApply,
            { name: hook.name, value, ctx },
            HOOK_APPLY_TIMEOUT_MS,
          )) as { value?: unknown; aborted?: unknown } | null | undefined;
          if (res !== null && typeof res === 'object' && res.aborted === true) {
            // 扩展侧 HookAbort：向内核 hook 链抛同款短路信号（HookManager 捕获后返回 result）
            throw new HookAbort(res.value);
          }
          // undefined 保值语义成立（"不改写"→ HookManager 保持上一层值）
          return res?.value;
        };
        undo.push(this.deps.hooks.add(hook.name, handler, { priority: hook.priority }));
      }
      for (const job of contributions.crons) {
        const record = await this.deps.scheduler.schedule({
          extId: id,
          name: job.name,
          expr: job.expr,
          tz: job.tz,
          payload: job.payload,
          overlap: job.overlap,
          misfire: job.misfire,
        });
        const cronId =
          record !== null && typeof record === 'object' ? (record as { id?: unknown }).id : undefined;
        if (typeof cronId === 'string') {
          undo.push(() => {
            void this.deps.scheduler.unschedule(cronId);
          });
        }
      }
      const addedRoutes: ExtRouteTableEntry[] = contributions.routes.map((route) => ({
        extId: id,
        method: route.method,
        path: route.path,
        auth: route.auth ?? 'user',
        scope: route.scope,
        timeoutMs: route.timeoutMs,
      }));
      this.#routes = [...this.#routes, ...addedRoutes];
      const dropped = new Set(addedRoutes);
      undo.push(() => {
        this.#routes = this.#routes.filter((r) => !dropped.has(r));
      });
      await this.#writeRow(id, manifest, { enabled: true, lastError: null });
    } catch (cause) {
      for (const undoFn of [...undo].reverse()) {
        try {
          await undoFn();
        } catch (rollbackCause) {
          this.deps.logger.error(
            { err: rollbackCause, extId: id },
            'extension enable: rollback step failed (continuing rollback)',
          );
        }
      }
      this.#routes = routesBefore;
      const activationError = HarnessError.wrap(cause, 'EXT_ACTIVATION_FAILED');
      // DB 提交半途失败也强制回零（无半活）
      await this.#recordFailure(id, manifest, activationError);
      throw err('EXT_ACTIVATION_FAILED', { detail: { id, cause: activationError.message }, cause: activationError });
    }

    rt.active.set(id, { manifest, dir: found.dir, contributions, undo });
    this.#notifyRoutesChanged(routesBefore);
    // 服务目录同步（注册中心整扩展覆盖注册；激活成功后才通知，失败路径不产生登记）
    this.deps.onServicesChanged?.(
      id,
      contributions.services.map((s) => ({ name: s.name, methods: [...s.methods] })),
    );
    // UI 贡献同步（UiRegistry register 语义；声明式 manifest.ui 与运行期贡献合并，
    // 两条通道并存——webui 的 SPA 即双通道声明。空片段不产生登记）。提交点在原子
    // 提交成功之后，失败仅记日志——UI 目录缺失不应回滚已生效的扩展激活。
    const uiFragment = mergedUiFragment(manifest, contributions);
    if (uiFragment !== null) {
      try {
        this.deps.onUiChanged?.(id, uiFragment);
      } catch (cause) {
        this.deps.logger.error({ err: cause, extId: id }, 'extension enable: ui registry sync failed');
      }
    }
    // AuthProvider 同步：声明 'auth:provider' 的扩展在提交完成后注册为认证提供方
    if (manifest.permissions.includes('auth:provider')) {
      this.deps.onAuthProvider?.(id, 'register');
    }
    this.deps.logger.info({ extId: id, version: manifest.version }, 'extension enabled');
  }

  /** 激活失败统一收口：enabled=0 + last_error 记录（无半活；覆盖表中残留 enabled=1 的情况） */
  async #recordFailure(id: string, manifest: ExtensionManifest, e: HarnessError): Promise<void> {
    try {
      await this.#writeRow(id, manifest, { enabled: false, lastError: lastErrorOf(e) });
    } catch (recordCause) {
      this.deps.logger.error({ err: recordCause, extId: id }, 'extension enable: failure recording failed');
    }
  }

  /** 阶段性失败：记录后原样抛出（保留阶段错误码：EXT_DEPENDENCY_MISSING / EXT_PERMISSION_DENIED / …） */
  async #failStage(id: string, manifest: ExtensionManifest, e: HarnessError): Promise<never> {
    await this.#recordFailure(id, manifest, e);
    throw e;
  }

  /** load/贡献点校验阶段失败：记录具体错误，统一抛 EXT_ACTIVATION_FAILED（detail.cause 带根因） */
  async #failActivation(id: string, manifest: ExtensionManifest, cause: unknown): Promise<never> {
    const specific = HarnessError.wrap(cause, 'EXT_ACTIVATION_FAILED');
    await this.#recordFailure(id, manifest, specific);
    throw err('EXT_ACTIVATION_FAILED', { detail: { id, cause: specific.message }, cause: specific });
  }

  /** disable 的锁内实现：逆序摘除 → host.unload（尽力而为）→ enabled=0；幂等 */
  async #disableLocked(id: string): Promise<void> {
    const rt = this.#runtimeForId(id);
    const active = rt.active.get(id);
    const routesBefore = this.#routes;
    if (active !== undefined) {
      for (const undoFn of [...active.undo].reverse()) {
        try {
          await undoFn();
        } catch (cause) {
          this.deps.logger.error(
            { err: cause, extId: id },
            'extension disable: teardown step failed (continuing teardown)',
          );
        }
      }
      rt.active.delete(id);
      // 服务目录同步：disable 即摘除（注册中心侧 suspend；对未登记 extId 幂等）
      this.deps.onServicesChanged?.(id, null);
      // UI 贡献同步：disable 即整扩展摘除（UiRegistry.remove 幂等）
      this.deps.onUiChanged?.(id, null);
      // AuthProvider 同步：'auth:provider' 扩展停用时注销其 provider（幂等）
      if (active.manifest.permissions.includes('auth:provider')) {
        this.deps.onAuthProvider?.(id, 'unregister');
      }
    }
    // 路由整表兜底过滤（崩溃路径/回滚残留等情况）
    this.#routes = this.#routes.filter((r) => r.extId !== id);
    // worker 侧卸载尽力而为：内核侧摘除已提交，卸载失败不回滚（摘除 fail-fast 语义）
    if (active !== undefined && rt.bridge !== null) {
      try {
        // worker 契约（host.unload）：payload { extId }
        await rt.bridge.callToWorker(id, HOST_METHODS.unloadExt, { extId: id });
      } catch (cause) {
        this.deps.logger.warn(
          { err: cause, extId: id },
          'extension unload failed on worker (kernel-side teardown already committed)',
        );
      }
    }
    const row = this.#rowCache.get(id);
    if (row !== undefined && row.enabled) {
      await this.#writeRow(id, undefined, { enabled: false });
    }
    this.#notifyRoutesChanged(routesBefore);
  }

  // ------------------------------------------------------------------ 校验辅助

  /** 硬依赖缺失清单：未发现 / 未启用 / 版本不符（'id@range' 支持 semver 范围） */
  #missingHardDeps(manifest: ExtensionManifest): Array<{ id: string; cause: string }> {
    const missing: Array<{ id: string; cause: string }> = [];
    for (const req of manifest.requires) {
      const { id: depId, range } = parseRequire(req);
      const dep = this.#discovered.get(depId);
      if (dep === undefined) {
        missing.push({ id: depId, cause: 'hard dependency is not discovered' });
        continue;
      }
      // 跨池依赖同样成立（如社区扩展硬依赖内置扩展）：激活态查全部池
      if (!this.#isActive(depId)) {
        missing.push({ id: depId, cause: 'hard dependency is not enabled' });
        continue;
      }
      if (range !== undefined && range !== '' && !semver.satisfies(dep.manifest.version, range)) {
        missing.push({
          id: depId,
          cause: `dependency version ${dep.manifest.version} does not satisfy "${range}"`,
        });
      }
    }
    return missing;
  }

  /**
   * 贡献点权限复核：
   * routes→'http'、crons→'cron'、events→'events'、hooks→'hooks'；
   * services 必须被 manifest.provides 声明覆盖；builtin mount 须经白名单校验。
   * 任一不匹配 → EXT_PERMISSION_DENIED。
   */
  #assertContributionPermissions(id: string, manifest: ExtensionManifest, c: ExtensionContributions): void {
    const perms = new Set(manifest.permissions);
    const need: string[] = [];
    if (c.routes.length > 0) need.push('http');
    if (c.crons.length > 0) need.push('cron');
    if (c.events.length > 0) need.push('events');
    if (c.hooks.length > 0) need.push('hooks');
    const missingPerms = need.filter((p) => !perms.has(p));
    if (missingPerms.length > 0) {
      throw err('EXT_PERMISSION_DENIED', {
        detail: {
          id,
          missingPermissions: missingPerms,
          cause: 'contributions require permissions the manifest does not declare (routes→http, crons→cron, events→events, hooks→hooks)',
        },
      });
    }
    const provides = new Set(manifest.provides);
    const undeclared = c.services.map((s) => s.name).filter((name) => !provides.has(name));
    if (undeclared.length > 0) {
      throw err('EXT_PERMISSION_DENIED', {
        detail: {
          id,
          undeclaredServices: undeclared,
          cause: 'contributions.services must be covered by manifest.provides declarations',
        },
      });
    }
    // mount 白名单已前移至 #enableLocked 的 SEC-3 受信闸（fail-closed，含目录裁决），
    // 此处不再重复校验（旧签名只看 mount 字符串，可被任意目录的 manifest 自声明绕过）。
  }

  // ------------------------------------------------------------------ 发现/拓扑

  /** 扫描 extensionsDirs 一级子目录中含 manifest.json 者；validateManifest 失败仅跳过并记日志 */
  #scanDirs(): Map<string, DiscoveredExt> {
    const found = new Map<string, DiscoveredExt>();
    for (const dir of this.deps.extensionsDirs) {
      if (!existsSync(dir)) continue;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (cause) {
        this.deps.logger.warn({ err: cause, dir }, 'extension discovery: directory unreadable, skipped');
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const extDir = join(dir, entry.name);
        const manifestPath = join(extDir, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
          const manifest = validateManifest(raw);
          if (found.has(manifest.id)) {
            this.deps.logger.warn(
              { extId: manifest.id, dir: extDir },
              'extension discovery: duplicate id, first occurrence wins',
            );
            continue;
          }
          found.set(manifest.id, { manifest, dir: extDir, mainPath: join(extDir, manifest.main) });
        } catch (cause) {
          this.deps.logger.error({ err: cause, path: manifestPath }, 'extension discovery: invalid manifest, skipped');
        }
      }
    }
    return found;
  }

  /** 全量重扫：清空既有发现态后重建（start 路径用） */
  #discover(): void {
    this.#discovered.clear();
    for (const [id, found] of this.#scanDirs()) {
      this.#discovered.set(id, found);
    }
  }

  /**
   * REL-7（DX）：运行中重扫扩展目录（免重启发现新目录）。
   * - 新发现的目录插入 #discovered，并在 extensions 表登记（enabled=0，不自动激活）；
   * - 已有目录/已有 id 跳过（重复扫描幂等）；
   * - 返回新增发现的 extId 列表（enable 前无需重启内核）。
   */
  async rescan(): Promise<{ discovered: string[] }> {
    const found = this.#scanDirs();
    const discovered: string[] = [];
    for (const [id, foundExt] of found) {
      if (this.#discovered.has(id)) continue;
      this.#discovered.set(id, foundExt);
      const existing = await this.#getRow(id);
      if (existing === undefined) {
        await this.#insertRow(id, foundExt.manifest, { enabled: false, lastError: null });
      } else {
        // 表里已有行（此前发现后源目录被删又恢复）：刷新声明字段，不改变 enabled
        await this.#updateRow(id, {
          version: foundExt.manifest.version,
          builtin: foundExt.manifest.builtin,
          mount: foundExt.manifest.mount ?? null,
        });
      }
      discovered.push(id);
    }
    if (discovered.length > 0) {
      this.deps.logger.info({ discovered }, 'extension manager: rescan discovered new extension directories');
    }
    return { discovered };
  }

  /**
   * Kahn 拓扑排序（发现序稳定），限定在给定 id 集合内（**池内独立拓扑**：跨池依赖
   * 不建边，由 enable 阶段的硬依赖校验兜底）。环（含自依赖）→ EXT_DEPENDENCY_MISSING
   * fail-fast。只对「双方都在集合内」的依赖建边；依赖目标不在集合内留给 enable 阶段拒绝。
   */
  #topoOrder(poolIds: string[]): string[] {
    const inPool = new Set(poolIds);
    const indegree = new Map<string, number>(poolIds.map((id) => [id, 0]));
    const dependents = new Map<string, string[]>();
    for (const id of poolIds) {
      const found = this.#discovered.get(id);
      if (found === undefined) continue;
      for (const req of found.manifest.requires) {
        const { id: depId } = parseRequire(req);
        if (depId === id) {
          throw err('EXT_DEPENDENCY_MISSING', {
            detail: { id, cycle: [id], cause: `extension depends on itself ("${req}")` },
          });
        }
        if (!inPool.has(depId)) continue;
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
        const list = dependents.get(depId) ?? [];
        list.push(id);
        dependents.set(depId, list);
      }
    }
    const queue = poolIds.filter((id) => (indegree.get(id) ?? 0) === 0);
    const order: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      order.push(id);
      for (const dependent of dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) queue.push(dependent);
      }
    }
    if (order.length !== poolIds.length) {
      const cycle = poolIds.filter((id) => !order.includes(id));
      throw err('EXT_DEPENDENCY_MISSING', {
        detail: { cycle, cause: 'dependency cycle detected among discovered extensions' },
      });
    }
    return order;
  }

  // ------------------------------------------------------------------ 池路由/worker/桥

  /** 放置规则：builtin 声明 + 受信目录（isTrustedExtDir 未注入视为受信，stub 兼容）→ builtin 池 */
  #placement(manifest: ExtensionManifest, dir: string): HostKind {
    return manifest.builtin === true && this.deps.isTrustedExtDir?.(dir) !== false
      ? 'builtin'
      : 'community';
  }

  /**
   * id → 所属池运行态：已发现的按放置规则；extensions 表残留行（源目录已删）按行内
   * builtin 标记；全未知兜底 community。
   */
  #runtimeForId(id: string): HostRuntime {
    const found = this.#discovered.get(id);
    if (found !== undefined) return this.#runtimes[this.#placement(found.manifest, found.dir)];
    return this.#rowCache.get(id)?.builtin === true ? this.#runtimes.builtin : this.#runtimes.community;
  }

  /** 指定池的已发现扩展 id 列表（放置规则的投影） */
  #poolIds(kind: HostKind): string[] {
    const ids: string[] = [];
    for (const [id, found] of this.#discovered) {
      if (this.#placement(found.manifest, found.dir) === kind) ids.push(id);
    }
    return ids;
  }

  /** id 是否已在任一池激活（跨池硬依赖校验用） */
  #isActive(id: string): boolean {
    return this.#runtimes.builtin.active.has(id) || this.#runtimes.community.active.has(id);
  }

  /**
   * 重启退避延迟：注入的 restartBackoffMs 优先（测试钉死）；缺省时 builtin 池按
   * 500ms×2^n 封顶 30s（无限次重启），community 池按 [500..8000] 序列（配合熔断）。
   */
  #restartDelay(rt: HostRuntime, attempt: number): number {
    const injected = this.deps.restartBackoffMs;
    if (injected !== undefined && injected.length > 0) {
      return injected[Math.min(attempt - 1, injected.length - 1)] ?? FALLBACK_RESTART_DELAY_MS;
    }
    if (rt.kind === 'builtin') {
      return Math.min(BUILTIN_RESTART_BASE_MS * 2 ** Math.max(0, attempt - 1), BUILTIN_RESTART_MAX_MS);
    }
    return DEFAULT_RESTART_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_RESTART_BACKOFF_MS.length - 1)] ?? FALLBACK_RESTART_DELAY_MS;
  }

  /** 内置池崩溃/恢复通知（5 分钟节流：重启风暴合并为一条；notifier 缺失/失败静默） */
  #notifyHost(level: 'warn' | 'success', title: string, body: string): void {
    const now = Date.now();
    if (now - this.#lastHostNotifyAt < BUILTIN_NOTIFY_THROTTLE_MS) return;
    this.#lastHostNotifyAt = now;
    const notifier = this.deps.notifier;
    if (notifier === undefined) return;
    void notifier.send({ title, body, level }).catch((cause) => {
      this.deps.logger.warn({ err: cause }, 'extension manager: builtin host notification failed');
    });
  }

  /** 起指定池的新 worker + 桥，并接线 exit → 该池 handleWorkerExit（自愈入口） */
  #spawnBridge(rt: HostRuntime): void {
    const worker = this.deps.workerFactory(rt.kind);
    const bridge = new ExtensionBridge({
      worker,
      timeoutMs: this.deps.config.rpcTimeoutMs,
      maxPayloadBytes: this.deps.config.maxRpcPayloadBytes,
      logger: this.deps.logger,
      handlers: this.deps.bridgeHandlers,
    });
    bridge.onWorkerExit(() => {
      rt.bridgeDead = true; // REL-3：exit 后、respawn 前桥不可用（enable 据此重建）
      void this.handleWorkerExit(rt.kind);
    });
    rt.bridge = bridge;
    rt.bridgeDead = false;
    rt.workerSpawnCount += 1;
  }

  /** 指定池内核侧全部本地摘除（worker 已死路径：不调 unload RPC），仅清该池路由并通知 */
  async #deactivatePoolLocal(rt: HostRuntime): Promise<void> {
    const poolIds = new Set<string>();
    for (const [id, active] of [...rt.active]) {
      poolIds.add(id);
      for (const undoFn of [...active.undo].reverse()) {
        try {
          await undoFn();
        } catch (cause) {
          this.deps.logger.error({ err: cause, extId: id }, 'extension local teardown step failed');
        }
      }
      rt.active.delete(id);
      // 服务目录同步：worker 已死即摘除（与 disable 同语义；对未登记 extId 幂等）
      this.deps.onServicesChanged?.(id, null);
      // UI 贡献同步：worker 已死即摘除（与 disable 同语义；对未登记 extId 幂等）
      this.deps.onUiChanged?.(id, null);
      // AuthProvider 同步：worker 已死，provider 不再可用，立即注销（幂等）
      if (active.manifest.permissions.includes('auth:provider')) {
        this.deps.onAuthProvider?.(id, 'unregister');
      }
    }
    const before = this.#routes;
    this.#routes = this.#routes.filter((r) => !poolIds.has(r.extId));
    this.#notifyRoutesChanged(before);
  }

  // ------------------------------------------------------------------ DB/通知辅助

  /** 读单行（无行返回 undefined） */
  async #getRow(id: string): Promise<RowSnapshot | undefined> {
    const row = await this.deps.db<ExtRow>('extensions').where({ id }).first();
    if (row === undefined) return undefined;
    return {
      version: row.version,
      enabled: Number(row.enabled) === 1,
      builtin: Number(row.builtin) === 1,
      mount: row.mount ?? null,
      lastError: row.last_error ?? null,
      trustedAt: row.trusted_at ?? null,
    };
  }

  /** 插入行（发现登记用）并同步内存快照 */
  async #insertRow(
    id: string,
    manifest: ExtensionManifest,
    patch: { enabled: boolean; lastError: string | null },
  ): Promise<void> {
    const now = Date.now();
    await this.deps.db('extensions').insert({
      id,
      version: manifest.version,
      enabled: patch.enabled ? 1 : 0,
      builtin: manifest.builtin ? 1 : 0,
      mount: manifest.mount ?? null,
      uninstall: manifest.uninstall,
      crash_count: 0,
      last_error: patch.lastError,
      installed_at: now,
      updated_at: now,
    });
    this.#rowCache.set(id, {
      version: manifest.version,
      enabled: patch.enabled,
      builtin: manifest.builtin,
      mount: manifest.mount ?? null,
      lastError: patch.lastError,
      trustedAt: null,
    });
  }

  /** 更新行（仅给定字段）并同步内存快照 */
  async #updateRow(
    id: string,
    patch: {
      version?: string;
      builtin?: boolean;
      mount?: string | null;
      enabled?: boolean;
      lastError?: string | null;
      trustedAt?: number | null;
      trustedBy?: string | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.version !== undefined) set['version'] = patch.version;
    if (patch.builtin !== undefined) set['builtin'] = patch.builtin ? 1 : 0;
    if (patch.mount !== undefined) set['mount'] = patch.mount;
    if (patch.enabled !== undefined) set['enabled'] = patch.enabled ? 1 : 0;
    if (patch.lastError !== undefined) set['last_error'] = patch.lastError;
    if (patch.trustedAt !== undefined) set['trusted_at'] = patch.trustedAt;
    if (patch.trustedBy !== undefined) set['trusted_by'] = patch.trustedBy;
    await this.deps.db('extensions').where({ id }).update(set);
    const cached = this.#rowCache.get(id);
    if (cached !== undefined) {
      this.#rowCache.set(id, {
        version: patch.version ?? cached.version,
        enabled: patch.enabled ?? cached.enabled,
        builtin: patch.builtin ?? cached.builtin,
        mount: patch.mount !== undefined ? patch.mount : cached.mount,
        lastError: patch.lastError !== undefined ? patch.lastError : cached.lastError,
        trustedAt: patch.trustedAt !== undefined ? patch.trustedAt : cached.trustedAt,
      });
    }
  }

  /**
   * 行写入统一入口：行存在则更新；行缺失且有 manifest 则插入；两者皆无则忽略
   * （未知扩展不造行）。
   */
  async #writeRow(
    id: string,
    manifest: ExtensionManifest | undefined,
    patch: { enabled?: boolean; lastError?: string | null },
  ): Promise<void> {
    const exists = this.#rowCache.has(id) || (await this.#getRow(id)) !== undefined;
    if (exists) {
      await this.#updateRow(id, patch);
      return;
    }
    if (manifest !== undefined) {
      await this.#insertRow(id, manifest, {
        enabled: patch.enabled ?? false,
        lastError: patch.lastError ?? null,
      });
    }
  }

  /** 路由表发生变化时（引用级比较）回调 onRoutesChanged（原子变更通知） */
  #notifyRoutesChanged(before: readonly ExtRouteTableEntry[]): void {
    const after = this.#routes;
    if (before.length === after.length && before.every((entry, i) => entry === after[i])) return;
    this.deps.onRoutesChanged?.(this.getRoutes());
  }

  // ------------------------------------------------------------------ 并发辅助

  /** per-ext 生命周期串行化：同一扩展的 enable/disable/reload/uninstall 依次执行 */
  #withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.#locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
