import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoxesIcon,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { connectSse, type SseEventData } from '@/lib/sse';
import { cn } from '@/lib/utils';

/**
 * AgentChat — 全屏 LLM 对话界面（类 Codex Chat 骨架；AppShell 之外的独立 Layout）。
 *
 * - 左侧 280px 会话列表：品牌区 + 「新建对话」+ 会话（标题/时间/归档 badge）+
 *   底部「← Dashboard」（Link to /admin）；
 * - 右侧对话区：消息流（user 右对齐 / assistant 左对齐 + tool_calls 折叠展示 +
 *   system 工具结果居中小字）+ Composer（textarea Enter 发送 + 模型 Select +
 *   附件按钮占位 + Skills/MCP 快捷 chip）；
 * - REST：/api/v1/agents/sessions*（创建/列表/消息/发送）；SSE 订阅 `agent:{sessionId}`
 *   实时追加（message.created），replay-gap 时整列表对账；
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

/** 单条消息气泡：user 右对齐 / assistant 左对齐（tool_calls 折叠）/ system 居中小字 */
function MessageBubble({ message }: { message: AgentMessage }): React.ReactNode {
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
        {message.usage !== undefined && (
          <div className="text-muted-foreground mt-1 text-[11px] opacity-70">
            tokens {message.usage.inputTokens} → {message.usage.outputTokens}
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 活动会话 id 的 ref（SSE 回调与 send 闭包读取现值，避免陈旧闭包） */
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

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

  /** 新建对话：惰性创建——清空活动会话，首条消息发送时才落会话（自动标题随之生效） */
  const startNewConversation = (): void => {
    setActiveId(null);
    setMessages([]);
  };

  /** 发送当前输入（无活动会话时先创建；首个「新对话」以消息前 30 字符自动改名） */
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
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openSession(s.id)}
              className={cn(
                'hover:bg-muted/60 w-full rounded-md px-2.5 py-2 text-left transition-colors',
                s.id === activeId && 'bg-muted',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{s.title}</span>
                {s.status === 'archived' && (
                  <Badge variant="outline" className="shrink-0 gap-0.5 px-1.5 text-[10px]">
                    <ArchiveIcon className="size-3" aria-hidden />
                    归档
                  </Badge>
                )}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs">
                {formatTime(s.last_message_at ?? s.created_at)}
              </span>
            </button>
          ))}
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
        {/* 头部：会话标题 + 归档态 + 连接状态点 */}
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{activeSession?.title ?? '新的对话'}</h1>
            {activeSession?.status === 'archived' && (
              <Badge variant="outline" className="shrink-0 text-[10px]">
                归档
              </Badge>
            )}
          </div>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <span
              className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
              aria-hidden
            />
            {connected ? '实时' : '离线'}
          </span>
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
            messages.map((m) => <MessageBubble key={m.id} message={m} />)
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
    </div>
  );
}
