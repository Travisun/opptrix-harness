/**
 * chat/types — 聊天面板共享类型与内容归一化。
 *
 * 与内核契约对齐（只读依赖，不改内核）：
 * - 频道：src/kernel/chat/store.ts ChannelRow（UI 只消费 id/slug/name/createdAt）；
 * - 消息：ChatMessage（messages 表 camelCase 行视图），即 REST 列表行与
 *   SSE `chat.message.created/updated` 事件载荷（store 行，无 channelSlug）；
 * - content 结构：{ type: 'text' | 'file' | 'card', ... }（kernel chat service 契约；
 *   text 型必带 text；file/card 型允许任意附加字段）；
 * - senderType：'user' | 'ext' | 'webhook'（存储层为 open 枚举，运行时按字符串容错）。
 */

/** GET /api/v1/channels 行的 UI 视图（多余字段运行时忽略） */
export interface ChatChannel {
  id: string;
  slug: string;
  name: string;
  createdAt: number;
}

/** REST/SSE 消息行的公共视图 */
export interface ChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  content: unknown;
  attachments: unknown;
  createdAt: number;
  updatedAt?: number;
  /** 乐观插入标记：POST 确认 / SSE 对账后移除 */
  pending?: boolean;
}

/** 归一化后的消息内容视图（渲染层唯一入口） */
export type ContentView =
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; size: number | null }
  | { type: 'card'; kind: string; payload: Record<string, unknown> }
  | { type: 'unknown'; payload: unknown };

/** 把内核 content（unknown，损坏可能为 null）归一化为可渲染视图 */
export function normalizeContent(content: unknown): ContentView {
  if (content === null || content === undefined) return { type: 'text', text: '' };
  if (typeof content === 'string') return { type: 'text', text: content };
  if (typeof content !== 'object' || Array.isArray(content)) {
    return { type: 'unknown', payload: content };
  }
  const raw = content as Record<string, unknown>;
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';
  if (type === 'text') {
    const text = typeof raw['text'] === 'string' ? raw['text'] : '';
    return { type: 'text', text };
  }
  if (type === 'file') {
    const name =
      firstString(raw['name'], raw['filename'], raw['fileName'], raw['path']) ?? '未命名文件';
    const size = firstNumber(raw['size'], raw['fileSize'], raw['bytes']);
    return { type: 'file', name, size };
  }
  if (type === 'card') {
    const kind = firstString(raw['kind'], raw['title']) ?? '卡片';
    const payload: Record<string, unknown> = { ...raw };
    delete payload['type'];
    return { type: 'card', kind, payload };
  }
  return { type: 'unknown', payload: content };
}

/** 未知类型内容渲染为紧凑 JSON（对象/数组）；标量直接转字符串 */
export function describeUnknown(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}

/** 拦截原因（chat.beforeSend hook 的 HookAbort.result，形状任意）转可读文本 */
export function describeReason(reason: unknown): string {
  if (reason === undefined || reason === null || reason === '') return '消息被频道规则拦截';
  if (typeof reason === 'string') return reason;
  let json: string;
  try {
    json = JSON.stringify(reason) ?? '';
  } catch {
    return String(reason);
  }
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

/** 字节数人性化（文件卡片占位） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

// ---------------------------------------------------------------------------
// 时间格式化（本地时区；day 分隔线 + 气泡时间）
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** HH:mm（气泡时间） */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 天分隔线标签：今天 / 昨天 / M月D日 / 跨年带年份 */
export function formatDayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const startOfDay = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? md : `${d.getFullYear()}年${md}`;
}

/** 天分组的比较键（本地日期 YYYY-M-D） */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}
