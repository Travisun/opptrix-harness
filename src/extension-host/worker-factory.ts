/**
 * worker-factory — Extension Worker 线程工厂（生产/开发双模式）。
 *
 * worker 入口解析（仓库根目录 = 本文件向上两级，即 src/extension-host/ → repo root）：
 * - 生产（dist 优先）：<repoRoot>/dist/extension-host/worker.js 存在 → 直接
 *   `new Worker(distEntry)`（纯 JS，无需任何 loader）；
 * - 开发：<repoRoot>/src/extension-host/worker.ts →
 *   `new Worker(srcEntry, { execArgv: ['--import', 'tsx'] })`（tsx loader 剥离 TS 语法；
 *   tsx 未安装时抛可操作的 INTERNAL 错误，说明修复方式）。
 *
 * 可用环境变量 HARNESS_WORKER_MODE 强制模式（部署/测试钉死路径用）：
 * - 'auto'（默认）：dist 存在用 dist，否则 dev；
 * - 'dist'：只用 dist 入口（缺失即抛错）；
 * - 'dev'：只用 src 入口 + tsx loader。
 *
 * 返回类型满足 ExtensionManager 的 workerFactory 契约（见 satisfies 编译期断言）：
 * worker_threads.Worker 经 WorkerLike 适配（on/off 事件用 addListener/removeListener
 * 包装）。另附一个 no-op 之外的 'error' 监听（记日志）——Worker 的 'error' 事件
 * 在无监听器时会作为未捕获异常击穿主线程，必须有人接住（exit 事件随后照常触发
 * manager 的自愈重启）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Logger } from 'pino';

import { err } from '../kernel/errors/index.js';
import type { WorkerLike } from '../kernel/extensions/bridge.js';
import type { ExtensionManagerDeps } from '../kernel/extensions/manager.js';

/** 本工厂的返回契约：与 ExtensionManager.deps.workerFactory 同形（编译期 satisfies 验证） */
export type ExtensionWorkerFactory = ExtensionManagerDeps['workerFactory'];

/** worker 模式强制开关（HARNESS_WORKER_MODE） */
type WorkerMode = 'auto' | 'dist' | 'dev';

/** 仓库根目录：src/extension-host/worker-factory.ts → 上两级 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 生产入口（tsc -p tsconfig.build.json 产物） */
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'extension-host', 'worker.js');
/** 开发入口（源码，经 tsx loader 加载） */
const SRC_ENTRY = path.join(REPO_ROOT, 'src', 'extension-host', 'worker.ts');

/** 解析 HARNESS_WORKER_MODE；非法值 fail-fast（编程性误用早暴露） */
function resolveMode(): WorkerMode {
  const raw = process.env['HARNESS_WORKER_MODE'];
  if (raw === undefined || raw === '') return 'auto';
  if (raw === 'auto' || raw === 'dist' || raw === 'dev') return raw;
  throw err('INTERNAL', {
    message:
      `[extensions] HARNESS_WORKER_MODE="${raw}" is invalid: ` +
      'use "auto" (default), "dist" or "dev". Remove the variable to fall back to auto-detection.',
    detail: { value: raw, allowed: ['auto', 'dist', 'dev'] },
  });
}

/** worker_threads.Worker → WorkerLike 适配（on/off 用 add/removeListener 包装） */
function adaptWorker(worker: Worker, logger: Logger): WorkerLike {
  // 'error' 事件无监听器会以未捕获异常击穿主线程；exit 随后照常触发自愈
  worker.on('error', (cause: Error) => {
    logger.error({ err: cause }, 'extension worker raised an error (self-heal will restart it)');
  });
  return {
    postMessage: (msg: unknown) => {
      worker.postMessage(msg);
    },
    on: (type, fn) => {
      worker.addListener(type, fn as (msg: unknown) => void);
    },
    off: (type, fn) => {
      worker.removeListener(type, fn as (msg: unknown) => void);
    },
    terminate: () => worker.terminate(),
  };
}

/**
 * 创建 Extension Worker 工厂（见模块头注释的模式解析规则）。
 *
 * @param logger 内核 pino logger（worker 'error' 事件的日志归宿）
 * @returns 与 ExtensionManager.deps.workerFactory 同形的工厂函数
 */
export function createWorkerFactory(logger: Logger): ExtensionWorkerFactory {
  const factory: ExtensionWorkerFactory = (_extIdsSupported?: unknown): WorkerLike => {
    const mode = resolveMode();
    if (mode !== 'dev' && existsSync(DIST_ENTRY)) {
      return adaptWorker(new Worker(DIST_ENTRY), logger);
    }
    if (mode === 'dist') {
      throw err('INTERNAL', {
        message:
          `[extensions] HARNESS_WORKER_MODE=dist but "${DIST_ENTRY}" does not exist. ` +
          'Run `npm run build` first, or unset HARNESS_WORKER_MODE to use the dev entry.',
        detail: { distEntry: DIST_ENTRY },
      });
    }
    // dev 模式：src 入口 + tsx loader（execArgv 整体替换，与宿主进程的 loader 隔离）
    try {
      return adaptWorker(new Worker(SRC_ENTRY, { execArgv: ['--import', 'tsx'] }), logger);
    } catch (cause) {
      throw err('INTERNAL', {
        message:
          '[extensions] failed to start the extension worker in dev mode. ' +
          'The tsx loader is required to run src/extension-host/worker.ts — ' +
          'install it with `npm install` (devDependency "tsx"), or run `npm run build` ' +
          'and use the production dist entry.',
        cause,
      });
    }
  };
  return factory;
}
