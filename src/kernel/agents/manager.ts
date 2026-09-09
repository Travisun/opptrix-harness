/**
 * subagent manager — 子代理编排（严格父子树 + 并发排队 + 取消/超时 + 持久化）。
 *
 * 职责边界：
 * - 持久化委托 deps.store（SubagentStore 或结构兼容替身），执行委托 deps.runner
 *   （集成方包装 runner.ts 的 runAgentLoop：循环回调映射到 onEvent）；
 * - 树约束：'main' 为根；子代理 depth = 父.depth + 1，超过 maxDepth 拒绝；
 *   每个直接父的子代数达到 maxChildrenPerParent 后拒绝——树在写入侧保持严格；
 * - 跨代禁令：transcript/result 只有直接父（或 main）可读（assertDirectParent）；
 *   REST 与（后续）MCP 工具都走它，兄弟/孙辈访问抛 FORBIDDEN；
 * - 并发：running 数达到 maxConcurrent 时 spawn 落 queued（不拒绝），
 *   任一运行中子代理到终态/被取消后由 #pump() 按 created_at FIFO 消化队列；
 *   queued 是持久化状态——进程重启后仍可被 pump 拾取（sweepTimeouts 或下一次终态触发），不丢失；
 * - 取消：running → cancelled 并经 AbortController 中断 runner（契约要求 runner
 *   响应 signal）；迟到事件按"行已非 running"丢弃；queued → cancelled 直接转移；
 * - 超时：每个 running 子代理挂 timeoutMs 定时器，到点 abort + failed('timeout')；
 *   另有 sweepTimeouts() 兜底清扫（覆盖进程重启遗留的 running 僵尸行，见方法注释）；
 * - 同一子代理的事件回调经每 id Promise 链串行化，progress/done/error 乱序到达也不会互相覆盖。
 */
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';
import {
  SUBAGENT_TERMINAL_STATUSES,
  type SubagentRecord,
  type SubagentRunner,
  type SubagentRunnerEvent,
  type SubagentSpawnInput,
  type SubagentStatus,
  type SubagentStoreLike,
} from './types.js';

/** 默认最大树深度（main→1→2 合法，depth 3 被拒） */
export const DEFAULT_MAX_DEPTH = 2;
/** 默认每个直接父的最大子代数 */
export const DEFAULT_MAX_CHILDREN_PER_PARENT = 8;
/** 默认全局并发上限（超出入队等待） */
export const DEFAULT_MAX_CONCURRENT = 8;
/** 默认子代理超时（毫秒） */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 600_000;
/** prompt 最大字节数（UTF-8；与 REST 层 64KB 上限一致） */
export const MAX_PROMPT_BYTES = 65_536;
/** waitFor 缺省总超时（毫秒） */
export const DEFAULT_WAIT_FOR_TIMEOUT_MS = 120_000;
/** waitFor 轮询间隔（毫秒） */
export const WAIT_FOR_POLL_MS = 50;
/** 通知正文截断长度（避免超大 result/error 撑爆通知渠道） */
const NOTIFY_BODY_MAX_CHARS = 1000;

/** SubagentManager 依赖集合 */
export interface SubagentManagerDeps {
  /** 子代理持久化存储（SubagentStore 结构兼容；测试可注入内存替身） */
  store: SubagentStoreLike;
  /**
   * 子代理执行器：集成方包装 runner.ts 的 runAgentLoop（循环回调映射到 onEvent）。
   * 必须响应 input.signal（abort 后尽快返回）；失败经 {type:'error'} 上报而非 reject。
   */
  runner: SubagentRunner;
  /** 内核 pino logger */
  logger: import('pino').Logger;
  /** 最大树深度（main 直接子代 = 1），默认 {@link DEFAULT_MAX_DEPTH} */
  maxDepth?: number;
  /** 每个直接父的最大子代数，默认 {@link DEFAULT_MAX_CHILDREN_PER_PARENT} */
  maxChildrenPerParent?: number;
  /** 全局并发上限（超出 queued 排队），默认 {@link DEFAULT_MAX_CONCURRENT} */
  maxConcurrent?: number;
  /** 单个子代理超时（毫秒），默认 {@link DEFAULT_SUBAGENT_TIMEOUT_MS} */
  timeoutMs?: number;
  /** 完成/失败通知器（可缺省）；send 抛错只记日志，不影响生命周期 */
  notify?: { send(input: { title: string; body: string; level?: 'info' | 'warn' | 'error' }): Promise<unknown> };
}

/** 运行中子代理的内存登记（AbortController + 超时定时器） */
interface RunningEntry {
  controller: AbortController;
  timer: NodeJS.Timeout | null;
}

export class SubagentManager {
  readonly #deps: SubagentManagerDeps;
  readonly #maxDepth: number;
  readonly #maxChildren: number;
  readonly #maxConcurrent: number;
  readonly #timeoutMs: number;
  /** agentId → 内存登记（仅 running 期间存在） */
  readonly #running = new Map<string, RunningEntry>();
  /** 同一子代理的事件/取消串行链（按到达序落库，乱序事件不互相覆盖） */
  readonly #chains = new Map<string, Promise<void>>();
  /** queued 子代理的 maxIterations 暂存（schema 无列不落库，进程重启后丢失——见 docs） */
  readonly #queuedMaxIterations = new Map<string, number>();
  /** 单调化后的最近 created_at（同毫秒 spawn 依次 +1，保证 created_at 严格递增 = FIFO 即 spawn 序） */
  #lastSpawnMs = 0;
  /** spawn/pump 共用临界区串行链（树校验 + 容量判定 + 落库/启动的原子性；错误被吞以保证链不断裂）。
   *  二者都做"读 running → 写"（判定并发槽），必须互斥，否则并发 spawn 与队列消化会超卖并发槽。 */
  #lockChain: Promise<void> = Promise.resolve();

  constructor(deps: SubagentManagerDeps) {
    this.#deps = deps;
    this.#maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.#maxChildren = deps.maxChildrenPerParent ?? DEFAULT_MAX_CHILDREN_PER_PARENT;
    this.#maxConcurrent = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#timeoutMs = deps.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  }

  /** 最大树深度（只读视图） */
  get maxDepth(): number {
    return this.#maxDepth;
  }

  /** 全局并发上限（只读视图） */
  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  /** 单个子代理超时阈值毫秒（只读视图） */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * 派生一个子代理。
   *
   * 树约束（违反抛 BAD_REQUEST）：
   * - parentId='main' → depth=1；否则 depth = 父.depth + 1，超过 maxDepth →
   *   `max subagent depth exceeded`；父不存在 → `parent subagent not found`；
   * - 父的现有子代数已达 maxChildrenPerParent → `max children per parent exceeded`。
   *
   * 并发语义：running 数达到 maxConcurrent 时**入队不拒绝**——记录以 status='queued'
   * 落库并立即返回；任一运行中子代理到终态/被取消后按 created_at FIFO 消化队列。
   * queued 是持久化状态：进程重启后仍会被 pump 拾取（sweepTimeouts 或下一次终态触发），不丢失。
   *
   * 执行语义：落库后 fire-and-forget 调用 deps.runner（不 await）；
   * done → result 落库 + info 通知；error → failed 落库 + error 通知；通知失败只记日志。
   *
   * @returns 落库后的记录快照（running 或 queued；终态经 get()/waitFor() 观察）
   */
  async spawn(input: SubagentSpawnInput): Promise<SubagentRecord> {
    if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
      throw err('BAD_REQUEST', { message: 'prompt is required', detail: { field: 'prompt' } });
    }
    if (Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw err('BAD_REQUEST', {
        message: `prompt exceeds ${MAX_PROMPT_BYTES} bytes`,
        detail: { field: 'prompt', maxBytes: MAX_PROMPT_BYTES },
      });
    }
    if (input.maxIterations !== undefined && (!Number.isInteger(input.maxIterations) || input.maxIterations < 1)) {
      throw err('BAD_REQUEST', {
        message: 'maxIterations must be a positive integer',
        detail: { field: 'maxIterations', got: input.maxIterations },
      });
    }
    // 临界区：树校验 + 子代数/容量判定 + 落库 必须原子（并发 spawn 不得超卖深度/子代/并发槽）。
    // run 只把失败抛给本次调用者；链的延伸吞错，保证后续 spawn 不被前序失败毒化。
    const run = this.#lockChain.then(() => this.#spawnInCriticalSection(input));
    this.#lockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 取消子代理：
   * - queued → cancelled 直接转移（pump 稍后扫到时按非 queued 跳过）；
   * - running → cancelled + 经 AbortController 中断 runner；迟到的 runner 事件按
   *   "行已非 running" 丢弃（状态转移先行落库，双保险）；
   * - 终态（done/failed/cancelled）→ 幂等返回 false，不重复转移。
   *
   * @returns 是否确有取消发生（不存在或已是终态返回 false）
   */
  async cancel(id: string): Promise<boolean> {
    const run = this.#chain(id, () => this.#cancelInChain(id));
    return run;
  }

  /** 按 ID 读取子代理记录（委托 store；树校验由调用方经 assertDirectParent 负责） */
  get(id: string): Promise<SubagentRecord | null> {
    return this.#deps.store.get(id);
  }

  /** 列出子代理记录（委托 store；支持 parentId/status/depth 过滤） */
  list(filter?: { parentId?: string; status?: SubagentStatus; depth?: number }): Promise<SubagentRecord[]> {
    return this.#deps.store.list(filter);
  }

  /**
   * 树校验（跨代禁令落点）：只有直接父（或 main）可读子代理的 transcript/result。
   *
   * - callerId='main' → 放行（主会话/外部 LLM 经 /mcp 调用时即为 main）；
   * - child.parent_id === callerId → 放行（直接父）；
   * - 其余（兄弟、孙辈、无关 id）→ FORBIDDEN
   *   `cross-generation or sibling access is not allowed (strict parent-child tree)`；
   * - child 不存在 → EXT_NOT_FOUND。
   *
   * REST 与（后续）MCP 工具都必须经本方法读取子代理内容（REST v1 对 list/get 元数据
   * 保持宽松，见 src/api/subagents.ts 注释；内容读取统一走此处强制）。
   */
  async assertDirectParent(childId: string, callerId: string): Promise<void> {
    const child = await this.#deps.store.get(childId);
    if (child === null) {
      throw err('EXT_NOT_FOUND', { message: `subagent "${childId}" not found`, detail: { id: childId } });
    }
    if (callerId === 'main' || child.parentId === callerId) return;
    throw err('FORBIDDEN', {
      message: 'cross-generation or sibling access is not allowed (strict parent-child tree)',
      detail: { childId, callerId, parentId: child.parentId },
    });
  }

  /** {@link assertDirectParent} 的可读别名（"只有直接父可读"的谓词形式） */
  assertParent(childId: string, callerParentId: string): Promise<void> {
    return this.assertDirectParent(childId, callerParentId);
  }

  /**
   * 轮询等待子代理到达终态（done/failed/cancelled），REST/工具用。
   *
   * @param id 子代理 id
   * @param timeoutMs 总超时毫秒，默认 {@link DEFAULT_WAIT_FOR_TIMEOUT_MS}；到点抛 RPC_TIMEOUT
   * @throws HarnessError（EXT_NOT_FOUND）子代理不存在（立即抛，不空等）
   * @throws HarnessError（RPC_TIMEOUT）超时未达终态
   */
  async waitFor(id: string, timeoutMs: number = DEFAULT_WAIT_FOR_TIMEOUT_MS): Promise<SubagentRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rec = await this.#deps.store.get(id);
      if (rec === null) {
        throw err('EXT_NOT_FOUND', { message: `subagent "${id}" not found`, detail: { id } });
      }
      if (SUBAGENT_TERMINAL_STATUSES.includes(rec.status)) return rec;
      if (Date.now() >= deadline) {
        throw err('RPC_TIMEOUT', {
          message: `waitFor: subagent "${id}" did not reach a terminal state within ${timeoutMs}ms`,
          detail: { id, timeoutMs, status: rec.status },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_POLL_MS));
    }
  }

  /**
   * 超时兜底清扫：running 且 startedAt + timeoutMs < now 的子代理 → failed('timeout')。
   *
   * 在册 running 子代理由每 id 定时器保证超时；本方法覆盖两类残留：
   * 1. 进程重启后仍在库里的 running 僵尸行（内存 controller 已丢）；
   * 2. 定时器路径异常时的兜底。
   * 幂等：重复调用对已清扫行无效果（行已非 running）。返回清扫数量。
   * 队列消化：清扫释放并发槽后触发一次 pump。
   */
  async sweepTimeouts(): Promise<number> {
    const now = Date.now();
    const running = await this.#deps.store.list({ status: 'running' });
    let swept = 0;
    for (const rec of running) {
      if (rec.startedAt === null) continue; // 无起点无法判定超时（防御跳过）
      if (rec.startedAt + this.#timeoutMs > now) continue;
      const error = `timeout: subagent exceeded ${this.#timeoutMs}ms`;
      await this.#deps.store.update(rec.id, { status: 'failed', error, finishedAt: now });
      this.#teardownRuntime(rec.id); // abort + 清定时器（迟到的 runner 事件按状态丢弃）
      swept += 1;
      this.#deps.logger.warn({ subagentId: rec.id }, '[subagents] swept timed-out subagent');
      await this.#notifySafely(rec.id, 'error', 'subagent timed out', error);
    }
    if (swept > 0) await this.#schedulePump();
    return swept;
  }

  // ---------------------------------------------------------------------------
  // 内部：spawn 临界区与执行
  // ---------------------------------------------------------------------------

  /** spawn 临界区（经 #lockChain 串行）：树校验 → 子代数校验 → 容量判定 → 落库 */
  async #spawnInCriticalSection(input: SubagentSpawnInput): Promise<SubagentRecord> {
    let depth: number;
    if (input.parentId === 'main') {
      depth = 1;
    } else {
      const parent = await this.#deps.store.get(input.parentId);
      if (parent === null) {
        throw err('BAD_REQUEST', {
          message: `parent subagent not found: "${input.parentId}"`,
          detail: { parentId: input.parentId },
        });
      }
      depth = parent.depth + 1;
      if (depth > this.#maxDepth) {
        throw err('BAD_REQUEST', {
          message: `max subagent depth exceeded (depth ${depth} > max ${this.#maxDepth})`,
          detail: { parentId: input.parentId, parentDepth: parent.depth, maxDepth: this.#maxDepth },
        });
      }
    }
    // 子代数上限对一切父（含 'main'）生效
    const siblings = await this.#deps.store.list({ parentId: input.parentId });
    if (siblings.length >= this.#maxChildren) {
      throw err('BAD_REQUEST', {
        message: `max children per parent exceeded (limit ${this.#maxChildren})`,
        detail: { parentId: input.parentId, children: siblings.length, maxChildrenPerParent: this.#maxChildren },
      });
    }

    const running = await this.#deps.store.list({ status: 'running' });
    const atCapacity = running.length >= this.#maxConcurrent;
    // created_at 单调化：同毫秒内的连续 spawn 依次 +1（临界区内串行，无并发冲突），
    // 使 list 的 (created_at, id) 排序与 spawn 顺序一致——否则同毫秒记录按随机 UUID
    // 决胜，排队消化顺序（FIFO）不确定。
    let now = Date.now();
    if (now <= this.#lastSpawnMs) now = this.#lastSpawnMs + 1;
    this.#lastSpawnMs = now;
    const record: SubagentRecord = {
      id: randomUUID(),
      parentId: input.parentId,
      depth,
      model: input.model ?? null,
      systemPrompt: input.systemPrompt ?? null,
      prompt: input.prompt,
      toolNames: input.toolNames ?? null,
      status: atCapacity ? 'queued' : 'running',
      result: null,
      error: null,
      transcript: null,
      usageIn: null,
      usageOut: null,
      createdAt: now,
      startedAt: atCapacity ? null : now,
      finishedAt: null,
    };
    await this.#deps.store.create(record);
    if (atCapacity) {
      if (input.maxIterations !== undefined) this.#queuedMaxIterations.set(record.id, input.maxIterations);
    } else {
      this.#execute(record, input.maxIterations);
    }
    return record;
  }

  /** 启动执行：登记 AbortController + 超时定时器 → fire-and-forget 调用 runner */
  #execute(record: SubagentRecord, maxIterations?: number): void {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      this.#onTimeout(record.id).catch((e: unknown) => {
        this.#deps.logger.error({ err: e, subagentId: record.id }, '[subagents] timeout handler failed');
      });
    }, this.#timeoutMs);
    timer.unref(); // 不阻进程退出
    this.#running.set(record.id, { controller, timer });

    // 契约上 runner 不 reject（失败经 error 事件上报）；此处仍兜底——runner 直接抛出时落 failed，
    // 保证不产生 unhandled rejection、记录不悬挂在 running。
    void Promise.resolve()
      .then(() =>
        this.#deps.runner(
          {
            agentId: record.id,
            depth: record.depth,
            ...(record.systemPrompt !== null ? { systemPrompt: record.systemPrompt } : {}),
            prompt: record.prompt,
            ...(record.model !== null ? { model: record.model } : {}),
            ...(record.toolNames !== null ? { toolNames: record.toolNames } : {}),
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            signal: controller.signal,
          },
          (e: SubagentRunnerEvent) => this.#dispatch(record.id, e),
        ),
      )
      .catch((e: unknown) =>
        this.#dispatch(record.id, { type: 'error', error: e instanceof Error ? e.message : String(e) }),
      );
  }

  /** 超时处理：running → failed('timeout') + abort（迟到的 runner 事件按状态丢弃） */
  async #onTimeout(id: string): Promise<void> {
    await this.#dispatch(id, { type: 'error', error: `timeout: subagent exceeded ${this.#timeoutMs}ms` });
  }

  // ---------------------------------------------------------------------------
  // 内部：事件处理（每 id 串行）
  // ---------------------------------------------------------------------------

  /** 事件入链：同一子代理的事件/取消按到达序串行处理 */
  #dispatch(id: string, event: SubagentRunnerEvent): Promise<void> {
    return this.#chain(id, () => this.#handleEvent(id, event));
  }

  /** 取消入链（与事件同一串行域，避免 cancel 与 done 竞态） */
  #chain<T>(id: string, step: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    const next = prev.then(step, step); // 前序失败（理论上不会）也不阻塞本步
    this.#chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 单个事件处理（行已非 running 时一律丢弃——cancel/sweep/前序终态已定局） */
  async #handleEvent(id: string, event: SubagentRunnerEvent): Promise<void> {
    const rec = await this.#deps.store.get(id);
    if (rec === null || rec.status !== 'running') return; // 迟到/已取消/已终态：丢弃
    switch (event.type) {
      case 'progress':
        // 无独立进度列：仅记日志（迭代号可观测），不触库
        this.#deps.logger.debug({ subagentId: id, iteration: event.iteration }, '[subagents] progress');
        return;
      case 'transcript':
        await this.#deps.store.update(id, { transcript: event.messages });
        return;
      case 'done': {
        const finishedAt = Date.now();
        await this.#deps.store.update(id, {
          status: 'done',
          result: event.result,
          usageIn: event.usageIn ?? null,
          usageOut: event.usageOut ?? null,
          finishedAt,
        });
        this.#teardownRuntime(id);
        this.#deps.logger.info({ subagentId: id }, '[subagents] done');
        await this.#notifySafely(id, 'info', 'subagent finished', event.result);
        await this.#schedulePump();
        return;
      }
      case 'error': {
        const finishedAt = Date.now();
        await this.#deps.store.update(id, { status: 'failed', error: event.error, finishedAt });
        this.#teardownRuntime(id);
        this.#deps.logger.error({ subagentId: id, error: event.error }, '[subagents] failed');
        await this.#notifySafely(id, 'error', 'subagent failed', event.error);
        await this.#schedulePump();
        return;
      }
    }
  }

  /** 取消处理（串行域内执行） */
  async #cancelInChain(id: string): Promise<boolean> {
    const rec = await this.#deps.store.get(id);
    if (rec === null) return false;
    if (rec.status !== 'queued' && rec.status !== 'running') return false; // 终态幂等
    await this.#deps.store.update(id, { status: 'cancelled', finishedAt: Date.now() });
    this.#queuedMaxIterations.delete(id); // queued 取消：暂存一并清理
    this.#teardownRuntime(id); // running 时 abort runner；迟到的 runner 事件按状态丢弃
    this.#deps.logger.info({ subagentId: id, from: rec.status }, '[subagents] cancelled');
    if (rec.status === 'running') await this.#schedulePump(); // 释放并发槽
    return true;
  }

  // ---------------------------------------------------------------------------
  // 内部：并发槽与队列消化
  // ---------------------------------------------------------------------------

  /** 队列消化入链（与 spawn 同一临界区串行；fire-and-forget） */
  #schedulePump(): Promise<void> {
    const run = this.#lockChain.then(() => this.#pump());
    this.#lockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 消化 queued 队列：并发槽空闲时按 created_at FIFO 启动（重新 get 防止取消竞态） */
  async #pump(): Promise<void> {
    const running = await this.#deps.store.list({ status: 'running' });
    let slots = this.#maxConcurrent - running.length;
    if (slots <= 0) return;
    const queued = await this.#deps.store.list({ status: 'queued' });
    for (const head of queued) {
      if (slots <= 0) break;
      const rec = await this.#deps.store.get(head.id); // 队列快照可能过期（被取消）
      if (rec === null || rec.status !== 'queued') {
        this.#queuedMaxIterations.delete(head.id); // 已取消/不存在：丢弃暂存
        continue;
      }
      const startedAt = Date.now();
      await this.#deps.store.update(rec.id, { status: 'running', startedAt });
      const maxIterations = this.#queuedMaxIterations.get(rec.id);
      this.#queuedMaxIterations.delete(rec.id);
      this.#execute({ ...rec, status: 'running', startedAt }, maxIterations);
      slots -= 1;
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：运行时登记与通知
  // ---------------------------------------------------------------------------

  /** 清理内存登记：清超时定时器 + abort controller + 移除映射 */
  #teardownRuntime(id: string): void {
    const entry = this.#running.get(id);
    if (entry === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.controller.abort();
    this.#running.delete(id);
  }

  /** 通知兜底：notify 未注入时跳过；send 抛错只记日志，绝不影响生命周期 */
  async #notifySafely(id: string, level: 'info' | 'warn' | 'error', title: string, body: string): Promise<void> {
    const notify = this.#deps.notify;
    if (notify === undefined) return;
    const clipped =
      body.length > NOTIFY_BODY_MAX_CHARS ? `${body.slice(0, NOTIFY_BODY_MAX_CHARS)}…(truncated)` : body;
    try {
      await notify.send({ title: `${title}: ${id}`, body: clipped, level });
    } catch (e) {
      this.#deps.logger.error({ err: e, subagentId: id }, '[subagents] notify failed');
    }
  }
}
