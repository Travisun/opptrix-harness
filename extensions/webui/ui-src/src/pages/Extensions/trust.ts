/**
 * Extensions/trust — 扩展授信（trust）纯函数与契约常量（零依赖，可直接单测）。
 *
 * 与内核真值逐字段对齐（只读参照，不 import 内核代码）：
 * - src/kernel/errors/codes.ts        EXT_TRUST_REQUIRED → HARNESS-3012（status 403）；
 * - src/kernel/extensions/manager.ts  enable 信任闸：目录不受信且 trusted_at 为空 →
 *                                     403 EXT_TRUST_REQUIRED（detail 携带 id/permissions/
 *                                     confirmHint）；确认后 POST enable {confirmTrust:true}
 *                                     落库授信（trusted_at/trusted_by）并继续激活；
 * - src/kernel/extensions/manifest.ts PERMISSION_WHITELIST 权限白名单（白名单外一律拒绝）。
 */

// ---------------------------------------------------------------------------
// 信任闸错误识别（403 HARNESS-3012 / EXT_TRUST_REQUIRED）
// ---------------------------------------------------------------------------

/** 信任闸错误码（线上 HARNESS-3012；内核内部别名 EXT_TRUST_REQUIRED） */
export const TRUST_ERROR_CODES = ['HARNESS-3012', 'EXT_TRUST_REQUIRED'] as const;

/** ApiError 的最小结构视图（与 lib/api.ApiError 的 code/status/detail 字段对齐） */
export interface TrustApiErrorLike {
  code: string;
  status: number;
  detail?: unknown;
}

/** 信任闸命中判定：403 且 code 为 HARNESS-3012 / EXT_TRUST_REQUIRED（其他错误一律 false） */
export function isTrustRequired(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const candidate = e as Partial<TrustApiErrorLike>;
  return (
    candidate.status === 403 &&
    typeof candidate.code === 'string' &&
    (TRUST_ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}

/** 从信任闸错误的 detail 提取声明权限清单（detail.permissions 字符串数组；缺失/形状不符 → []） */
export function trustPermissions(e: unknown): string[] {
  if (typeof e !== 'object' || e === null) return [];
  const detail = (e as { detail?: unknown }).detail;
  if (typeof detail !== 'object' || detail === null) return [];
  const perms = (detail as { permissions?: unknown }).permissions;
  return Array.isArray(perms) ? perms.filter((p): p is string => typeof p === 'string') : [];
}

// ---------------------------------------------------------------------------
// 权限中文说明映射（与内核 manifest.ts PERMISSION_WHITELIST 全量对齐）
// ---------------------------------------------------------------------------

/**
 * 内核权限白名单镜像（src/kernel/extensions/manifest.ts PERMISSION_WHITELIST）。
 * 仅用于展示侧的映射完整性校验；权威判定始终在内核 validatePermissions。
 */
export const KNOWN_PERMISSIONS: readonly string[] = [
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
  'rpc:call',
  'auth:provider',
  'skills',
  'mcp:client',
  'plugins',
  'memory',
  'asr',
  'browser',
];

/** 精确权限 → 中文说明（含 task 约定的 secrets/files 展示别名；未知权限走 permissionLabel 兜底） */
export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  http: '网络请求',
  events: '事件总线',
  hooks: '生命周期钩子',
  cron: '定时任务',
  'notify:send': '发送通知',
  'notify:driver': '通知渠道驱动',
  'chat:write': '写入会话消息',
  'chat:bridge': '会话桥接',
  'files:read': '读取文件',
  'files:write': '写入文件',
  files: '文件访问',
  tasks: '后台任务',
  sandbox: '沙箱执行',
  llm: '模型调用',
  storage: '对象存储',
  db: '独立数据库',
  ui: '界面贡献',
  'net:out': '外发网络',
  'rpc:call': '跨扩展 RPC',
  'auth:provider': '认证提供方',
  skills: '技能库读取',
  'mcp:client': 'MCP 客户端调用',
  plugins: '插件目录读取',
  memory: '全局记忆',
  asr: '语音识别',
  browser: '浏览器自动化',
  secrets: '凭据读取',
};

/** 权限 → 中文说明：精确命中映射；net:out:<domain> / rpc:call:<id> 按前缀带参说明；其余兜底「其他权限」 */
export function permissionLabel(p: string): string {
  const exact = PERMISSION_LABELS[p];
  if (exact !== undefined) return exact;
  if (p.startsWith('net:out:')) return `外发网络（${p.slice('net:out:'.length)}）`;
  if (p.startsWith('rpc:call:')) return `跨扩展 RPC（定向 ${p.slice('rpc:call:'.length)}）`;
  return '其他权限';
}

// ---------------------------------------------------------------------------
// 信任状态与内置锁定名单
// ---------------------------------------------------------------------------

/** 扩展信任状态：builtin = 受信第一方池；trusted = 第三方已人工授信；untrusted = 待授信 */
export type ExtTrustStatus = 'builtin' | 'trusted' | 'untrusted';

/** trustStatus 的入参最小视图（ExtSummary / ExtensionInstallResponse 的相关字段） */
export interface TrustStatusExtLike {
  builtin?: boolean;
  host?: 'builtin' | 'community';
  /** 第三方扩展人工授信时间（epoch ms）；受信第一方恒为 null（内核 ExtSummary.trustedAt） */
  trustedAt?: number | null;
}

/** 信任状态判定：builtin 池（builtin 声明或 host='builtin'）→ 'builtin'；trustedAt>0 → 'trusted'；否则 'untrusted' */
export function trustStatus(ext: TrustStatusExtLike): ExtTrustStatus {
  if (ext.builtin === true || ext.host === 'builtin') return 'builtin';
  return typeof ext.trustedAt === 'number' && ext.trustedAt > 0 ? 'trusted' : 'untrusted';
}

/** 信任状态 → 徽标文案（builtin=内置 / trusted=已授信 / untrusted=未授信） */
export function trustStatusLabel(status: ExtTrustStatus): string {
  if (status === 'builtin') return '内置';
  return status === 'trusted' ? '已授信' : '未授信';
}

/** 系统内置锁定名单（manifest.builtin=true 且挂受信目录的第一方扩展，内核拒绝 disable/uninstall） */
export const BUILTIN_LOCKED_EXTS: readonly string[] = ['auth', 'webui', 'doc-extract'];

/** 内置锁定判定：名单内的系统内置扩展不可禁用或卸载（与内核 core-builtin 保护一致） */
export function isBuiltinLockedExt(extId: string): boolean {
  return (BUILTIN_LOCKED_EXTS as readonly string[]).includes(extId);
}
