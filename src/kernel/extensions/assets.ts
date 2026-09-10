/**
 * extensions/assets — 扩展 UI 静态资产挂载。
 *
 * 每个启用 UI 的扩展经 @fastify/static 注册一个独立实例：
 * - root: 扩展的 uiRoot 目录；prefix: `/ext/${extId}/ui/`；
 * - decorateReply: false —— 同一 app 上注册多实例必须关闭（reply.send decoration 只能一份）；
 * - index: 'index.html' —— 目录根（`/ext/{id}/ui/`）回退到 index.html（SPA/静态页入口；
 *   mount:'ui' 的 /admin 入口 302 落点即该前缀根，必须可达）；无 index.html 的目录照常 404；
 * - 未注册的 extId 天然没有对应前缀路由 → fastify notFound（404）。
 *
 * 路径安全（目录穿越防护）由 @fastify/static（@fastify/send 的 root 限制）保证。
 *
 * 缓存策略（v1）：此处不设长缓存/immutable 头（仅 hashed 文件名可安全长缓存，v1 的
 * 扩展 UI 文件名不保证带 hash）。统一 `Cache-Control: no-store` 由集成方在反向代理层
 * 对 /ext/&lt;extId&gt;/ui/ 前缀下发；@fastify/static 默认仅带 etag/last-modified 协商缓存。
 */
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { err } from '../errors/HarnessError.js';

/** 一个扩展的 UI 静态目录声明 */
export interface ExtAssetDir {
  extId: string;
  /** UI 资产根目录（磁盘绝对路径） */
  uiRoot: string;
}

/** 入参校验：extId 作为 URL 段禁止含路径分隔符等字符；uiRoot 非空 */
const EXT_ASSET_DIR_SCHEMA = z.object({
  extId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'extId 仅允许字母数字与 . _ -（作为 URL 段）'),
  uiRoot: z.string().min(1).max(4096),
});

/**
 * 为各扩展注册 UI 静态资产路由（同步入队 fastify 插件，ready 时生效）。
 * 单个声明非法（EXT_MANIFEST_INVALID）或 extId 重复（EXT_ROUTE_CONFLICT）时同步抛 HarnessError。
 */
export function registerExtAssets(app: FastifyInstance, dirs: ExtAssetDir[]): void {
  const seen = new Set<string>();
  for (const dir of dirs) {
    const parsed = EXT_ASSET_DIR_SCHEMA.safeParse(dir);
    if (!parsed.success) {
      throw err('EXT_MANIFEST_INVALID', {
        detail: { extId: dir.extId, uiRoot: dir.uiRoot, issues: parsed.error.issues },
      });
    }
    const { extId, uiRoot } = parsed.data;
    if (seen.has(extId)) {
      throw err('EXT_ROUTE_CONFLICT', { detail: { extId, reason: 'duplicate ui dir registration' } });
    }
    seen.add(extId);

    void app.register(fastifyStatic, {
      root: uiRoot,
      prefix: `/ext/${extId}/ui/`,
      decorateReply: false, // 多实例共存：reply decoration 只允许一份
      index: 'index.html', // 目录根回退 index.html（/admin 302 落点 /ext/{id}/ui/ 必须可达）
      setHeaders(reply, path) {
        // index.html 永远协商且不缓存：重编译后产物 hash 变化，旧壳缓存会引用已删除
        // 的资产文件（404 白屏）。带 hash 的静态资产保持默认 etag 协商即可。
        // 注意 @fastify/static 传入的是 Fastify Reply（非原生 res），用 reply.header()
        if (path.endsWith('.html')) reply.header('Cache-Control', 'no-cache');
      },
    });
  }
}
