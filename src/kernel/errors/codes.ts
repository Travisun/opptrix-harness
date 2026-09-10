/**
 * HARNESS-xxxx 错误码注册表。
 * 分段：1xxx HTTP / 2xxx RPC / 3xxx EXT / 4xxx DB / 5xxx LLM / 6xxx SANDBOX / 7xxx DELIVERY / 8xxx UPDATE / 9xxx KERNEL
 * 新增错误码必须登记在此，禁止裸造。
 */
export type ErrorDomain =
  | 'HTTP'
  | 'RPC'
  | 'EXT'
  | 'DB'
  | 'LLM'
  | 'SANDBOX'
  | 'DELIVERY'
  | 'UPDATE'
  | 'KERNEL';

export interface ErrorCodeDef {
  domain: ErrorDomain;
  seq: number;
  status: number;
  message: string;
  retryable: boolean;
}

export const ERR_CODES = {
  // ---- HTTP 1xxx ----
  ROUTE_NOT_FOUND: { domain: 'HTTP', seq: 1, status: 404, message: 'route not found', retryable: false },
  HANDLER_TIMEOUT: { domain: 'HTTP', seq: 2, status: 504, message: 'extension handler timeout', retryable: true },
  SERVICE_UNAVAILABLE: { domain: 'HTTP', seq: 3, status: 503, message: 'service unavailable (extension disabled or reloading)', retryable: true },
  RATE_LIMITED: { domain: 'HTTP', seq: 4, status: 429, message: 'rate limited', retryable: true },
  PAYLOAD_TOO_LARGE: { domain: 'HTTP', seq: 5, status: 413, message: 'payload too large', retryable: false },
  UNAUTHORIZED: { domain: 'HTTP', seq: 6, status: 401, message: 'unauthorized', retryable: false },
  FORBIDDEN: { domain: 'HTTP', seq: 7, status: 403, message: 'forbidden', retryable: false },
  BAD_REQUEST: { domain: 'HTTP', seq: 8, status: 400, message: 'bad request', retryable: false },
  VALIDATION_FAILED: { domain: 'HTTP', seq: 9, status: 400, message: 'validation failed', retryable: false },
  METHOD_NOT_ALLOWED: { domain: 'HTTP', seq: 10, status: 405, message: 'method not allowed', retryable: false },
  TOO_MANY_CONCURRENT: { domain: 'HTTP', seq: 11, status: 429, message: 'extension concurrency limit reached', retryable: true },
  // ---- RPC 2xxx ----
  RPC_TIMEOUT: { domain: 'RPC', seq: 1, status: 504, message: 'rpc call timeout', retryable: true },
  RPC_TARGET_NOT_FOUND: { domain: 'RPC', seq: 2, status: 404, message: 'rpc target not found (extension disabled or not exposing this method)', retryable: false },
  RPC_PERMISSION_DENIED: { domain: 'RPC', seq: 3, status: 403, message: 'rpc permission denied', retryable: false },
  RPC_PAYLOAD_TOO_LARGE: { domain: 'RPC', seq: 4, status: 413, message: 'rpc payload too large', retryable: false },
  RPC_HANDLER_ERROR: { domain: 'RPC', seq: 5, status: 500, message: 'rpc handler raised', retryable: false },
  // ---- EXT 3xxx ----
  EXT_MANIFEST_INVALID: { domain: 'EXT', seq: 1, status: 400, message: 'extension manifest invalid', retryable: false },
  EXT_PERMISSION_DENIED: { domain: 'EXT', seq: 2, status: 403, message: 'extension permission denied', retryable: false },
  EXT_ACTIVATION_FAILED: { domain: 'EXT', seq: 3, status: 500, message: 'extension activation failed', retryable: false },
  EXT_NOT_FOUND: { domain: 'EXT', seq: 4, status: 404, message: 'extension not found', retryable: false },
  EXT_DEPENDENCY_MISSING: { domain: 'EXT', seq: 5, status: 409, message: 'extension hard dependency missing or disabled', retryable: false },
  EXT_CRASH_LOOP: { domain: 'EXT', seq: 6, status: 503, message: 'extension crash loop, auto-disabled', retryable: false },
  EXT_ROUTE_LIMIT: { domain: 'EXT', seq: 7, status: 400, message: 'extension route limit exceeded', retryable: false },
  EXT_ROUTE_CONFLICT: { domain: 'EXT', seq: 8, status: 400, message: 'duplicate route in extension', retryable: false },
  EXT_REGISTRATION_PHASE: { domain: 'EXT', seq: 9, status: 400, message: 'registration API called outside activation phase', retryable: false },
  EXT_DB_QUOTA: { domain: 'EXT', seq: 10, status: 507, message: 'extension database quota exceeded', retryable: false },
  EXT_API_INCOMPATIBLE: { domain: 'EXT', seq: 11, status: 409, message: 'extension api version incompatible with kernel', retryable: false },
  EXT_TRUST_REQUIRED: { domain: 'EXT', seq: 12, status: 403, message: 'third-party extension requires manual trust confirmation', retryable: false },
  FLOW_DISABLED: { domain: 'EXT', seq: 13, status: 403, message: 'flow endpoint is disabled', retryable: false },
  // ---- DB 4xxx ----
  DB_MIGRATION_FAILED: { domain: 'DB', seq: 1, status: 500, message: 'database migration failed', retryable: false },
  DB_STATEMENT_FORBIDDEN: { domain: 'DB', seq: 2, status: 400, message: 'sql statement forbidden (ATTACH/DETACH/load_extension/multi-statement)', retryable: false },
  DB_ERROR: { domain: 'DB', seq: 3, status: 500, message: 'database error', retryable: false },
  // ---- LLM 5xxx ----
  LLM_NOT_CONFIGURED: { domain: 'LLM', seq: 1, status: 409, message: 'llm gateway not configured', retryable: false },
  LLM_PROVIDER_ERROR: { domain: 'LLM', seq: 2, status: 502, message: 'llm provider error', retryable: true },
  LLM_MODEL_NOT_FOUND: { domain: 'LLM', seq: 3, status: 404, message: 'model not configured', retryable: false },
  LLM_PARAM_REJECTED: { domain: 'LLM', seq: 4, status: 400, message: 'provider param rejected by allowlist', retryable: false },
  // ---- SANDBOX 6xxx ----
  SANDBOX_DISABLED: { domain: 'SANDBOX', seq: 1, status: 409, message: 'sandbox disabled (enable HARNESS_SANDBOX_ENABLED)', retryable: false },
  SANDBOX_TIMEOUT: { domain: 'SANDBOX', seq: 2, status: 504, message: 'sandbox command timeout', retryable: true },
  SANDBOX_ERROR: { domain: 'SANDBOX', seq: 3, status: 500, message: 'sandbox error', retryable: false },
  SANDBOX_NOT_FOUND: { domain: 'SANDBOX', seq: 4, status: 404, message: 'sandbox workspace not found', retryable: false },
  // ---- DELIVERY 7xxx ----
  DELIVERY_FAILED: { domain: 'DELIVERY', seq: 1, status: 502, message: 'channel delivery failed', retryable: true },
  DELIVERY_DRIVER_NOT_FOUND: { domain: 'DELIVERY', seq: 2, status: 404, message: 'channel driver not found', retryable: false },
  // ---- UPDATE 8xxx ----
  UPDATE_CHECK_FAILED: { domain: 'UPDATE', seq: 1, status: 502, message: 'update feed check failed', retryable: true },
  UPDATE_CHECKSUM_MISMATCH: { domain: 'UPDATE', seq: 2, status: 400, message: 'release checksum mismatch', retryable: false },
  UPDATE_PREFLIGHT_FAILED: { domain: 'UPDATE', seq: 3, status: 500, message: 'release preflight self-check failed', retryable: false },
  UPDATE_IN_PROGRESS: { domain: 'UPDATE', seq: 4, status: 409, message: 'an update is already in progress', retryable: false },
  // ---- KERNEL 9xxx ----
  KERNEL_NOT_READY: { domain: 'KERNEL', seq: 1, status: 503, message: 'kernel not ready', retryable: true },
  KERNEL_SHUTTING_DOWN: { domain: 'KERNEL', seq: 2, status: 503, message: 'kernel shutting down', retryable: true },
  INTERNAL: { domain: 'KERNEL', seq: 3, status: 500, message: 'internal error', retryable: false },
  NOT_IMPLEMENTED: { domain: 'KERNEL', seq: 4, status: 501, message: 'not implemented', retryable: false },
} as const satisfies Record<string, ErrorCodeDef>;

export type ErrorCodeName = keyof typeof ERR_CODES;
