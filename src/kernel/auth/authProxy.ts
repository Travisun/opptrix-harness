import { timingSafeEqual } from 'node:crypto';

import { err } from '../errors/HarnessError.js';
import type { AuthProviderRegistry } from './AuthProviderRegistry.js';
import type { AuthIdentity, AuthVerifyInput } from './types.js';

/**
 * 常量时间字符串比较（防时序侧信道）：字节长度不等直接 false（长度本身不构成泄露面），
 * 等长时走 crypto.timingSafeEqual。
 */
function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 构造统一认证入口。
 * 判定顺序：token 缺失 → UNAUTHORIZED；命中 rootToken（timingSafeEqual 比较）→ root 身份（scopes ['*']）；
 * 否则交给 registry 逐个 provider 验证，仍无身份 → UNAUTHORIZED。
 *
 * rootToken 支持值或取值函数（后者适配运行期轮换/延迟解析）。
 */
export function createAuthChecker(deps: {
  rootToken: string | (() => string);
  registry: AuthProviderRegistry;
}): (input: AuthVerifyInput) => Promise<AuthIdentity> {
  return async (input: AuthVerifyInput): Promise<AuthIdentity> => {
    const token = input.token;
    if (token === undefined || token === '') {
      throw err('UNAUTHORIZED', { detail: 'missing token (Authorization: Bearer <token> or ?token=)' });
    }
    const rootToken = typeof deps.rootToken === 'function' ? deps.rootToken() : deps.rootToken;
    if (tokensEqual(token, rootToken)) {
      return { userId: 'root', role: 'root', scopes: ['*'] };
    }
    const identity = await deps.registry.verify(input);
    if (identity === null) {
      throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
    }
    return identity;
  };
}

/**
 * 从请求中提取令牌：
 * 1. `Authorization: Bearer <token>`（键名大小写不敏感，scheme 大小写不敏感）；
 * 2. query.token（仅接受字符串）。
 * Authorization 优先于 query；两者都无 → undefined。
 */
export const extractToken = (
  headers: Record<string, string | string[] | undefined>,
  query?: Record<string, unknown>,
): string | undefined => {
  let authz: string | string[] | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      authz = value;
      break;
    }
  }
  const candidates = Array.isArray(authz) ? authz : authz !== undefined ? [authz] : [];
  for (const value of candidates) {
    const m = /^\s*bearer\s+(\S+)\s*$/i.exec(value);
    const token = m?.[1];
    if (token !== undefined) return token;
  }
  const queryToken = query?.['token'];
  if (typeof queryToken === 'string' && queryToken !== '') return queryToken;
  return undefined;
};
