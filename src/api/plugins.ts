/**
 * plugins — 插件包管理 REST API（/api/v1/plugins*，全部 admin/root）。
 *
 * 路由：
 * - GET    /api/v1/plugins            已安装插件列表（registry.list()；boot/安装/refresh 后更新）
 * - POST   /api/v1/plugins/install    安装 zip 包（multipart/form-data 单文件，field 名 `file`，
 *                                    ≤64MB）→ 201 InstalledPlugin；随后自动 refresh 聚合注入。
 *                                    `?overwrite=1` 覆盖安装。同 id 已装且未 overwrite → 400
 *                                    BAD_REQUEST（'plugin id already installed, use overwrite'）
 * - GET    /api/v1/plugins/:id        单个插件摘要；不存在 → 404 HARNESS-3004
 * - DELETE /api/v1/plugins/:id        卸载；插件有贡献在用（skills/MCP 注入）时必须
 *                                    `?force=1`（先摘贡献再删目录），否则 403 HARNESS-1007
 * - POST   /api/v1/plugins/refresh    重新扫描聚合 `<dataDir>/plugins/` → { plugins: [...] }
 *
 * 约定：
 * - 鉴权：token 经 extractToken（Authorization: Bearer 优先，其次 ?token=）交 deps.checker；
 *   role 非 'root'|'admin' → 403 HARNESS-1007；
 * - multipart 用 @fastify/multipart 流式 API 手动计量（同 files 路由），超 64MB → 413
 *   HARNESS-1005；非 multipart → 400 HARNESS-1008；
 * - deps.installerZip 两种形态皆可（按 `fn.length` 区分）：
 *   - 原始形态：`installPluginZip(cfg, zipPath, opts?)`（length>=2 自动以
 *     `registry.dataDir` 绑定 cfg；`?overwrite=1` 全语义可用）；
 *   - 绑定形态：`(zipPath) => InstalledPlugin`（单参箭头包装；此时 `?overwrite=1`
 *     不生效，重复安装会得到 400 的引导性 BAD_REQUEST）。
 *   注意：不要用 `.bind(null, cfg)`（length 归零会被误判为绑定形态）；绑定请用单参箭头。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../kernel/auth/authProxy.js';
import { err, HarnessError } from '../kernel/errors/index.js';
import type { InstalledPlugin, PluginRegistry } from '../kernel/plugins/index.js';

/** 插件 zip 上传大小上限（64MB） */
export const MAX_PLUGIN_ZIP_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** 已绑定的 zip 安装器：单参（首参即 zipPath）；?overwrite=1 在此形态下不生效（见头注释） */
export type PluginZipInstallerBound = (zipPath: string) => Promise<InstalledPlugin>;

/** 原始 installPluginZip 形态（length >= 2，自动以 registry.dataDir 绑定首参） */
export type PluginZipInstallerRaw = (
  cfg: { dataDir: string },
  zipPath: string,
  opts?: { overwrite?: boolean },
) => Promise<InstalledPlugin>;

/** registerPluginRoutes 依赖集合 */
export interface PluginRoutesDeps {
  /**
   * 统一认证入口（authProxy.createAuthChecker 的产物）。
   * 校验失败应抛 HarnessError(UNAUTHORIZED) → 401；返回 role 非 'root'|'admin'
   * 时本模块抛 FORBIDDEN → 403。
   */
  checker: (input: {
    token?: string;
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ role: string }>;
  /** 插件注册中心（list/get/remove/refresh 的落点） */
  registry: PluginRegistry;
  /**
   * zip 安装器：原始 installPluginZip（length>=2，自动绑定 dataDir）或
   * 单参绑定形态 (zipPath) => InstalledPlugin。见模块头注释。
   */
  installerZip: PluginZipInstallerBound | PluginZipInstallerRaw;
  /** 上传大小上限（字节）；缺省 64MB */
  maxZipBytes?: number;
}

// ---------------------------------------------------------------------------
// zod schema
// ---------------------------------------------------------------------------

/** install 查询参数：overwrite=1|true 覆盖安装 */
const installQuerySchema = z.object({
  overwrite: z.enum(['1', 'true']).optional(),
});

/** DELETE 查询参数：force=1|true 强制卸载 */
const deleteQuerySchema = z.object({
  force: z.enum(['1', 'true']).optional(),
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

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
        message: `uploaded plugin zip exceeds the ${maxBytes} byte limit`,
        detail: { limit: maxBytes },
      });
    }
    chunks.push(buf);
  }
  if ((part.file as { truncated?: boolean }).truncated === true || size > maxBytes) {
    throw err('PAYLOAD_TOO_LARGE', {
      message: `uploaded plugin zip exceeds the ${maxBytes} byte limit`,
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
      message: 'request must be multipart/form-data with a single "file" field containing a plugin zip',
      detail: [{ code, message: e instanceof Error ? e.message : String(e) }],
      cause: e,
    });
  }
  if (e instanceof Error) return e;
  return new Error(String(e));
}

// ---------------------------------------------------------------------------
// 路由注册
// ---------------------------------------------------------------------------

/**
 * 向 Fastify 实例注册插件管理 API 路由（全部 admin/root）。
 * 必须在 app.ready() 之前调用（路由注册期）；重复注册会因路由冲突抛错。
 */
export function registerPluginRoutes(app: FastifyInstance, deps: PluginRoutesDeps): void {
  // multipart 内容类型解析器（流式：request.file() 时才解析）
  void app.register(multipart);

  const maxZipBytes = deps.maxZipBytes ?? MAX_PLUGIN_ZIP_BYTES;

  /** installerZip 双形态归一化：length>=2 视为原始 installPluginZip(cfg, zipPath, opts)；绑定形态单参（丢弃 opts，见头注释） */
  const installZip = (zipPath: string, opts: { overwrite?: boolean }): Promise<InstalledPlugin> => {
    const fn = deps.installerZip;
    if (fn.length >= 2) {
      return (fn as PluginZipInstallerRaw)({ dataDir: deps.registry.dataDir }, zipPath, opts);
    }
    return (fn as PluginZipInstallerBound)(zipPath);
  };

  /** 统一鉴权 + admin 门禁（root 放行） */
  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const identity = await deps.checker({
      token: extractToken(request.headers, query),
      headers: request.headers,
    });
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: `plugin management requires role admin or root (got "${identity.role}")`,
        detail: { role: identity.role },
      });
    }
  };

  const routeOptions = { schema: { tags: ['plugins'] } };

  // GET /api/v1/plugins — 已安装插件列表
  app.get('/api/v1/plugins', routeOptions, async (request) => {
    await requireAdmin(request);
    return deps.registry.list();
  });

  // POST /api/v1/plugins/install — 上传 zip 安装（field 'file'，≤64MB）→ 201
  app.post('/api/v1/plugins/install', routeOptions, async (request, reply) => {
    await requireAdmin(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsedQuery = installQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      throw err('VALIDATION_FAILED', { detail: parsedQuery.error.issues });
    }

    let part: FilePart | undefined;
    try {
      part = await request.file({
        throwFileSizeLimit: false,
        limits: { fileSize: maxZipBytes + 1, files: 1, fields: 8, parts: 16 },
      });
    } catch (e) {
      throw mapMultipartError(e);
    }
    if (part === undefined) {
      throw err('BAD_REQUEST', { message: 'multipart body with a "file" field (plugin zip) is required' });
    }
    if (!part.filename.toLowerCase().endsWith('.zip')) {
      throw err('VALIDATION_FAILED', {
        message: 'plugin package must be a .zip file (field "file")',
        detail: { filename: part.filename },
      });
    }

    const data = await consumeFilePart(part, maxZipBytes);
    // 落临时文件后交安装器（installer 以路径为入参），finally 清理
    const stagingDir = await mkdtemp(path.join(tmpdir(), 'opptrix-plugin-upload-'));
    const zipPath = path.join(stagingDir, `plugin-${randomUUID()}.zip`);
    try {
      await writeFile(zipPath, data);
      const plugin = await installZip(zipPath, { overwrite: parsedQuery.data.overwrite !== undefined });
      await deps.registry.refresh(); // 安装即聚合注入（扩展贡献立即可用）
      reply.code(201);
      return plugin;
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  });

  // GET /api/v1/plugins/:id — 单个插件摘要
  app.get('/api/v1/plugins/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const plugin = deps.registry.get(id);
    if (plugin === undefined) {
      throw err('EXT_NOT_FOUND', { message: `plugin "${id}" is not installed`, detail: { id } });
    }
    return plugin;
  });

  // DELETE /api/v1/plugins/:id — 卸载（?force=1 摘贡献并删目录）
  app.delete('/api/v1/plugins/:id', routeOptions, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const parsed = deleteQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    await deps.registry.remove(id, { force: parsed.data.force !== undefined });
    return { deleted: true };
  });

  // POST /api/v1/plugins/refresh — 重新扫描聚合（内核升级 / 手工放包后调用）
  app.post('/api/v1/plugins/refresh', routeOptions, async (request) => {
    await requireAdmin(request);
    const plugins = await deps.registry.refresh();
    return { plugins };
  });
}
