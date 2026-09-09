/**
 * manifest — 扩展 manifest（package.json 同目录的 manifest 形状）zod schema 与校验。
 *
 * 内核在发现扩展目录后、激活前调用：
 * 1. `validateManifest(raw)`：结构 + 字段校验（失败 EXT_MANIFEST_INVALID，detail 携带 zod issues）；
 * 2. `checkApiCompat(m)`：扩展 API 版本必须落在 SUPPORTED_API_VERSIONS（否则 EXT_API_INCOMPATIBLE）；
 * 3. `validatePermissions(m)`：权限必须在白名单内（未知权限 → EXT_MANIFEST_INVALID）。
 *
 * 权限清单（白名单外的权限一律拒绝，禁止扩展自造）：
 * http / events / hooks / cron / notify:send / notify:driver / chat:write / chat:bridge /
 * files:read / files:write / tasks / sandbox / llm / storage / db / ui / auth:provider /
 * skills（技能库读面：skills.list/get/refresh；skills.register 贡献免权限——按调用方
 * extId 记名、禁用即摘除）/ mcp:client（扩展桥的 MCP 客户端调用：tools/resources/prompts）/
 * plugins（插件目录读面：plugins.list）/ rpc:call（跨扩展 RPC 全量）或 rpc:call:<id>
 * （定向目标扩展）/ net:out（泛域名出口）或 net:out:<domain>（精确域名出口）。
 */
import { basename } from 'node:path';

import semver from 'semver';
import { z } from 'zod';

import { err } from '../errors/index.js';

/** 当前内核支持的扩展 API 版本（破坏性变更时递增并保留迁移窗口） */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

/** 扩展 ui 贡献（webui 菜单 / 页面 / 小部件 / 自定义渲染器） */
const uiSchema = z
  .object({
    menu: z.object({ label: z.string(), icon: z.string().optional() }).optional(),
    pages: z
      .array(z.object({ path: z.string(), title: z.string(), entry: z.string() }))
      .default([]),
    widgets: z
      .array(z.object({ id: z.string(), title: z.string(), entry: z.string() }))
      .default([]),
    renderers: z.array(z.string()).default([]),
  })
  .optional();

/** 扩展 manifest schema（所有默认值即"约定优于配置"的落点） */
export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** 扩展 API 版本，当前内核支持 [1] */
  api: z.number().int(),
  /** semver（如 1.2.3） */
  version: z
    .string()
    .refine((v) => semver.valid(v) !== null, { error: 'version must be valid semver (e.g. "1.2.3")' }),
  main: z.string().default('index.js'),
  displayName: z.string().optional(),
  /** 见本文件头部的权限清单 */
  permissions: z.array(z.string()).default([]),
  /** 服务声明 'extId.service' */
  provides: z.array(z.string()).default([]),
  /** 硬依赖（缺失→拒绝激活 EXT_DEPENDENCY_MISSING，由激活编排检查） */
  requires: z.array(z.string()).default([]),
  requiresOptional: z.array(z.string()).default([]),
  routes: z.boolean().default(true),
  uninstall: z.enum(['keep', 'purge']).default('keep'),
  builtin: z.boolean().default(false),
  /** builtin mount 白名单: 'auth'|'ui' */
  mount: z.string().optional(),
  ui: uiSchema,
});

export type ExtensionManifest = z.infer<typeof manifestSchema>;

/**
 * 校验并规整 manifest 原始数据。
 * 失败抛 `err('EXT_MANIFEST_INVALID')`，detail 为 zod issues（含路径与原因，面向扩展开发者可操作）。
 */
export function validateManifest(raw: unknown): ExtensionManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw err('EXT_MANIFEST_INVALID', { detail: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * 扩展 API 版本兼容检查。
 * manifest.api 不在 SUPPORTED_API_VERSIONS 内 → `err('EXT_API_INCOMPATIBLE')`。
 */
export function checkApiCompat(m: ExtensionManifest): void {
  if (!SUPPORTED_API_VERSIONS.includes(m.api)) {
    throw err('EXT_API_INCOMPATIBLE', {
      detail: { manifestApi: m.api, supported: [...SUPPORTED_API_VERSIONS] },
    });
  }
}

/** 固定权限白名单（精确匹配项） */
const PERMISSION_WHITELIST: ReadonlySet<string> = new Set([
  'http',
  'events',
  'hooks',
  'cron',
  'notify:send',
  'notify:driver',
  'chat:write',
  'chat:bridge',
  'files:read',
  'files:write',
  'tasks',
  'sandbox',
  'llm',
  'storage',
  'db',
  'ui',
  'net:out',
  // 跨扩展 RPC（ExtensionServiceRegistry.resolveCaller 的运行时权限门同款键）：
  // 'rpc:call'（全量）或 'rpc:call:<targetExtId>'（定向）
  'rpc:call',
  // auth 内置扩展专用：内核 scrypt 密码哈希 + AuthProvider 注册（auth.* topics 与 host.authVerify）
  'auth:provider',
  // skills 技能库读面（skills.list/get/refresh；skills.register 贡献面免权限——按调用方
  // extId 记名、扩展禁用即由内核摘除，见 core-services 桥工厂的权限闸注释）
  'skills',
  // 扩展桥的 MCP 客户端调用（mcp.servers.list / mcp.tools.* 桥 topics 的统一权限闸）
  'mcp:client',
  // 插件目录读面（plugins.list 桥 topic）
  'plugins',
]);

/** net:out:<domain> 的域名形状（hostname：点分字母数字连字符段，允许单段如 localhost） */
const NET_OUT_DOMAIN_RE =
  /^net:out:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/** rpc:call:<id> 的目标扩展 id 段形状（与 manifest id 同规则：小写字母数字与 . _ -） */
const RPC_CALL_TARGET_RE = /^rpc:call:[a-z0-9][a-z0-9._-]*$/;

function isKnownPermission(p: string): boolean {
  return PERMISSION_WHITELIST.has(p) || NET_OUT_DOMAIN_RE.test(p) || RPC_CALL_TARGET_RE.test(p);
}

/**
 * 权限白名单校验。
 * 存在白名单外权限 → `err('EXT_MANIFEST_INVALID')`，detail 列出全部未知权限（一次说清，别挤牙膏）。
 */
export function validatePermissions(m: ExtensionManifest): void {
  const unknown = m.permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length > 0) {
    throw err('EXT_MANIFEST_INVALID', {
      detail: {
        issues: [
          {
            path: ['permissions'],
            message: `unknown permission(s): ${unknown.join(', ')}; allowed: fixed list, rpc:call[:<extId>] or net:out:<domain>`,
            unknownPermissions: unknown,
          },
        ],
      },
    });
  }
}

/**
 * 从扩展目录路径推导扩展 id（目录名即 id）。
 * 例：'/data/extensions/hello-world' → 'hello-world'（容忍结尾斜杠）。
 */
export function extIdFromDir(dir: string): string {
  return basename(dir);
}
