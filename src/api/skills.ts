/**
 * skills — 技能子系统 REST API（/api/v1/skills*）。
 *
 * 路由（全部要求已认证；refresh 为写操作，仅 admin/root）：
 * - GET  /api/v1/skills       列表（?q=&source=&tag=；不含正文）→ SkillEntry[]
 * - GET  /api/v1/skills/:id   读取单个技能（含正文 body；未找到 → 404 HARNESS-3004 形状）
 * - POST /api/v1/skills/refresh  重扫技能库 → { total, bySource }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1006；
 *   refresh 要求 role 为 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验，失败 → 400 HARNESS-1009 VALIDATION_FAILED（detail = issues）；
 * - 注册表是纯读模型：列表/详情/refresh 全部只读磁盘与内存贡献，无任何写副作用。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err } from '../kernel/errors/index.js';
import type { SkillEntry, SkillRegistryLike, SkillSource, SkillWithBody } from '../kernel/skills/types.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerSkillRoutes 依赖集合 */
export interface SkillRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时 refresh 抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 技能注册表（list/get/refresh 全部委托于此；SkillRegistry 满足此形状） */
  registry: Pick<SkillRegistryLike, 'list' | 'get' | 'refresh'>;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** GET /api/v1/skills 查询参数 */
const listQuerySchema = z.object({
  q: z.string().min(1).max(256).optional(),
  source: z.enum(['builtin', 'data', 'extension']).optional(),
  tag: z.string().min(1).max(64).optional(),
});

/** 查询串空串视同未提供（`?q=` 不会撞 min(1) 校验） */
function dropEmptyStrings(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''));
}

/** POST /api/v1/skills/refresh 应答体 */
export interface SkillsRefreshReport {
  /** 当前生效技能总数 */
  total: number;
  /** 按来源分布（三键恒在） */
  bySource: Record<SkillSource, number>;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册技能 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerSkillRoutes(app: FastifyInstance, deps: SkillRoutesDeps): void {
  // 统一鉴权（任意已认证角色）
  const requireAuth = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  // 鉴权 + 角色门禁：refresh 是唯一的写面（重扫），要求 admin 及以上（root 放行）
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await requireAuth(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: 'skills refresh requires role admin or root',
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['skills'] } };

  // GET /api/v1/skills — 列表（?q=&source=&tag=；条目不含正文）
  app.get('/api/v1/skills', routeOptions, async (request) => {
    await requireAuth(request);
    const query = dropEmptyStrings((request.query ?? {}) as Record<string, unknown>);
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const entries: SkillEntry[] = deps.registry.list({
      ...(parsed.data.q !== undefined ? { q: parsed.data.q } : {}),
      ...(parsed.data.source !== undefined ? { source: parsed.data.source } : {}),
      ...(parsed.data.tag !== undefined ? { tag: parsed.data.tag } : {}),
    });
    return entries;
  });

  // GET /api/v1/skills/:id — 详情（含正文 body）
  app.get('/api/v1/skills/:id', routeOptions, async (request) => {
    await requireAuth(request);
    const { id } = request.params as { id: string };
    const found: SkillWithBody | null = await deps.registry.get(id);
    if (found === null) {
      throw err('EXT_NOT_FOUND', { message: `skill "${id}" not found`, detail: { id } });
    }
    return { ...found.entry, body: found.body };
  });

  // POST /api/v1/skills/refresh — 重扫技能库（admin/root）
  app.post('/api/v1/skills/refresh', routeOptions, async (request) => {
    await requireAdmin(request);
    const entries: SkillEntry[] = await deps.registry.refresh();
    const bySource: Record<SkillSource, number> = { builtin: 0, data: 0, extension: 0 };
    for (const entry of entries) bySource[entry.source] += 1;
    const report: SkillsRefreshReport = { total: entries.length, bySource };
    return report;
  });
}
