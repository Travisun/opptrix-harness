/**
 * memory — 全局 LLM 记忆系统 REST API（/api/v1/memory*）。
 *
 * 路由（**读写全部任意已认证身份**——记忆是智能体的运行时工作记忆，普通用户/
 * 扩展代理皆可读写；仅 settings 面要求 role root|admin）：
 * - GET    /api/v1/memory/search?q=&kind=&limit=   FTS5 加权检索 → { items, query }
 *          （enabled=false → { items: [], enabled: false, disabled: true }）
 * - POST   /api/v1/memory                          新增 { content, kind?, tags?, sessionRef? }
 *          → 201 { record, deduped }（精确去重命中时 deduped=true）
 * - GET    /api/v1/memory?kind=&limit=             列表（updated_at 倒序）→ { items }
 * - DELETE /api/v1/memory/:id                      遗忘 → { ok, removed }（未知 id → 404）
 * - POST   /api/v1/memory/extract                  LLM 抽取入记忆 { text, model?, sessionRef? }
 *          → { extracted, added, skipped, items }（enabled=false → 空 + 禁用提示；
 *          抽取器未接线 → 501 HARNESS-9004）
 * - GET    /api/v1/memory/stats                    统计 → { count, byKind }
 * - GET    /api/v1/memory/settings                 读取设置（admin；未接线 deps.settings → 501）
 * - PUT    /api/v1/memory/settings                 覆写 { enabled?, maxMemories?, autoExtract? }
 *          （admin；zod 校验 + 合并缺省 → settings('memory.settings')；联动 manager 上限）
 *
 * 约定（与 notifications.ts 同款）：
 * - 鉴权：token 经 extractToken 交 deps.checker 校验；失败抛 UNAUTHORIZED → 401；
 * - 入参全部 zod 校验；非法 JSON body 与校验失败统一 400 HARNESS-1009 VALIDATION_FAILED；
 * - **enabled 门禁只在 REST 层**：enabled=false 时 extract/search 返回空 + 禁用提示
 *   （HTTP 200，body.enabled=false）——manager 层不强制，桥/内部直连不受影响；
 * - deps.settings 未接线时设置面 501，且 enabled 视为缺省 true（不阻塞记忆主功能）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { MemoryManager } from '../kernel/memory/index.js';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTINGS_KEY,
  mergeMemorySettings,
  type MemorySettings,
} from '../kernel/memory/index.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** registerMemoryRoutes 依赖集合 */
export interface MemoryRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；settings 面要求 role 'root'|'admin'，
   * 否则本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 记忆管理器（kernel/memory 的领域编排层） */
  manager: MemoryManager;
  /**
   * settings 持久化（SettingsService 契约，键 'memory.settings'）。
   * 可选：未接线时 GET/PUT /settings 返回 501 NOT_IMPLEMENTED，且 enabled 恒视为 true。
   */
  settings?: {
    get<T>(key: string, fallback?: T): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** GET /search 查询参数 */
const searchQuerySchema = z.object({
  q: z.string().min(1).max(4_096),
  kind: z.string().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** POST /memory 请求体 */
const addBodySchema = z.object({
  content: z.string().min(1).max(8_000),
  kind: z.enum(['fact', 'preference', 'event', 'procedure']).optional(),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
  sessionRef: z.string().max(256).optional(),
});

/** GET /memory 列表查询参数 */
const listQuerySchema = z.object({
  kind: z.string().min(1).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** POST /extract 请求体 */
const extractBodySchema = z.object({
  text: z.string().min(1).max(100_000),
  model: z.string().min(1).max(256).optional(),
  sessionRef: z.string().max(256).optional(),
});

/** PUT /settings 请求体（全部可选 = 部分更新；合并既有值后整体持久化） */
const settingsBodySchema = z.object({
  enabled: z.boolean().optional(),
  maxMemories: z.number().int().min(1).max(1_000_000).optional(),
  autoExtract: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** fastify JSON body 解析类错误码（仅这两个映射为 VALIDATION_FAILED，其余交回全局兜底） */
const JSON_PARSE_ERROR_CODES = new Set(['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY']);

/**
 * POST/PUT/DELETE 路由级错误处理：非法 JSON body 映射为 400 VALIDATION_FAILED；
 * HarnessError 按自身状态码下发；其余异常重新抛出交回全局错误处理器兜底。
 */
function mapBodyParseError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof HarnessError) {
    reply.code(error.status).send(error.toJSON());
    return;
  }
  if (typeof error.code === 'string' && JSON_PARSE_ERROR_CODES.has(error.code)) {
    const invalid = err('VALIDATION_FAILED', {
      message: 'request body is not valid JSON — fix the JSON syntax and send content-type: application/json',
      detail: [{ code: error.code, message: error.message }],
    });
    reply.code(invalid.status).send(invalid.toJSON());
    return;
  }
  throw error;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册记忆系统 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRoutesDeps): void {
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** settings 面门禁：admin 及以上（root 放行），否则 FORBIDDEN */
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const identity = await authenticate(request);
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `memory settings requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  /** 读取生效中的设置（未接线 deps.settings → 缺省值；enabled 恒 true） */
  const readSettings = async (): Promise<MemorySettings> => {
    if (deps.settings === undefined) return DEFAULT_MEMORY_SETTINGS;
    const raw = await deps.settings.get<unknown>(MEMORY_SETTINGS_KEY, DEFAULT_MEMORY_SETTINGS);
    return mergeMemorySettings(raw ?? DEFAULT_MEMORY_SETTINGS);
  };

  const routeOptions = { schema: { tags: ['memory'] } };

  // GET /api/v1/memory/search — FTS5 加权检索（enabled=false → 空 + 禁用提示）
  app.get('/api/v1/memory/search', routeOptions, async (request) => {
    await authenticate(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = searchQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'search requires query "q" (1..4096 chars); optional "kind" and "limit" (1..100)',
        detail: parsed.error.issues,
      });
    }
    const settings = await readSettings();
    if (!settings.enabled) {
      return { items: [], query: parsed.data.q, enabled: false, disabled: true };
    }
    const items = await deps.manager.search(parsed.data.q, {
      limit: parsed.data.limit,
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    });
    return { items, query: parsed.data.q, enabled: true };
  });

  // POST /api/v1/memory — 新增（201；精确去重命中 → deduped=true，不重复插入）
  app.post(
    '/api/v1/memory',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request, reply) => {
      await authenticate(request);
      const parsed = addBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'body must be { content: string(1..8000), kind?, tags?, sessionRef? }',
          detail: parsed.error.issues,
        });
      }
      const result = await deps.manager.add({
        content: parsed.data.content,
        kind: parsed.data.kind,
        tags: parsed.data.tags,
        source: 'manual',
        ...(parsed.data.sessionRef !== undefined ? { sessionRef: parsed.data.sessionRef } : {}),
      });
      reply.code(201);
      return { record: result.record, deduped: result.deduped };
    },
  );

  // GET /api/v1/memory — 列表（updated_at 倒序；kind/limit 过滤）
  app.get('/api/v1/memory', routeOptions, async (request) => {
    await authenticate(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', {
        message: 'list accepts optional "kind" and "limit" (1..500)',
        detail: parsed.error.issues,
      });
    }
    const items = await deps.manager.list({
      limit: parsed.data.limit,
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
    });
    return { items };
  });

  // DELETE /api/v1/memory/:id — 遗忘（未知 id → 404 HARNESS-3004）
  app.delete(
    '/api/v1/memory/:id',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await authenticate(request);
      const { id } = request.params as { id: string };
      const removed = await deps.manager.forget(id);
      if (!removed) {
        throw err('EXT_NOT_FOUND', { message: `memory "${id}" not found`, detail: { id } });
      }
      return { ok: true, removed: true };
    },
  );

  // POST /api/v1/memory/extract — LLM 抽取入记忆（enabled=false → 空 + 禁用提示；
  // 抽取器未接线 → 501；LLM 报错（模型缺失/网关未配置）透传其状态码）
  app.post(
    '/api/v1/memory/extract',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await authenticate(request);
      const parsed = extractBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'body must be { text: string(1..100000), model?, sessionRef? }',
          detail: parsed.error.issues,
        });
      }
      const settings = await readSettings();
      if (!settings.enabled) {
        return {
          extracted: 0,
          added: 0,
          skipped: 0,
          items: [],
          enabled: false,
          disabled: true,
          message: 'memory system is disabled (settings.enabled=false); extraction skipped',
        };
      }
      if (!deps.manager.canExtract) {
        throw err('NOT_IMPLEMENTED', {
          message: 'memory extract is not wired: the kernel has no LLM extractor registered for the memory manager',
        });
      }
      return deps.manager.extractAndStore(parsed.data.text, {
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        ...(parsed.data.sessionRef !== undefined ? { sessionRef: parsed.data.sessionRef } : {}),
      });
    },
  );

  // GET /api/v1/memory/stats — 统计（读操作）
  app.get('/api/v1/memory/stats', routeOptions, async (request) => {
    await authenticate(request);
    return deps.manager.stats();
  });

  // GET /api/v1/memory/settings — 读取设置（admin；未接线 → 501）
  app.get('/api/v1/memory/settings', routeOptions, async (request) => {
    await requireAdmin(request);
    if (deps.settings === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'memory settings are not wired (no deps.settings provider registered)',
      });
    }
    return readSettings();
  });

  // PUT /api/v1/memory/settings — 覆写设置（admin；部分更新合并既有值后整体持久化；
  // maxMemories 联动 manager 容量上限，enabled 只影响 REST 门禁——manager 层不强制）
  app.put(
    '/api/v1/memory/settings',
    { ...routeOptions, errorHandler: mapBodyParseError },
    async (request) => {
      await requireAdmin(request);
      if (deps.settings === undefined) {
        throw err('NOT_IMPLEMENTED', {
          message: 'memory settings are not wired (no deps.settings provider registered)',
        });
      }
      const parsed = settingsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'body must be { enabled?: boolean, maxMemories?: int(1..1000000), autoExtract?: boolean }',
          detail: parsed.error.issues,
        });
      }
      const current = await readSettings();
      const next: MemorySettings = { ...current, ...parsed.data };
      await deps.settings.set(MEMORY_SETTINGS_KEY, next);
      deps.manager.setMaxMemories(next.maxMemories);
      return next;
    },
  );
}
