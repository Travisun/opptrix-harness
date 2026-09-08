/**
 * 批次化迁移运行器（Laravel 语义，记账表自管）。
 *
 * 自研而非复用 knex.migrate 的理由：knex.migrate 依赖文件目录与命名约定，
 * 记账表（knex_migrations）结构固定；本运行器以数组注入迁移、自管记账表
 * （默认 `migrations_log`：name TEXT PK / batch INTEGER / applied_at INTEGER epoch ms），
 * 不绑定任何文件布局，天然支持后续扩展库复用（每个扩展库一个 Migrator 实例、独立记账表）。
 *
 * 语义对齐 Laravel：
 * - `latest()` 一次调用 = 一个批次，batch = max(batch) + 1；
 * - `rollback()` 回滚最新批次的全部迁移，逆序执行 down；
 * - 每个迁移独立事务：up/down 与记账写入同事务，任一抛错即整体回滚。
 */
import type { Knex } from 'knex';
import { err } from '../errors/index.js';

/** 单个迁移定义。down 缺省表示该迁移不可回滚（rollback 时跳过且保留记账行）。 */
export interface Migration {
  /** 迁移名，全局唯一（记账表主键） */
  name: string;
  /** 升级；在独立事务内执行，抛错则该迁移（含 schema 变更与记账写入）整体回滚 */
  up(knex: Knex): Promise<void>;
  /** 降级；缺省时 rollback 跳过此迁移 */
  down?(knex: Knex): Promise<void>;
}

export interface MigratorOptions {
  /** 记账表名，默认 `migrations_log` */
  table?: string;
  /**
   * 迁移列表（按应用顺序传入）。latest / pending / rollback 均相对此列表工作；
   * 传入数组引用，后续 push 新迁移即可被下一次 latest() 拾取。
   */
  migrations?: Migration[];
}

const DEFAULT_TABLE = 'migrations_log';

/**
 * 批次化迁移运行器。
 *
 * 排序说明：applied() 按 SQLite rowid（插入序）升序返回；rollback 依赖该顺序逆序回滚。
 * 同一毫秒内连续应用的迁移在 applied_at 上可能并列，rowid 保证插入序稳定。
 */
export class Migrator {
  private readonly db: Knex;
  private readonly table: string;
  private readonly migrations: readonly Migration[];
  /** ensureTable 的备忘录：表只需确保一次，并发操作共享同一次建表 */
  private ensurePromise: Promise<void> | null = null;

  constructor(db: Knex, opts: MigratorOptions = {}) {
    this.db = db;
    this.table = opts.table ?? DEFAULT_TABLE;
    this.migrations = opts.migrations ?? [];
  }

  /**
   * 按数组顺序应用所有未执行的迁移；返回本次应用的迁移数量（无待应用时为 0）。
   *
   * 同一次调用内的迁移共用批号 batch = max(batch) + 1（首批评号为 1）。
   * 某迁移 up 抛错时：该迁移所在事务回滚，整体抛 `DB_MIGRATION_FAILED`
   * （detail = { name, cause }），排在其后的迁移不再执行。
   */
  async latest(): Promise<number> {
    await this.ensureTable();
    const appliedRows = await this.applied();
    const appliedNames = new Set(appliedRows.map((r) => r.name));
    const todo = this.migrations.filter((m) => !appliedNames.has(m.name));
    if (todo.length === 0) return 0;
    const batch = appliedRows.reduce((max, r) => Math.max(max, r.batch), 0) + 1;
    for (const migration of todo) {
      try {
        await this.db.transaction(async (trx) => {
          await migration.up(trx);
          await trx(this.table).insert({ name: migration.name, batch, applied_at: Date.now() });
        });
      } catch (cause) {
        throw err('DB_MIGRATION_FAILED', { detail: { name: migration.name, cause }, cause });
      }
    }
    return todo.length;
  }

  /**
   * 回滚最大批次的全部迁移（逆序执行 down，down 与记账删除同事务）。
   * 返回实际回滚的迁移数量；无可回滚批次时返回 0。
   *
   * 跳过规则：迁移缺少 down、或不在构造传入的迁移列表中时——不执行 down、
   * 不删记账行（仍可通过 applied() 观察到）、不计入返回值。
   * 某迁移 down 抛错时：该迁移所在事务回滚，整体抛 `DB_MIGRATION_FAILED`
   * （detail = { name, cause }），排在其前的已回滚迁移保持已回滚状态。
   */
  async rollback(): Promise<number> {
    await this.ensureTable();
    const all = await this.applied();
    if (all.length === 0) return 0;
    const batch = all.reduce((max, r) => Math.max(max, r.batch), 0);
    // applied() 按插入序升序，逆序即最新批次内后应用的先回滚
    const rows = all.filter((r) => r.batch === batch).reverse();
    const byName = new Map(this.migrations.map((m) => [m.name, m]));
    let rolledBack = 0;
    for (const row of rows) {
      const migration = byName.get(row.name);
      if (!migration || !migration.down) continue;
      try {
        await this.db.transaction(async (trx) => {
          await migration.down!(trx);
          await trx(this.table).where('name', row.name).del();
        });
      } catch (cause) {
        throw err('DB_MIGRATION_FAILED', { detail: { name: row.name, cause }, cause });
      }
      rolledBack += 1;
    }
    return rolledBack;
  }

  /** 全部已应用迁移记录，按应用顺序（批次升序、批内插入序）排列 */
  async applied(): Promise<Array<{ name: string; batch: number; appliedAt: number }>> {
    await this.ensureTable();
    const rows = await this.db<{ name: string; batch: number; applied_at: number }>(
      this.table,
    )
      .select('name', 'batch', 'applied_at')
      .orderBy('rowid', 'asc');
    return rows.map((r) => ({ name: r.name, batch: r.batch, appliedAt: r.applied_at }));
  }

  /** 尚未应用的迁移名（相对构造时传入的迁移列表，保持传入顺序） */
  async pending(): Promise<string[]> {
    const appliedNames = new Set((await this.applied()).map((r) => r.name));
    return this.migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);
  }

  /** 首次操作时确保记账表存在（备忘录化，避免并发重复建表） */
  private ensureTable(): Promise<void> {
    this.ensurePromise ??= (async () => {
      if (await this.db.schema.hasTable(this.table)) return;
      await this.db.schema.createTable(this.table, (t) => {
        t.text('name').primary();
        t.integer('batch').notNullable();
        t.integer('applied_at').notNullable();
      });
    })();
    return this.ensurePromise;
  }
}
