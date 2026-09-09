/**
 * extract — 文件内容提取 REST API（/api/v1/extract*）。
 *
 * 路由：
 * - POST /api/v1/extract            提取（已认证任意角色）。二选一：
 *                                   ① multipart/form-data 单文件（field 'file'，≤ maxFileBytes，
 *                                   缺省 100MB，临时提取不落 files 表）；
 *                                   ② query fileId（引用已上传文件；private 仅 root/admin）
 *                                   → 200 ExtractResult（text ≤8MB，超限截断并标 truncated:true）
 * - POST /api/v1/extract/file/:id   提取已上传文件并把全文存 file_extracts（惰性建表，重复提取覆盖；
 *                                   private 仅 root/admin）→ 200 ExtractResult & { fileId, stored: true }
 * - GET  /api/v1/extract/status     OCR 模型状态（downloaded / downloading(pct) / not-downloaded / error）
 *
 * 约定：
 * - 鉴权经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 * - multipart 流式计量：超过 maxFileBytes 立即销毁流并抛 HARNESS-1005 PAYLOAD_TOO_LARGE；
 * - 文本内容问题（损坏/不支持/OCR 未就绪）不报错——ExtractResult.warnings / needsOcr 表达；
 * - @fastify/multipart 已由 files.ts 注册时复用（按 request decorator 探测，避免重复注册）。
 */
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err } from '../kernel/errors/index.js';
import type { FileService } from '../kernel/files/service.js';
import type { FileExtractService } from '../kernel/fileextract/service.js';
import { EXTRACT_TEXT_MAX_BYTES } from '../kernel/fileextract/types.js';

/** extract 路由上传上限缺省值：100MB */
export const DEFAULT_MAX_EXTRACT_BYTES = 100 * 1024 * 1024;

/** registerExtractRoutes 依赖集合 */
export interface ExtractRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 文件提取服务 */
  service: FileExtractService;
  /** 文件服务（fileId 引用路径；private 读取的角色门禁在此裁决） */
  files: FileService;
  /** multipart 上传提取的大小上限（字节），缺省 100MB */
  maxFileBytes?: number;
}

/** POST /extract 查询参数 */
const extractQuerySchema = z.object({
  fileId: z.string().min(1).max(128).optional(),
  ocr: z.enum(['auto', 'never', 'always']).optional(),
  deep: z.enum(['true', 'false']).optional(),
});

/** 响应文本截断：> maxBytes 时按 UTF-8 字节近似收缩到限内 */
function truncateText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, truncated: false };
  }
  let cut = text.length;
  while (cut > 0 && Buffer.byteLength(text.slice(0, cut), 'utf8') > maxBytes) {
    cut = Math.floor(cut * 0.95);
  }
  return { text: text.slice(0, cut), truncated: true };
}

/** request.file() 的返回类型（@fastify/multipart 对 FastifyRequest 的增强） */
type FilePart = NonNullable<Awaited<ReturnType<FastifyRequest['file']>>>;

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
        message: `uploaded file exceeds extract max bytes ${maxBytes}`,
        detail: { limit: maxBytes },
      });
    }
    chunks.push(buf);
  }
  if ((part.file as { truncated?: boolean }).truncated === true || size > maxBytes) {
    throw err('PAYLOAD_TOO_LARGE', {
      message: `uploaded file exceeds extract max bytes ${maxBytes}`,
      detail: { limit: maxBytes },
    });
  }
  return Buffer.concat(chunks);
}

/** multipart 解析类异常 → 400 BAD_REQUEST（其余原样上抛交全局兜底） */
function mapMultipartError(e: unknown): Error {
  if (e instanceof Error && typeof (e as { code?: string }).code === 'string' && (e as { code?: string }).code?.startsWith('FST_')) {
    return err('BAD_REQUEST', {
      message: 'request must be multipart/form-data with a single "file" field',
      detail: [{ code: (e as { code?: string }).code, message: e.message }],
      cause: e,
    });
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * 向 Fastify 实例注册文件提取 API 路由。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerExtractRoutes(app: FastifyInstance, deps: ExtractRoutesDeps): void {
  // multipart 复用探测：files.ts 已在同一 app 注册过时跳过（@fastify/multipart 为 fastify-plugin，
  // 重复 register 会重复添加 decorator 报错）
  if (!app.hasRequestDecorator('file')) {
    void app.register(multipart);
  }

  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_EXTRACT_BYTES;

  /** 已认证身份获取（Authorization: Bearer 优先，其次 ?token=） */
  const authenticate = async (request: FastifyRequest): Promise<{ role: string }> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
  };

  /** private 文件的提取权限：仅 root/admin（与 GET /api/v1/files/:id 同一口径） */
  const canReadPrivate = (role: string): boolean => role === 'root' || role === 'admin';

  /** 解析公共 query（fileId/ocr/deep）；失败 → VALIDATION_FAILED */
  const parseQuery = (request: FastifyRequest) => {
    const parsed = extractQuerySchema.safeParse((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    return parsed.data;
  };

  const routeOptions = { schema: { tags: ['extract'] } };

  // POST /api/v1/extract — multipart 上传直提 或 ?fileId= 引用已上传文件
  app.post('/api/v1/extract', routeOptions, async (request) => {
    const identity = await authenticate(request);
    const query = parseQuery(request);
    const opts = {
      ...(query.ocr !== undefined ? { ocr: query.ocr } : {}),
      ...(query.deep !== undefined ? { deep: query.deep === 'true' } : {}),
    };

    if (query.fileId !== undefined) {
      // 引用已上传文件：private 门禁与文件下载同口径
      if (!canReadPrivate(identity.role)) {
        // 先探 visibility（normal 角色对 private 文件 403，而非默默按 public 处理）
        const record = await deps.files.get(query.fileId);
        if (record.visibility === 'private') {
          throw err('FORBIDDEN', {
            message: `file "${query.fileId}" is private (readable by admin/root only)`,
            detail: { fileId: query.fileId, visibility: record.visibility },
          });
        }
      }
      const result = await deps.service.extract({ fileId: query.fileId }, opts);
      const { text, truncated } = truncateText(result.text, EXTRACT_TEXT_MAX_BYTES);
      return { ...result, text, truncated };
    }

    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw err('BAD_REQUEST', {
        message: 'provide a multipart "file" field or a ?fileId= query referencing an uploaded file',
      });
    }

    let part: FilePart | undefined;
    try {
      part = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: maxFileBytes + 1, files: 1, fields: 20, parts: 100 },
      });
    } catch (e) {
      throw mapMultipartError(e);
    }
    if (part === undefined) {
      throw err('BAD_REQUEST', { message: 'multipart body with a "file" field is required' });
    }
    const data = await consumeFilePart(part, maxFileBytes);
    const result = await deps.service.extract(
      { data, name: part.filename, mime: part.mimetype },
      opts,
    );
    const { text, truncated } = truncateText(result.text, EXTRACT_TEXT_MAX_BYTES);
    return { ...result, text, truncated };
  });

  // POST /api/v1/extract/file/:id — 提取 + 持久化 file_extracts（重复提取覆盖）
  app.post('/api/v1/extract/file/:id', routeOptions, async (request) => {
    const identity = await authenticate(request);
    const query = parseQuery(request);
    const { id } = request.params as { id: string };
    if (!canReadPrivate(identity.role)) {
      const record = await deps.files.get(id);
      if (record.visibility === 'private') {
        throw err('FORBIDDEN', {
          message: `file "${id}" is private (readable by admin/root only)`,
          detail: { fileId: id, visibility: record.visibility },
        });
      }
    }
    const result = await deps.service.extractFile(id, {
      ...(query.ocr !== undefined ? { ocr: query.ocr } : {}),
      ...(query.deep !== undefined ? { deep: query.deep === 'true' } : {}),
    });
    const { text, truncated } = truncateText(result.text, EXTRACT_TEXT_MAX_BYTES);
    return { ...result, text, truncated, stored: true as const };
  });

  // GET /api/v1/extract/status — OCR 模型状态
  app.get('/api/v1/extract/status', routeOptions, async (request) => {
    await authenticate(request);
    return deps.service.status();
  });
}
