/**
 * runtime-profile — 运行时画像（核心自适应并发的单一事实来源）。
 *
 * 一次探测宿主机的 CPU 核数与内存规模，产出三组并发缺省值：
 * - `taskWorkers`：CPU 密集任务池线程数（TaskWorkerPool，见 kernel/tasks/worker-pool.ts）；
 * - `subagentMaxConcurrent` / `subagentMaxPerParent`：等待型子代理并发上限
 *   （SubagentManager，见 kernel/agents/manager.ts）；
 * - `uvThreadpoolSize`：libuv 线程池建议值（fs/crypto/dns 共用；须在 Node 启动前经
 *   环境变量 UV_THREADPOOL_SIZE 设置，进程内读改无效——此处仅在已显式设置时**如实回读**，
 *   否则给出建议值，供运维文档/诊断展示）。
 *
 * 并发模型依据（详见 ARCHITECTURE.md「并发模型」小节）：
 * - 子代理是 I/O 密集型（生命周期几乎全部时间在等 LLM 网络往返），单进程事件循环即可
 *   大量并发，不占 CPU → 上限按核数 ×8 放大（封顶 64）；
 * - 任务池是 CPU 密集型 → 线程数 ≈ 核数（超出核数只添上下文切换），并与
 *   HARNESS_TASK_WORKERS 的合法区间上限 16 对齐；
 * - 小机保护：总内存 < 2GB 时并发值减半（下限 1），避免并发放大压垮小内存实例。
 *
 * 纯函数：os 读取（核数/内存）与环境变量均可注入，便于测试与嵌入宿主覆盖。
 */
import * as os from 'node:os';

/** 小机保护阈值：总内存低于该 GB 数时 taskWorkers 与子代理并发减半 */
const SMALL_MACHINE_MEM_GB = 2;
/** CPU 密集任务池的绝对上限（与 HARNESS_TASK_WORKERS env 合法区间 [1, 16] 对齐） */
const TASK_WORKERS_HARD_MAX = 16;
/** libuv 线程池硬上限（Node 官方：UV_THREADPOOL_SIZE 最大 1024） */
const UV_THREADPOOL_MAX = 1024;
/** libuv 线程池建议基线（Node 缺省即 4；fs/crypto 并发更高时放大至核数） */
const UV_THREADPOOL_BASELINE = 4;

/** os 读取注入（测试替身 / 嵌入宿主覆盖）；缺省读真实 `os.cpus()` / `os.totalmem()` */
export interface RuntimeProfileOsDeps {
  /** 逻辑核数（缺省 os.cpus().length；注入 0/负数按 1 处理——容器/异常环境防御） */
  cpus?: number;
  /** 总内存字节（缺省 os.totalmem()） */
  totalMemBytes?: number;
}

/** 环境覆盖面（缺省读 `process.env` 的 UV_THREADPOOL_SIZE 与 NODE_OPTIONS） */
export interface RuntimeProfileEnv {
  /** libuv 线程池大小显式覆盖（须在 Node 启动前设置才实际生效） */
  UV_THREADPOOL_SIZE?: string;
  /** NODE_OPTIONS 原文（解析其中的 --uv-threadpool-size=<n> / --uv-threadpool-size <n>） */
  nodeOptions?: string;
}

/** 运行时画像：一次探测、全程使用的并发缺省值集合 */
export interface RuntimeProfile {
  /** 逻辑核数（≥1 下限；容器/异常环境 os.cpus() 可能为 0，按 1 收敛） */
  cpus: number;
  /** 总内存（GB，十进制换算 1GB = 2^30 字节） */
  memTotalGB: number;
  /** CPU 密集任务池线程数：clamp(cpus, 1, min(cpus, 16))；内存 <2GB 再减半 */
  taskWorkers: number;
  /** 子代理全局并发上限：clamp(cpus*8, 8, 64)（等待型并发）；内存 <2GB 再减半 */
  subagentMaxConcurrent: number;
  /** 单个直接父的最大子代数：clamp(cpus*2, 4, 16)；内存 <2GB 再减半 */
  subagentMaxPerParent: number;
  /** libuv 线程池：UV_THREADPOOL_SIZE / NODE_OPTIONS 显式设置时回读（clamp 1..1024），否则建议值 clamp(4, 4, cpus) */
  uvThreadpoolSize: number;
}

/** 统一 clamp：先抬下限再压上限（max < min 时以 max 为准，用于"上限收紧到核数"语义） */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 解析 ≥1 的整数字面量；空串/非整数/<1 返回 null（视为未设置，不 fail-fast） */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** 从 NODE_OPTIONS 原文解析 --uv-threadpool-size（= 连接与空格分隔两种形态） */
function uvOverrideFromNodeOptions(nodeOptions: string | undefined): number | null {
  if (nodeOptions === undefined) return null;
  const eq = /--uv-threadpool-size=(\d+)/.exec(nodeOptions);
  if (eq !== null) return parsePositiveInt(eq[1]);
  const sp = /--uv-threadpool-size\s+(\d+)/.exec(nodeOptions);
  if (sp !== null) return parsePositiveInt(sp[1]);
  return null;
}

/**
 * 探测运行时画像。同步、纯计算（os 读取可注入），任何输入都不会抛错。
 *
 * @param env 环境覆盖面（缺省读 `process.env`；测试传 `{}` 得到纯建议值）
 * @param osDeps os 读取注入（缺省读真实宿主机）
 */
export function detectRuntimeProfile(env?: RuntimeProfileEnv, osDeps?: RuntimeProfileOsDeps): RuntimeProfile {
  const e: RuntimeProfileEnv =
    env ??
    ({
      UV_THREADPOOL_SIZE: process.env['UV_THREADPOOL_SIZE'],
      nodeOptions: process.env['NODE_OPTIONS'],
    } satisfies RuntimeProfileEnv);

  // 核数 ≥1 下限：容器 cgroup 异常 / 特殊平台下 os.cpus() 可能返回空数组（length 0）
  const cpus = Math.max(1, Math.trunc(osDeps?.cpus ?? os.cpus().length));
  const totalMemBytes = osDeps?.totalMemBytes ?? os.totalmem();
  const memTotalGB = totalMemBytes / (1024 * 1024 * 1024);
  const smallMachine = memTotalGB < SMALL_MACHINE_MEM_GB;

  // CPU 密集任务池：上限 = 核数（超出核数只添上下文切换开销），再与
  // HARNESS_TASK_WORKERS env 合法区间上限 16 对齐（缺省值不得超出 env 可表达范围）
  let taskWorkers = clamp(cpus, 1, Math.min(cpus, TASK_WORKERS_HARD_MAX));
  // 等待型子代理并发：生命周期绝大部分时间阻塞在 LLM 网络往返（0% CPU），按核数 ×8 放大
  let subagentMaxConcurrent = clamp(cpus * 8, 8, 64);
  // 单父最大子代：树宽约束，按核数 ×2，收敛到 [4, 16]
  let subagentMaxPerParent = clamp(cpus * 2, 4, 16);

  if (smallMachine) {
    // 小机保护（内存 < 2GB）：并发值减半（向下取整、下限 1），uv 建议值不动
    taskWorkers = Math.max(1, Math.floor(taskWorkers / 2));
    subagentMaxConcurrent = Math.max(1, Math.floor(subagentMaxConcurrent / 2));
    subagentMaxPerParent = Math.max(1, Math.floor(subagentMaxPerParent / 2));
  }

  // libuv 线程池：显式覆盖（env > NODE_OPTIONS）如实回读（仍 clamp 1..1024 防御）；
  // 未设置时给建议值 clamp(4, 4, cpus)——小核机器收敛到核数，大核机器维持 Node 缺省 4
  const envOverride = parsePositiveInt(e.UV_THREADPOOL_SIZE) ?? uvOverrideFromNodeOptions(e.nodeOptions);
  const uvThreadpoolSize = envOverride !== null ? clamp(envOverride, 1, UV_THREADPOOL_MAX) : clamp(UV_THREADPOOL_BASELINE, UV_THREADPOOL_BASELINE, cpus);

  return { cpus, memTotalGB, taskWorkers, subagentMaxConcurrent, subagentMaxPerParent, uvThreadpoolSize };
}
