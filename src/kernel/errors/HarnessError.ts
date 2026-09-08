import { ERR_CODES, type ErrorDomain, type ErrorCodeName } from './codes.js';

export class HarnessError extends Error {
  readonly code: string;
  readonly detail: unknown;
  readonly retryable: boolean;
  readonly status: number;
  /** 上层可附带的响应头（如 Retry-After） */
  readonly headers?: Record<string, string>;

  constructor(
    codeName: ErrorCodeName,
    opts: { detail?: unknown; message?: string; cause?: unknown; headers?: Record<string, string> } = {},
  ) {
    const def = ERR_CODES[codeName];
    const message = opts.message ?? def.message;
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'HarnessError';
    const domainChar = domainCharOf(def.domain);
    this.code = `HARNESS-${domainChar}${String(def.seq).padStart(3, '0')}`;
    this.detail = opts.detail;
    this.retryable = def.retryable;
    this.status = def.status;
    this.headers = opts.headers;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail, retryable: this.retryable };
  }

  /**
   * 任意异常规整为 HarnessError（内部兜底 INTERNAL）。
   *
   * 注意：wrap 产生的 INTERNAL 会携带原始 message（用于服务端日志定位），
   * 勿直接回传客户端——对外响应必须使用 `err('INTERNAL')`（固定文案 'internal error'），
   * 或经 HTTP 错误处理器兜底（其对非 HarnessError 统一下发脱敏形状）。
   */
  static wrap(e: unknown, codeName: ErrorCodeName = 'INTERNAL'): HarnessError {
    if (e instanceof HarnessError) return e;
    return new HarnessError(codeName, {
      message: e instanceof Error ? e.message : String(e),
      cause: e,
    });
  }
}

function domainCharOf(domain: ErrorDomain): string {
  const map: Record<string, string> = {
    HTTP: '1',
    RPC: '2',
    EXT: '3',
    DB: '4',
    LLM: '5',
    SANDBOX: '6',
    DELIVERY: '7',
    UPDATE: '8',
    KERNEL: '9',
  };
  return map[domain] ?? '9';
}

/** 构造登记过的错误：err('HANDLER_TIMEOUT', { detail }) */
export function err(
  codeName: ErrorCodeName,
  opts: { detail?: unknown; message?: string; cause?: unknown; headers?: Record<string, string> } = {},
): HarnessError {
  return new HarnessError(codeName, opts);
}
