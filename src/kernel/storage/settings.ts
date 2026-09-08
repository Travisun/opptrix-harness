/**
 * 内核设置存储服务（`settings` 表）。
 *
 * - 表结构（迁移由内核统一管理；本服务通过 `ensureTable` 惰性建表以便独立使用）：
 *   `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)`
 * - value 一律以 JSON 字符串落库；updated_at 为 UTC epoch ms（`Date.now()`）。
 * - `get` 对 JSON 损坏（反序列化失败）容错：返回 fallback，不抛错。
 * - `all` 跳过损坏行，保证整体读取不因单条脏数据失败。
 */
import type { Knex } from 'knex';

import { err, HarnessError } from '../errors/index.js';

const TABLE = 'settings';

interface SettingsRow {
  key: string;
  value: string;
}

export class SettingsService {
  /** 惰性建表的共享 Promise：并发调用只触发一次；失败后重置以便重试 */
  private tableReady?: Promise<void>;

  constructor(private readonly db: Knex) {}

  /**
   * 读取一个设置项（JSON 反序列化）。
   * 键不存在或 value 损坏（非法 JSON）时返回 fallback（默认 undefined），不抛错。
   * 注意：返回值按调用方声明的 T 信任，本服务不做运行时形状校验。
   */
  async get<T>(key: string, fallback?: T): Promise<T | undefined> {
    assertKey(key, 'settings.get');
    await this.ensureTable();
    const row = (await this.db(TABLE).where('key', key).first('value')) as SettingsRow | undefined;
    if (row === undefined) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch (e) {
      // JSON 损坏容错：不抛错，返回 fallback（损坏详情放 detail 便于排查）
      void e;
      return fallback;
    }
  }

  /**
   * 写入（新增或覆盖）一个设置项。value 必须可 JSON 序列化。
   * updated_at 取写入时刻的 UTC epoch ms（Date.now()）。
   */
  async set(key: string, value: unknown): Promise<void> {
    assertKey(key, 'settings.set');
    let json: string;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string') {
        throw err('DB_ERROR', {
          message:
            `settings.set: value for key "${key}" is not JSON-serializable ` +
            '(undefined, function or symbol). Store null instead, or serialize before saving.',
          detail: { key },
        });
      }
      json = serialized;
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      throw err('DB_ERROR', {
        message:
          `settings.set: failed to JSON-serialize value for key "${key}" ` +
          '(circular reference or BigInt?). Fix the value before saving.',
        detail: { key },
        cause: e,
      });
    }
    await this.ensureTable();
    const now = Date.now();
    await this.db(TABLE)
      .insert({ key, value: json, updated_at: now })
      .onConflict('key')
      .merge({ value: json, updated_at: now });
  }

  /**
   * 删除一个设置项。
   * @returns 是否确有行被删除（键不存在返回 false）
   */
  async delete(key: string): Promise<boolean> {
    assertKey(key, 'settings.delete');
    await this.ensureTable();
    const affected = await this.db(TABLE).where('key', key).del();
    return affected > 0;
  }

  /**
   * 读取全部设置项（JSON 反序列化后的键值表）。
   * 损坏行（非法 JSON）被跳过而非抛错。
   */
  async all(): Promise<Record<string, unknown>> {
    await this.ensureTable();
    const rows = (await this.db(TABLE).select('key', 'value')) as SettingsRow[];
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        // 跳过损坏行，保证 all() 整体可用
      }
    }
    return out;
  }

  /** 惰性幂等建表：已存在则跳过（与内核迁移幂等兼容） */
  private ensureTable(): Promise<void> {
    this.tableReady ??= (async () => {
      const has = await this.db.schema.hasTable(TABLE);
      if (has) return;
      await this.db.schema.createTable(TABLE, (t) => {
        t.text('key').primary();
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

/** 入参校验：key 必须是非空字符串（错误信息可操作：说清哪里错了、怎么改） */
function assertKey(key: string, op: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw err('DB_ERROR', {
      message: `${op}: settings key must be a non-empty string (got ${typeof key}). Provide a non-empty key.`,
      detail: { key },
    });
  }
}
