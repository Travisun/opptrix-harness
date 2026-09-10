/**
 * agents/session — Agent 会话管理器（类 Codex 全屏 Chat 的内核子系统）。
 *
 * 职责边界：
 * - 会话/消息的 CRUD 委托 deps.store（AgentSessionStore 或结构兼容替身）；
 * - sendMessage：user 消息落库 → 组装上下文（会话系统提示 + 最近 50 条消息 + 系统 MCP
 *   工具 schemas）→ createSessionRunner(runner.ts 的 runAgentLoop) 执行「对话 ↔ 工具」
 *   循环 → 工具调用轨迹 + 最终 assistant 回复落库 → SSE topic `agent:{sessionId}`
 *   实时推送（message.created / generation.cancelled）→ 返回最终 assistant 消息；
 * - 模型解析链：会话显式 model → settings 'agents.defaultModel' → 第一可用 provider
 *   的 models[0]（经 gateway.getProviders）；全链落空 → undefined 透传（沿用网关既有
 *   路由语义，不可路由时 LLM_MODEL_NOT_FOUND）；
 * - 取消：每个进行中的生成挂 AbortController（cancelGeneration 中断；中断的 sendMessage
 *   收敛为 SERVICE_UNAVAILABLE，调用方可据此提示「已取消」）；
 * - 同一会话的生成互斥：已在生成中再发消息 → TOO_MANY_CONCURRENT（429）。
 * 不做：模型路由/回退（gateway 既有语义）、工具实现（系统 MCP 工具目录）、
 * 会话标题的 LLM 自动生成（UI 侧以首条 user 消息前 30 字符自动改名）。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { err } from '../errors/index.js';
import type { LlmChatInput, LlmChatResult, LlmProviderConfig, LlmStreamEvent } from '../llm/index.js';
import type { WorkspaceResolveResult, WorkspaceService } from '../workspace/index.js';
import {
  createSessionRunner,
  type SessionRunner,
  type SessionRunnerInput,
  type SystemToolRuntimeLike,
} from './session-runner.js';
import {
  AgentSessionStore,
  type AgentMessageRecord,
  type AgentMessageRole,
  type AgentMessageToolCall,
  type AgentMessageUsage,
  type AgentSessionListFilter,
  type AgentSessionPatch,
  type AgentSessionRecord,
  type AgentSessionStatus,
} from './session-store.js';

export {
  AGENT_MESSAGES_TABLE,
  AGENT_SESSIONS_TABLE,
  AGENT_SESSION_STATUSES,
  AgentSessionStore,
} from './session-store.js';
export type {
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageToolCall,
  AgentMessageUsage,
  AgentSessionListFilter,
  AgentSessionPatch,
  AgentSessionRecord,
  AgentSessionStatus,
} from './session-store.js';
export { createSessionRunner } from './session-runner.js';
export type { SessionRunner, SessionRunnerDeps, SessionRunnerInput } from './session-runner.js';

/** 会话标题缺省值 */
export const DEFAULT_SESSION_TITLE = '新对话';

/** 会话缺省模型的 settings 键（模型解析链第二级） */
export const AGENTS_DEFAULT_MODEL_SETTINGS_KEY = 'agents.defaultModel';

/** 组装上下文时携带的最近消息条数（含当前 user 消息） */
export const CONTEXT_MESSAGE_LIMIT = 50;

/** SSE topic 前缀：`agent:{sessionId}`（实时推送 message.created / generation.cancelled） */
export function agentSessionTopic(sessionId: string): string {
  return `agent:${sessionId}`;
}

/** SSE 事件名：新消息落库（user / assistant / system 轨迹） */
export const AGENT_SESSION_EVENT_MESSAGE = 'message.created';

/** SSE 事件名：生成被取消（无最终 assistant 回复） */
export const AGENT_SESSION_EVENT_CANCELLED = 'generation.cancelled';

/** 会话循环执行器依赖的网关最小视图（真实 LlmGateway.chat 天然满足） */
export interface AgentSessionGateway {
  chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>>;
  /** 供应商配置目录（模型解析链第三级用） */
  getProviders(): Promise<LlmProviderConfig[]>;
}

/** settings 服务的最小结构视图（真实 SettingsService 天然满足） */
export interface AgentSessionSettings {
  get<T>(key: string, fallback?: T): Promise<T | undefined>;
}

/** SSE 广播门面（fire-and-forget；core-services 以 hub.publish 闭包注入） */
export interface AgentSessionPublisher {
  (topic: string, event: string, data: unknown): void;
}

/** AgentSessionManager 依赖集合 */
export interface AgentSessionManagerDeps {
  /** 会话/消息持久化存储 */
  store: AgentSessionStore;
  /** LLM 网关（chat + providers 目录） */
  gateway: AgentSessionGateway;
  /** 内核设置存储（'agents.defaultModel' 读取） */
  settings: AgentSessionSettings;
  /** 内核 pino logger */
  logger: Logger;
  /** 系统工具运行时取值器（缺省 = 本次无工具；core-services 传 currentSystemRuntime） */
  systemRuntime?: () => SystemToolRuntimeLike | undefined;
  /** SSE 广播门面（缺省 = 不推送） */
  publish?: AgentSessionPublisher;
  /**
   * 会话工作区服务取值器（缺省 = resolveWorkspace 抛 INTERNAL；core-services 装配传
   * workspaceService 惰性门面——装配时序上工作区与会话子系统同段构造，getter 规避互指）。
   */
  workspace?: () => WorkspaceService;
  /** 循环迭代上限缺省值（透传 runAgentLoop；缺省 16） */
  maxIterations?: number;
  /** 迭代间让出（透传 runAgentLoop；测试可注入空实现加速） */
  sleep?: (ms: number) => Promise<void>;
}

/** 中断错误判定（runner 约定 name === 'AbortError'，不新增错误码） */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** 历史消息 → 上下文文本（角色前缀中文标注；system（工具结果）不进历史——噪声大于收益） */
function historyToText(history: AgentMessageRecord[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const speaker = m.role === 'user' ? '用户' : '助手';
    const toolNote =
      m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0
        ? `（调用了工具 ${m.toolCalls.map((tc) => tc.name).join('、')}）`
        : '';
    const text = m.content === '' ? toolNote : `${toolNote}${m.content}`;
    lines.push(`${speaker}：${text}`);
  }
  return lines.join('\n');
}

/**
 * Agent 会话管理器（见模块头注释）。全部依赖注入，本类无外部副作用之外的自身状态
 * （仅生成中的 AbortController 内存登记）。
 */
export class AgentSessionManager {
  readonly #deps: AgentSessionManagerDeps;
  /** 会话循环执行器（createSessionRunner 包装 runAgentLoop） */
  readonly #runner: SessionRunner;
  /** sessionId → 进行中生成的 AbortController（仅生成期间存在） */
  readonly #generating = new Map<string, AbortController>();

  constructor(deps: AgentSessionManagerDeps) {
    this.#deps = deps;
    this.#runner = createSessionRunner({
      gateway: deps.gateway,
      ...(deps.systemRuntime !== undefined ? { systemRuntime: deps.systemRuntime } : {}),
      logger: deps.logger,
      ...(deps.maxIterations !== undefined ? { maxIterations: deps.maxIterations } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // 会话 CRUD
  // ---------------------------------------------------------------------------

  /**
   * 创建会话（title 缺省 '新对话'；model/systemPrompt 缺省 null = 运行期解析/runner 缺省）。
   *
   * - userId：属主落库（null = system 会话；REST 层从 checker identity 注入，不收请求体）；
   * - parentId：父会话存在性软校验（不存在 → EXT_NOT_FOUND 404 形状），通过后落库——
   *   子会话不建工作区目录，经 parent 链解析到根会话的工作区。
   */
  async createSession(
    input: {
      title?: string;
      model?: string;
      systemPrompt?: string;
      userId?: string | null;
      parentId?: string;
    } = {},
  ): Promise<AgentSessionRecord> {
    let parentId: string | null = null;
    if (input.parentId !== undefined) {
      const parent = await this.#deps.store.getSession(input.parentId);
      if (parent === null) {
        throw err('EXT_NOT_FOUND', {
          message: `parent agent session "${input.parentId}" not found`,
          detail: { parentId: input.parentId },
        });
      }
      parentId = parent.id;
    }
    const now = Date.now();
    const record: AgentSessionRecord = {
      id: randomUUID(),
      title: input.title ?? DEFAULT_SESSION_TITLE,
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
      last_message_at: null,
      userId: input.userId ?? null,
      parentId,
    };
    await this.#deps.store.createSession(record);
    return record;
  }

  /** 列出会话（按最后消息时间降序；filter.status / filter.userId 可选过滤） */
  listSessions(filter?: AgentSessionListFilter): Promise<AgentSessionRecord[]> {
    return this.#deps.store.listSessions(filter);
  }

  /** 按 ID 读取会话；不存在返回 null */
  getSession(id: string): Promise<AgentSessionRecord | null> {
    return this.#deps.store.getSession(id);
  }

  /** 部分更新会话（title/status）；不存在返回 null */
  async updateSession(id: string, patch: AgentSessionPatch): Promise<AgentSessionRecord | null> {
    return this.#deps.store.updateSession(id, patch);
  }

  /** 删除会话（级联删除全部消息）；返回是否确有删除 */
  async deleteSession(id: string): Promise<boolean> {
    return this.#deps.store.deleteSession(id);
  }

  // ---------------------------------------------------------------------------
  // 所有权与工作区
  // ---------------------------------------------------------------------------

  /**
   * 会话访问权断言（REST 会话级端点的统一闸；不存在 → EXT_NOT_FOUND 404，越权 → FORBIDDEN 403）。
   *
   * 所有权矩阵：
   * - role root / admin → 全通；
   * - session.userId === identity.userId → 放行（本人的会话）；
   * - session.userId 为 null（system 会话）→ 仅 root/admin；
   * - 其余（他人会话 / 无身份）→ FORBIDDEN。
   *
   * @returns 命中的会话记录（调用方可免二次查询）
   */
  async assertAccess(
    sessionId: string,
    identity?: { userId?: string; role?: string },
  ): Promise<AgentSessionRecord> {
    const session = await this.#assertSession(sessionId);
    const privileged = identity?.role === 'root' || identity?.role === 'admin';
    if (privileged) return session;
    if (session.userId !== null && identity?.userId !== undefined && session.userId === identity.userId) {
      return session;
    }
    throw err('FORBIDDEN', {
      message: `access to agent session "${sessionId}" is forbidden (owner: ${session.userId ?? 'system'})`,
      detail: { sessionId, ownerUserId: session.userId },
    });
  }

  /**
   * 解析 scopeId（会话 id 或 subagent id）→ 根会话工作区（委托 WorkspaceService；
   * 子会话/子代理沿 parent 链继承根会话的工作区，目录只在根会话名下）。
   *
   * @throws VALIDATION_FAILED scopeId 非法 / 链成环或超深
   * @throws EXT_NOT_FOUND scopeId 未命中（404 形状）
   * @throws INTERNAL 装配未注入工作区服务
   */
  async resolveWorkspace(scopeId: string): Promise<WorkspaceResolveResult> {
    const workspace = this.#deps.workspace;
    if (workspace === undefined) {
      throw err('INTERNAL', {
        message: 'workspace service is not wired into AgentSessionManager (deps.workspace missing)',
        detail: { scopeId },
      });
    }
    return workspace().resolve(scopeId);
  }

  // ---------------------------------------------------------------------------
  // 消息
  // ---------------------------------------------------------------------------

  /** 追加一条消息（同时触碰会话 last_message_at/updated_at；会话不存在抛 EXT_NOT_FOUND） */
  async addMessage(
    sessionId: string,
    input: { role: AgentMessageRole; content: string; toolCalls?: AgentMessageToolCall[]; usage?: AgentMessageUsage },
  ): Promise<AgentMessageRecord> {
    await this.#assertSession(sessionId);
    return this.#deps.store.addMessage(sessionId, input);
  }

  /**
   * 读取会话消息（升序）。`before` 为消息 id 游标（取严格早于它的最近 limit 条），
   * limit 缺省 50、上限 500；会话不存在抛 EXT_NOT_FOUND。
   */
  async getMessages(
    sessionId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<AgentMessageRecord[]> {
    await this.#assertSession(sessionId);
    return this.#deps.store.getMessages(sessionId, opts);
  }

  // ---------------------------------------------------------------------------
  // sendMessage / cancelGeneration
  // ---------------------------------------------------------------------------

  /**
   * 发送一条用户消息并驱动 LLM 回复（见模块头注释）。
   *
   * @returns 最终 assistant 消息记录（工具调用轨迹 + 最终文本均已落库）
   * @throws EXT_NOT_FOUND 会话不存在
   * @throws BAD_REQUEST 消息内容为空
   * @throws TOO_MANY_CONCURRENT 该会话已有生成在进行
   * @throws SERVICE_UNAVAILABLE 生成被 cancelGeneration 中断
   * @throws LLM_* 网关/路由失败（原样上抛）
   */
  async sendMessage(sessionId: string, userMessage: string): Promise<AgentMessageRecord> {
    // 生成互斥：check-and-set 同步完成（其间无 await），并发窗口不存在
    if (this.#generating.has(sessionId)) {
      throw err('TOO_MANY_CONCURRENT', {
        message: `a generation is already in progress for session "${sessionId}"`,
        detail: { sessionId },
      });
    }
    const controller = new AbortController();
    this.#generating.set(sessionId, controller);
    try {
      const session = await this.#assertSession(sessionId);
      const content = typeof userMessage === 'string' ? userMessage.trim() : '';
      if (content === '') {
        throw err('BAD_REQUEST', { message: 'message content is required', detail: { field: 'content' } });
      }

      // 1. user 消息落库 + 实时推送
      const userMsg = await this.#deps.store.addMessage(sessionId, { role: 'user', content });
      this.#publishMessage(userMsg);

      // 2. 组装上下文：历史（最近 50 条，含刚入库的 user 消息）→ 人类可读文本 + 当前消息
      const history = await this.#deps.store.getMessages(sessionId, { limit: CONTEXT_MESSAGE_LIMIT });
      const priorText = historyToText(history.slice(0, -1));
      const prompt =
        priorText === ''
          ? content
          : `（以下是本会话的历史消息，供理解上下文参考）\n${priorText}\n\n（当前用户消息）${content}`;

      // 3. 模型解析链：会话显式 → settings → 第一可用 provider models[0]
      const model = await this.#resolveModel(session);

      // 4. Agent 循环（runner.ts 语义：工具调用执行/失败回填/收束）
      const input: SessionRunnerInput = {
        agentId: sessionId,
        depth: 0,
        prompt,
        signal: controller.signal,
        ...(session.systemPrompt !== null ? { systemPrompt: session.systemPrompt } : {}),
        ...(model !== undefined ? { model } : {}),
      };
      const result = await this.#runner(input);

      // 5. 工具调用轨迹落库（assistant 工具调用轮 + tool 结果以 system 角色落库）
      await this.#persistTrajectory(sessionId, result.messages);

      // 6. 最终 assistant 回复落库（含累计 usage）+ 实时推送
      const assistantMsg = await this.#deps.store.addMessage(sessionId, {
        role: 'assistant',
        content: result.finalText,
        usage: result.usage,
      });
      this.#publishMessage(assistantMsg);
      return assistantMsg;
    } catch (e) {
      if (isAbortError(e)) {
        this.#deps.publish?.(agentSessionTopic(sessionId), AGENT_SESSION_EVENT_CANCELLED, { sessionId });
        throw err('SERVICE_UNAVAILABLE', {
          message: `generation for session "${sessionId}" was cancelled`,
          detail: { sessionId },
        });
      }
      throw e;
    } finally {
      this.#generating.delete(sessionId);
    }
  }

  /**
   * 取消会话进行中的生成（AbortController 中断；runner 在最近的中断检查点收敛）。
   * 返回是否确有取消（无进行中生成返回 false，幂等）。
   */
  cancelGeneration(sessionId: string): boolean {
    const controller = this.#generating.get(sessionId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  /** 会话是否有进行中的生成（诊断/测试用） */
  isGenerating(sessionId: string): boolean {
    return this.#generating.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 会话存在性断言（不存在 → EXT_NOT_FOUND → 404 HARNESS-3004） */
  async #assertSession(sessionId: string): Promise<AgentSessionRecord> {
    const session = await this.#deps.store.getSession(sessionId);
    if (session === null) {
      throw err('EXT_NOT_FOUND', {
        message: `agent session "${sessionId}" not found`,
        detail: { id: sessionId },
      });
    }
    return session;
  }

  /** 模型解析链：显式 model → settings 'agents.defaultModel' → 第一可用 provider models[0] */
  async #resolveModel(session: AgentSessionRecord): Promise<string | undefined> {
    let model = session.model ?? undefined;
    if (model === undefined || model === '') {
      const configured = await this.#deps.settings.get<string>(AGENTS_DEFAULT_MODEL_SETTINGS_KEY, '');
      if (typeof configured === 'string' && configured !== '') model = configured;
    }
    if (model === undefined || model === '') {
      const providers = await this.#deps.gateway.getProviders();
      model = providers.find((p) => p.models.length > 0)?.models[0];
    }
    return model;
  }

  /** 循环轨迹落库：assistant 工具调用轮原样落（toolCalls JSON），tool 结果以 system 角色落 */
  async #persistTrajectory(sessionId: string, messages: unknown[]): Promise<void> {
    for (const raw of messages.slice(2)) {
      // 前两条为 runner 组装的 system 提示与 user 提示（装配态，非用户原始消息；不重复落库）
      const m = raw as { role?: unknown; content?: unknown };
      if (m.role === 'assistant') {
        const rich = (m.content ?? {}) as { text?: unknown; toolCalls?: unknown };
        const text = typeof rich.text === 'string' ? rich.text : '';
        const toolCalls = Array.isArray(rich.toolCalls) ? (rich.toolCalls as AgentMessageToolCall[]) : [];
        if (toolCalls.length === 0) continue; // 非工具轮（防御；当前 runner 不产生）
        const record = await this.#deps.store.addMessage(sessionId, {
          role: 'assistant',
          content: text,
          toolCalls,
        });
        this.#publishMessage(record);
        continue;
      }
      if (m.role === 'tool') {
        const rich = (m.content ?? {}) as { toolCallId?: unknown; text?: unknown };
        const record = await this.#deps.store.addMessage(sessionId, {
          role: 'system',
          content: typeof rich.text === 'string' ? rich.text : '',
        });
        this.#publishMessage(record);
      }
    }
  }

  /** SSE 实时推送单条消息（fire-and-forget；publish 未注入时 no-op） */
  #publishMessage(record: AgentMessageRecord): void {
    this.#deps.publish?.(agentSessionTopic(record.session_id), AGENT_SESSION_EVENT_MESSAGE, record);
  }
}
