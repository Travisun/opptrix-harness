/**
 * 内核密钥存储服务（`secrets` 表）。
 *
 * 安全约定（必须遵守）：
 * - 只存密钥名与值；除 `get()` 外任何 API（如 `list()`）一律不回传值字段。
 * - 值永不写入日志：本服务不含任何 logger 调用，错误 detail 中也不得携带 value。
 * - 加密落盘（注入 secretKey 时）：AES-256-GCM，随机 96-bit IV，存储格式
 *   `enc:v1:<ivB64>:<tagB64>:<cipherB64>`（base64 字母表不含 ':'，按 ':' 切分安全）。
 *   GCM 认证标签保证完整性：密钥不符/密文被篡改 → 解密失败 → `get()` 返回 null 并
 *   经 `process.emitWarning` 进程级一次性告警（坏库通常影响多行，避免告警风暴）。
 * - 兼容性：`get()` 读到无 `enc:v1:` 前缀的历史明文值 → 原样返回（不做迁移写回）；
 *   未注入 secretKey（裸装配）→ 明文直存（v1 遗留模式，主库文件权限 0600 由部署保证）。
 *   ⚠️ 未注入 key 时读到 `enc:v1:` 值无法解密 → 同样 null + 告警（绝不把密文当值返回）。
 * - 表结构（迁移由内核统一管理；本服务通过 `ensureTable` 惰性建表以便独立使用）：
 *   `secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';

const TABLE = 'secrets';

/** 加密值前缀（版本化：v1 = AES-256-GCM，三段 base64） */
const ENC_PREFIX = 'enc:v1:';
/** GCM 推荐 IV 长度（96 bit） */
const IV_BYTES = 12;
/** GCM 认证标签长度（128 bit） */
const TAG_BYTES = 16;
/** AES-256 密钥长度（字节） */
const KEY_BYTES = 32;

/** 解密失败告警的一次性标记（进程级；坏库文件通常影响多行，只告警一次） */
let decryptFailureWarned = false;

/** 进程级一次性告警（值与名字段不入 message 细节以外的任何日志通道） */
function warnDecryptFailure(reason: string): void {
  if (decryptFailureWarned) return;
  decryptFailureWarned = true;
  process.emitWarning(
    `[secrets] an encrypted secret value could not be decrypted (${reason}) and null was returned. ` +
      'Provide the same secret.key data key used for encryption, or re-set affected secrets to rewrite them. ' +
      '(Warning is emitted once per process.)',
    { code: 'HARNESS_SECRETS_DECRYPT_FAILED' },
  );
}

/** AES-256-GCM 加密：随机 IV，输出 `enc:v1:<ivB64>:<tagB64>:<cipherB64>` */
function encryptValue(secretKey: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
  const cipherText = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${cipherText.toString('base64')}`;
}

/**
 * AES-256-GCM 解密。任何失败（格式非法 / IV·tag 长度不符 / 认证失败 / 密钥不符）
 * 都返回 null 并触发一次性告警，绝不抛错、绝不回传密文。
 */
function decryptValue(secretKey: Buffer, stored: string): string | null {
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    warnDecryptFailure('malformed enc:v1 payload (expected iv:tag:cipher)');
    return null;
  }
  try {
    const iv = Buffer.from(parts[0]!, 'base64');
    const tag = Buffer.from(parts[1]!, 'base64');
    const cipherText = Buffer.from(parts[2]!, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || cipherText.length === 0) {
      warnDecryptFailure('malformed enc:v1 payload (iv/tag/cipher length out of range)');
      return null;
    }
    const decipher = createDecipheriv('aes-256-gcm', secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败（密钥不符/密文被篡改）在此落地
    warnDecryptFailure('GCM authentication failed (wrong key or tampered data)');
    return null;
  }
}

interface SecretRow {
  name: string;
  value: string;
}

/** list() 的返回行：仅元数据，永不携带值 */
export interface SecretMeta {
  name: string;
  /** 最后更新时间，UTC epoch ms（Date.now()） */
  updatedAt: number;
}

export class SecretsService {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  /**
   * @param db knex 实例（内核主库）
   * @param secretKey 可选数据密钥（32 字节，来源 `loadOrCreateSecretKey()`）。
   *   注入 → set() 以 AES-256-GCM 加密落库；未注入（裸装配兼容）→ 明文直存（v1 遗留
   *   模式），get() 对历史明文与 enc:v1 值分别原样返回 / null+告警。
   *   主库装配接线由集成方完成（见 Kernel.ts secrets 登记处）。
   * @throws HarnessError（DB_ERROR）secretKey 长度 ≠ 32 字节（fail-fast，绝不带病运行）
   */
  constructor(private readonly db: Knex, private readonly secretKey?: Buffer) {
    if (secretKey !== undefined && secretKey.length !== KEY_BYTES) {
      throw err('DB_ERROR', {
        message:
          `SecretsService: secretKey must be exactly ${KEY_BYTES} bytes for AES-256-GCM ` +
          `(got ${secretKey.length}). Obtain it via loadOrCreateSecretKey({ dataDir }).`,
        detail: { bytes: secretKey.length, expected: KEY_BYTES },
      });
    }
  }

  /**
   * 写入（新增或覆盖）一个密钥。value 必须为字符串（按原样加密/落库，不做序列化）。
   * 注入 secretKey 时值以 AES-256-GCM 加密（每次写入新鲜随机 IV）后落库。
   * updated_at 取写入时刻的 UTC epoch ms（Date.now()）。
   */
  async set(name: string, value: string): Promise<void> {
    if (typeof name !== 'string' || name.length === 0) {
      throw err('DB_ERROR', {
        message:
          `secrets.set: secret name must be a non-empty string (got ${typeof name}). ` +
          'Provide a non-empty name, e.g. "smtp/password".',
        detail: { name },
      });
    }
    if (typeof value !== 'string') {
      throw err('DB_ERROR', {
        message:
          `secrets.set: secret value for "${name}" must be a string (got ${typeof value}). ` +
          'Convert the value to a string (e.g. JSON.stringify / String) before saving.',
        detail: { name },
      });
    }
    await this.ensureTable();
    const stored = this.secretKey === undefined ? value : encryptValue(this.secretKey, value);
    const now = Date.now();
    await this.db(TABLE)
      .insert({ name, value: stored, updated_at: now })
      .onConflict('name')
      .merge({ value: stored, updated_at: now });
  }

  /**
   * 读取一个密钥的值。
   * - `enc:v1:` 前缀值 → AES-256-GCM 解密；解密/认证失败 → null + 进程一次性告警。
   * - 历史明文值（无前缀）→ 原样返回（兼容升级前数据，不做迁移写回）。
   * @returns 密钥值；不存在或加密值不可解密时返回 null（而非抛错）
   */
  async get(name: string): Promise<string | null> {
    if (typeof name !== 'string' || name.length === 0) {
      throw err('DB_ERROR', {
        message:
          `secrets.get: secret name must be a non-empty string (got ${typeof name}). ` +
          'Provide a non-empty name.',
        detail: { name },
      });
    }
    await this.ensureTable();
    const row = (await this.db(TABLE).where('name', name).first('value')) as SecretRow | undefined;
    const stored = row?.value;
    if (stored === undefined || stored === null) return null;
    if (!stored.startsWith(ENC_PREFIX)) return stored; // 历史明文 / 未注入 key 的写入
    if (this.secretKey === undefined) {
      warnDecryptFailure('no secretKey configured for this SecretsService');
      return null;
    }
    return decryptValue(this.secretKey, stored);
  }

  /**
   * 删除一个密钥。
   * @returns 是否确有行被删除（名称不存在返回 false）
   */
  async delete(name: string): Promise<boolean> {
    if (typeof name !== 'string' || name.length === 0) {
      throw err('DB_ERROR', {
        message:
          `secrets.delete: secret name must be a non-empty string (got ${typeof name}). ` +
          'Provide a non-empty name.',
        detail: { name },
      });
    }
    await this.ensureTable();
    const affected = await this.db(TABLE).where('name', name).del();
    return affected > 0;
  }

  /**
   * 列出全部密钥（按名称排序）。仅返回名称与更新时间，永不回传值。
   */
  async list(): Promise<SecretMeta[]> {
    await this.ensureTable();
    const rows = (await this.db(TABLE)
      .select('name', 'updated_at')
      .orderBy('name')) as Array<{ name: string; updated_at: number | null }>;
    return rows.map((r) => ({ name: r.name, updatedAt: r.updated_at ?? 0 }));
  }

  /** 惰性幂等建表：已存在则跳过（与内核迁移幂等兼容） */
  private ensureTable(): Promise<void> {
    this.tableReady ??= (async () => {
      const has = await this.db.schema.hasTable(TABLE);
      if (has) return;
      await this.db.schema.createTable(TABLE, (t) => {
        t.text('name').primary();
        t.text('value').notNullable();
        t.integer('updated_at');
      });
    })().catch((e: unknown) => {
      this.tableReady = undefined; // 失败后允许下次重试
      throw HarnessError.wrap(e, 'DB_ERROR');
    });
    return this.tableReady;
  }
}
