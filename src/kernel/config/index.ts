/**
 * 全局配置模块。
 *
 * - `loadDotenv()`：可选的 .env 装载（幂等、不覆盖已有环境变量、.env 缺失不致命）
 * - `loadConfig()`：同步、fail-fast 的配置解析（env 前缀 HARNESS_，运行环境用 NODE_ENV）
 * - `configGet()`：Laravel `config()` 风格的点号取值
 *
 * 来源优先级：默认值 ← .env ← 进程环境变量（dotenv 默认不覆盖已有真实环境变量）。
 * 任何配置项非法都在启动期抛 HarnessError，信息包含变量名、期望值与修复方式。
 */
import { createRequire } from 'node:module';

import { err } from '../errors/index.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface HarnessConfig {
  env: 'development' | 'production' | 'test';
  dataDir: string;
  port: number;
  host: string;
  /** break-glass root 令牌；为空则首次启动生成并打印 */
  token: string;
  persistRootToken: boolean;
  /** CORS 允许的 origin；'*' 或逗号分隔的 origin 列表（如 "https://a.com,https://b.com"） */
  corsOrigin: string;
  /** 是否信任 X-Forwarded-* 头（反代部署置 true；直连暴露务必保持 false） */
  trustProxy: boolean;
  logLevel: LogLevel;
  /** 展示与 cron 默认时区（IANA）。存储一律 UTC。 */
  timezone: string;
  taskWorkers: number;
  rpcTimeoutMs: number;
  routeTimeoutMs: number;
  maxBodyBytes: number;
  maxUploadBytes: number;
  maxRpcPayloadBytes: number;
  maxRoutesPerExt: number;
  maxConcurrentPerExt: number;
  sandboxEnabled: boolean;
  sandboxImage: string;
  dockerHost: string;
  updateAuto: boolean;
  updateFeed: string;
  updateChannel: 'stable' | 'beta';
  updateToken: string;
  updateWindow: string;
  crashLoopWindowMs: number;
  crashLoopMax: number;
}

// ---------------------------------------------------------------------------
// env 解析辅助（全部 fail-fast，错误信息面向开发者可操作）
// ---------------------------------------------------------------------------

const TRUE_BOOLS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLS = new Set(['0', 'false', 'off', 'no']);

/** 统一构造配置校验错误：码 VALIDATION_FAILED（HARNESS-1009），message 即修复指引 */
function configError(message: string, detail: { env: string; value: string }) {
  return err('VALIDATION_FAILED', { message, detail });
}

const strEnv = (v: string | undefined, def: string): string => (v === undefined || v === '' ? def : v);

const intEnv = (key: string, v: string | undefined, def: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw configError(
      `[config] ${key}: expected integer in [${min}, ${max}], got "${v}". ` +
        `Fix the variable or unset it to use the default ${def}.`,
      { env: key, value: v },
    );
  }
  return n;
};

/** 布尔解析：真值 1/true/yes/on，假值 0/false/off/no（大小写不敏感），其余 fail-fast */
const boolEnv = (key: string, v: string | undefined, def: boolean): boolean => {
  if (v === undefined || v.trim() === '') return def;
  const s = v.trim().toLowerCase();
  if (TRUE_BOOLS.has(s)) return true;
  if (FALSE_BOOLS.has(s)) return false;
  throw configError(
    `[config] ${key}: expected boolean ("1"/"true"/"yes"/"on" or "0"/"false"/"off"/"no"), got "${v}". ` +
      'Fix the variable or unset it to use the default.',
    { env: key, value: v },
  );
};

const enumEnv = <T extends string>(key: string, v: string | undefined, allowed: readonly T[], def: T): T => {
  if (v === undefined || v.trim() === '') return def;
  const lower = v.trim().toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === lower);
  if (!hit) {
    throw configError(
      `[config] ${key}: expected one of [${allowed.join('|')}], got "${v}". ` +
        'Fix the variable or unset it to use the default.',
      { env: key, value: v },
    );
  }
  return hit;
};

/** IANA 时区校验：非法即抛错（存储一律 UTC，此值仅用于展示与 cron 边界层） */
function validateTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw configError(
      `[config] HARNESS_TIMEZONE: "${tz}" is not a valid IANA time zone. ` +
        'Use a tz database name such as "UTC", "Asia/Shanghai" or "America/New_York".',
      { env: 'HARNESS_TIMEZONE', value: tz },
    );
  }
  return tz;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 解析进程环境（或显式传入的 env）为 {@link HarnessConfig}。
 * 同步、fail-fast：任何非法值立即抛 {@link HarnessError}（VALIDATION_FAILED）。
 * @param env 默认 `process.env`；测试传 `{}` 得到纯默认值
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): HarnessConfig {
  const cfg: HarnessConfig = {
    env: enumEnv('NODE_ENV', env.NODE_ENV, ['development', 'production', 'test'] as const, 'development'),
    dataDir: strEnv(env.HARNESS_DATA_DIR, './data'),
    port: intEnv('HARNESS_PORT', env.HARNESS_PORT, 3000, 1, 65535),
    host: strEnv(env.HARNESS_HOST, '0.0.0.0'),
    // 显式 trim：空白串视为未设置（空串 → 走生成/持久化路径）；长度校验在 ensureRootToken
    token: strEnv(env.HARNESS_TOKEN, '').trim(),
    persistRootToken: boolEnv('HARNESS_PERSIST_ROOT_TOKEN', env.HARNESS_PERSIST_ROOT_TOKEN, true),
    corsOrigin: strEnv(env.HARNESS_CORS_ORIGIN, '*'),
    trustProxy: boolEnv('HARNESS_TRUST_PROXY', env.HARNESS_TRUST_PROXY, false),
    logLevel: enumEnv(
      'HARNESS_LOG_LEVEL',
      env.HARNESS_LOG_LEVEL,
      ['trace', 'debug', 'info', 'warn', 'error'] as const,
      'info',
    ),
    timezone: validateTimezone(strEnv(env.HARNESS_TIMEZONE, 'UTC')),
    taskWorkers: intEnv('HARNESS_TASK_WORKERS', env.HARNESS_TASK_WORKERS, 1, 1, 16),
    rpcTimeoutMs: intEnv('HARNESS_RPC_TIMEOUT_MS', env.HARNESS_RPC_TIMEOUT_MS, 30_000, 1_000, 600_000),
    routeTimeoutMs: intEnv('HARNESS_ROUTE_TIMEOUT_MS', env.HARNESS_ROUTE_TIMEOUT_MS, 30_000, 1_000, 600_000),
    maxBodyBytes: intEnv('HARNESS_MAX_BODY_BYTES', env.HARNESS_MAX_BODY_BYTES, 2 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER),
    maxUploadBytes: intEnv('HARNESS_MAX_UPLOAD_BYTES', env.HARNESS_MAX_UPLOAD_BYTES, 100 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER),
    maxRpcPayloadBytes: intEnv(
      'HARNESS_MAX_RPC_PAYLOAD_BYTES',
      env.HARNESS_MAX_RPC_PAYLOAD_BYTES,
      8 * 1024 * 1024,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxRoutesPerExt: intEnv('HARNESS_MAX_ROUTES_PER_EXT', env.HARNESS_MAX_ROUTES_PER_EXT, 100, 1, 10_000),
    maxConcurrentPerExt: intEnv('HARNESS_MAX_CONCURRENT_PER_EXT', env.HARNESS_MAX_CONCURRENT_PER_EXT, 32, 1, 10_000),
    sandboxEnabled: boolEnv('HARNESS_SANDBOX_ENABLED', env.HARNESS_SANDBOX_ENABLED, false),
    sandboxImage: strEnv(env.HARNESS_SANDBOX_IMAGE, 'opptrix-sandbox:latest'),
    dockerHost: strEnv(env.HARNESS_DOCKER_HOST, ''),
    updateAuto: boolEnv('HARNESS_UPDATE_AUTO', env.HARNESS_UPDATE_AUTO, false),
    updateFeed: strEnv(env.HARNESS_UPDATE_FEED, ''),
    updateChannel: enumEnv('HARNESS_UPDATE_CHANNEL', env.HARNESS_UPDATE_CHANNEL, ['stable', 'beta'] as const, 'stable'),
    updateToken: strEnv(env.HARNESS_UPDATE_TOKEN, ''),
    updateWindow: strEnv(env.HARNESS_UPDATE_WINDOW, '0 4 * * *'),
    crashLoopWindowMs: intEnv('HARNESS_CRASH_LOOP_WINDOW_MS', env.HARNESS_CRASH_LOOP_WINDOW_MS, 60_000, 1_000, 3_600_000),
    crashLoopMax: intEnv('HARNESS_CRASH_LOOP_MAX', env.HARNESS_CRASH_LOOP_MAX, 5, 1, 1_000),
  };
  return cfg;
}

/**
 * Laravel `config()` 风格点号取值：`configGet(cfg, 'port')`、`configGet(cfg, 'a.b.c')`。
 * 路径不存在（或中途断链）返回 fallback；未给 fallback 则为 undefined。
 * 返回类型为 `T | undefined`：调用侧必须处理取值缺失（undefined）的情形。
 */
export function configGet<T>(cfg: HarnessConfig, path: string, fallback?: T): T | undefined {
  if (path === '') return fallback;
  let cur: unknown = cfg;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return fallback;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? fallback : (cur as T);
}

// dotenv 包的最小类型面（createRequire 返回 any，此处收窄；避免引入 any 泄漏）
interface DotenvModule {
  config(options?: { quiet?: boolean; path?: string; override?: boolean }): { error?: Error; parsed?: Record<string, string> };
}

let dotenvLoaded = false;

/**
 * 装载项目根目录 `.env`（存在时）。特性：
 * - 幂等：重复调用只生效一次
 * - 不覆盖已存在的环境变量（dotenv 默认语义，进程环境优先于 .env）
 * - .env 缺失或 dotenv 包不可用均不致命（.env 只是本地开发便利层）
 *
 * 由 boot 流程显式调用，避免 import 期副作用。
 */
export async function loadDotenv(): Promise<void> {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const require = createRequire(import.meta.url);
    const dotenv = require('dotenv') as DotenvModule;
    // config() 对缺失的 .env 返回 { error } 而不抛错；quiet 关闭提示输出
    dotenv.config({ quiet: true });
  } catch {
    /* .env 是可选的：包缺失/加载失败均忽略 */
  }
}
