/**
 * task-worker — 任务线程入口（worker_threads 工作线程侧）。
 *
 * 消息协议（与 TaskWorkerPool 对齐）：
 * - 入站：`{ type: 'run', taskId, fn, args }`
 * - 出站：`{ type: 'progress', taskId, pct, msg? }`
 *         `{ type: 'done', taskId, result }`
 *         `{ type: 'failed', taskId, error }`
 *
 * 内置 fn：
 * - `echo`（自测任务，回 progress 50 → done(args)），用于证明
 *   "派发 → 线程执行 → 进度/结果回调 → 落库"的完整管道；
 * - `file-extract`（文件内容提取执行器，FileExtractService 的任务池面）：
 *   首次调用时才惰性加载提取引擎链（线程私有，OCR 单例亦线程私有）；
 *   加载/执行失败一律回 failed 消息（调用方 FileExtractService 据此回退主线程）。
 * 未知 fn 回 failed（消息与池侧门禁文案一致）。
 *
 * 注意：本文件会被 Node 在工作线程中以原生 TS 类型剥离直接加载（execArgv 已清空），
 * 只能使用可剥离语法（不得使用 enum / namespace / 构造器参数属性等），且**运行时
 * import 必须按源码态/编译态显式选择 .ts/.js 扩展名**（原生剥离不改写 .js 说明符，
 * 见 loadExtractExecutor 内注释）。
 */
import { parentPort } from 'node:worker_threads';

import type { ExtractTaskArgs } from '../fileextract/types.js';

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

/**
 * 文件提取任务名。与 src/kernel/fileextract/types.ts 的 EXTRACT_TASK_NAME 对齐——
 * 本文件被原生类型剥离加载，不能运行时 import 该包（.js 说明符在源码态无法解析），
 * 故以常量镜像（两侧漂移会由提取任务失败暴露，FileExtractService 回退主线程兜底）。
 */
const FILE_EXTRACT_FN = 'file-extract';

/**
 * 提取执行器（惰性创建：首个 file-extract 任务到达才加载提取引擎链；线程私有）。
 *
 * 加载形态推导与 worker-pool.ts 的 workerEntryUrl() 同款：源码态（vitest/tsx 直跑 .ts）
 * 动态 import `.ts`，编译态（dist/*.js）import `.js`。源码态下目标模块图内部仍是
 * .js 说明符、原生剥离无法解析 → import 失败 → 任务 failed → FileExtractService
 * 回退主线程执行（附警告）；编译态（生产）则真正入池隔离执行。
 */
let extractExecutor: Promise<(args: ExtractTaskArgs) => Promise<unknown>> | null = null;

function loadExtractExecutor(): Promise<(args: ExtractTaskArgs) => Promise<unknown>> {
  extractExecutor ??= (async () => {
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const mod = (await import(new URL(`../fileextract/service.${ext}`, import.meta.url).href)) as {
      createExtractTaskHandler(deps: {
        dataDir: string;
        logger: import('pino').Logger;
        autoDownload?: boolean;
      }): (args: ExtractTaskArgs) => Promise<unknown>;
    };
    return mod.createExtractTaskHandler({
      // 与主进程 loadConfig 的 dataDir 解析对齐（env 缺省 './data'，worker 共享 cwd）
      dataDir: process.env['HARNESS_DATA_DIR'] && process.env['HARNESS_DATA_DIR'] !== ''
        ? process.env['HARNESS_DATA_DIR']
        : './data',
      // 工作线程无 pino 实例：静默 logger（引擎日志不跨线程落主进程汇）
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as unknown as import('pino').Logger,
      // OCR 模型自动下载开关（与主进程装配同款 env 口径，缺省关）
      autoDownload: process.env['HARNESS_OCR_AUTO_DOWNLOAD'] === '1',
    });
  })();
  return extractExecutor;
}

/** 执行一个任务并回消息；fn 分发表是扩展执行器的挂载点 */
async function runTask(msg: WorkerInbound): Promise<void> {
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
  if (msg.fn === FILE_EXTRACT_FN) {
    try {
      const executor = await loadExtractExecutor();
      const result = await executor(msg.args as ExtractTaskArgs);
      parentPort?.postMessage({ type: 'done', taskId: msg.taskId, result } satisfies WorkerOutbound);
    } catch (e) {
      // 引擎链加载失败 / 提取失败：回 failed 消息（线程继续服务后续任务）
      parentPort?.postMessage({
        type: 'failed',
        taskId: msg.taskId,
        error: e instanceof Error ? e.message : String(e),
      } satisfies WorkerOutbound);
    }
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
    void runTask(msg).catch((e: unknown) => {
      // 执行器异常不杀死线程：降级为该任务 failed，线程继续服务后续任务
      parentPort?.postMessage({
        type: 'failed',
        taskId: typeof msg?.taskId === 'string' ? msg.taskId : '',
        error: e instanceof Error ? e.message : String(e),
      } satisfies WorkerOutbound);
    });
  } catch (e) {
    parentPort?.postMessage({
      type: 'failed',
      taskId: typeof msg?.taskId === 'string' ? msg.taskId : '',
      error: e instanceof Error ? e.message : String(e),
    } satisfies WorkerOutbound);
  }
});
