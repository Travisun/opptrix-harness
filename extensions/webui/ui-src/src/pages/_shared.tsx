/**
 * _shared — 页面包（W2-W4）内部共享的 REST 类型视图、纯函数工具与最小 JSX 组件。
 *
 * 刻意只依赖 lib/api、components/ui 与 features 的公开面，不反向依赖任何页面；
 * 全部页面（含 W4 的 Users/ApiKeys/Logs）统一从 '@/pages/_shared' 导入，避免跨包冲突。
 */
import { useCallback, useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { api, getToken } from '@/lib/api';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// REST 形状（与内核 src/api/*.ts、auth 扩展契约逐字段对齐的最小视图）
// ---------------------------------------------------------------------------

/** GET /api/v1/auth/me 响应（api.ts MeResult 的共享视图） */
export interface MeInfo {
  userId: string;
  username: string | null;
  role: string;
  scopes: string[];
  tokenType: string;
}

/** GET /api/v1/users 条目（auth 扩展 authPublicUser） */
export interface UserRow {
  id: string;
  username: string;
  role: string;
  createdAt: number;
}

/** GET /api/v1/auth/api-keys 条目（auth 扩展；永不携带令牌） */
export interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: number | null;
  revoked: boolean;
  createdAt: number;
}

/** POST /api/v1/auth/api-keys 响应（明文令牌仅本次返回一次） */
export interface ApiKeyCreated {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  expiresAt: number | null;
  createdAt: number;
}

/** GET /api/v1/system/logs 条目（内核 SystemLogEntry） */
export interface LogEntry {
  /** UTC epoch ms */
  ts: number;
  /** pino 级别名（info/warn/error/…） */
  level: string;
  /** 日志 scope（缺省 ''） */
  scope: string;
  message: string;
  /** 附加字段（结构化 JSON；损坏或无附加字段为 null） */
  data: unknown;
}

/** GET /api/v1/system/doctor 的单项检查（内核 DoctorCheck） */
export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** GET /api/v1/system/doctor 响应（内核 DoctorReport） */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** GET /api/v1/extensions 条目（内核 ExtSummary） */
export interface ExtSummary {
  id: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  host: 'builtin' | 'community';
  mount: string | null;
  manifest?: {
    id?: string;
    version?: string;
    displayName?: string;
    permissions?: string[];
    provides?: string[];
    requires?: string[];
    builtin?: boolean;
    mount?: string;
  };
  contributions?: { routes: number; crons: number; events: number; hooks: number; services: number };
  dir?: string;
  crashCount: number;
  lastError: string | null;
}

/** GET /api/v1/extensions/routes 条目（内核 ExtRouteTableEntry） */
export interface ExtRouteTableEntry {
  extId: string;
  method: string;
  path: string;
  auth: 'public' | 'user' | 'admin';
  scope?: string;
  timeoutMs?: number;
}

/** GET /api/v1/extensions/registry 条目（内核 ServiceEntry） */
export interface ServiceEntry {
  extId: string;
  service: string;
  methods: string[];
  status: 'active' | 'suspended';
}

/** GET /api/v1/ui 条目（内核 UiSnapshotEntry） */
export interface UiSnapshotEntry {
  extId: string;
  menu?: { label: string; icon?: string };
  pages: Array<{ path: string; title: string; entry: string }>;
  widgets: Array<{ id: string; title: string; entry: string }>;
  renderers: string[];
}

/** GET /api/v1/cron 条目（内核 CronJobRecord；时间均为 UTC epoch ms） */
export interface CronJobRecord {
  id: string;
  extId: string | null;
  name: string;
  expr: string;
  tz: string;
  payload: unknown;
  enabled: boolean;
  overlap: 'skip' | 'queue';
  misfire: 'skip' | 'runOnce';
  lastRun: number | null;
  nextRun: number | null;
  createdAt: number;
}

/** GET /api/v1/cron/:id/history 条目（内核 CronRunEntry） */
export interface CronRunEntry {
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  durationMs: number | null;
  error: string | null;
}

/** GET /api/v1/notifications 条目（内核 NotificationRecord） */
export interface NotificationRecord {
  id: string;
  level: string;
  title: string;
  body: string;
  data?: unknown;
  channels?: string[] | null;
  readAt?: number | null;
  createdAt: number;
}

/** PUT /api/v1/notifications/routes 的规则形状（内核 routeRuleSchema） */
export interface NotificationRouteRule {
  match: { level?: string };
  channels: Array<{ driver: string; target: unknown }>;
}

/** GET /api/v1/notifications/drivers 响应 */
export interface NotificationDrivers {
  notification: string[];
  chat: string[];
}

/** GET /api/v1/files 条目（内核 FileRecord） */
export interface FileRecord {
  id: string;
  extId: string | null;
  origName: string;
  mime: string;
  size: number;
  path: string;
  visibility: 'private' | 'public';
  createdAt: number;
}

/** GET /api/v1/tasks 条目（内核 TaskRecord） */
export interface TaskRecord {
  id: string;
  extId: string;
  name: string;
  args: unknown;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  progressMsg: string | null;
  result: unknown;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** GET /api/v1/sandbox/workspaces 条目（内核 WorkspaceInfo） */
export interface WorkspaceInfo {
  id: string;
  containerId: string | null;
  image: string;
  networkMode: 'bridge' | 'none';
  status: 'creating' | 'running' | 'stopped' | 'error';
  homeDir: string;
  createdAt: number;
  lastActiveAt: number;
}

/** POST /api/v1/sandbox/workspaces/:id/exec 响应（内核 SandboxExecResult） */
export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** GET /api/v1/sandbox/workspaces/:id/files?list=1 条目 */
export interface SandboxFileEntry {
  name: string;
  size: number;
  dir: boolean;
}

/** GET /api/v1/system/update 响应（内核 UpdateCheckResult） */
export interface UpdateCheckResult {
  currentVersion: string | null;
  available: { channel: 'stable' | 'beta'; version: string; url: string; sha256: string; notes?: string } | null;
  feedOk: boolean;
  error?: string;
}

/** GET /api/v1/system/update/history 条目（内核 UpdateHistoryEntry） */
export interface UpdateHistoryEntry {
  version: string;
  appliedAt: number;
  ok: boolean;
}

/** LLM 协议枚举（内核 src/api/llm.ts LLM_PROTOCOLS） */
export const LLM_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages'] as const;
export type LlmProtocol = (typeof LLM_PROTOCOLS)[number];

/** GET/PUT /api/v1/llm/providers 条目（内核 providerConfigSchema；密钥二选一） */
export interface LlmProviderConfig {
  name: string;
  protocol: LlmProtocol | string;
  baseUrl: string;
  apiKey?: string;
  apiKeySecretRef?: string;
  models: string[];
  paramAllowlist?: string[];
  timeoutMs?: number;
}

/** GET /api/v1/llm/models 聚合条目（aggregateModels 输出） */
export interface LlmModelAggregate {
  provider: string;
  models: string[];
}

/** POST /api/v1/system/backup 响应（内核 BackupInfo） */
export interface BackupResult {
  path: string;
  sizeBytes: number;
  createdAt: string;
}

/** 逗号分隔输入 → 去空白去空的字符串数组（Settings 表单用） */
export function parseCsv(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** secret 引用脱敏展示（保留首尾各 4 字符；空值显示占位符） */
export function maskSecret(ref: string | undefined | null): string {
  if (ref === undefined || ref === null || ref === '') return '—';
  if (ref.length <= 8) return `${ref.slice(0, 2)}***`;
  return `${ref.slice(0, 4)}***${ref.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 错误形状工具（{ code, message, detail, status } — 线上 code 形如 HARNESS-xxxx）
// ---------------------------------------------------------------------------

/** ApiError 结构判窄 */
export function isApiError(e: unknown): e is import('@/lib/api').ApiError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof (e as { code: unknown }).code === 'string' &&
    'status' in e &&
    typeof (e as { status: unknown }).status === 'number'
  );
}

/** 错误码（如 HARNESS-1007 / HARNESS-3012）；非 ApiError 返回空串 */
export function errCode(e: unknown): string {
  return isApiError(e) ? e.code : '';
}

/** 友好错误文案：优先业务 message，兜底通用提示（api 层已自动 toast，这里供内联展示） */
export function errText(e: unknown): string {
  if (isApiError(e)) return e.message !== '' ? e.message : `请求失败（${e.code}）`;
  if (e instanceof Error && e.message !== '') return e.message;
  return '请求失败，请稍后重试';
}

/** detail 渲染文本：字符串原样；对象/数组 JSON 化；缺失返回 null */
export function errDetailText(e: unknown): string | null {
  if (!isApiError(e) || e.detail === undefined || e.detail === null) return null;
  if (typeof e.detail === 'string') return e.detail;
  try {
    return JSON.stringify(e.detail, null, 2);
  } catch {
    return String(e.detail);
  }
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

/** 字节数人性化（B/KB/MB/GB/TB，1 位小数） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 运行时长人性化（「x天 x小时 x分钟」；不足 1 分钟显示「<1 分钟」） */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '<1 分钟';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} 分钟`);
  return parts.join(' ');
}

/** 耗时人性化（毫秒：<1000 显示 ms，否则秒，取 1 位小数） */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** epoch ms → 本地时间串（空值返回 '—'） */
export function formatDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 数字千分位（counters 展示） */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '-';
}

/** 管理员角色判定（与 auth 扩展语义一致：admin / root） */
export function isAdminRole(role: string): boolean {
  return role === 'admin' || role === 'root';
}

// ---------------------------------------------------------------------------
// 输入校验 / 编解码 / 剪贴板
// ---------------------------------------------------------------------------

/** JSON 文本校验（payload/args/target 等 textarea 输入）：空串 → value undefined（视为未提供） */
export function parseJsonInput(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `JSON 语法错误：${e.message}` : 'JSON 语法错误' };
  }
}

/** IANA 时区合法性（Intl 可识别即合法） */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** UTF-8 文本 → base64（沙箱写文件 contentBase64） */
export function b64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64 → UTF-8 文本（沙箱读文件回显） */
export function textOfB64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 带 token 的 GET 下载（内核 extractToken 支持 ?token=）：
 * 构造 <a download> 触发浏览器下载，不经过 fetch（避免大文件驻留内存）。
 */
export function downloadWithToken(path: string, filename?: string): void {
  const sep = path.includes('?') ? '&' : '?';
  const a = document.createElement('a');
  a.href = `${path}${sep}token=${encodeURIComponent(getToken())}`;
  if (filename !== undefined && filename !== '') a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 剪贴板复制（Clipboard API 失败时回退 execCommand） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// useMe — 当前身份（GET /api/v1/auth/me；静默失败 → null）
// ---------------------------------------------------------------------------

/** 当前身份 Hook：Users/ApiKeys 等页面判定「（我）」与 admin 权限用 */
export function useMe(): { me: MeInfo | null; loading: boolean; reload: () => Promise<void> } {
  const [me, setMe] = useState<MeInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async (): Promise<void> => {
    if (getToken() === '') {
      setMe(null);
      setLoading(false);
      return;
    }
    try {
      const res = await api.get<MeInfo>('/api/v1/auth/me', { silent: true });
      setMe(res);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { me, loading, reload };
}

// ---------------------------------------------------------------------------
// 共享 JSX
// ---------------------------------------------------------------------------

/** 统一空态：图标圆底 + 标题 + 描述 + 可选操作区（PlaceholderPage 风格的收敛版） */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}): React.ReactNode {
  return (
    <div
      className={cn(
        'border-input flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <Icon className="size-6" aria-hidden />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined && (
        <p className="text-muted-foreground max-w-md text-sm leading-relaxed break-words">{description}</p>
      )}
      {children !== undefined && <div className="flex flex-wrap items-center justify-center gap-2 pt-1">{children}</div>}
    </div>
  );
}

/** 终端风格输出块（exec 输出 / detail / JSON 折叠内容共用） */
export function CodeBlock({ text, className }: { text: string; className?: string }): React.ReactNode {
  return (
    <pre
      className={cn(
        'bg-muted text-muted-foreground max-h-64 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap',
        className,
      )}
    >
      {text}
    </pre>
  );
}

/** 通知级别 → 徽标配色（未知级别走 outline） */
export function LevelBadge({ level }: { level: string }): React.ReactNode {
  const normalized = level.toLowerCase();
  if (normalized === 'success') return <Badge variant="success">{level}</Badge>;
  if (normalized === 'warning' || normalized === 'warn') return <Badge variant="warning">{level}</Badge>;
  if (normalized === 'error' || normalized === 'fatal' || normalized === 'critical') {
    return <Badge variant="destructive">{level}</Badge>;
  }
  if (normalized === 'info' || normalized === 'notice') return <Badge variant="secondary">{level}</Badge>;
  return <Badge variant="outline">{level}</Badge>;
}
