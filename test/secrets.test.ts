import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SecretsService } from '../src/kernel/storage/secrets.js';

let db: Knex;
let svc: SecretsService;

beforeEach(() => {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
  });
  svc = new SecretsService(db);
});

afterEach(async () => {
  await db.destroy();
});

async function rawValue(name: string): Promise<unknown> {
  const row = (await db('secrets').where('name', name).first('value')) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('SecretsService 基本读写', () => {
  it('set 后 get 返回原值', async () => {
    await svc.set('smtp/password', 'p@ssw0rd-π');
    await expect(svc.get('smtp/password')).resolves.toBe('p@ssw0rd-π');
  });

  it('缺失密钥 → null（不抛错）', async () => {
    await expect(svc.get('nope')).resolves.toBeNull();
  });

  it('覆盖更新：同名写两次 → 取最新值', async () => {
    await svc.set('k', 'v1');
    await svc.set('k', 'v2');
    await expect(svc.get('k')).resolves.toBe('v2');
  });

  it('delete：存在 → true，再删 → false；删除后 get → null', async () => {
    await svc.set('k', 'v');
    await expect(svc.delete('k')).resolves.toBe(true);
    await expect(svc.delete('k')).resolves.toBe(false);
    await expect(svc.get('k')).resolves.toBeNull();
  });
});

describe('SecretsService list：只回传元数据，不回传值', () => {
  it('list 返回 name + updatedAt（数值），行上不存在 value 字段', async () => {
    const before = Date.now();
    await svc.set('b-secret', 'value-b');
    await svc.set('a-secret', 'value-a');
    const after = Date.now();

    const list = await svc.list();
    expect(list.map((s) => s.name)).toEqual(['a-secret', 'b-secret']); // 按名称排序
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(['name', 'updatedAt']);
      expect('value' in entry).toBe(false);
      expect(typeof entry.updatedAt).toBe('number');
      expect(entry.updatedAt).toBeGreaterThanOrEqual(before);
      expect(entry.updatedAt).toBeLessThanOrEqual(after);
    }
  });

  it('list 不含已删除密钥；空表 → []', async () => {
    await svc.set('k', 'v');
    await svc.delete('k');
    await expect(svc.list()).resolves.toEqual([]);
  });

  it('对比：raw 表中确存值，但 list/get 之外的 API 均不暴露', async () => {
    await svc.set('k', 'plain-v1'); // v1 明文落库（见 JSDoc，加密为 T1）
    await expect(rawValue('k')).resolves.toBe('plain-v1'); // 存储契约
    const list = await svc.list();
    expect(JSON.stringify(list)).not.toContain('plain-v1'); // 列表绝不回传值
  });
});

describe('SecretsService 入参校验与惰性建表', () => {
  it('value 非字符串 → HarnessError(DB_ERROR)，不落库', async () => {
    await svc.set('seed', 'seed-value'); // 触发建表
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 故意传错类型验证校验
    await expect(svc.set('k', 12345 as any)).rejects.toMatchObject({ code: 'HARNESS-4003' });
    const saved = await rawValue('k');
    expect(saved).toBeUndefined(); // 校验失败不得落库
  });

  it('空 name → HarnessError(DB_ERROR)', async () => {
    await expect(svc.set('', 'v')).rejects.toMatchObject({ code: 'HARNESS-4003' });
    await expect(svc.get('')).rejects.toMatchObject({ code: 'HARNESS-4003' });
    await expect(svc.delete('')).rejects.toMatchObject({ code: 'HARNESS-4003' });
  });

  it('表不存在时首次操作自动建表；多实例共享同一库幂等共存', async () => {
    const svc2 = new SecretsService(db);
    await svc.set('a', 'va');
    await svc2.set('b', 'vb');
    await expect(svc.get('b')).resolves.toBe('vb');
    await expect(svc2.get('a')).resolves.toBe('va');
    expect((await svc2.list()).map((s) => s.name)).toEqual(['a', 'b']);
  });
});
