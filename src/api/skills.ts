/**
 * skills — 技能子系统 REST API（/api/v1/skills*）。
 *
 * 路由（全部要求已认证；refresh/create/delete 为写操作，仅 admin/root）：
 * - GET  /api/v1/skills       列表（?q=&source=&tag=；不含正文）→ SkillEntry[]
 * - GET  /api/v1/skills/:id   读取单个技能（含正文 body；未找到 → 404 HARNESS-3004 形状）
 * - POST /api/v1/skills       创建技能（admin/root；写入 data 源目录）→ 201 { id, path }
 * - DELETE /api/v1/skills/:id 删除技能（admin/root；仅 data 源可删，builtin/extension → 403）
 * - POST /api/v1/skills/refresh  重扫技能库 → { total, bySource }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交
 *   deps.checker 校验；失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1006；
 *   写操作要求 role 为 'root'|'admin'，否则 403 HARNESS-1007；
 * - 入参全部 zod 校验，失败 → 400 HARNESS-1009 VALIDATION_FAILED（detail = issues）；
 * - 写面依赖 deps.writer（可选注入，src/kernel/skills/writer.ts 的
 *   writeSkill/deleteSkill 满足此形状）：注入后 POST/DELETE 生效并**写后触发
 *   registry.refresh**（新技能立即可读、删除立即消失）；未注入 → 503 SERVICE_UNAVAILABLE；
 * - 注册表本体是纯读模型：列表/详情/refresh 全部只读磁盘与内存贡献；
 *   落盘只发生在 deps.writer（data 源目录）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err } from '../kernel/errors/index.js';
import {
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
  type SkillEntry,
  type SkillRegistryLike,
  type SkillSource,
  type SkillWithBody,
} from '../kernel/skills/types.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 受控写面依赖（结构化最小面；src/kernel/skills/writer.ts 的 writeSkill/deleteSkill 满足此形状） */
export interface SkillWriterDeps {
  /** 创建技能（data 源 `<dataDir>/skills/<id>/SKILL.md`；目录已存在 → BAD_REQUEST） */
  write: (input: {
    id: string;
    name: string;
    description: string;
    body: string;
    tags?: string[];
    author?: string;
  }) => Promise<{ id: string; path: string }>;
  /** 删除技能（仅 data 源；builtin → FORBIDDEN，未知 → EXT_NOT_FOUND） */
  remove: (id: string, opts?: { force?: boolean }) => Promise<void>;
}

/** registerSkillRoutes 依赖集合 */
export interface SkillRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回的 role 非
   * 'root'|'admin' 时写操作抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 技能注册表（list/get/refresh 全部委托于此；SkillRegistry 满足此形状） */
  registry: Pick<SkillRegistryLike, 'list' | 'get' | 'refresh'>;
  /** 受控写面（可选注入；注入则 POST/DELETE /api/v1/skills 生效并写后 refresh） */
  writer?: SkillWriterDeps;
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

/** POST /api/v1/skills 应答体（body 字节级 ≤128KB / 非空复核在 writer 层） */
const createSkillBodySchema = z.object({
  id: z.string().max(64).regex(SKILL_NAME_PATTERN),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
  body: z.string().min(1),
  tags: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
  author: z.string().min(1).max(200).optional(),
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

  // 鉴权 + 角色门禁：写操作（创建/删除/重扫）要求 admin 及以上（root 放行）
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await requireAuth(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: 'skills write requires role admin or root',
        detail: { role: identity.role },
      });
    }
  };

  /** 写面依赖（未注入 → 503：本部署未装配技能写能力） */
  const requireWriter = (deps: SkillRoutesDeps): SkillWriterDeps => {
    if (deps.writer === undefined) {
      throw err('SERVICE_UNAVAILABLE', {
        message: 'skills writer is not configured on this deployment (read-only skills registry)',
      });
    }
    return deps.writer;
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

  // POST /api/v1/skills — 创建技能（admin/root；写入 data 源目录后立即 refresh）
  app.post('/api/v1/skills', routeOptions, async (request, reply) => {
    await requireAdmin(request);
    const writer = requireWriter(deps);
    const parsed = createSkillBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message:
          'body requires { id, name, description, body, tags?, author? } (id ^[a-z0-9-]{1,64}$, description ≤1024 chars, body non-empty ≤128KB)',
        detail: parsed.error.issues,
      });
    }
    // body 字节级上限（128KB）与非空复核在 writer（zod 只能按字符校验）
    const created = await writer.write(parsed.data);
    // registry 恒注入：写后立即重扫，新技能马上可经 GET 列表/详情读到
    await deps.registry.refresh();
    return await reply.code(201).send({ id: created.id, path: created.path });
  });

  // DELETE /api/v1/skills/:id — 删除技能（admin/root；仅 data 源可删，删后立即 refresh）
  app.delete('/api/v1/skills/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const writer = requireWriter(deps);
    const { id } = request.params as { id: string };
    const found: SkillWithBody | null = await deps.registry.get(id);
    if (found === null) {
      throw err('EXT_NOT_FOUND', { message: `skill "${id}" not found`, detail: { id } });
    }
    if (found.entry.source !== 'data') {
      // builtin 源（repoRoot/skills）只读；extension 贡献驻留内存（随扩展生命周期），皆不可删
      throw err('FORBIDDEN', {
        message: `skill "${id}" is provided by the "${found.entry.source}" source; only data-source skills can be deleted`,
        detail: { id, source: found.entry.source },
      });
    }
    await writer.remove(id);
    await deps.registry.refresh();
    return { ok: true, id };
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
