import { describe, expect, it } from 'vitest';
import { ERR_CODES, HarnessError, err, type ErrorDomain, type ErrorCodeName } from '../src/kernel/errors/index.js';

describe('HarnessError 构造与错误码映射', () => {
  it("err('HANDLER_TIMEOUT') → HARNESS-1002 / 504 / retryable", () => {
    const e = err('HANDLER_TIMEOUT');
    expect(e).toBeInstanceOf(HarnessError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('HarnessError');
    expect(e.code).toBe('HARNESS-1002');
    expect(e.status).toBe(504);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe(ERR_CODES.HANDLER_TIMEOUT.message);
  });

  it("err('ROUTE_NOT_FOUND') → 404", () => {
    const e = err('ROUTE_NOT_FOUND');
    expect(e.code).toBe('HARNESS-1001');
    expect(e.status).toBe(404);
    expect(e.retryable).toBe(false);
  });

  it("err('EXT_DB_QUOTA') → HARNESS-3010 / 507（两位序号补零）", () => {
    const e = err('EXT_DB_QUOTA');
    expect(e.code).toBe('HARNESS-3010');
    expect(e.status).toBe(507);
  });

  it("err('UPDATE_CHECKSUM_MISMATCH') → HARNESS-8002", () => {
    const e = err('UPDATE_CHECKSUM_MISMATCH');
    expect(e.code).toBe('HARNESS-8002');
    expect(e.status).toBe(400);
  });

  it('自定义 message / detail / headers / cause 生效', () => {
    const cause = new Error('boom');
    const e = err('RATE_LIMITED', {
      message: 'too many requests, slow down',
      detail: { key: 'ip:1.2.3.4', limit: 100 },
      headers: { 'Retry-After': '30' },
      cause,
    });
    expect(e.message).toBe('too many requests, slow down');
    expect(e.detail).toEqual({ key: 'ip:1.2.3.4', limit: 100 });
    expect(e.headers).toEqual({ 'Retry-After': '30' });
    expect(e.cause).toBe(cause);
  });

  it('toJSON 形状恰为 { code, message, detail, retryable }', () => {
    const e = err('BAD_REQUEST', { detail: { field: 'email' } });
    expect(e.toJSON()).toEqual({
      code: 'HARNESS-1008',
      message: 'bad request',
      detail: { field: 'email' },
      retryable: false,
    });
    expect(Object.keys(e.toJSON()).sort()).toEqual(['code', 'detail', 'message', 'retryable']);
  });
});

describe('HarnessError.wrap', () => {
  it('普通 Error → INTERNAL，message 保留，原错误作为 cause', () => {
    const original = new Error('socket hang up');
    const wrapped = HarnessError.wrap(original);
    expect(wrapped).toBeInstanceOf(HarnessError);
    expect(wrapped.code).toBe('HARNESS-9003');
    expect(wrapped.status).toBe(500);
    expect(wrapped.message).toBe('socket hang up');
    expect(wrapped.cause).toBe(original);
  });

  it('非 Error 值 → INTERNAL，String() 化为 message', () => {
    const wrapped = HarnessError.wrap('plain string failure');
    expect(wrapped.code).toBe('HARNESS-9003');
    expect(wrapped.message).toBe('plain string failure');
  });

  it('wrap(HarnessError) 原样返回（同一引用，不改码）', () => {
    const original = err('RPC_TIMEOUT', { detail: { ms: 3000 } });
    const wrapped = HarnessError.wrap(original);
    expect(wrapped).toBe(original);
    expect(wrapped.code).toBe('HARNESS-2001');
  });

  it('wrap 可指定其他兜底码', () => {
    const wrapped = HarnessError.wrap(new Error('x'), 'LLM_PROVIDER_ERROR');
    expect(wrapped.code).toBe('HARNESS-5002');
    expect(wrapped.retryable).toBe(true);
  });
});

describe('各 domain 段首个错误码的域字符映射（1-9）', () => {
  // codes.ts 中每个域按登记顺序的首个错误码
  const firstCodeByDomain: Array<[ErrorDomain, ErrorCodeName, string]> = [
    ['HTTP', 'ROUTE_NOT_FOUND', 'HARNESS-1001'],
    ['RPC', 'RPC_TIMEOUT', 'HARNESS-2001'],
    ['EXT', 'EXT_MANIFEST_INVALID', 'HARNESS-3001'],
    ['DB', 'DB_MIGRATION_FAILED', 'HARNESS-4001'],
    ['LLM', 'LLM_NOT_CONFIGURED', 'HARNESS-5001'],
    ['SANDBOX', 'SANDBOX_DISABLED', 'HARNESS-6001'],
    ['DELIVERY', 'DELIVERY_FAILED', 'HARNESS-7001'],
    ['UPDATE', 'UPDATE_CHECK_FAILED', 'HARNESS-8001'],
    ['KERNEL', 'KERNEL_NOT_READY', 'HARNESS-9001'],
  ];

  it('每个域的首码映射到正确的域字符', () => {
    expect(firstCodeByDomain).toHaveLength(9);
    for (const [domain, codeName, expectedCode] of firstCodeByDomain) {
      const e = err(codeName);
      expect(ERR_CODES[codeName].domain, codeName).toBe(domain);
      expect(e.code, codeName).toBe(expectedCode);
      expect(e.code.startsWith(`HARNESS-${expectedCode.slice(8, 9)}`), codeName).toBe(true);
    }
  });

  it('HARNESS 码格式：HARNESS-<域字符1-9><三位序号>', () => {
    for (const codeName of Object.keys(ERR_CODES) as ErrorCodeName[]) {
      const e = err(codeName);
      expect(e.code).toMatch(/^HARNESS-[1-9]\d{3}$/);
    }
  });

  it('遍历 ERR_CODES：domain+seq 组合无重复（同一域内序号唯一）', () => {
    const seen = new Map<string, ErrorCodeName>();
    for (const codeName of Object.keys(ERR_CODES) as ErrorCodeName[]) {
      const def = ERR_CODES[codeName];
      const key = `${def.domain}#${def.seq}`;
      expect(seen.has(key), `${codeName} 与 ${seen.get(key) ?? ''} 重复占用 ${key}`).toBe(false);
      seen.set(key, codeName);
    }
    expect(seen.size).toBe(Object.keys(ERR_CODES).length);
  });
});
