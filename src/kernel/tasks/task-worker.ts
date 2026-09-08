/**
 * task-worker — 任务线程入口（worker_threads 工作线程侧）。
 *
 * 消息协议（与 TaskWorkerPool 对齐）：
 * - 入站：`{ type: 'run', taskId, fn, args }`
 * - 出站：`{ type: 'progress', taskId, pct, msg? }`
 *         `{ type: 'done', taskId, result }`
 *         `{ type: 'failed', taskId, error }`
 *
 * 内置 fn：`echo`（自测任务，回 progress 50 → done(args)），用于在阶段 9 扩展执行器
 * 接入前证明"派发 → 线程执行 → 进度/结果回调 → 落库"的完整管道。
 * 未知 fn 回 failed（消息与池侧门禁文案一致）。
 *
 * 注意：本文件会被 Node 在工作线程中以原生 TS 类型剥离直接加载，
 * 只能使用可剥离语法（不得使用 enum / namespace / 构造器参数属性等）。
 */
import { parentPort } from 'node:worker_threads';

/** 池 → 工作线程的入站消息 */
interface WorkerInbound {
  type: 'run';
  taskId: string;
  fn: string;
  args: unknown;
}

/** 工作线程 → 池的出站消息 */
export type WorkerOutbound =
  | { type: 'progress'; taskId: string; pct: number; msg?: string }
  | { type: 'done'; taskId: string; result: unknown }
  | { type: 'failed'; taskId: string; error: string };

/** 与 TaskWorkerPool 门禁一致的未注册文案（保持两侧报错统一） */
const TASK_NOT_REGISTERED = 'task type not registered (extension executors arrive in stage 9)';

/** 执行一个任务并回消息；fn 分发表是阶段 9 注册扩展执行器的挂载点 */
function runTask(msg: WorkerInbound): void {
  if (msg.fn === 'echo') {
    parentPort?.postMessage({
      type: 'progress',
      taskId: msg.taskId,
      pct: 50,
      msg: 'echo: half way',
    } satisfies WorkerOutbound);
    parentPort?.postMessage({ type: 'done', taskId: msg.taskId, result: msg.args } satisfies WorkerOutbound);
    return;
  }
  parentPort?.postMessage({
    type: 'failed',
    taskId: msg.taskId,
    error: TASK_NOT_REGISTERED,
  } satisfies WorkerOutbound);
}

parentPort?.on('message', (msg: WorkerInbound) => {
  try {
    runTask(msg);
  } catch (e) {
    // 执行器异常不杀死线程：降级为该任务 failed，线程继续服务后续任务
    parentPort?.postMessage({
      type: 'failed',
      taskId: typeof msg?.taskId === 'string' ? msg.taskId : '',
      error: e instanceof Error ? e.message : String(e),
    } satisfies WorkerOutbound);
  }
});
