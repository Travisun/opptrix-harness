/**
 * 内核日志模块（pino）。
 *
 * - `createLogger(cfg)`：按 `cfg.logLevel` 构建 pino 实例；epoch ms 时间戳；
 *   密钥类字段（token/authorization/password/secret/apiKey）一律 redact
 * - `scoped(logger, scope)`：返回带 `scope` 字段的 child logger（模块/子系统标注）
 *
 * 密钥/令牌永不入日志（ENGINEERING.md）：redact 在序列化层兜底，
 * 但调用方仍不应主动把密钥写进日志字段。
 */
import pino from 'pino';

import type { HarnessConfig } from '../config/index.js';
import { LOG_LEVEL_NUM } from './sqlite-sink.js';

/** 密钥类字段名：出现在这些路径的值一律替换为 [REDACTED] */
const REDACT_KEYS = ['token', 'authorization', 'password', 'secret', 'apiKey', 'api_key'] as const;

/**
 * pino redact 路径：顶层字段 + 一/二/三层嵌套通配（`*.token` … `*.*.*.token`），
 * 覆盖常见 HTTP 序列化位置（req.headers.authorization 等）。pino 无深层 `**` 通配，
 * 更深嵌套的密钥字段应由调用方避免入日志。
 */
const REDACT_PATHS: string[] = [
  ...REDACT_KEYS,
  ...REDACT_KEYS.map((k) => `*.${k}`),
  ...REDACT_KEYS.map((k) => `*.*.${k}`),
  ...REDACT_KEYS.map((k) => `*.*.*.${k}`),
  'req.headers.authorization',
  'req.headers.token',
];

/**
 * 创建 kernel logger。
 * @param cfg 内核配置（使用 `logLevel`）
 * @param stream 可选输出流（默认 stdout，fd 1）；测试注入捕获流用
 */
export function createLogger(cfg: HarnessConfig, stream?: pino.DestinationStream): pino.Logger {
  return pino(
    {
      level: cfg.logLevel,
      timestamp: pino.stdTimeFunctions.epochTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    stream,
  );
}

/** 返回带 `scope` 字段的 child logger：`scoped(logger, 'rpc.server').warn(...)` */
export function scoped(logger: pino.Logger, scope: string): pino.Logger {
  return logger.child({ scope });
}

// ---------------------------------------------------------------------------
// 启动期 logger（multistream：stdout + 可注册 sink）
// ---------------------------------------------------------------------------

/** 启动期 logger 句柄：logger 直接可用；addSink 在启动期随时挂载额外输出流 */
export interface BootLogger {
  logger: pino.Logger;
  /**
   * 追加一个输出流（如 `createSqliteLogSink(db).stream`）。
   * @param stream pino 目的地流
   * @param level 该流接收的最低级别，缺省沿用 `cfg.logLevel`
   */
  addSink(stream: pino.DestinationStream, level?: pino.Level): void;
}

/**
 * 创建启动期 logger：pino.multistream 双写（stdout 在前，`addSink` 追加后续流）。
 *
 * - stdout 目的地为 `pino.destination({ dest: 1, sync: false })`（异步刷写）；
 *   测试可通过 `opts.stdout` 注入内存流覆盖
 * - 多流各自按 entry 级别过滤：记录先经 logger 级别放行，再由 multistream
 *   按每流级别分发——因此 `addSink(stream, 更低级别)` 时会把 logger 级别
 *   自动下调到两者更严者，低级别日志才能真正序列化下发（stdout 仍按自身级别过滤）
 * - 脱敏/redact/时间戳语义与 {@link createLogger} 完全一致
 *
 * @param cfg 内核配置（使用 `logLevel`）
 * @param opts.stdout 覆盖默认 stdout 目的地（测试用）
 */
export function createBootLogger(cfg: HarnessConfig, opts?: { stdout?: pino.DestinationStream }): BootLogger {
  const stdoutDest = opts?.stdout ?? pino.destination({ dest: 1, sync: false });
  const multi = pino.multistream([{ level: cfg.logLevel, stream: stdoutDest }]);
  const logger = pino(
    {
      level: cfg.logLevel,
      timestamp: pino.stdTimeFunctions.epochTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    multi,
  );
  return {
    logger,
    addSink(stream: pino.DestinationStream, level?: pino.Level): void {
      const entryLevel = level ?? cfg.logLevel;
      multi.add({ level: entryLevel, stream });
      const next = LOG_LEVEL_NUM[entryLevel];
      const current = LOG_LEVEL_NUM[logger.level as pino.Level];
      if (next !== undefined && current !== undefined && next < current) {
        logger.level = entryLevel; // 放行更低级别：由 multistream 按流各自过滤
      }
    },
  };
}
