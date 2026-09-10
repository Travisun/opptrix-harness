import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoxesIcon,
  ChevronDownIcon,
  EllipsisVerticalIcon,
  FileTextIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  NetworkIcon,
  PaperclipIcon,
  SendHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  WrenchIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, getToken, workspaceApi } from '@/lib/api';
import { connectSse, type SseEventData } from '@/lib/sse';
import { cn } from '@/lib/utils';
import { WorkspacePanel } from '@/pages/AgentChat/WorkspacePanel';
import { formatBytes } from '@/pages/_shared';

/**
 * AgentChat — 全屏 LLM 对话界面（类 Codex Chat 骨架；AppShell 之外的独立 Layout）。
 *
 * - 左侧 280px 会话列表：品牌区 + 「新建对话」+ 会话树（按 parent_id 组树：子会话缩进 +
 *   「↳ 子会话」徽标，父会话可展开/收起；孤儿（父已删）按根处理）+ 会话项操作菜单
 *   （「新建子会话」）+ 底部「← Dashboard」（Link to /admin）；
 * - 右侧对话区：顶栏（子会话面包屑「父会话名 / 当前名」可跳回 + 「📁 文件」工作区抽屉入口 +
 *   连接状态点）+ 消息流（user 右对齐 / assistant 左对齐 + tool_calls 折叠展示 +
 *   workspace_* / report_create / browser_screenshot 结果增强渲染 + system 工具结果居中小字）+
 *   Composer（textarea Enter 发送 + 模型 Select + 附件按钮占位 + Skills/MCP 快捷 chip）；
 * - 工作区文件面板（WorkspacePanel）：右侧 320px 抽屉——文件树懒加载 / 上传（≤8MB）/
 *   预览（文本/图片/HTML iframe + ?token=）/ 下载 / 删除；
 * - REST：/api/v1/agents/sessions*（创建/列表/消息/发送；子会话创建带 parent_id）；
 *   SSE 订阅 `agent:{sessionId}` 实时追加（message.created），replay-gap 时整列表对账；
 * - report_create 预览：新契约直开结果 url（workspace file 端点 + ?token=），
 *   旧契约（{ok,reportId} → /ext/html-report 预览路由）保留兜底；
 * - 新建对话自动标题：首条 user 消息前 30 字符（PATCH title）；
 * - 模型 Select：选项来自 GET /api/v1/llm/models（缺省 = 内核解析链默认），
 *   作用于之后新建的会话（会话级 model 落在创建入参）；
 * - 样式全部走 shadcn 主题令牌（bg-background/border-border 等），暗色跟随 .dark。
 */

/** GET /api/v1/agents/sessions 条目（与内核 AgentSessionRecord 契约对齐） */
interface AgentSession {
  id: string;
  title: string;
  model: string | null;
  systemPrompt: string | null;
  status: 'active' | 'archived';
  created_at: number;
  updated_at: number;
  last_message_at: number | null;
  /** 创建者用户 id（后端字段并行落地；未落地时为 undefined，按可选处理不崩溃） */
  user_id?: string | null;
  /** 父会话 id（子会话才有；根会话为 null/undefined——组树时孤儿按根处理） */
  parent_id?: string | null;
}

/** GET /api/v1/agents/sessions/:id/messages 条目（与内核 AgentMessageRecord 契约对齐） */
interface AgentMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens: number; outputTokens: number };
  created_at: number;
}

/** GET /api/v1/llm/models 条目 */
interface LlmModelEntry {
  provider: string;
  models: string[];
}

/** 新建对话的缺省标题（与内核 DEFAULT_SESSION_TITLE 一致；首条消息后自动改名） */
const NEW_SESSION_TITLE = '新对话';

/** 自动标题截取长度（首条 user 消息前 30 字符） */
const AUTO_TITLE_MAX_CHARS = 30;

// ---------------------------------------------------------------------------
// 会话树（按 parent_id 组树；子会话缩进 + 徽标；父会话可展开/收起）
// ---------------------------------------------------------------------------

/** 会话树节点（children 为按 parent_id 归组的子会话，保持列表原有排序） */
interface SessionTreeNode {
  session: AgentSession;
  children: SessionTreeNode[];
}

/**
 * buildSessionTree — 按 parent_id 把平铺会话列表组为树：
 * - parent_id 为空或父会话不存在（已删）的孤儿 → 按根处理（不缩进、不丢失）；
 * - 兄弟/根节点保持输入列表顺序（last_message_at 排序语义不变）。
 */
function buildSessionTree(sessions: AgentSession[]): SessionTreeNode[] {
  const byId = new Map<string, AgentSession>(sessions.map((s) => [s.id, s]));
  const nodes = new Map<string, SessionTreeNode>(sessions.map((s) => [s.id, { session: s, children: [] }]));
  const roots: SessionTreeNode[] = [];
  for (const s of sessions) {
    const node = nodes.get(s.id);
    if (node === undefined) continue;
    const pid = s.parent_id ?? null;
    const parent = pid !== null && pid !== '' ? byId.get(pid) : undefined;
    if (parent !== undefined) {
      nodes.get(parent.id)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** 时间展示：当天显示 HH:mm，否则 MM-DD HH:mm */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

/** 工具参数美化：可解析 JSON 则缩进两格，否则原样展示 */
function formatToolArgs(argsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argsJson) as unknown, null, 2);
  } catch {
    return argsJson;
  }
}

// ---------------------------------------------------------------------------
// 工具调用结果配对与增强渲染（workspace_* / report_create / browser_screenshot）
// ---------------------------------------------------------------------------

/** system 工具结果消息 JSON 的最小视图（轨迹落库契约：工具结果以 system 角色落库） */
interface ToolResultPayload {
  ok?: unknown;
  path?: unknown;
  size?: unknown;
  reportId?: unknown;
  url?: unknown;
}

/** 参与增强渲染的工具名（其余工具调用仍走通用折叠兜底） */
const TRACKED_TOOL_NAMES = new Set(['workspace_write', 'workspace_read', 'workspace_delete', 'report_create', 'browser_screenshot']);

/** system 工具结果消息 content → JSON 对象（非 JSON 返回 null） */
function parseToolResult(content: string): ToolResultPayload | null {
  try {
    const obj = JSON.parse(content) as ToolResultPayload | null;
    return obj !== null && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * mapToolResults — 按消息顺序把 system 工具结果配对到发起调用的 assistant 消息：
 * 每条 assistant 消息的受管调用（TRACKED_TOOL_NAMES）进入 FIFO 队列，其后最近的成功结果
 * （ok===true；失败/非 JSON 结果不消费，走通用折叠兜底）按序归还，输出按调用顺序对齐的
 * payload 数组（messageId → payloads[i] 对应该消息第 i 个受管调用）。
 */
function mapToolResults(messages: AgentMessage[]): Map<string, ToolResultPayload[]> {
  const out = new Map<string, ToolResultPayload[]>();
  /** FIFO：尚有未配对受管调用的 assistant 消息 id 队列 */
  const order: string[] = [];
  /** messageId → 剩余未配对调用数 */
  const quota = new Map<string, number>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).filter((tc) => TRACKED_TOOL_NAMES.has(tc.name)).length;
      if (calls > 0) {
        quota.set(m.id, calls);
        order.push(m.id);
      }
      continue;
    }
    if (m.role === 'system' && order.length > 0) {
      const payload = parseToolResult(m.content);
      if (payload === null || payload.ok !== true) continue;
      const owner = order[0];
      if (owner === undefined) continue;
      out.set(owner, [...(out.get(owner) ?? []), payload]);
      const left = (quota.get(owner) ?? 1) - 1;
      quota.set(owner, left);
      if (left <= 0) order.shift();
    }
  }
  return out;
}

/** 成功创建的报告 id（report_create 旧契约的 {ok,reportId} 形状） */
function extractCreatedReportId(content: string): string | null {
  try {
    const obj = JSON.parse(content) as { ok?: unknown; reportId?: unknown };
    return obj.ok === true && typeof obj.reportId === 'string' && obj.reportId !== '' ? obj.reportId : null;
  } catch {
    return null;
  }
}

/**
 * 按消息顺序配对 report_create 调用与其 system 结果（旧契约兜底）：assistant 消息携带的每个
 * report_create 调用，按序消费其后最近的成功结果消息（一条结果只配一个调用）。
 */
function mapReportPreviews(messages: AgentMessage[]): Map<string, string[]> {
  const byMessage = new Map<string, string[]>();
  /** messageId → 尚未配到结果的 report_create 调用数 */
  const quota = new Map<string, number>();
  const order: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).filter((tc) => tc.name === 'report_create').length;
      if (calls > 0) {
        quota.set(m.id, calls);
        order.push(m.id);
      }
      continue;
    }
    if (m.role === 'system' && order.length > 0) {
      const reportId = extractCreatedReportId(m.content);
      if (reportId === null) continue;
      const owner = order[0];
      if (owner === undefined) continue;
      byMessage.set(owner, [...(byMessage.get(owner) ?? []), reportId]);
      const left = (quota.get(owner) ?? 1) - 1;
      quota.set(owner, left);
      if (left <= 0) order.shift();
    }
  }
  return byMessage;
}

/** 为服务端返回的相对 url 追加 ?token=（iframe/img 直开通道；已有 query 则 & 拼接） */
function withToken(url: string): string {
  const token = getToken();
  if (token === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** browser_screenshot 调用参数里的截图落盘路径（结果缺 path 时的兜底） */
function screenshotPathFromArgs(argsJson: string): string | null {
  try {
    const obj = JSON.parse(argsJson) as { path?: unknown };
    return typeof obj.path === 'string' && obj.path !== '' ? obj.path : null;
  } catch {
    return null;
  }
}

/**
 * 单个受管工具调用的增强结果渲染：
 * - workspace_write → 「已写入 📄 {path} (size)」；read/delete 同理（path 主键）；
 * - report_create → 「报告已生成」+ 预览按钮（iframe Dialog 直开结果 url + ?token=）；
 * - browser_screenshot → 内嵌缩略图（workspace file 端点直链），点击放大；
 * 失败/未配对/旧形状返回 null（由通用折叠兜底）。
 */
function renderToolResultNode(
  tc: { id: string; name: string; arguments: string },
  payload: ToolResultPayload | undefined,
  sessionId: string,
  onPreviewFrame: (url: string, title: string) => void,
  onPreviewImage: (url: string, title: string) => void,
): React.ReactNode {
  if (tc.name === 'browser_screenshot') {
    const fromPayload = payload !== undefined && payload.ok === true ? payload.path : undefined;
    const path = typeof fromPayload === 'string' && fromPayload !== '' ? fromPayload : screenshotPathFromArgs(tc.arguments);
    if (path === null) return null;
    const src = workspaceApi.fileUrl(sessionId, path);
    return (
      <div data-tool-result="browser_screenshot">
        <img
          src={src}
          alt={`截图 ${path}`}
          loading="lazy"
          className="max-h-40 cursor-zoom-in rounded-md border border-border"
          onClick={() => onPreviewImage(src, path)}
        />
      </div>
    );
  }
  if (payload === undefined || payload.ok !== true) return null;
  const path = typeof payload.path === 'string' && payload.path !== '' ? payload.path : null;
  if (tc.name === 'workspace_write') {
    if (path === null) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs" data-tool-result="workspace_write">
        <span>已写入 📄 {path}</span>
        {typeof payload.size === 'number' && (
          <span className="text-muted-foreground">({formatBytes(payload.size)})</span>
        )}
      </div>
    );
  }
  if (tc.name === 'workspace_read') {
    return path === null ? null : (
      <div className="text-xs" data-tool-result="workspace_read">
        已读取 📄 {path}
      </div>
    );
  }
  if (tc.name === 'workspace_delete') {
    return path === null ? null : (
      <div className="text-xs" data-tool-result="workspace_delete">
        已删除 📄 {path}
      </div>
    );
  }
  if (tc.name === 'report_create') {
    // 新契约：结果 {reportId, path, url}，url 直开（workspace file 端点）；旧契约走 legacyReportIds 兜底
    if (typeof payload.url !== 'string' || payload.url === '') return null;
    const reportUrl = payload.url;
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs" data-tool-result="report_create">
        <span>报告已生成{path !== null ? `：${path}` : ''}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 rounded-full px-2.5 text-xs"
          onClick={() => onPreviewFrame(withToken(reportUrl), '报告预览')}
        >
          <FileTextIcon className="size-3.5" aria-hidden />
          预览
        </Button>
      </div>
    );
  }
  return null;
}

/** 单条消息气泡：user 右对齐 / assistant 左对齐（tool_calls 折叠 + 工具结果增强 + 报告预览入口）/ system 居中小字 */
function MessageBubble({
  message,
  sessionId,
  payloads,
  legacyReportIds,
  onPreviewReport,
  onPreviewFrame,
  onPreviewImage,
}: {
  message: AgentMessage;
  /** 活动会话 id（截图缩略图等 workspace file 端点直链需要；null = 未落库新对话） */
  sessionId: string | null;
  /** 受管工具调用按序配对的成功结果 payload（mapToolResults 输出） */
  payloads?: ToolResultPayload[];
  /** 旧契约兜底：成功创建的报告 id 列表（{ok,reportId} 结果 → /ext 预览路由） */
  legacyReportIds?: string[];
  onPreviewReport?: (reportId: string) => void;
  onPreviewFrame: (url: string, title: string) => void;
  onPreviewImage: (url: string, title: string) => void;
}): React.ReactNode {
  if (message.role === 'system') {
    return (
      <div className="flex justify-center">
        <div className="text-muted-foreground max-w-[80%] rounded-md bg-muted/50 px-2.5 py-1 text-xs break-all whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  const isUser = message.role === 'user';
  const toolCalls = message.toolCalls ?? [];
  // 受管工具调用的增强结果（按调用顺序配对 payload；无匹配则不渲染，走通用折叠兜底）
  const specialResults: React.ReactNode[] = [];
  if (!isUser && sessionId !== null) {
    let trackedIdx = 0;
    for (const tc of toolCalls) {
      if (!TRACKED_TOOL_NAMES.has(tc.name)) continue;
      const node = renderToolResultNode(tc, payloads?.[trackedIdx], sessionId, onPreviewFrame, onPreviewImage);
      trackedIdx += 1;
      if (node !== null) specialResults.push(<Fragment key={tc.id}>{node}</Fragment>);
    }
  }
  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-lg px-3.5 py-2 text-sm shadow-sm',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
        )}
        data-role={message.role}
      >
        {message.content !== '' && <div className="whitespace-pre-wrap break-words">{message.content}</div>}
        {toolCalls.length > 0 && (
          <details className={cn('mt-1.5', message.content !== '' && 'border-t pt-1.5')}>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs opacity-80 select-none">
              <WrenchIcon className="size-3.5" aria-hidden />
              调用了 {toolCalls.length} 个工具
            </summary>
            <div className="mt-1.5 space-y-1.5">
              {toolCalls.map((tc) => (
                <div key={tc.id} className="rounded bg-background/70 p-2 text-xs">
                  <div className="font-medium">{tc.name}</div>
                  <pre className="text-muted-foreground mt-1 overflow-x-auto whitespace-pre-wrap">
                    {formatToolArgs(tc.arguments)}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        )}
        {/* 受管工具结果增强渲染（workspace_* / report_create / browser_screenshot） */}
        {specialResults.length > 0 && (
          <div className="mt-1.5 space-y-1.5 border-t pt-1.5" data-slot="tool-results">
            {specialResults}
          </div>
        )}
        {message.usage !== undefined && (
          <div className="text-muted-foreground mt-1 text-[11px] opacity-70">
            tokens {message.usage.inputTokens} → {message.usage.outputTokens}
          </div>
        )}
        {/* 旧契约兜底：report_create {ok,reportId} 结果 → /ext/html-report 预览路由入口 */}
        {legacyReportIds !== undefined && legacyReportIds.length > 0 && onPreviewReport !== undefined && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 border-t pt-1.5">
            {legacyReportIds.map((reportId, i) => (
              <Button
                key={reportId}
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-full px-2.5 text-xs"
                onClick={() => onPreviewReport(reportId)}
              >
                <FileTextIcon className="size-3.5" aria-hidden />
                {legacyReportIds.length > 1 ? `📄 预览报告 ${i + 1}` : '📄 预览报告'}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentChatPage(): React.ReactNode {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  /** 收起的父会话 id 集合（子会话树默认展开；点父会话行的展开钮切换） */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** 工作区文件抽屉（WorkspacePanel）开合 */
  const [wsOpen, setWsOpen] = useState(false);
  /** iframe 预览（报告 url 直开 / 旧契约 /ext 预览路由；null = 关闭） */
  const [framePreview, setFramePreview] = useState<{ title: string; url: string } | null>(null);
  /** 图片放大预览（截图缩略图点击） */
  const [imagePreview, setImagePreview] = useState<{ title: string; url: string } | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 活动会话 id 的 ref（SSE 回调与 send 闭包读取现值，避免陈旧闭包） */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  /** 子会话面包屑的父会话（parent_id 未落地/根会话/父已删 → null，不渲染面包屑） */
  const parentSession =
    activeSession?.parent_id !== undefined && activeSession?.parent_id !== null && activeSession.parent_id !== ''
      ? (sessions.find((s) => s.id === activeSession.parent_id) ?? null)
      : null;

  /** 会话树（按 parent_id 组树；孤儿按根处理）→ 展开/收起过滤后的可见列表（含缩进深度） */
  const sessionTree = useMemo(() => buildSessionTree(sessions), [sessions]);
  const visibleNodes = useMemo(() => {
    const out: Array<{ node: SessionTreeNode; depth: number }> = [];
    const seen = new Set<string>();
    const walk = (list: SessionTreeNode[], depth: number): void => {
      for (const node of list) {
        if (seen.has(node.session.id)) return; // 防御：异常数据成环时不无限递归
        seen.add(node.session.id);
        out.push({ node, depth });
        if (!collapsed.has(node.session.id)) walk(node.children, depth + 1);
      }
    };
    walk(sessionTree, 0);
    return out;
  }, [sessionTree, collapsed]);

  /** report_create 新契约结果配对（url 直开）与旧契约配对（reportId → /ext 路由兜底） */
  const toolResults = useMemo(() => mapToolResults(messages), [messages]);
  const reportPreviews = useMemo(() => mapReportPreviews(messages), [messages]);
  /** 消息已有 url 直开预览时抑制旧契约按钮（避免同一报告双入口） */
  const hasUrlPreview = (messageId: string): boolean =>
    (toolResults.get(messageId) ?? []).some((p) => typeof p.url === 'string' && p.url !== '');

  /** 旧契约预览 iframe 地址：扩展路由 auth:'user'，token 走 ?token= 查询通道（extractToken 契约） */
  const previewUrl = (reportId: string): string => {
    const token = getToken();
    return `/ext/html-report/reports/${encodeURIComponent(reportId)}${token !== '' ? `?token=${encodeURIComponent(token)}` : ''}`;
  };

  /** 会话列表刷新（发送后重取以反映 last_message_at 排序变化） */
  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      setSessions(await api.get<AgentSession[]>('/api/v1/agents/sessions'));
    } catch {
      /* 错误已由 api 层统一 toast */
    }
  }, []);

  /** 整列表对账（replay-gap / 会话切换时） */
  const reloadMessages = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const list = await api.get<AgentMessage[]>(`/api/v1/agents/sessions/${sessionId}/messages?limit=200`);
      setMessages(list);
    } catch {
      /* 错误已由 api 层统一 toast */
    }
  }, []);

  useEffect(() => {
    document.title = 'Chat · Opptrix Harness';
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // 模型目录（任意已认证身份可读；失败 = 未配置 provider，Select 退化为「默认模型」）
  useEffect(() => {
    api
      .get<LlmModelEntry[]>('/api/v1/llm/models', { silent: true })
      .then((entries) => setModels(entries.flatMap((e) => e.models)))
      .catch(() => setModels([]));
  }, []);

  // SSE 订阅 agent:{sessionId}：实时追加（幂等去重）；replay-gap → 整列表 REST 对账
  useEffect(() => {
    if (activeId === null) {
      setConnected(false);
      return;
    }
    const sessionId = activeId;
    const onEvent = (e: SseEventData): void => {
      if (e.event !== 'message.created') return;
      const msg = e.data as Partial<AgentMessage> | null;
      if (msg === null || typeof msg.id !== 'string' || msg.session_id !== sessionId) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg as AgentMessage]));
    };
    const stream = connectSse({
      topics: [`agent:${sessionId}`],
      onEvent,
      onReplayGap: () => void reloadMessages(sessionId),
      onStateChange: setConnected,
    });
    return () => stream.close();
  }, [activeId, reloadMessages]);

  // 消息变化后滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  /** 打开既有会话（清空消息 → REST 拉取） */
  const openSession = (id: string): void => {
    setActiveId(id);
    setMessages([]);
    void reloadMessages(id);
  };

  /** 新建对话：惰性创建——清空活动会话，首条消息发送时才落会话（自动标题随之生效；根会话无 parentId） */
  const startNewConversation = (): void => {
    setActiveId(null);
    setMessages([]);
  };

  /** 新建子会话：以指定会话为 parentId 创建并切换（工作区相对子会话解析到根会话，天然继承） */
  const createChildSession = async (parent: AgentSession): Promise<void> => {
    try {
      const created = await api.post<AgentSession>('/api/v1/agents/sessions', {
        ...(model !== '' ? { model } : {}),
        parent_id: parent.id,
      });
      setSessions((prev) => [created, ...prev]);
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parent.id); // 展开父会话确保新子会话可见
        return next;
      });
      openSession(created.id);
    } catch {
      /* 错误已由 api 层统一 toast */
    }
  };

  /** 发送当前输入（无活动会话时先创建根会话；首个「新对话」以消息前 30 字符自动改名） */
  const send = async (): Promise<void> => {
    const text = input.trim();
    if (text === '' || sending) return;
    setSending(true);
    try {
      let sessionId = activeIdRef.current;
      if (sessionId === null) {
        const created = await api.post<AgentSession>(
          '/api/v1/agents/sessions',
          model !== '' ? { model } : {},
        );
        sessionId = created.id;
        setSessions((prev) => [created, ...prev]);
        setActiveId(sessionId);
      }
      const session = sessions.find((s) => s.id === sessionId) ?? null;
      if (session !== null && session.title === NEW_SESSION_TITLE) {
        try {
          const renamed = await api.patch<AgentSession>(`/api/v1/agents/sessions/${sessionId}`, {
            title: text.slice(0, AUTO_TITLE_MAX_CHARS),
          });
          setSessions((prev) => prev.map((s) => (s.id === renamed.id ? renamed : s)));
        } catch {
          /* 自动标题失败不阻断发送 */
        }
      }
      // SSE message.created 会先追加 user 消息；此处等最终 assistant 回复（幂等去重）
      const assistant = await api.post<AgentMessage>(`/api/v1/agents/sessions/${sessionId}/messages`, {
        content: text,
      });
      setMessages((prev) => (prev.some((m) => m.id === assistant.id) ? prev : [...prev, assistant]));
      setInput('');
      void refreshSessions();
    } catch {
      /* 错误已由 api 层统一 toast；输入保留便于修改重发 */
    } finally {
      setSending(false);
    }
  };

  /** 取消进行中的生成（composer 的停止按钮） */
  const cancel = async (): Promise<void> => {
    const sessionId = activeIdRef.current;
    if (sessionId === null) return;
    try {
      await api.post(`/api/v1/agents/sessions/${sessionId}/cancel`);
    } catch {
      /* 取消失败静默（生成自身会收束） */
    }
  };

  /** 快捷 chip：向输入区插入提示片段（占位能力，后续接 Skills/MCP 选择器） */
  const insertChip = (snippet: string): void => {
    setInput((prev) => (prev === '' ? snippet : `${prev} ${snippet}`));
  };

  /** 父会话展开/收起切换 */
  const toggleExpanded = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sessionModels = (
    <Select value={model === '' ? 'default' : model} onValueChange={(v) => setModel(v === 'default' ? '' : v)}>
      <SelectTrigger size="sm" className="w-[180px]" aria-label="模型选择">
        <SelectValue placeholder="默认模型" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">默认模型</SelectItem>
        {models.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="bg-background text-foreground flex h-svh w-full overflow-hidden">
      {/* ---- 左侧 280px 会话列表 ---- */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-background">
        {/* 品牌区（与 Dashboard 侧栏同款：primary 方块 logo + 主/副标） */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg shadow-sm">
            <BoxesIcon className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Opptrix Harness</p>
            <p className="text-muted-foreground truncate text-xs">Chat</p>
          </div>
        </div>

        <div className="p-3">
          <Button className="w-full" onClick={startNewConversation}>
            <MessageSquarePlusIcon aria-hidden />
            新建对话
          </Button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-2" aria-label="会话列表">
          {sessions.length === 0 && (
            <p className="text-muted-foreground px-2.5 py-6 text-center text-xs">还没有对话，点上方按钮开始。</p>
          )}
          {visibleNodes.map(({ node, depth }) => {
            const s = node.session;
            const isChild = depth > 0; // 仅父会话存在且展开时子会话才渲染在更深层级（孤儿按根处理）
            const hasChildren = node.children.length > 0;
            const expanded = !collapsed.has(s.id);
            return (
              <div
                key={s.id}
                className={cn(
                  'group hover:bg-muted/60 flex w-full items-center rounded-md pr-1 transition-colors',
                  s.id === activeId && 'bg-muted',
                )}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
                data-session-id={s.id}
              >
                {/* 父会话展开/收起钮（有子会话才出现；点击不切换会话） */}
                {hasChildren ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded"
                    aria-label={expanded ? `收起子会话（${s.title}）` : `展开子会话（${s.title}）`}
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(s.id)}
                  >
                    <ChevronDownIcon
                      className={cn('size-3.5 transition-transform', !expanded && '-rotate-90')}
                      aria-hidden
                    />
                  </button>
                ) : (
                  <span className="size-5 shrink-0" aria-hidden />
                )}
                <button
                  type="button"
                  onClick={() => openSession(s.id)}
                  className="min-w-0 flex-1 py-2 text-left"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{s.title}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {isChild && (
                        <Badge variant="secondary" className="px-1.5 text-[10px]">
                          ↳ 子会话
                        </Badge>
                      )}
                      {s.status === 'archived' && (
                        <Badge variant="outline" className="gap-0.5 px-1.5 text-[10px]">
                          <ArchiveIcon className="size-3" aria-hidden />
                          归档
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {formatTime(s.last_message_at ?? s.created_at)}
                  </span>
                </button>
                {/* 会话项操作菜单：新建子会话（以当前项为 parentId） */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label={`会话操作（${s.title}）`}
                    >
                      <EllipsisVerticalIcon className="size-3.5" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void createChildSession(s)}>新建子会话</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-border p-3">
          <Link
            to="/admin"
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors"
          >
            <ArrowLeftIcon className="size-4" aria-hidden />
            Dashboard
          </Link>
        </div>
      </aside>

      {/* ---- 右侧对话区 ---- */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* 头部：子会话面包屑 + 会话标题/归档态 + 工作区入口 + 连接状态点 */}
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {/* 子会话面包屑：父会话名（可点击跳回）/ 当前会话名 */}
            {parentSession !== null && (
              <nav aria-label="会话面包屑" className="flex min-w-0 shrink items-center gap-1 text-xs">
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground hover:bg-muted max-w-[140px] truncate rounded px-1 py-0.5 transition-colors"
                  title={`返回父会话：${parentSession.title}`}
                  onClick={() => openSession(parentSession.id)}
                >
                  {parentSession.title}
                </button>
                <span className="text-muted-foreground/60" aria-hidden>
                  /
                </span>
              </nav>
            )}
            <h1 className="truncate text-sm font-semibold">{activeSession?.title ?? '新的对话'}</h1>
            {activeSession?.status === 'archived' && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                归档
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {/* 工作区文件抽屉入口（未落库的新对话无工作区，置灰） */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              disabled={activeId === null}
              aria-label="打开工作区文件面板"
              onClick={() => setWsOpen(true)}
            >
              📁 文件
            </Button>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span
                className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                aria-hidden
              />
              {connected ? '实时' : '离线'}
            </span>
          </div>
        </header>

        {/* 消息流 */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {activeId === null ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 text-center">
              <div className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-xl shadow-sm">
                <BoxesIcon className="size-6" aria-hidden />
              </div>
              <p className="text-sm font-medium">开始新的对话</p>
              <p className="max-w-sm text-xs">向助手提问，或让助手调用系统工具（技能 / 定时任务 / 文件 / MCP…）。</p>
            </div>
          ) : (
            messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                sessionId={activeId}
                payloads={toolResults.get(m.id)}
                legacyReportIds={hasUrlPreview(m.id) ? undefined : reportPreviews.get(m.id)}
                onPreviewReport={(reportId) => setFramePreview({ title: '报告预览', url: previewUrl(reportId) })}
                onPreviewFrame={(url, title) => setFramePreview({ title, url })}
                onPreviewImage={(url, title) => setImagePreview({ title, url })}
              />
            ))
          )}
          {sending && (
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              助手正在思考…
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => insertChip('使用技能：')}
            >
              <SparklesIcon className="size-3.5" aria-hidden />
              Skills
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={() => insertChip('调用 MCP 工具：')}
            >
              <NetworkIcon className="size-3.5" aria-hidden />
              MCP
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 rounded-full px-2.5 text-xs"
              disabled
              title="附件功能即将支持"
            >
              <PaperclipIcon className="size-3.5" aria-hidden />
              附件
            </Button>
            <span className="grow" />
            {sessionModels}
          </div>
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={activeId === null ? '描述你的任务，Enter 发送（将自动创建对话）' : '输入消息，Enter 发送，Shift+Enter 换行'}
              rows={2}
              aria-label="消息输入框"
              className="max-h-40 resize-none"
            />
            {sending ? (
              <Button size="icon" variant="outline" aria-label="停止生成" onClick={() => void cancel()}>
                <SquareIcon aria-hidden />
              </Button>
            ) : (
              <Button
                size="icon"
                aria-label="发送消息"
                disabled={input.trim() === ''}
                onClick={() => {
                  void send();
                }}
              >
                <SendHorizontalIcon aria-hidden />
              </Button>
            )}
          </div>
          <p className="text-muted-foreground mt-1.5 text-[11px]">Enter 发送，Shift+Enter 换行</p>
        </div>
      </section>

      {/* ---- 工作区文件抽屉（当前会话工作区；子会话继承根会话工作区） ---- */}
      <WorkspacePanel sessionId={activeId} open={wsOpen} onOpenChange={setWsOpen} />

      {/* ---- iframe 预览（报告 url 直开 / 旧契约 /ext 预览路由；CSP 由端点下发）---- */}
      <Dialog open={framePreview !== null} onOpenChange={(open) => (open ? undefined : setFramePreview(null))}>
        <DialogContent className="flex max-h-[85vh] w-[min(920px,92vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(920px,92vw)]">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="text-sm">{framePreview?.title ?? '预览'}</DialogTitle>
            <DialogDescription className="text-xs">
              {framePreview !== null ? framePreview.url.split('?')[0] : ''}
            </DialogDescription>
          </DialogHeader>
          {framePreview !== null && (
            <iframe
              key={framePreview.url}
              src={framePreview.url}
              title={framePreview.title}
              className="h-[68vh] w-full flex-1 bg-white"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ---- 图片放大预览（截图缩略图点击）---- */}
      <Dialog open={imagePreview !== null} onOpenChange={(open) => (open ? undefined : setImagePreview(null))}>
        <DialogContent className="w-[min(760px,92vw)] p-3 sm:max-w-[min(760px,92vw)]">
          <DialogHeader className="sr-only">
            <DialogTitle>图片预览</DialogTitle>
            <DialogDescription>{imagePreview?.title ?? ''}</DialogDescription>
          </DialogHeader>
          {imagePreview !== null && (
            <img
              src={imagePreview.url}
              alt={imagePreview.title}
              className="bg-muted max-h-[75vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
