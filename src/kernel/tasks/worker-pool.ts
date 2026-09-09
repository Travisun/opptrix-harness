/**
 * task worker pool — CPU 密集长任务的线程池（worker_threads）。
 *
 * 职责边界：
 * - 启动 `deps.size` 个工作线程（入口 `./task-worker.ts`，编译态为同目录 .js），
 *   空闲线程表 + FIFO 队列：并发超过 size 时任务排队，先到先执行；
 * - `run(taskId, name, args)` 返回的 Promise 在该任务收到终态消息（done/failed）或
 *   被判失败（未注册/池未运行/线程崩溃/stop）时 resolve——契约上 **永不 reject**，
 *   全部失败经 `deps.onFailed` 回调表达（调用方 fire-and-forget 也不会产生 unhandled rejection）；
 * - v1 仅内置自测任务 `echo`（证明管道）；未知 name 直接 onFailed，不占用线程，
 *   真实扩展执行器在阶段 9 经注册表接入（工作线程侧 `runTask` 的 fn 分发表为挂载点）；
 * - 线程崩溃（error / 非正常 exit）时：在途任务判失败并从池中摘除该线程（不自动重生，
 *   阶段 9 一并处理自愈），队列中的任务由剩余线程继续消费；
 * - `stop()` 语义：排队任务直接 onFailed；在途任务因线程被强杀 onFailed；随后 terminate 全部线程。
 */
import { Worker } from 'node:worker_threads';

import { EXTRACT_TASK_NAME } from '../fileextract/types.js';

import { err } from '../errors/index.js';
import type { WorkerOutbound } from './task-worker.js';

/** 池依赖：size 个线程 + 三个生命周期回调 + 内核 logger */
export interface TaskWorkerPoolDeps {
  /** 工作线程数（必须为 ≥1 的整数） */
  size: number;
  /** 进度回调（工作线程 progress 消息） */
  onProgress(taskId: string, pct: number, msg?: string): void;
  /** 完成回调（工作线程 done 消息） */
  onDone(taskId: string, result: unknown): void;
  /** 失败回调（未注册 / 池未运行 / 线程崩溃 / stop 中断） */
  onFailed(taskId: string, error: string): void;
  /** 内核 pino logger（线程崩溃等服务端事件） */
  logger: import('pino').Logger;
}

/** 内置任务名：'echo' 自测管道 + 'file-extract'（FileExtractService 的任务池面） */
export const BUILTIN_TASK_NAMES = ['echo', EXTRACT_TASK_NAME] as const;

/** 未注册任务的标准文案（池侧门禁与工作线程侧兜底保持一致） */
export const TASK_NOT_REGISTERED_MESSAGE = 'task type not registered (extension executors arrive in stage 9)';

/** 排队任务（FIFO 队列元素） */
interface QueuedJob {
  taskId: string;
  name: string;
  args: unknown;
  resolve(): void;
}

/** 定位工作线程入口：源码态（vitest/tsx 直跑 .ts）与编译态（dist/*.js）各自同目录取用 */
function workerEntryUrl(): URL {
  const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./task-worker.${ext}`, import.meta.url);
}

/**
 * 任务线程池：start/stop 生命周期 + run 派发（池满 FIFO 排队）。
 * 回调经构造注入，由 TaskManager 接线（见 manager.onProgress/onDone/onFailed）。
 */
export class TaskWorkerPool {
  readonly #deps: TaskWorkerPoolDeps;
  /** 全部存活线程 */
  #workers: Worker[] = [];
  /** 空闲线程（LWSTR 取用：pop 最近归还的线程，减少消息乱序窗口） */
  #free: Worker[] = [];
  /** FIFO 排队（并发 > size 时） */
  #queue: QueuedJob[] = [];
  /** 线程 → 在途 taskId（一线程同时只跑一个任务） */
  #inflight = new Map<Worker, string>();
  /** 在途 taskId → job（终态时 resolve run() 的 Promise） */
  #pending = new Map<string, QueuedJob>();
  #started = false;
  #stopping = false;

  constructor(deps: TaskWorkerPoolDeps) {
    if (!Number.isInteger(deps.size) || deps.size < 1) {
      throw err('INTERNAL', {
        message: `[tasks] TaskWorkerPool: size 必须是 ≥1 的整数（收到 ${deps.size}）`,
        detail: { size: deps.size },
      });
    }
    this.#deps = deps;
  }

  /** 池容量（配置的线程数） */
  size(): number {
    return this.#deps.size;
  }

  /** 启动：spawn size 个工作线程。幂等（重复调用为 no-op）；stop 后可再次 start。 */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#stopping = false;
    for (let i = 0; i < this.#deps.size; i++) this.#spawn();
    this.#started = true;
    this.#deps.logger.info({ size: this.#deps.size }, '[tasks] task worker pool started');
  }

  /**
   * 停止：排队任务与在途任务先经 onFailed 判失败（run() 的 Promise 一并 resolve），
   * 再 terminate 全部线程。幂等；之后可重新 start。
   */
  async stop(): Promise<void> {
    if (!this.#started && this.#workers.length === 0) return;
    this.#stopping = true;
    this.#started = false;

    // 1. 排队任务：未曾上线程，直接判失败
    const queued = this.#queue.splice(0);
    for (const job of queued) {
      this.#deps.onFailed(job.taskId, 'task worker pool stopped before the task started');
      job.resolve();
    }
    // 2. 在途任务：线程将被强杀，不可能再有终态消息
    for (const [worker, taskId] of this.#inflight) {
      this.#deps.onFailed(taskId, 'task worker terminated during pool stop');
      this.#pending.get(taskId)?.resolve();
    }
    this.#pending.clear();
    this.#inflight.clear();
    this.#free.length = 0;
    const workers = this.#workers.splice(0);
    await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
    this.#deps.logger.info({ size: workers.length }, '[tasks] task worker pool stopped');
  }

  /**
   * 派发任务：
   * - 未知 name → 立即 onFailed（不占用线程；内置清单见 BUILTIN_TASK_NAMES）；
   * - 有空闲线程立即执行；否则进入 FIFO 队列，线程空闲时按先到先执行；
   * - 返回的 Promise 在任务终态（或判失败）时 resolve，永不 reject。
   */
  run(taskId: string, name: string, args: unknown): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!(BUILTIN_TASK_NAMES as readonly string[]).includes(name)) {
        this.#deps.onFailed(taskId, TASK_NOT_REGISTERED_MESSAGE);
        resolve();
        return;
      }
      if (!this.#started || this.#stopping) {
        this.#deps.onFailed(taskId, 'task worker pool is not running');
        resolve();
        return;
      }
      const job: QueuedJob = { taskId, name, args, resolve };
      const free = this.#free.pop();
      if (free !== undefined) this.#execute(free, job);
      else this.#queue.push(job);
    });
  }

  // ---- 内部 ----

  /** spawn 一个工作线程并挂事件监听 */
  #spawn(): void {
    const worker = new Worker(workerEntryUrl(), {
      // 线程入口是可原生加载的 .ts（Node 24 类型剥离）/编译态 .js，清空继承的 execArgv 保证线程环境纯净
      execArgv: [],
    });
    worker.on('message', (msg: WorkerOutbound) => this.#onMessage(worker, msg));
    worker.on('error', (e: Error) => this.#onWorkerError(worker, e));
    worker.on('exit', (code: number) => this.#onWorkerExit(worker, code));
    this.#workers.push(worker);
    this.#free.push(worker);
  }

  /** 把 job 派发到指定线程（调用方保证线程空闲） */
  #execute(worker: Worker, job: QueuedJob): void {
    this.#inflight.set(worker, job.taskId);
    this.#pending.set(job.taskId, job);
    worker.postMessage({ type: 'run', taskId: job.taskId, fn: job.name, args: job.args });
  }

  /** 线程空闲即补位：FIFO 队列非空则立即派发下一个 */
  #pump(): void {
    while (this.#queue.length > 0 && this.#free.length > 0) {
      const job = this.#queue.shift();
      const worker = this.#free.pop();
      if (job === undefined || worker === undefined) break;
      this.#execute(worker, job);
    }
  }

  /** 终态消息（done/failed）：线程归还被 + resolve run() 的 Promise（回调由调用方继续） */
  #finish(worker: Worker, taskId: string): void {
    this.#inflight.delete(worker);
    this.#pending.get(taskId)?.resolve();
    this.#pending.delete(taskId);
    if (this.#workers.includes(worker) && !this.#free.includes(worker)) {
      this.#free.push(worker);
    }
    this.#pump();
  }

  /** 工作线程消息路由：progress → onProgress；done/failed → 归还线程 + 对应回调 */
  #onMessage(worker: Worker, msg: WorkerOutbound): void {
    if (this.#stopping) return; // stop 后不再处理残余消息
    switch (msg.type) {
      case 'progress':
        this.#deps.onProgress(msg.taskId, msg.pct, msg.msg);
        break;
      case 'done':
        this.#finish(worker, msg.taskId);
        this.#deps.onDone(msg.taskId, msg.result);
        break;
      case 'failed':
        this.#finish(worker, msg.taskId);
        this.#deps.onFailed(msg.taskId, msg.error);
        break;
    }
  }

  /** 线程崩溃（uncaughtException 等）：从池中摘除该线程，在途任务判失败 */
  #onWorkerError(worker: Worker, e: Error): void {
    this.#deps.logger.error({ err: e }, '[tasks] task worker crashed');
    this.#dropWorker(worker);
    const taskId = this.#inflight.get(worker);
    if (taskId !== undefined) {
      this.#inflight.delete(worker);
      this.#pending.get(taskId)?.resolve();
      this.#pending.delete(taskId);
      this.#deps.onFailed(taskId, `task worker crashed: ${e.message}`);
    }
    this.#pump();
  }

  /** 线程退出：非 stop 期间且仍有在途任务时按崩溃兜底（error 事件通常先行，此处幂等） */
  #onWorkerExit(worker: Worker, code: number): void {
    if (this.#stopping) return;
    this.#dropWorker(worker);
    const taskId = this.#inflight.get(worker);
    if (taskId !== undefined) {
      this.#inflight.delete(worker);
      this.#pending.get(taskId)?.resolve();
      this.#pending.delete(taskId);
      this.#deps.logger.error({ code }, '[tasks] task worker exited unexpectedly');
      this.#deps.onFailed(taskId, `task worker exited unexpectedly (code ${code})`);
    }
    this.#pump();
  }

  /** 从 workers/free 数组中摘除线程（inflight 由调用方处理） */
  #dropWorker(worker: Worker): void {
    this.#workers = this.#workers.filter((w) => w !== worker);
    this.#free = this.#free.filter((w) => w !== worker);
  }
}
