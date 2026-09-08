/**
 * ext-auth-support — 内核侧密码学支撑（供 auth 内置扩展经 RPC 使用，内核不暴露原始 crypto）。
 *
 * - `createPasswordSupport()`：scrypt 密码哈希/校验。hash 产出自描述格式
 *   `scrypt$N$r$p$salt_hex$key_hex`（缺省 N=16384, r=8, p=1, keyLen=64, salt=16B 随机），
 *   verify 从 hash 解析参数重算后 timingSafeEqual 比较（参数损坏/格式不合法一律 false，不抛）；
 * - `safeEqualStrings(a, b)`：常数时间字符串比较（字节长度不等直接 false）。
 *
 * scrypt 参数为 OWASP 推荐基线（N=2^14, r=8, p=1）；哈希格式自带参数，
 * 未来调参后旧哈希仍可校验（verify 按 hash 内参数重算）。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** promisify 后的 scrypt（回调 → Promise）；选项收窄为对象形式 */
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** scrypt 成本参数基线（OWASP 推荐：N=2^14, r=8, p=1） */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** 随机盐缺省字节数 */
const DEFAULT_SALT_BYTES = 16;
/** 派生钥缺省字节数 */
const DEFAULT_KEY_LEN = 64;

/** hash 串的段数与算法标记（`scrypt$N$r$p$salt_hex$key_hex`） */
const HASH_SEGMENT_COUNT = 6;
const HASH_ALGORITHM = 'scrypt';

/** 密码哈希/校验门面（扩展经 auth.hashPassword / auth.verifyPassword topic 使用） */
export interface PasswordSupport {
  /** 哈希明文密码 → `scrypt$N$r$p$salt_hex$key_hex`（每次调用新鲜随机盐） */
  hash(password: string): Promise<string>;
  /** 校验明文密码与 hash 是否匹配；hash 格式非法/参数越界一律 false（不抛） */
  verify(password: string, hash: string): Promise<boolean>;
}

export interface PasswordSupportOptions {
  /** 随机盐字节数（缺省 16） */
  saltBytes?: number;
  /** 派生钥字节数（缺省 64） */
  keyLen?: number;
}

/**
 * 常数时间字符串比较（防时序侧信道）：utf8 编码后字节长度不等直接 false
 * （长度本身不构成泄露面），等长时走 crypto.timingSafeEqual。
 */
export function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 校验 scrypt 整数参数可用（正整数；node:crypto 侧还会做二次约束校验） */
function isPositiveInt(v: number): boolean {
  return Number.isInteger(v) && v > 0;
}

/**
 * 创建密码支撑实例（内核 handler 层用模块级单例；opts 仅影响 hash 产出，
 * verify 永远以 hash 内记录的参数为准）。
 */
export function createPasswordSupport(opts?: PasswordSupportOptions): PasswordSupport {
  const saltBytes = opts?.saltBytes ?? DEFAULT_SALT_BYTES;
  const keyLen = opts?.keyLen ?? DEFAULT_KEY_LEN;
  if (!isPositiveInt(saltBytes) || !isPositiveInt(keyLen)) {
    throw new TypeError('createPasswordSupport: saltBytes and keyLen must be positive integers');
  }

  return {
    async hash(password: string): Promise<string> {
      if (typeof password !== 'string') {
        throw new TypeError('hash: password must be a string');
      }
      const salt = randomBytes(saltBytes);
      const key = await scrypt(password, salt, keyLen, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
      return `${HASH_ALGORITHM}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
    },

    async verify(password: string, hash: string): Promise<boolean> {
      if (typeof password !== 'string' || typeof hash !== 'string') return false;
      const parts = hash.split('$');
      if (parts.length !== HASH_SEGMENT_COUNT || parts[0] !== HASH_ALGORITHM) return false;
      const n = Number(parts[1]);
      const r = Number(parts[2]);
      const p = Number(parts[3]);
      if (!isPositiveInt(n) || !isPositiveInt(r) || !isPositiveInt(p)) return false;
      // Buffer.from(x, 'hex') 对非法字符静默截断（不抛）；长度为 0 即视为坏格式
      const salt = Buffer.from(parts[4] ?? '', 'hex');
      const expected = Buffer.from(parts[5] ?? '', 'hex');
      if (salt.length === 0 || expected.length === 0) return false;
      let actual: Buffer;
      try {
        actual = await scrypt(password, salt, expected.length, { N: n, r, p });
      } catch {
        // hash 内参数不满足 node:crypto 约束（如 N 非 2 的幂）：按"不匹配"处理
        return false;
      }
      if (actual.length !== expected.length) return false;
      return timingSafeEqual(actual, expected);
    },
  };
}
