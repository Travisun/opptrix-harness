import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadOrCreateSecretKey } from '../src/kernel/storage/secretkey.js';
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
    await svc.set('k', 'plain-v1'); // 未注入 secretKey → 明文直存（裸装配兼容，见 JSDoc）
    await expect(rawValue('k')).resolves.toBe('plain-v1'); // 存储契约（明文模式）
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

  it('secretKey 长度 ≠ 32 → 构造即抛 HarnessError(DB_ERROR)（fail-fast，不带病运行）', async () => {
    expect(() => new SecretsService(db, randomBytes(16))).toThrowError(
      /secretKey must be exactly 32 bytes for AES-256-GCM/,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 故意传错类型验证校验
    expect(() => new SecretsService(db, 'not-a-buffer' as any)).toThrowError(/HARNESS-4003|32 bytes/);
  });
});

describe('SecretsService AES-256-GCM 加密（注入 secretKey）', () => {
  /** 服务内解密路径的一次性告警在进程/测试文件级只发一次——以下用例顺序敏感：
   * 「错误 key」用例必须最先触发解密失败，才能断言“只告警一次”。 */
  it('错误 key 解密 → get 返回 null + process.emitWarning 一次性告警（不抛错、不回传密文）', async () => {
    const writer = new SecretsService(db, randomBytes(32));
    await writer.set('k', 'top-secret-π');

    const reader = new SecretsService(db, randomBytes(32)); // 同库、不同 key
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      await expect(reader.get('k')).resolves.toBeNull();
      await expect(reader.get('k')).resolves.toBeNull(); // 再次读取仍 null
      expect(spy).toHaveBeenCalledTimes(1); // 一次性：进程级只告警一次
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ code: 'HARNESS_SECRETS_DECRYPT_FAILED' });
    } finally {
      spy.mockRestore();
    }
  });

  it('set→get 往返：注入 key 时加密落库、读取解密还原（含多字节字符）', async () => {
    const enc = new SecretsService(db, randomBytes(32));
    await enc.set('smtp/password', 'p@ssw0rd-π-🔐');
    await enc.set('llm/mock-openai', 'sk-plain-key');
    await expect(enc.get('smtp/password')).resolves.toBe('p@ssw0rd-π-🔐');
    await expect(enc.get('llm/mock-openai')).resolves.toBe('sk-plain-key');
    await enc.set('smtp/password', 'rotated-值'); // 覆盖更新后仍可往返
    await expect(enc.get('smtp/password')).resolves.toBe('rotated-值');
  });

  it('库内原始行为 enc:v1 密文：非明文、片段不出现、三段 base64、随机 IV（同值两次写入密文不同）', async () => {
    const enc = new SecretsService(db, randomBytes(32));
    await enc.set('k', 'p@ssw0rd-π');
    await enc.set('k2', 'p@ssw0rd-π'); // 同明文 → 不同密文（随机 IV）
    const raw1 = (await rawValue('k')) as string;
    const raw2 = (await rawValue('k2')) as string;

    expect(raw1).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/); // 格式契约
    expect(raw1).not.toContain('p@ssw0rd'); // 明文与其片段绝不出现
    expect(raw1).not.toContain('π');
    expect(raw1.split(':')).toHaveLength(5); // enc / v1 / iv / tag / cipher
    expect(Buffer.from(raw1.split(':')[2]!, 'base64')).toHaveLength(12); // 96-bit IV
    expect(Buffer.from(raw1.split(':')[3]!, 'base64')).toHaveLength(16); // 128-bit 认证标签
    expect(raw1).not.toBe(raw2); // 随机 IV → 语义安全
  });

  it('未注入 key（裸装配）明文直存：与既有行为完全兼容', async () => {
    await svc.set('k', 'plain-v2'); // svc 来自 beforeEach：无 secretKey
    const raw = (await rawValue('k')) as string;
    expect(raw).toBe('plain-v2'); // 库内即明文
    expect(raw.startsWith('enc:v1:')).toBe(false);
    await expect(svc.get('k')).resolves.toBe('plain-v2');
  });

  it('历史明文值读出：加密服务的 get 对无 enc:v1 前缀的存量行原样返回（升级兼容）', async () => {
    await svc.list(); // 触发惰性建表（后续绕过服务直插存量行）
    const now = Date.now();
    await db('secrets').insert({ name: 'legacy', value: 'legacy-plain', updated_at: now }); // 绕过服务直插明文
    const enc = new SecretsService(db, randomBytes(32));
    await expect(enc.get('legacy')).resolves.toBe('legacy-plain'); // 原样返回，不抛错、不改写
    await expect(rawValue('legacy')).resolves.toBe('legacy-plain'); // 兼容读取不回写
  });

  it('未注入 key 时读到 enc:v1 行 → null（绝不把密文当值返回）', async () => {
    const enc = new SecretsService(db, randomBytes(32));
    await enc.set('k', 'secret-value');
    await expect(svc.get('k')).resolves.toBeNull(); // svc 无 key：无法解密
  });

  it('格式非法的 enc:v1 行容错：返回 null 不抛错（坏长度/坏 base64/段数不符）', async () => {
    await svc.list(); // 触发惰性建表（后续绕过服务直插存量行）
    const now = Date.now();
    const enc = new SecretsService(db, randomBytes(32));
    const badValues = [
      'enc:v1:only-two-colons', // 段数不符
      'enc:v1:a:b', // 段数不符（2 段）
      `enc:v1:${Buffer.alloc(4).toString('base64')}:${Buffer.alloc(16).toString('base64')}:${Buffer.alloc(8).toString('base64')}`, // IV 长度不符
      'enc:v1:!!!!:!!!!:!!!!', // base64 乱码 → 解码为空
      'enc:v1:', // 空载荷
    ];
    for (const [i, bad] of badValues.entries()) {
      await db('secrets').insert({ name: `bad-${i}`, value: bad, updated_at: now });
      await expect(enc.get(`bad-${i}`)).resolves.toBeNull(); // 容错：null 而非抛错
    }
  });
});

describe('loadOrCreateSecretKey（数据密钥管理）', () => {
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-secretkey-'));
  });

  afterEach(async () => {
    if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  it('首次调用：生成 32B 随机密钥，secret.key 0600 原子落盘（无 tmp 残留）', async () => {
    const key = await loadOrCreateSecretKey({ dataDir });
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);

    const statInfo = await stat(path.join(dataDir, 'secret.key'));
    expect(statInfo.mode & 0o777).toBe(0o600); // 权限收紧
    expect((await readFile(path.join(dataDir, 'secret.key'))).equals(key)).toBe(true);
    expect(await readdir(dataDir)).not.toContain('secret.key.tmp'); // 原子写无 tmp 残留
  });

  it('幂等：再次调用读回同一密钥（不重新生成）；目录缺级自动创建', async () => {
    const nested = path.join(dataDir, 'a', 'b'); // 递归 mkdir 路径
    const k1 = await loadOrCreateSecretKey({ dataDir: nested });
    const k2 = await loadOrCreateSecretKey({ dataDir: nested });
    expect(k2.equals(k1)).toBe(true);
  });

  it('已存在文件直接读取（内容原样返回）并 chmod 0600 兜底过宽权限', async () => {
    const file = path.join(dataDir, 'secret.key');
    const planted = randomBytes(32);
    await writeFile(file, planted, { mode: 0o644 }); // 模拟手工创建的过宽权限
    const key = await loadOrCreateSecretKey({ dataDir });
    expect(key.equals(planted)).toBe(true);
    const statInfo = await stat(file);
    expect(statInfo.mode & 0o777).toBe(0o600); // 兜底收紧
  });

  it('既有文件损坏（长度 ≠ 32）→ HarnessError(INTERNAL)，绝不带病运行', async () => {
    await writeFile(path.join(dataDir, 'secret.key'), 'too-short', { mode: 0o600 });
    await expect(loadOrCreateSecretKey({ dataDir })).rejects.toMatchObject({ code: 'HARNESS-9003' });
  });

  it('dataDir 非法（空串/非字符串）→ HarnessError(VALIDATION_FAILED)', async () => {
    await expect(loadOrCreateSecretKey({ dataDir: '' })).rejects.toMatchObject({ code: 'HARNESS-1009' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 故意传错类型验证校验
    await expect(loadOrCreateSecretKey({ dataDir: 42 as any })).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });
});
