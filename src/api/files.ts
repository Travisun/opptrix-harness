/**
 * files — 文件上传/管理 REST API（/api/v1/files*）。
 *
 * 路由：
 * - POST   /api/v1/files        上传（已认证任意角色；multipart/form-data 单文件，
 *                               field 名 `file`；query.extId 可选）→ 201 FileRecord
 * - GET    /api/v1/files        列表（已认证；?extId=&limit=）→ FileRecord[]
 * - GET    /api/v1/files/:id    下载（已认证；public 任意用户，private 仅 root/admin）
 *                               → 二进制内容（Content-Type = mime，Content-Disposition 带 filename）
 * - DELETE /api/v1/files/:id    删除（admin/root）→ { deleted: true }
 *
 * 约定：
 * - 鉴权经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 * - multipart 用 @fastify/multipart 的流式 API（request.file()）手动计量：
 *   累计字节超过 maxUploadBytes 立即销毁流并抛 `HARNESS-1005` PAYLOAD_TOO_LARGE；
 *   不使用 attachFieldsToBody；
 * - @fastify/multipart 在本函数内 app.register 注册（调用方需在 app.ready() 前完成注册，
 *   fastify.inject 会自动 boot，无需额外处理）；
 * - 非 multipart 的 Content-Type / 缺 file 字段 → 400 BAD_REQUEST。
 */
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { FileService } from '../kernel/files/service.js';

/** request.file() 的返回类型（@fastify/multipart 对 FastifyRequest 的增强） */
type FilePart = NonNullable<Awaited<ReturnType<FastifyRequest['file']>>>;

/** registerFileRoutes 依赖集合 */
export interface FileRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 内核文件服务 */
  service: FileService;
  /** 单文件大小上限（字节），与内核 config.maxUploadBytes 同源 */
  maxUploadBytes: number;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** POST 上传查询参数 */
const uploadQuerySchema = z.object({
  extId: z.string().min(1).optional(),
});

/** GET 列表查询参数 */
const listQuerySchema = z.object({
  extId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 逐块消费上传流并计量：累计超过 maxBytes 即销毁流并抛 PAYLOAD_TOO_LARGE */
async function consumeFilePart(part: FilePart, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of part.file) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > maxBytes) {
      part.file.destroy();
      throw err('PAYLOAD_TOO_LARGE', {
        message: `uploaded file exceeds maxUploadBytes ${maxBytes}`,
        detail: { limit: maxBytes },
      });
    }
    chunks.push(buf);
  }
  // busboy 在 fileSize 上限处截断（fileSize 设为 maxBytes+1 兜底），双保险复核
  if ((part.file as { truncated?: boolean }).truncated === true || size > maxBytes) {
    throw err('PAYLOAD_TOO_LARGE', {
      message: `uploaded file exceeds maxUploadBytes ${maxBytes}`,
      detail: { limit: maxBytes },
    });
  }
  return Buffer.concat(chunks);
}

/** multipart 解析类异常 → 400 BAD_REQUEST（其余原样上抛交全局兜底） */
function mapMultipartError(e: unknown): Error {
  if (e instanceof HarnessError) return e;
  const code = (e as { code?: string }).code;
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return err('BAD_REQUEST', {
      message: 'request must be multipart/form-data with a single "file" field',
      detail: [{ code, message: e instanceof Error ? e.message : String(e) }],
      cause: e,
    });
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}

/** Content-Disposition：ASCII 回退 + RFC 5987 UTF-8 扩展（非 ASCII 文件名） */
function contentDispositionOf(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册文件管理 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerFileRoutes(app: FastifyInstance, deps: FileRoutesDeps): void {
  // multipart 内容类型解析器（流式：body 不在此消费，request.file() 时才解析）
  void app.register(multipart);

  /** 已认证身份获取（Authorization: Bearer 优先，其次 ?token=） */
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** private 文件的读权限：仅 root/admin（v1 约定；扩展私有访问走 h.files） */
  const canReadPrivate = (role: string): boolean => role === 'root' || role === 'admin';

  const routeOptions = { schema: { tags: ['files'] } };

  // POST /api/v1/files — 上传（multipart 单文件 field 'file'；?extId= 可选）
  app.post('/api/v1/files', routeOptions, async (request, reply) => {
    await authenticate(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsedQuery = uploadQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      throw err('VALIDATION_FAILED', { detail: parsedQuery.error.issues });
    }

    let part: FilePart | undefined;
    try {
      part = await request.file({
        throwFileSizeLimit: false,
        limits: {
          fileSize: deps.maxUploadBytes + 1,
          files: 1,
          fields: 20,
          parts: 100,
        },
      });
    } catch (e) {
      throw mapMultipartError(e);
    }
    if (part === undefined) {
      throw err('BAD_REQUEST', { message: 'multipart body with a "file" field is required' });
    }

    const data = await consumeFilePart(part, deps.maxUploadBytes);
    const record = await deps.service.store({
      data,
      origName: part.filename,
      mime: part.mimetype,
      extId: parsedQuery.data.extId ?? null,
    });
    reply.code(201);
    return record;
  });

  // GET /api/v1/files — 列表（?extId=&limit=）
  app.get('/api/v1/files', routeOptions, async (request) => {
    await authenticate(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = listQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return deps.service.list({
      extId: parsed.data.extId,
      limit: parsed.data.limit,
    });
  });

  // GET /api/v1/files/:id — 下载（private 仅 root/admin；public 任意已认证用户）
  app.get('/api/v1/files/:id', routeOptions, async (request, reply: FastifyReply) => {
    const identity = await authenticate(request);
    const { id } = request.params as { id: string };
    const { record, data } = await deps.service.read(id, { allowPrivate: canReadPrivate(identity.role) });
    reply.header('content-type', record.mime);
    reply.header('content-disposition', contentDispositionOf(record.origName));
    return reply.send(data);
  });

  // DELETE /api/v1/files/:id — 删除（admin/root）
  app.delete('/api/v1/files/:id', routeOptions, async (request) => {
    const identity = await authenticate(request);
    if (!canReadPrivate(identity.role)) {
      throw err('FORBIDDEN', {
        message: `file deletion requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
    const { id } = request.params as { id: string };
    await deps.service.remove(id);
    return { deleted: true };
  });
}
