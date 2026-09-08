#!/usr/bin/env node
/**
 * Opptrix Harness OS — bootstrap 进程监管器（仓库根，纯 ESM JS）。
 *
 * 用法：`node bootstrap.mjs`（可直接被容器/进程管理器作为 PID 1 旁的入口运行）。
 *
 * 职责（进程监管，业务逻辑全部在被监管的内核子进程内）：
 * 1. 解析启动 slot（A/B）→ spawn `node <slotDir>/dist/main.js`（env 原样透传、stdio inherit）；
 *    无任何 slot 可运行（degraded）时回退镜像内嵌副本 `./dist/main.js`（cwd /app，
 *    仅当文件存在；缺失才 FATAL 退出——首启无需预先播种 releases/）
 * 2. 崩溃退避重启：500ms * 2^n（上限 30s）；5 分钟窗口内连续 ≥5 次失败且疑似新 slot
 *    不健康（updateInFlight 或 version != previousVersion）→ 回滚 slots.json 并重启旧 slot
 * 3. 健康看门狗：每 2s GET http://127.0.0.1:${HARNESS_PORT:-3000}/readyz；
 *    启动宽限 20s 不计失败；宽限后连续 5 次失败 → 仅当处于更新窗口/版本切换后才回滚，
 *    正常运行期只 stderr 警告不动作（防误杀）
 * 4. SIGTERM/SIGINT：转发子进程，等待退出（15s 后 SIGKILL），随后自身以相同码退出
 *
 * 环境变量：
 * - HARNESS_DATA_DIR                 数据根目录（默认 /data）
 * - HARNESS_PORT                     健康检查端口（默认 3000；全部 env 原样透传给子进程）
 * - HARNESS_BOOTSTRAP_HEALTHCHECK=0  禁用看门狗（测试用）
 *
 * 与 src/kernel/update/slots.ts 的关系：本文件必须能被 `node bootstrap.mjs` 直接运行
 * （纯 JS 运行时不能 import TypeScript），故 slots 读取/回滚写在此外联内联最小实现，
 * ——与 src/kernel/update/slots.ts 保持语义一致——修改 slots.ts 语义时必须同步本文件。
 * 写操作（commitNewSlot/markUpdateSettled）由内核 Updater 完成；本文件只在「回滚」时
 * 内联最小写（tmp + rename 原子写，0600）。
 *
 * 日志例外说明：内核内禁止 console.*；本文件是进程级启动器（内核 logger 尚不存在），
 * 允许向 stderr 写诊断输出（process.stderr.write），供容器日志采集。
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 配置（env）
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.HARNESS_DATA_DIR || '/data';
const HEALTH_PORT = process.env.HARNESS_PORT || '3000';
const HEALTHCHECK_ENABLED = process.env.HARNESS_BOOTSTRAP_HEALTHCHECK !== '0';

const HEALTH_INTERVAL_MS = 2_000; // 看门狗轮询间隔
const HEALTH_GRACE_MS = 20_000; // 启动宽限期（期间不计失败）
const HEALTH_TIMEOUT_MS = 1_500; // 单次 /readyz 超时
const HEALTH_MAX_FAILURES = 5; // 宽限后连续失败阈值

const BACKOFF_BASE_MS = 500; // 退避基数：500ms * 2^n
const BACKOFF_MAX_MS = 30_000; // 退避上限 30s
/** 子进程存活超过该时长视为「跑起来过」，重置退避与失败计数 */
const STABLE_UPTIME_MS = 120_000;

const FAILURE_WINDOW_MS = 5 * 60 * 1000; // 失败窗口：5 分钟
const FAILURE_THRESHOLD = 5; // 窗口内连续失败阈值

const STOP_GRACE_MS = 15_000; // SIGTERM → SIGKILL 宽限

// ---------------------------------------------------------------------------
// 诊断输出（进程脚本例外：stderr）
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[bootstrap] ${new Date().toISOString()} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// slots 最小实现（与 src/kernel/update/slots.ts 保持语义一致）
// ---------------------------------------------------------------------------

const SLOTS_FILE = path.join(DATA_DIR, 'releases', 'slots.json');
const SLOT_NAMES = ['slot-a', 'slot-b'];

/** 初始态（与 slots.ts initialSlotsState 语义一致；updatedAt 仅作占位，引导路径不使用） */
const INITIAL_SLOTS = Object.freeze({
  current: 'slot-a',
  previous: 'slot-b',
  version: null,
  previousVersion: null,
  updatedAt: 0,
  updatedAtIso: '',
  updateInFlight: false,
});

/** 形状校验（与 slots.ts isSlotsStateLike 一致的最小子集） */
function isSlotsStateLike(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    SLOT_NAMES.includes(v.current) &&
    SLOT_NAMES.includes(v.previous) &&
    (v.version === null || typeof v.version === 'string') &&
    (v.previousVersion === null || typeof v.previousVersion === 'string') &&
    typeof v.updatedAt === 'number' &&
    typeof v.updatedAtIso === 'string' &&
    typeof v.updateInFlight === 'boolean'
  );
}

/**
 * 读取 slots 状态（引导容错版）：
 * 缺失/损坏/形状不符一律退回初始态并 stderr 警告（引导路径必须可用，
 * 随后的文件存在性探测会自行降级）；不抛错。
 */
async function readSlotsMinimal() {
  let raw;
  try {
    raw = await readFile(SLOTS_FILE, 'utf8');
  } catch {
    return { ...INITIAL_SLOTS };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isSlotsStateLike(parsed)) throw new Error('shape invalid');
    return parsed;
  } catch (e) {
    log(`warning: slots.json unreadable (${e instanceof Error ? e.message : String(e)}); assuming initial state`);
    return { ...INITIAL_SLOTS };
  }
}

/** slot 目录：<dataDir>/releases/<slot>（与 slots.ts slotDir 一致） */
function slotDirOf(slot) {
  return path.join(DATA_DIR, 'releases', slot);
}

/** slot 可运行入口约定：<slotDir>/dist/main.js */
function slotMainJs(slot) {
  return path.join(slotDirOf(slot), 'dist', 'main.js');
}

/**
 * 镜像内嵌入口（cwd 相对）：容器镜像把内核 dist 构建产物 COPY 到 /app/dist（见
 * docker/Dockerfile），bootstrap 的工作目录即 /app。无任何 slot 可运行（首启未播种、
 * 或 releases 目录损坏）时回退该副本，保证「开箱即启」——仅当文件真实存在时使用。
 */
const EMBEDDED_MAIN = path.resolve('./dist/main.js');

async function embeddedMainExists() {
  try {
    await access(EMBEDDED_MAIN);
    return true;
  } catch {
    return false;
  }
}

async function mainJsExists(slot) {
  try {
    await access(slotMainJs(slot));
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析启动 slot（与 slots.ts resolveBootSlot 一致）：
 * current → previous → 任一（a→b 固定序）→ degraded（slot='slot-a'，调用方决定退出）。
 */
async function resolveBootSlotMinimal() {
  const state = await readSlotsMinimal();
  if (await mainJsExists(state.current)) {
    return { slot: state.current, version: state.version, degraded: false };
  }
  if (await mainJsExists(state.previous)) {
    return { slot: state.previous, version: state.previousVersion, degraded: false };
  }
  for (const slot of SLOT_NAMES) {
    if (await mainJsExists(slot)) {
      return { slot, version: slot === state.current ? state.version : state.previousVersion, degraded: false };
    }
  }
  return { slot: 'slot-a', version: null, degraded: true };
}

/** 原子写 slots.json（tmp + rename，0600；与 slots.ts writeSlots 一致；仅回滚路径使用） */
async function writeSlotsMinimal(state) {
  await mkdir(path.dirname(SLOTS_FILE), { recursive: true });
  const tmp = `${SLOTS_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, SLOTS_FILE);
}

/**
 * 视情况回滚（监管唯一会写 slots.json 的路径）：
 * 疑似新 slot 不健康（updateInFlight 或 version != previousVersion）时，
 * 写回 current=previous（版本随之互换、updateInFlight=false）并返回 true。
 * 正常运行期（非更新窗口）返回 false，调用方不得动作。
 */
async function maybeRollback(reason) {
  const state = await readSlotsMinimal();
  const suspicious = state.updateInFlight === true || state.version !== state.previousVersion;
  if (!suspicious) return false;
  const now = Date.now();
  const rolled = {
    current: state.previous,
    previous: state.current,
    version: state.previousVersion,
    previousVersion: state.version,
    updateInFlight: false,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
  };
  try {
    await writeSlotsMinimal(rolled);
  } catch (e) {
    log(`warning: rollback write failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  log(`UPDATE ROLLED BACK (${reason}): current=${rolled.current} version=${String(rolled.version)}`);
  return true;
}

// ---------------------------------------------------------------------------
// 子进程监管
// ---------------------------------------------------------------------------

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let shuttingDown = false; // SIGTERM/SIGINT 收尾中
let stoppingForRollback = false; // 看门狗回滚停机中（exit 回调不接管）
let restartAttempt = 0; // 退避指数 n
let consecutiveFailures = 0; // 5 分钟窗口内连续失败计数
let failureWindowStart = 0; // 窗口起点（epoch ms）
let childStartedAt = 0; // 当前子进程启动时刻
let healthTimer = null;
let healthCheckStart = 0;
let consecutiveUnhealthy = 0;

function stopHealthWatchdog() {
  if (healthTimer !== null) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

function spawnKernel(mainJs) {
  log(`spawning kernel: node ${mainJs}`);
  const c = spawn(process.execPath, [mainJs], { env: process.env, stdio: 'inherit' });
  child = c;
  childStartedAt = Date.now();
  c.on('exit', (code, signal) => onChildExit(c, code, signal));
  startHealthWatchdog(c);
}

/** 子进程退出：干净退出（0）→ 监管器随退；异常退出 → 退避重启（含回滚判定） */
function onChildExit(c, code, signal) {
  if (child !== c) return; // 已被监管逻辑脱管（回滚/关停路径接管）
  child = null;
  stopHealthWatchdog();
  if (shuttingDown) return; // 信号处理函数负责退出
  if (stoppingForRollback) return; // 回滚路径负责接管
  if (code === 0) {
    log('kernel exited cleanly (code 0); bootstrap exiting');
    process.exit(0);
  }
  void scheduleRestart(code, signal);
}

async function scheduleRestart(code, signal) {
  // 上一个子进程稳定运行过 → 旧失败不算连续，重置退避与失败窗口
  if (Date.now() - childStartedAt > STABLE_UPTIME_MS) {
    restartAttempt = 0;
    consecutiveFailures = 0;
  }
  const now = Date.now();
  if (consecutiveFailures === 0 || now - failureWindowStart > FAILURE_WINDOW_MS) {
    failureWindowStart = now;
    consecutiveFailures = 1;
  } else {
    consecutiveFailures += 1;
  }
  log(`kernel exited unexpectedly (code=${String(code)}, signal=${String(signal)}); ` +
    `consecutive failures in 5min window: ${consecutiveFailures}`);

  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    const rolledBack = await maybeRollback(`restart loop: ${consecutiveFailures} failures in 5min window`);
    if (rolledBack) {
      restartAttempt = 0;
      consecutiveFailures = 0;
      await boot(); // 立即按回滚后的 slots.json 启动旧 slot
      return;
    }
  }

  const delay = Math.min(BACKOFF_BASE_MS * 2 ** restartAttempt, BACKOFF_MAX_MS);
  restartAttempt += 1;
  log(`restarting kernel in ${delay}ms (attempt ${restartAttempt})`);
  setTimeout(() => {
    if (!shuttingDown) void boot();
  }, delay);
}

// ---------------------------------------------------------------------------
// 健康看门狗（HARNESS_BOOTSTRAP_HEALTHCHECK=0 可禁用）
// ---------------------------------------------------------------------------

function startHealthWatchdog(c) {
  stopHealthWatchdog();
  if (!HEALTHCHECK_ENABLED) return;
  healthCheckStart = Date.now();
  consecutiveUnhealthy = 0;
  healthTimer = setInterval(() => void checkHealth(c), HEALTH_INTERVAL_MS);
  healthTimer.unref();
}

async function checkHealth(c) {
  if (child !== c) {
    stopHealthWatchdog();
    return;
  }
  if (Date.now() - healthCheckStart < HEALTH_GRACE_MS) return; // 启动宽限期

  let ok = false;
  try {
    const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/readyz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  if (ok) {
    consecutiveUnhealthy = 0;
    return;
  }

  consecutiveUnhealthy += 1;
  log(`healthcheck failed: GET http://127.0.0.1:${HEALTH_PORT}/readyz (${consecutiveUnhealthy}/${HEALTH_MAX_FAILURES})`);
  if (consecutiveUnhealthy < HEALTH_MAX_FAILURES) return;

  stopHealthWatchdog(); // 回滚停机期间不再轮询
  const rolledBack = await maybeRollback(`healthcheck unhealthy x${HEALTH_MAX_FAILURES}`);
  if (rolledBack) {
    stoppingForRollback = true;
    await stopChildGracefully(c); // 停掉不健康的新 slot 子进程（脱管，exit 回调不接管）
    stoppingForRollback = false;
    restartAttempt = 0;
    consecutiveFailures = 0;
    await boot(); // 启动回滚后的旧 slot
  } else {
    // 正常运行期（非更新窗口/未切版本）：仅警告不动作——防误杀
    consecutiveUnhealthy = 0;
    log('kernel unhealthy but no update in flight (version unchanged); supervision only, not acting');
  }
}

/** 脱管并停止指定子进程：SIGTERM，STOP_GRACE_MS 后升级 SIGKILL */
function stopChildGracefully(c) {
  if (child === c) child = null; // 脱管
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, STOP_GRACE_MS);
    c.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

// ---------------------------------------------------------------------------
// 启动与信号
// ---------------------------------------------------------------------------

async function boot() {
  const resolved = await resolveBootSlotMinimal();
  if (resolved.degraded) {
    // degraded（无任何 slot 提供 dist/main.js）：回退镜像内嵌副本 ./dist/main.js（cwd /app）。
    // ⚠️ 双份同步义务（约定共享，任一变更必须三处同步）：
    //   1) 本文件内联的 slots 语义 ← src/kernel/update/slots.ts（见上方注释）；
    //   2) slot 入口布局 `<slot>/dist/main.js` ← slots.ts slotMainJs / Updater commitNewSlot；
    //   3) 内嵌入口 `./dist/main.js` ← docker/Dockerfile 的 `COPY --from=build /app/dist ./dist`。
    // 仅在内嵌副本真实存在时回退；不存在才 FATAL 退出（部署既无 slot 也无镜像产物 =
    // 构建损坏，静默兜底只会掩盖问题）。
    if (await embeddedMainExists()) {
      log('no slots found; booting embedded dist');
      log(`boot embedded main=${EMBEDDED_MAIN}`);
      spawnKernel(EMBEDDED_MAIN);
      return;
    }
    log(
      `FATAL: no bootable release under ${DATA_DIR}/releases ` +
        `(expected <slot>/dist/main.js) and no embedded kernel at ${EMBEDDED_MAIN}; exiting`,
    );
    process.exit(1);
  }
  log(`boot slot=${resolved.slot} version=${String(resolved.version)} main=${slotMainJs(resolved.slot)}`);
  spawnKernel(slotMainJs(resolved.slot));
}

/** SIGTERM/SIGINT：转发子进程，等退出（15s 后 SIGKILL），自身以相同码退出 */
async function shutdown(signum) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopHealthWatchdog();
  log(`received ${signum === 2 ? 'SIGINT' : 'SIGTERM'}; forwarding to kernel and exiting`);
  const fallbackCode = 128 + signum;
  const c = child;
  child = null; // 脱管：exit 回调不再接管
  if (!c) process.exit(fallbackCode);
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, STOP_GRACE_MS);
    c.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? fallbackCode);
    });
    c.kill(signum === 2 ? 'SIGINT' : 'SIGTERM');
  });
  process.exit(exitCode ?? fallbackCode);
}

process.on('SIGTERM', () => void shutdown(15));
process.on('SIGINT', () => void shutdown(2));

log(`bootstrap starting (dataDir=${DATA_DIR}, healthPort=${HEALTH_PORT}, healthcheck=${HEALTHCHECK_ENABLED ? 'on' : 'off'})`);
boot().catch((e) => {
  log(`FATAL: bootstrap failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
