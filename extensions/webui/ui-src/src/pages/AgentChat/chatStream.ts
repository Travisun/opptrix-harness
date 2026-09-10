/**
 * chatStream — Chat 前端流式发送管线（/chat 页消费 `POST /api/v1/agents/sessions/:id/messages/stream`）。
 *
 * 分层（全部零 React 依赖，可单测/可重放）：
 * - SSE 解析：`createSseFeeder` 按 `\n\n` 切帧、取 `data:` 前缀行（跳过空行/注释/非 data 行），
 *   以增量 feed 方式天然处理「跨 chunk 断行」；`\r\n` 归一化；end() 冲刷尾帧；
 * - 事件反序列化：`parseChatStreamEvent` 把 JSON payload 收敛为强类型事件（非法/未知 → null 跳过）；
 * - 纯函数 reducer：`applyChatStreamEvent(snapshot, event)` 折叠为
 *   `{phase, thinkingSegments[], replyDraft, toolSteps[], error}`，无副作用、可重放（同一事件序列
 *   从初始快照重放结果恒等）；
 * - 代数防串台：`createStreamGen` 单调递增代数——发送/会话切换开启新代，闭包持旧代比对，
 *   过期事件直接丢弃（会话切换后晚到的 done/error 不会污染新会话状态）；
 * - 传输层：`streamSessionMessage` fetch POST + body.getReader() 增量解码（借鉴 Opptrix
 *   streamSessionChat 的解析思路），错误分为 ChatStreamHttpError（含 status，404 → 降级回退旧
 *   POST /messages）/ ChatStreamNetworkError / AbortError（Stop 按钮 abort → 断开即服务端取消）。
 *
 * 事件契约（与内核流式端点对齐）：
 * - `{type:'thinking', round, segmentIndex, content}`：reasoning 增量（节流后），按 segmentIndex
 *   累积进 thinkingSegments；
 * - `{type:'reply', content, estimatedTokens, draft:true}`：回复增量（节流后），content 为累计草稿
 *   （直接整体替换 replyDraft，不叠加）；
 * - `{type:'tool_start', step:{id,tool,label,status:'running',argsPreview,startedAt}}` /
 *   `{type:'tool_done', step:{…status:'done'|'error', resultPreview, error?}}`：按 step.id upsert；
 * - `{type:'done', message, usage, reasoningSegments}`：终态（message 为正式落库的助手消息记录，
 *   工具调用在其 toolCalls 里）；
 * - `{type:'error', message}`：终态失败。
 */

// ---------------------------------------------------------------------------
// 事件与快照契约
// ---------------------------------------------------------------------------

/** 工具步骤（流式 tool_start/tool_done 的 step 载荷） */
export interface ChatStreamToolStep {
  id: string;
  tool: string;
  label: string;
  status: 'running' | 'done' | 'error';
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
  startedAt?: string;
}

/** token 用量（done 事件；字段按可选消费，缺省回退 message.usage） */
export interface ChatStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** done 事件的最终助手消息（与 REST messages 的 AgentMessageRecord 同形，字段按可选消费） */
export interface ChatStreamFinalMessage {
  id: string;
  session_id?: string;
  role?: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ id: string; name: string; label?: string; arguments: string }>;
  usage?: ChatStreamUsage;
  reasoningSegments?: string[];
  created_at?: number;
}

/** 流式事件强类型（parseChatStreamEvent 的输出形状） */
export type ChatStreamEvent =
  | { type: 'thinking'; round: number; segmentIndex: number; content: string }
  | { type: 'reply'; content: string; estimatedTokens: number | null; draft: boolean }
  | { type: 'tool_start'; step: ChatStreamToolStep }
  | { type: 'tool_done'; step: ChatStreamToolStep }
  | { type: 'done'; message: ChatStreamFinalMessage; usage: ChatStreamUsage | null; reasoningSegments: string[] }
  | { type: 'error'; message: string };

/** 流式折叠状态相位：connecting（已发出请求未见事件）→ thinking/replying（按事件推进）→ done | error */
export type ChatStreamPhase = 'connecting' | 'thinking' | 'replying' | 'done' | 'error';

/** 流式折叠快照（reducer 的状态载体；ThinkingPanel 直接消费） */
export interface ChatStreamSnapshot {
  phase: ChatStreamPhase;
  /** 思考分段（按 segmentIndex 累积；下标即分段序号） */
  thinkingSegments: string[];
  /** 回复累计草稿（reply 事件整体替换） */
  replyDraft: string;
  /** 最近一次 reply 事件的估算 token（无则 null，不残留旧值） */
  estimatedTokens: number | null;
  /** 工具步骤（按 step.id upsert，保持首现顺序） */
  toolSteps: ChatStreamToolStep[];
  /** error 事件的错误消息（phase==='error' 时非空） */
  error: string | null;
  /** 最近一次 thinking 事件的轮次 */
  round: number;
  /** done 终态产物：正式助手消息（入列消息流用） */
  finalMessage: ChatStreamFinalMessage | null;
  /** done 终态用量（优先事件级 usage，回退 message.usage） */
  finalUsage: ChatStreamUsage | null;
  /** done 终态思考分段（优先事件级 reasoningSegments，回退流式累积） */
  finalReasoningSegments: string[];
}

/** 初始快照（每次发送前重置） */
export function createInitialChatStreamSnapshot(): ChatStreamSnapshot {
  return {
    phase: 'connecting',
    thinkingSegments: [],
    replyDraft: '',
    estimatedTokens: null,
    toolSteps: [],
    error: null,
    round: 0,
    finalMessage: null,
    finalUsage: null,
    finalReasoningSegments: [],
  };
}

// ---------------------------------------------------------------------------
// 纯函数 reducer（可单测、可重放）
// ---------------------------------------------------------------------------

/**
 * applyChatStreamEvent — 折叠单个流式事件进快照（纯函数：不修改入参，返回新快照）。
 * 未知事件类型原样返回（前向兼容新事件名）。相位推进单调：connecting < thinking < replying，
 * thinking 不把 replying 打回思考态（新一轮思考仍累积分段，仅状态头不再回切）。
 */
export function applyChatStreamEvent(snapshot: ChatStreamSnapshot, event: ChatStreamEvent): ChatStreamSnapshot {
  switch (event.type) {
    case 'thinking': {
      const idx = Math.max(0, Math.floor(event.segmentIndex));
      const segments = [...snapshot.thinkingSegments];
      while (segments.length <= idx) segments.push('');
      segments[idx] = segments[idx] + event.content;
      return {
        ...snapshot,
        phase: snapshot.phase === 'replying' ? 'replying' : 'thinking',
        thinkingSegments: segments,
        round: event.round,
      };
    }
    case 'reply':
      return {
        ...snapshot,
        phase: snapshot.phase === 'done' || snapshot.phase === 'error' ? snapshot.phase : 'replying',
        replyDraft: event.content,
        estimatedTokens: event.estimatedTokens,
      };
    case 'tool_start': {
      const exists = snapshot.toolSteps.some((s) => s.id === event.step.id);
      return {
        ...snapshot,
        phase: snapshot.phase === 'done' || snapshot.phase === 'error' ? snapshot.phase : snapshot.phase === 'replying' ? 'replying' : 'thinking',
        toolSteps: exists
          ? snapshot.toolSteps.map((s) => (s.id === event.step.id ? { ...s, ...event.step, status: 'running' } : s))
          : [...snapshot.toolSteps, event.step],
      };
    }
    case 'tool_done': {
      const exists = snapshot.toolSteps.some((s) => s.id === event.step.id);
      return {
        ...snapshot,
        toolSteps: exists
          ? snapshot.toolSteps.map((s) => (s.id === event.step.id ? { ...s, ...event.step } : s))
          : [...snapshot.toolSteps, event.step],
      };
    }
    case 'done': {
      const segments = event.reasoningSegments.length > 0 ? event.reasoningSegments : snapshot.thinkingSegments;
      return {
        ...snapshot,
        phase: 'done',
        finalMessage: event.message,
        finalUsage: event.usage ?? event.message.usage ?? null,
        finalReasoningSegments: segments.filter((s) => s.trim() !== ''),
      };
    }
    case 'error':
      return { ...snapshot, phase: 'error', error: event.message };
    default:
      return snapshot;
  }
}

// ---------------------------------------------------------------------------
// SSE 帧解析（跨 chunk 断行安全）
// ---------------------------------------------------------------------------

export interface SseFeeder {
  /** 喂入一个网络 chunk（内部缓冲，按 \n\n 切完整帧） */
  feed(chunk: string): void;
  /** 流结束：冲刷残余缓冲（服务端最后一帧未带 \n\n 收尾时兜底） */
  end(): void;
}

/**
 * createSseFeeder — 增量 SSE 解析：feed 任意分块的文本，每凑齐一帧（\n\n 分隔）即对该帧内
 * 每条 `data:` 行回调 onData（payload 为 `data:` 之后的 JSON 文本）。空行、注释行（`:` 开头）、
 * `event:`/`id:` 等非 data 行一律跳过；`\r\n` 行尾归一化。
 */
export function createSseFeeder(onData: (payload: string) => void): SseFeeder {
  let buffer = '';
  const dispatch = (frame: string): void => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.charAt(5) === ' ' ? line.slice(6) : line.slice(5);
      if (payload.trim() === '') continue;
      onData(payload);
    }
  };
  return {
    feed(chunk: string): void {
      buffer = (buffer + chunk).replace(/\r\n/g, '\n');
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) dispatch(frame);
    },
    end(): void {
      const tail = buffer.replace(/\r\n/g, '\n');
      buffer = '';
      if (tail.trim() !== '') dispatch(tail);
    },
  };
}

// ---------------------------------------------------------------------------
// 事件反序列化（JSON payload → 强类型；非法/未知 → null）
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 预览载荷收敛：字符串原样；对象/数组 → JSON 文本（服务端字段形状漂移的防御） */
function coercePreview(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function coerceStep(raw: unknown): ChatStreamToolStep | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id);
  if (id === '') return null;
  const statusRaw = asString(obj.status);
  const status: ChatStreamToolStep['status'] =
    statusRaw === 'done' || statusRaw === 'error' ? statusRaw : 'running';
  const step: ChatStreamToolStep = {
    id,
    tool: asString(obj.tool),
    label: asString(obj.label),
    status,
  };
  const args = coercePreview(obj.argsPreview);
  if (args !== undefined) step.argsPreview = args;
  const result = coercePreview(obj.resultPreview);
  if (result !== undefined) step.resultPreview = result;
  const error = coercePreview(obj.error);
  if (error !== undefined) step.error = error;
  if (typeof obj.startedAt === 'string') step.startedAt = obj.startedAt;
  return step;
}

function coerceFinalMessage(raw: unknown): ChatStreamFinalMessage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = asString(obj.id);
  if (id === '') return null;
  const msg: ChatStreamFinalMessage = { id, content: asString(obj.content) };
  if (typeof obj.session_id === 'string') msg.session_id = obj.session_id;
  // done.message 语义上是助手消息记录：缺省/非法 role 兜底 assistant
  msg.role = obj.role === 'user' || obj.role === 'system' ? obj.role : 'assistant';
  if (Array.isArray(obj.toolCalls)) {
    const calls: ChatStreamFinalMessage['toolCalls'] = [];
    for (const tc of obj.toolCalls) {
      if (tc === null || typeof tc !== 'object') continue;
      const o = tc as Record<string, unknown>;
      const tcId = asString(o.id);
      if (tcId === '') continue;
      calls.push({
        id: tcId,
        name: asString(o.name),
        label: typeof o.label === 'string' ? o.label : undefined,
        arguments: asString(o.arguments),
      });
    }
    msg.toolCalls = calls;
  }
  if (obj.usage !== null && typeof obj.usage === 'object') {
    const u = obj.usage as Record<string, unknown>;
    msg.usage = {
      inputTokens: asNumber(u.inputTokens) ?? undefined,
      outputTokens: asNumber(u.outputTokens) ?? undefined,
      totalTokens: asNumber(u.totalTokens) ?? undefined,
    };
  }
  const reasoning = asStringArray(obj.reasoningSegments);
  if (reasoning.length > 0) msg.reasoningSegments = reasoning;
  if (typeof obj.created_at === 'number') msg.created_at = obj.created_at;
  return msg;
}

function coerceUsage(raw: unknown): ChatStreamUsage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const usage: ChatStreamUsage = {
    inputTokens: asNumber(u.inputTokens) ?? undefined,
    outputTokens: asNumber(u.outputTokens) ?? undefined,
    totalTokens: asNumber(u.totalTokens) ?? undefined,
  };
  return usage;
}

/**
 * parseChatStreamEvent — SSE payload JSON → 强类型事件。
 * 非 JSON / 非对象 / 未知 type / 缺关键载荷（如 tool_start 无 step.id、done 无 message.id）→ null
 * （调用方静默跳过该帧，不让单帧脏数据毒化整条流）。
 */
export function parseChatStreamEvent(payload: string): ChatStreamEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  switch (obj.type) {
    case 'thinking':
      return {
        type: 'thinking',
        round: asNumber(obj.round) ?? 0,
        segmentIndex: asNumber(obj.segmentIndex) ?? 0,
        content: asString(obj.content),
      };
    case 'reply':
      return {
        type: 'reply',
        content: asString(obj.content),
        estimatedTokens: asNumber(obj.estimatedTokens),
        draft: obj.draft !== false,
      };
    case 'tool_start':
    case 'tool_done': {
      const step = coerceStep(obj.step);
      return step === null ? null : { type: obj.type, step };
    }
    case 'done': {
      const message = coerceFinalMessage(obj.message);
      if (message === null) return null;
      return {
        type: 'done',
        message,
        usage: coerceUsage(obj.usage),
        reasoningSegments: asStringArray(obj.reasoningSegments),
      };
    }
    case 'error':
      return { type: 'error', message: asString(obj.message) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 代数防串台（会话切换/重发丢弃过期事件）
// ---------------------------------------------------------------------------

export interface StreamGen {
  /** 开启新一代流式，返回新代数（旧代即刻过期） */
  begin(): number;
  /** 不开启新流也使当前代失效（会话切换时晚到事件按过期丢弃） */
  invalidate(): void;
  /** 事件携带的代数是否仍是当前代 */
  isCurrent(gen: number): boolean;
  /** 当前代数 */
  current(): number;
}

/** createStreamGen — 单调递增代数守卫：begin()/invalidate() 推进代数，isCurrent 判定事件归属 */
export function createStreamGen(): StreamGen {
  let gen = 0;
  return {
    begin: () => {
      gen += 1;
      return gen;
    },
    invalidate: () => {
      gen += 1;
    },
    isCurrent: (g: number) => g === gen,
    current: () => gen,
  };
}

// ---------------------------------------------------------------------------
// 传输层：fetch POST + body.getReader() 增量解析
// ---------------------------------------------------------------------------

/** 流式端点 HTTP 非 2xx（status===404 等触发降级回退旧 POST /messages） */
export class ChatStreamHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChatStreamHttpError';
    this.status = status;
  }
}

/** 网络层失败（连接建立失败 / 读流中途断开） */
export class ChatStreamNetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ChatStreamNetworkError';
    this.cause = cause;
  }
}

export function isChatStreamHttpError(err: unknown): err is ChatStreamHttpError {
  return err instanceof ChatStreamHttpError;
}

export function isChatStreamNetworkError(err: unknown): err is ChatStreamNetworkError {
  return err instanceof ChatStreamNetworkError;
}

/** AbortError 判定（Stop 按钮 abort / 页面导航中断；DOMException 在 Node 18+ 与浏览器均可用） */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export interface StreamSessionMessageRequest {
  /** Bearer 凭据（空串则不带 authorization 头） */
  token: string;
  sessionId: string;
  content: string;
  /** 事件回调（仅强类型合法事件；单帧解析失败静默跳过） */
  onEvent: (event: ChatStreamEvent) => void;
  /** Stop/导航中断：abort() 断开连接即服务端取消生成 */
  signal?: AbortSignal;
  /** payload 反序列化器（默认 parseChatStreamEvent；测试可注入桩） */
  parse?: (payload: string) => ChatStreamEvent | null;
  /** 请求失败（含中途断线）回调（随后仍会抛出；调用方可用于埋点/提示） */
  onError?: (err: unknown) => void;
}

/**
 * streamSessionMessage — 流式发送一条消息并消费 SSE 事件直到 done/error/断开。
 *
 * - POST /api/v1/agents/sessions/:id/messages/stream {content}，Accept: text/event-stream；
 * - 响应非 2xx → ChatStreamHttpError（保留 status，404 由调用方降级回退旧 POST /messages）；
 * - 传输失败 → ChatStreamNetworkError；abort → 原样抛出 AbortError（调用方按「用户停止」处理，
 *   不降级重发）；onError 在抛出前回调（断线/错误观察点）。
 */
export async function streamSessionMessage(req: StreamSessionMessageRequest): Promise<void> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (req.token !== '') headers['authorization'] = `Bearer ${req.token}`;
  let res: Response;
  try {
    res = await fetch(`/api/v1/agents/sessions/${encodeURIComponent(req.sessionId)}/messages/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: req.content }),
      signal: req.signal,
    });
  } catch (e) {
    if (isAbortError(e)) throw e;
    const err = new ChatStreamNetworkError(e instanceof Error ? e.message : '网络错误', e);
    req.onError?.(err);
    throw err;
  }
  if (!res.ok) {
    const err = new ChatStreamHttpError(res.status, `流式端点返回 ${res.status}`);
    req.onError?.(err);
    throw err;
  }
  if (res.body === null) {
    const err = new ChatStreamNetworkError('流式响应不可用（无 body）');
    req.onError?.(err);
    throw err;
  }
  const parse = req.parse ?? ((payload: string) => parseChatStreamEvent(payload));
  const feeder = createSseFeeder((payload) => {
    const event = parse(payload);
    if (event !== null) req.onEvent(event);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    if (req.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (isAbortError(e)) throw e;
      const err = new ChatStreamNetworkError(e instanceof Error ? e.message : '流式连接中断', e);
      req.onError?.(err);
      throw err;
    }
    if (chunk.done) break;
    feeder.feed(decoder.decode(chunk.value, { stream: true }));
  }
  feeder.end();
}

// ---------------------------------------------------------------------------
// 展示辅助
// ---------------------------------------------------------------------------

/**
 * formatTokenCount — 自适应数量单位（约 1.2k 格式）：
 * <1000 整数；≥1k → 1.2k；≥1M → 1.1M（一位小数，整数则不带小数点）。
 */
export function formatTokenCount(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value >= 1_000_000) {
    const m = Math.round((value / 1_000_000) * 10) / 10;
    return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  const k = Math.round((value / 1000) * 10) / 10;
  return `${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
}

/** usage → 总 token（totalTokens 优先，缺省 input+output 求和） */
export function usageTotalTokens(usage: ChatStreamUsage | null | undefined): number {
  if (usage === null || usage === undefined) return 0;
  if (typeof usage.totalTokens === 'number') return usage.totalTokens;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}
