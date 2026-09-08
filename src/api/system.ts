/**
 * system — 内核系统 API（/api/v1/system/*）。
 *
 * - GET  /api/v1/system/info    内核运行时信息（含 counters 快照）
 * - GET  /api/v1/system/doctor  环境体检（doctor.runDoctor）
 * - POST /api/v1/system/backup  数据库备份（未注入 runDbBackup 时 501 NOT_IMPLEMENTED）
 * - GET  /api/v1/system/openapi OpenAPI 文档位置（指向 /api/v1/openapi.json）
 *
 * 约定：
 * - 全部路由前置统一鉴权（Authorization: Bearer 或 ?token=，由 extractToken 提取，
 *   checker 校验失败抛 HarnessError UNAUTHORIZED → 401 HARNESS-1006）；
 * - 计数：onResponse 钩子内对 /api/v1 前缀请求 inc('api.requests', { route })；
 * - 这些路由不接收外部 body/query 业务入参，无需 zod schema（token 提取本身已做类型收窄）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { extractToken } from '../kernel/auth/authProxy.js';
import type { AuthIdentity, AuthVerifyInput } from '../kernel/auth/types.js';
import type { HarnessConfig } from '../kernel/config/index.js';
import { err } from '../kernel/errors/HarnessError.js';
import { runDoctor } from '../kernel/system/doctor.js';
import type { Counters } from '../kernel/system/info.js';

/** 内核版本（与 package.json / OpenAPI info.version 对齐；刻意用常量避免构建期路径依赖） */
const VERSION = '0.1.0';

/** 数据库备份执行器（由存储模块注入内核后传入；未注入时 backup 端点返回 501） */
export type RunDbBackup = (cfg: HarnessConfig) => Promise<{ path: string; sizeBytes: number }>;

/** POST /api/v1/system/backup 成功时的返回体 */
export interface BackupInfo {
  /** 备份文件绝对/相对路径（由执行器决定） */
  path: string;
  /** 备份文件大小（字节） */
  sizeBytes: number;
  /** 备份完成时间（UTC ISO8601） */
  createdAt: string;
}

/** registerSystemRoutes 依赖集合 */
export interface SystemRoutesDeps {
  config: HarnessConfig;
  /** 统一认证入口（authProxy.createAuthChecker 的产物） */
  checker: (input: AuthVerifyInput) => Promise<AuthIdentity>;
  /** 进程内计数器 */
  counters: Counters;
  /** 可选的数据库备份执行器 */
  runDbBackup?: RunDbBackup;
}

/**
 * 向 Fastify 实例注册系统 API 路由与请求计数钩子。
 * 必须在 app.ready() 之前调用（路由注册期）；幂等性由调用方保证（重复注册会因路由冲突抛错）。
 */
export function registerSystemRoutes(app: FastifyInstance, deps: SystemRoutesDeps): void {
  const { config, checker, counters } = deps;

  // 统一鉴权：Bearer / ?token= 提取后交 checker；失败抛 HarnessError → 401
  const authenticate = async (request: FastifyRequest): Promise<AuthIdentity> => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    return checker({ token: extractToken(request.headers, query), headers: request.headers });
  };

  // 计数钩子：先于路由注册添加（同作用域内先 addHook 后定义路由才能命中）。
  // 仅统计 /api/v1 前缀；route 取路由模板（404 无模板时退回去掉 query 的原始路径）。
  app.addHook('onResponse', async (request) => {
    const rawUrl = request.raw.url ?? request.url;
    const qIdx = rawUrl.indexOf('?');
    const pathOnly = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    if (!pathOnly.startsWith('/api/v1')) return;
    counters.inc('api.requests', { route: request.routeOptions.url ?? pathOnly });
  });

  app.get('/api/v1/system/info', { schema: { tags: ['system'] } }, async (request) => {
    await authenticate(request);
    return {
      name: 'opptrix-harness',
      env: config.env,
      version: VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      node: process.versions.node,
      timezone: config.timezone,
      state: 'ready',
      counters: counters.snapshot(),
    };
  });

  app.get('/api/v1/system/doctor', { schema: { tags: ['system'] } }, async (request) => {
    await authenticate(request);
    return runDoctor(config);
  });

  app.post('/api/v1/system/backup', { schema: { tags: ['system'] } }, async (request) => {
    const identity = await authenticate(request);
    // SEC-6：备份导出整库——仅 root/admin 可触发（normal 角色一律 403）
    if (identity.role !== 'root' && identity.role !== 'admin') {
      throw err('FORBIDDEN', {
        message: 'database backup requires role admin or root',
        detail: { role: identity.role },
      });
    }
    if (deps.runDbBackup === undefined) {
      throw err('NOT_IMPLEMENTED', {
        detail:
          'database backup is not wired into this kernel (no storage module installed) — ' +
          'provide runDbBackup when registering system routes to enable this endpoint',
      });
    }
    const { path, sizeBytes } = await deps.runDbBackup(config);
    const info: BackupInfo = { path, sizeBytes, createdAt: new Date().toISOString() };
    return info;
  });

  app.get('/api/v1/system/openapi', { schema: { tags: ['system'] } }, async (request) => {
    await authenticate(request);
    return { url: '/api/v1/openapi.json' };
  });
}
