/**
 * 内核密钥存储服务（`secrets` 表）。
 *
 * 安全约定（必须遵守）：
 * - 只存密钥名与值；除 `get()` 外任何 API（如 `list()`）一律不回传值字段。
 * - 值永不写入日志：本服务不含任何 logger 调用，错误 detail 中也不得携带 value。
 * - v1 明文落库：主库文件权限 0600 由部署保证；加密存储升级列为 T1 任务，
 *   届时仅替换本类内部读写实现，表结构与公开 API 保持不变。
 *
 * - 表结构（迁移由内核统一管理；本服务通过 `ensureTable` 惰性建表以便独立使用）：
 *   `secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`
 */
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';

const TABLE = 'secrets';

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

  constructor(private readonly db: Knex) {}

  /**
   * 写入（新增或覆盖）一个密钥。value 必须为字符串（密钥按原样落库，不做序列化）。
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
    const now = Date.now();
    await this.db(TABLE)
      .insert({ name, value, updated_at: now })
      .onConflict('name')
      .merge({ value, updated_at: now });
  }

  /**
   * 读取一个密钥的值。
   * @returns 密钥值；不存在时返回 null（而非抛错）
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
    return row?.value ?? null;
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
