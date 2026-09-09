/**
 * Mcp/shared — MCP 管理页内部共享的 REST 类型视图、纯函数工具与小型展示组件。
 *
 * 类型与内核真值逐字段对齐（只读依赖，不重复实现逻辑）：
 * - src/kernel/mcp/types.ts   → McpServerSummary / McpToolInfo / McpResourceInfo /
 *                               McpPromptInfo / McpContentBlock / McpCallToolResult；
 * - src/api/mcp.ts            → 9 端点（servers CRUD+connect / tools 目录+call /
 *                               :id/resources / :id/prompts）与 zod 入参约束；
 * - 状态机                    → never → connect → connected | error；enabled=false 恒为 disabled。
 *
 * 说明：ui-src 未引入 zod 依赖，前端校验为内核 zod schema（mcpCreateBodySchema /
 * mcpServerConfigSchema）同规则的手工镜像（id 形态、stdio 必 command、remote 必 http(s)
 * url、timeoutMs ∈ [1000, 600000] 等）。
 */
import { BanIcon, CheckCircle2Icon, CircleDashedIcon, ClipboardPasteIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { errCode, errDetailText, errText } from '@/pages/_shared';
import { parseHeadersJson } from '@/pages/Mcp/json-import';

// ---------------------------------------------------------------------------
// REST 形状（内核 src/kernel/mcp/types.ts 的最小视图）
// ---------------------------------------------------------------------------

/** 传输形态（与内核 McpTransportKind 一致） */
export const MCP_TRANSPORTS = ['stdio', 'streamable-http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** server 运行态（与内核 McpServerState 一致） */
export type McpState = 'connected' | 'error' | 'disabled' | 'never';

/** GET /api/v1/mcp/servers 条目（内核 McpServerSummary = McpServerConfig + McpServerStatus） */
export interface McpServerSummary {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  timeoutMs?: number;
  state: McpState;
  /** state === 'error' 时最后一次失败的归一原因 */
  error?: string;
  /** 连接期缓存的工具数（未连接为 0） */
  toolCount: number;
}

/** GET /api/v1/mcp/tools?serverId= 条目（内核 listTools 输出，附 serverId） */
export interface McpToolRow {
  serverId: string;
  name: string;
  description?: string;
  /** JSON Schema（MCP 规范 draft 2020-12）原样透传 */
  inputSchema?: unknown;
}

/** GET /api/v1/mcp/:id/resources 条目 */
export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** GET /api/v1/mcp/:id/prompts 条目 */
export interface McpPromptInfo {
  name: string;
  description?: string;
  /** 参数声明原样透传（MCP prompt argument 列表） */
  arguments?: unknown;
}

/** POST /api/v1/mcp/tools/call 归一返回（content text 块 + isError 标记） */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

/** server id 形态约束（与内核 MCP_ID_PATTERN 一致：文件名安全） */
export const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** timeoutMs 允许区间（与内核 MCP_TIMEOUT_MIN/MAX_MS 一致） */
export const MCP_TIMEOUT_MIN_MS = 1_000;
export const MCP_TIMEOUT_MAX_MS = 600_000;

/**
 * args 输入 → 参数数组：按空白分词，支持单/双引号包裹（引号内空白保留，
 * 双引号内支持 \" 与 \\ 转义）。对齐内核 `args: array(string())` —— 产物永不含空串。
 */
export function tokenizeArgs(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quote !== null) {
      if (quote === '"' && c === '\\' && i + 1 < text.length) {
        const next = text.charAt(i + 1);
        if (next === '"' || next === '\\') {
          cur += next;
          i += 1;
          continue;
        }
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has) {
        out.push(cur);
        cur = '';
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 名称 → 建议 id（小写、非法字符折叠为连字符、去首尾连字符、截断 64） */
export function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 64);
}

/** 连接目标一行展示：stdio → command + args；remote → url */
export function serverTarget(server: McpServerSummary): string {
  if (server.transport === 'stdio') return [server.command ?? '—', ...(server.args ?? [])].join(' ');
  return server.url ?? '—';
}

/** http(s) URL 校验（镜像内核：z.url() + ^https?:\/\//i，≤2048） */
export function isValidHttpUrl(text: string): boolean {
  if (text.length > 2048 || !/^https?:\/\//i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}

/** 统一错误 toast：按 {code, message, detail} 形状呈现一次（api 层 silent，避免双 toast） */
export function toastApiError(e: unknown, title: string): void {
  const code = errCode(e);
  const base = code !== '' ? `[${code}] ${errText(e)}` : errText(e);
  const detail = errDetailText(e);
  const desc = detail === null ? base : `${base} ｜ ${detail.slice(0, 240)}`;
  toast.error(title, desc);
}

/** 行内错误文案（`[HARNESS-xxxx] message`；用于目录加载失败等非 toast 展示） */
export function describeApiError(e: unknown): string {
  const code = errCode(e);
  return code !== '' ? `[${code}] ${errText(e)}` : errText(e);
}

// ---------------------------------------------------------------------------
// 徽标
// ---------------------------------------------------------------------------

/** 传输形态徽标（stdio | streamable-http | sse） */
export function TransportBadge({ transport }: { transport: McpTransport }): React.ReactNode {
  return (
    <Badge variant="outline" className="font-mono text-[11px]" title={`transport: ${transport}`}>
      {transport}
    </Badge>
  );
}

/**
 * 运行态徽标（状态机 never/connected/error/disabled）：
 * connected 绿✓；error 红 + error message Tooltip；disabled 灰；never 灰。
 */
export function StateBadge({ server }: { server: McpServerSummary }): React.ReactNode {
  if (server.state === 'connected') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2Icon className="size-3" aria-hidden />
        已连接
      </Badge>
    );
  }
  if (server.state === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default">
            <Badge variant="destructive" className="gap-1">
              <TriangleAlertIcon className="size-3" aria-hidden />
              错误
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 break-words whitespace-normal">
          {server.error ?? '连接失败（原因未知）'}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (server.state === 'disabled') {
    return (
      <Badge variant="secondary" className="gap-1">
        <BanIcon className="size-3" aria-hidden />
        已停用
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-muted-foreground gap-1">
      <CircleDashedIcon className="size-3" aria-hidden />
      未连接
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// 键值对编辑器（stdio env / remote headers 共用）
// ---------------------------------------------------------------------------

/** 键值对编辑器的行草稿（允许空行，提交时过滤） */
export interface KeyValueEntry {
  key: string;
  value: string;
}

/** 从 Record 初始化编辑行（保留原始顺序） */
export function entriesOf(record: Record<string, string> | undefined): KeyValueEntry[] {
  if (record === undefined) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

/** 编辑行 → Record：丢弃空键行；重复键报错（交调用方 toast） */
export function recordOfEntries(entries: KeyValueEntry[]): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key === '') continue; // 空键行视为占位，静默丢弃
    if (key in out) return { ok: false, message: `存在重复的键「${key}」` };
    out[key] = entry.value;
  }
  return { ok: true, value: out };
}

/** 键值对编辑器（env / headers）：行内 key+value 输入、删除行、追加行 */
export function KeyValueEditor({
  entries,
  onChange,
  disabled,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  entries: KeyValueEntry[];
  onChange: (next: KeyValueEntry[]) => void;
  disabled?: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}): React.ReactNode {
  const update = (index: number, patch: Partial<KeyValueEntry>): void => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
          <Input
            value={entry.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            disabled={disabled}
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            aria-label={`键 ${i + 1}`}
          />
          <Input
            value={entry.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            disabled={disabled}
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            aria-label={`值 ${i + 1}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('text-muted-foreground hover:text-destructive', entries.length <= 1 && 'invisible')}
            onClick={() => onChange(entries.filter((_, j) => j !== i))}
            disabled={disabled}
            aria-label="删除此行"
          >
            <Trash2Icon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...entries, { key: '', value: '' }])}
        disabled={disabled}
      >
        <PlusIcon aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 小型展示件
// ---------------------------------------------------------------------------

/**
 * headers「粘贴 JSON」区块：textarea 粘贴 `{"X-API-Key":"...","Authorization":"Bearer ..."}`
 * 形状 → 解析填充键值对行；解析失败**内联报错**（role=alert，不 toast）。
 * 解析成功回调整个 Record（整表替换语义由调用方决定），并清空输入。
 */
export function HeadersJsonPaste({
  onParsed,
  disabled,
}: {
  onParsed: (value: Record<string, string>) => void;
  disabled?: boolean;
}): React.ReactNode {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parse = (): void => {
    const res = parseHeadersJson(text);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setText('');
    onParsed(res.value);
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
      <Textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error !== null) setError(null);
        }}
        placeholder={'{"Authorization":"Bearer xxx","X-API-Key":"yyy"}'}
        disabled={disabled}
        className="min-h-20 font-mono text-xs"
        spellCheck={false}
        aria-label="粘贴 headers JSON"
      />
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={parse}
        disabled={disabled || text.trim() === ''}
      >
        <ClipboardPasteIcon aria-hidden />
        解析并填充
      </Button>
    </div>
  );
}

/** 标签-值元信息行（Dialog / 详情头共用） */
export function MetaRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="text-muted-foreground w-24 shrink-0 text-xs">{label}</span>
      <span className="min-w-0 text-sm break-all">{children}</span>
    </div>
  );
}

/** unknown 值 → 截断 JSON 预览文本（prompts.arguments 等） */
export function jsonPreview(value: unknown, cap = 160): string {
  if (value === undefined || value === null) return '—';
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  } catch {
    return String(value);
  }
}
