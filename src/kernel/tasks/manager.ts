/**
 * task manager — 长任务编排（状态机回调 + 取消 + 超时 sweep）。
 *
 * 职责边界：
 * - 持久化委托 {@link TaskStore}，执行委托 deps.pool（TaskWorkerPool 或测试替身），
 *   事件经 deps.emit（EventBus 语义：task.completed / task.failed），
 *   实时进度经 deps.publish（SSE 语义：topic 'tasks' / event 'task.progress'）；
 * - dispatch：落库 queued → pool.run 异步执行（立即返回记录，不等待完成）；
 *   状态机全部经 store.transition 条件更新推进（queued→running 在首个回调里补，
 *   保证"池满排队中的任务"在库里保持 queued，可被 cancel/sweep 正确区分）；
 * - 池无中断通道：cancel(running) 只落 cancelled 标记，迟到的池回调按
 *   runningTasks 映射的 cancelled 丢弃（终态转移本身也会因行已 cancelled 而失败，双保险）；
 * - sweepTimeouts：running 且 startedAt+timeout < now → failed('timeout')；
 *   start() 起 30s sweep 定时器（unref 不阻退出），stop() 清理定时器并 stop pool；
 * - 同一任务的回调经每任务 Promise 链串行化，progress/done 乱序到达也不会互相覆盖。
 */
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';
import { TASK_LIST_MAX_LIMIT, type TaskRecord, type TaskStatus, type TaskStore } from './store.js';

/** sweep 定时器周期（毫秒） */
export const TASKS_SWEEP_INTERVAL_MS = 30_000;
/** 默认任务超时（毫秒）：超过后 sweep 判 failed('timeout') */
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;

/** TaskManager 依赖集合 */
export interface TaskManagerDeps {
  store: TaskStore;
  /** 池门面（TaskWorkerPool 结构兼容；测试可注入替身） */
  pool: {
    start(): Promise<void>;
    stop(): Promise<void>;
    run(taskId: string, name: string, args: unknown): Promise<void>;
  };
  /** 事件总线 emit（EventBus.emit 结构兼容；task.completed / task.failed） */
  emit(name: string, payload: unknown, opts?: { source?: string }): Promise<unknown> | unknown;
  /** 实时推送（SseHub.publish 语义）：进度以 topic 'tasks' / event 'task.progress' 下发 */
  publish(topic: string, event: string, data: unknown): void;
  /** 内核 pino logger */
  logger: import('pino').Logger;
  /** 任务超时（毫秒），默认 {@link DEFAULT_TASK_TIMEOUT_MS}；sweep 每 30s 扫一次 */
  defaultTimeoutMs?: number;
  /**
   * 外部执行器：name 非内置（非 'echo'）且任务带 extId 时改派给该扩展的执行环境
   * （集成层经桥派发 host.taskRun；进度/完成经 task.* topic 回流本管理器）。
   * 未注入时非 echo 任务按池语义判失败。
   */
  externalExecutor?: (extId: string, taskId: string, name: string, args: unknown) => Promise<void>;
}

const ECHO_TASK_NAME = 'echo';

/** dispatch 入参 */
export interface TaskDispatchInput {
  /** 扩展标识；缺省为内核级任务（落库 ''） */
  extId?: string | null;
  /** 任务类型名（v1 仅内置 'echo'，其余由池判失败） */
  name: string;
  /** 任务入参（JSON 序列化落库） */
  args?: unknown;
}

/** runningTasks 映射的内存标记：cancelled 后迟到的池回调一律丢弃 */
interface RunningEntry {
  cancelled: boolean;
}

/**
 * 长任务编排器：dispatch / cancel / get / list / sweepTimeouts + start/stop 生命周期。
 *
 * 池接线：TaskWorkerPool 的三个回调分别接到 {@link onProgress}/{@link onDone}/{@link onFailed}
 * （构造 TaskWorkerPool 时以 `manager.onXxx` 注入即可，见各集成点/测试）。
 */
export class TaskManager {
  readonly #deps: TaskManagerDeps;
  /** taskId → 内存标记（迟到的池回调据此丢弃） */
  readonly #runningTasks = new Map<string, RunningEntry>();
  /** taskId → 回调串行链（同任务 progress/done 乱序到达时仍按到达序落库） */
  readonly #chains = new Map<string, Promise<void>>();
  /** 超时阈值（毫秒） */
  readonly #timeoutMs: number;
  #sweepTimer: NodeJS.Timeout | null = null;
  #started = false;
  #sweeping = false;

  constructor(deps: TaskManagerDeps) {
    this.#deps = deps;
    this.#timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  }

  /** 任务超时阈值（毫秒，只读视图） */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * 启动：pool.start() + 30s sweep 定时器（unref，不阻进程退出）。幂等（重复调用 no-op）。
   */
  async start(): Promise<void> {
    if (this.#started) return;
    await this.#deps.pool.start();
    this.#sweepTimer = setInterval(() => this.#sweepSafely(), TASKS_SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref();
    this.#started = true;
    this.#deps.logger.info({ timeoutMs: this.#timeoutMs }, '[tasks] task manager started');
  }

  /**
   * 停止：清理 sweep 定时器 → pool.stop()（排队/在途任务判 failed）→ 等本轮回调链排空 →
   * 清理内存映射。幂等；之后 dispatch 抛 KERNEL_NOT_READY，可重新 start。
   */
  async stop(): Promise<void> {
    if (this.#sweepTimer !== null) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    await this.#deps.pool.stop();
    // pool.stop 期间 onFailed 又入列了回调链：先等它们排空再清理
    const pending = [...this.#chains.values()];
    if (pending.length > 0) await Promise.allSettled(pending);
    this.#chains.clear();
    this.#runningTasks.clear();
    this.#started = false;
    this.#deps.logger.info('[tasks] task manager stopped');
  }

  /**
   * 派发任务：生成 id → store.create（queued）→ 登记内存标记 → pool.run 异步执行（不 await）。
   *
   * @returns 落库后的记录快照（status=queued；完成状态经 get()/事件观察）
   * @throws HarnessError（KERNEL_NOT_READY）start() 之前调用
   */
  async dispatch(input: TaskDispatchInput): Promise<TaskRecord> {
    if (!this.#started) {
      throw err('KERNEL_NOT_READY', {
        message: '[tasks] TaskManager 尚未启动：先 await manager.start() 再 dispatch()',
      });
    }
    const id = randomUUID();
    const record = await this.#deps.store.create({
      id,
      extId: input.extId,
      name: input.name,
      args: input.args,
    });
    this.#runningTasks.set(id, { cancelled: false });
    const execute = (): void => {
      // pool.run / externalExecutor 契约上永不 reject；此处兜底（契约破坏时任务仍能落 failed，不产生 unhandled rejection）
      void Promise.resolve()
        .then(() =>
          input.name !== ECHO_TASK_NAME && typeof input.extId === 'string' && input.extId !== '' && this.#deps.externalExecutor !== undefined
            ? this.#deps.externalExecutor(input.extId, id, input.name, input.args)
            : this.#deps.pool.run(id, input.name, input.args),
        )
        .catch((e: unknown) => {
          this.#deps.logger.error({ err: e, taskId: id }, '[tasks] executor rejected (contract violation)');
          this.onFailed(id, e instanceof Error ? e.message : String(e));
        });
    };
    execute();
    return record;
  }

  /**
   * 取消任务：
   * - queued → cancelled 直接转移（池稍后取到该任务时，其回调因 cancelled 标记被丢弃）；
   * - running → 标记 cancelled（池无中断通道：记录标记后等回调到来时丢弃迟到结果）；
   * - 终态（done/failed/cancelled）幂等返回当前记录，不重复转移。
   *
   * @returns 取消后的最新记录；任务不存在返回 null
   */
  async cancel(id: string): Promise<TaskRecord | null> {
    const rec = await this.#deps.store.get(id);
    if (rec === null) return null;
    if (rec.status === 'queued' || rec.status === 'running') {
      await this.#deps.store.transition(id, [rec.status], 'cancelled', { finishedAt: Date.now() });
      const entry = this.#runningTasks.get(id);
      if (entry !== undefined) entry.cancelled = true; // 迟到的池回调据此丢弃
      return this.#deps.store.get(id);
    }
    return rec; // 终态幂等
  }

  /** 按 ID 读取任务记录（委托 store） */
  get(id: string): Promise<TaskRecord | null> {
    return this.#deps.store.get(id);
  }

  /** 列出任务记录（委托 store；支持 extId/status/limit 过滤） */
  list(opts?: { extId?: string; status?: TaskStatus; limit?: number }): Promise<TaskRecord[]> {
    return this.#deps.store.list(opts);
  }

  /**
   * 超时清扫：running 且 startedAt + timeout < now 的任务 → failed('timeout')（finishedAt 落 now，
   * error 落超时文案，并补发 task.failed 事件），返回清扫数量。
   * 幂等：重复调用对已清扫任务无效果（行已非 running）。
   */
  async sweepTimeouts(): Promise<number> {
    const now = Date.now();
    const running = await this.#deps.store.list({ status: 'running', limit: TASK_LIST_MAX_LIMIT });
    let swept = 0;
    for (const rec of running) {
      if (rec.startedAt === null) continue; // 无起点无法判定超时（不应出现，防御跳过）
      if (rec.startedAt + this.#timeoutMs > now) continue;
      const entry = this.#runningTasks.get(rec.id);
      if (entry !== undefined) entry.cancelled = true; // 真实完成回调迟到时丢弃
      const ok = await this.#deps.store.transition(rec.id, ['running'], 'failed', { finishedAt: now });
      if (!ok) continue; // 状态已被 cancel 等并发路径改变
      const error = `timeout: task exceeded ${this.#timeoutMs}ms`;
      await this.#deps.store.setError(rec.id, error);
      this.#runningTasks.delete(rec.id);
      this.#chains.delete(rec.id);
      swept += 1;
      await this.#safeEmit('task.failed', { id: rec.id, name: rec.name, extId: rec.extId, error, reason: 'timeout' });
    }
    if (swept > 0) {
      this.#deps.logger.warn({ swept, timeoutMs: this.#timeoutMs }, '[tasks] swept timed-out tasks');
    }
    return swept;
  }

  // ---------------------------------------------------------------------------
  // 池回调接线点（TaskWorkerPool deps 注入；fire-and-forget，绝不向池抛异常）
  // ---------------------------------------------------------------------------

  /** 进度回调接线点：转 running（若仍在排队）→ 写进度 → publish('tasks','task.progress') */
  onProgress(taskId: string, pct: number, msg?: string): void {
    this.#chain(taskId, () => this.#handleProgress(taskId, pct, msg));
  }

  /** 完成回调接线点：转 done → setResult → emit('task.completed')；迟到/已取消的丢弃 */
  onDone(taskId: string, result: unknown): void {
    this.#chain(taskId, () => this.#handleDone(taskId, result));
  }

  /** 失败回调接线点：转 failed → setError → emit('task.failed')；迟到/已取消的丢弃 */
  onFailed(taskId: string, error: string): void {
    this.#chain(taskId, () => this.#handleFailed(taskId, error));
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  /** 排队中的任务真正开跑：queued→running 并落 startedAt（行已是 running/cancelled 时为 no-op） */
  async #ensureRunning(taskId: string): Promise<void> {
    await this.#deps.store.transition(taskId, ['queued'], 'running', { startedAt: Date.now() });
  }

  async #handleProgress(taskId: string, pct: number, msg?: string): Promise<void> {
    const entry = this.#runningTasks.get(taskId);
    if (entry === undefined || entry.cancelled) return; // 迟到/已取消：丢弃，不写库不推送
    await this.#ensureRunning(taskId);
    await this.#deps.store.setProgress(taskId, pct, msg);
    this.#deps.publish('tasks', 'task.progress', { id: taskId, pct, msg: msg ?? null });
  }

  async #handleDone(taskId: string, result: unknown): Promise<void> {
    const entry = this.#runningTasks.get(taskId);
    if (entry === undefined || entry.cancelled) return; // 迟到/已取消：丢弃
    const rec = await this.#deps.store.get(taskId);
    if (rec === null) return;
    await this.#ensureRunning(taskId); // 池在排队态就被判完成时兜底推进状态机
    const ok = await this.#deps.store.transition(taskId, ['running'], 'done', { finishedAt: Date.now() });
    if (!ok) return; // 状态已被 sweep/cancel 改变：迟到结果丢弃
    await this.#deps.store.setResult(taskId, result);
    this.#runningTasks.delete(taskId);
    this.#chains.delete(taskId);
    await this.#safeEmit('task.completed', { id: taskId, name: rec.name, extId: rec.extId, result });
  }

  async #handleFailed(taskId: string, error: string): Promise<void> {
    const rec = await this.#deps.store.get(taskId);
    if (rec === null) return;
    if (rec.status !== 'queued' && rec.status !== 'running') return; // 终态：迟到失败丢弃
    await this.#ensureRunning(taskId); // queued 态即失败（如未知任务名）先推到 running 保持转移合法
    const ok = await this.#deps.store.transition(taskId, ['running'], 'failed', { finishedAt: Date.now() });
    if (!ok) return; // 状态已被 cancel 改变：迟到失败丢弃
    await this.#deps.store.setError(taskId, error);
    this.#runningTasks.delete(taskId);
    this.#chains.delete(taskId);
    await this.#safeEmit('task.failed', { id: taskId, name: rec.name, extId: rec.extId, error });
  }

  /** 同一任务的回调串行化：按到达序落库；单步异常记日志不中断后续回调 */
  #chain(taskId: string, step: () => Promise<void>): void {
    const prev = this.#chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(step, step); // 前序失败（理论上不会）也继续本步
    const guarded = next.catch((e: unknown) => {
      this.#deps.logger.error({ err: e, taskId }, '[tasks] task lifecycle handler failed');
    });
    this.#chains.set(taskId, guarded);
  }

  /** 事件发射兜底：emit 异常只记日志，不影响任务状态推进 */
  async #safeEmit(name: string, payload: unknown): Promise<void> {
    try {
      await Promise.resolve(this.#deps.emit(name, payload, { source: 'tasks' }));
    } catch (e) {
      this.#deps.logger.error({ err: e, event: name }, '[tasks] emit failed');
    }
  }

  /** 定时 sweep 入口：防重入 + 异常隔离（interval 回调不允许抛） */
  #sweepSafely(): void {
    if (this.#sweeping) return;
    this.#sweeping = true;
    this.sweepTimeouts()
      .catch((e: unknown) => {
        this.#deps.logger.error({ err: e }, '[tasks] sweepTimeouts failed');
      })
      .finally(() => {
        this.#sweeping = false;
      });
  }
}
