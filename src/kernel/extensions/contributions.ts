/**
 * contributions — 扩展激活贡献点契约（worker `host.load` 回执）。
 *
 * 扩展线程在 load 阶段把要注册的路由/定时/事件订阅/hook/服务/UI 贡献回报给内核，
 * 内核用 `validateContributions(raw, maxRoutes)` 过闸后才能入册：
 * - 结构校验（zod）：字段形状、method 枚举、path 以 '/' 开头等；
 * - 路由数上限：超过 maxRoutes → EXT_ROUTE_LIMIT（防单扩展拖垮路由表）；
 * - 同扩展内重复 method+path（归一化后）→ EXT_ROUTE_CONFLICT；
 * - 其余形状问题 → EXT_MANIFEST_INVALID（沿用 manifest 失败码，detail 携带 zod issues）。
 *
 * 路径归一化规则：连续 '/' 折叠为单 '/'、去结尾 '/'（根 '/' 保留）；method 恒大写。
 * 因此 `/a//b/` 与 `/a/b` 视为同一路由；`:param` / 通配段原样参与比较。
 */
import { z } from 'zod';

import { err } from '../errors/index.js';

/** 单条 HTTP 路由贡献 */
export interface RouteContribution {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** 认证层级（缺省由内核路由表默认值兜底） */
  auth?: 'public' | 'user' | 'admin';
  /** 所需权限 scope（配合 auth 使用） */
  scope?: string;
  /** 处理超时（毫秒），缺省用内核默认 */
  timeoutMs?: number;
}

/** 单条定时任务贡献（expr 交由 croner 在注册时校验，tz 为 IANA 时区名） */
export interface CronContribution {
  name: string;
  expr: string;
  tz?: string;
  payload?: unknown;
  /** 上一次未结束时再次触发：skip=丢弃本次；queue=排队续跑 */
  overlap?: 'skip' | 'queue';
  /** 错过触发点：skip=跳过；runOnce=补跑一次 */
  misfire?: 'skip' | 'runOnce';
}

/** 单个服务贡献（h.expose 注册：方法名 → 扩展线程 handler） */
export interface ServiceContribution {
  name: string;
  methods: string[];
}

/** UI 贡献段（worker 线格式；与 manifest.ui 同形的菜单/页面/小部件/渲染器） */
export interface UiContributionSection {
  /**
   * 菜单（worker 线格式为**数组**——h.menu / h.ui.register 每次调用追加一项；
   * 提交 UiRegistry 时由 manager 取最后一项归一为单值语义）。
   */
  menu: Array<{ label: string; icon?: string }>;
  pages: Array<{ path: string; title: string; entry: string }>;
  widgets: Array<{ id: string; title: string; entry: string }>;
  renderers: string[];
}

/** 一个扩展激活时的全部贡献点 */
export interface ExtensionContributions {
  routes: RouteContribution[];
  crons: CronContribution[];
  events: { pattern: string; priority?: number }[];
  hooks: { name: string; priority?: number }[];
  services: ServiceContribution[];
  /** UI 贡献段（缺省全空；激活提交时交给 UiRegistry，见 manager.ts 的 onUiChanged 接线） */
  ui: UiContributionSection;
}

/** 空贡献点（无贡献的扩展回执兜底值）；顶层与数组均冻结，防止误改共享实例 */
export const EMPTY_CONTRIBUTIONS: ExtensionContributions = Object.freeze({
  // 冻结的空数组需经 unknown 断言为可变数组类型（消费方拿到的是冻结实例，运行期不可变）
  routes: Object.freeze([]) as unknown as RouteContribution[],
  crons: Object.freeze([]) as unknown as CronContribution[],
  events: Object.freeze([]) as unknown as ExtensionContributions['events'],
  hooks: Object.freeze([]) as unknown as ExtensionContributions['hooks'],
  services: Object.freeze([]) as unknown as ServiceContribution[],
  ui: Object.freeze({
    menu: Object.freeze([]) as unknown as UiContributionSection['menu'],
    pages: Object.freeze([]) as unknown as UiContributionSection['pages'],
    widgets: Object.freeze([]) as unknown as UiContributionSection['widgets'],
    renderers: Object.freeze([]) as unknown as UiContributionSection['renderers'],
  }),
});

/** 贡献点 zod schema（形状层校验；路由上限/冲突在 validateContributions 做语义层校验） */
export const contributionsSchema = z.object({
  routes: z
    .array(
      z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().refine((p) => p.startsWith('/'), {
          error: 'route path must start with "/"',
        }),
        auth: z.enum(['public', 'user', 'admin']).optional(),
        scope: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .default([]),
  crons: z
    .array(
      z.object({
        name: z.string().min(1),
        expr: z.string().min(1),
        tz: z.string().min(1).optional(),
        payload: z.unknown().optional(),
        overlap: z.enum(['skip', 'queue']).optional(),
        misfire: z.enum(['skip', 'runOnce']).optional(),
      }),
    )
    .default([]),
  events: z
    .array(z.object({ pattern: z.string().min(1), priority: z.number().int().optional() }))
    .default([]),
  hooks: z
    .array(z.object({ name: z.string().min(1), priority: z.number().int().optional() }))
    .default([]),
  services: z
    .array(z.object({ name: z.string().min(1), methods: z.array(z.string().min(1)) }))
    .default([]),
  // UI 段（worker 线格式：menu 为数组——h.menu/h.ui.register 每次调用追加；
  // 缺省全空段兜底旧 worker 回执）
  ui: z
    .object({
      menu: z.array(z.object({ label: z.string(), icon: z.string().optional() })).default([]),
      pages: z
        .array(z.object({ path: z.string(), title: z.string(), entry: z.string() }))
        .default([]),
      widgets: z
        .array(z.object({ id: z.string(), title: z.string(), entry: z.string() }))
        .default([]),
      renderers: z.array(z.string()).default([]),
    })
    .default({ menu: [], pages: [], widgets: [], renderers: [] }),
});

/** 路由归一化：折叠连续 '/'、去结尾 '/'（根保留）；method 恒大写 */
function normalizeRouteKey(method: string, path: string): string {
  let p = path.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return `${method.toUpperCase()} ${p}`;
}

/**
 * 校验并规整 worker 上报的贡献点。
 * - 形状非法（含 path 不以 '/' 开头）→ `err('EXT_MANIFEST_INVALID')`，detail 为 zod issues；
 * - 路由数超过 maxRoutes → `err('EXT_ROUTE_LIMIT')`；
 * - 同扩展内归一化后重复的 method+path → `err('EXT_ROUTE_CONFLICT')`。
 */
export function validateContributions(raw: unknown, maxRoutes: number): ExtensionContributions {
  const parsed = contributionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw err('EXT_MANIFEST_INVALID', { detail: parsed.error.issues });
  }
  const data = parsed.data;

  if (data.routes.length > maxRoutes) {
    throw err('EXT_ROUTE_LIMIT', { detail: { routes: data.routes.length, maxRoutes } });
  }

  const seen = new Map<string, { method: string; path: string }>();
  for (const route of data.routes) {
    const key = normalizeRouteKey(route.method, route.path);
    const first = seen.get(key);
    if (first) {
      throw err('EXT_ROUTE_CONFLICT', {
        detail: { method: route.method, path: route.path, duplicateOf: first },
      });
    }
    seen.set(key, { method: route.method, path: route.path });
  }

  return data;
}
