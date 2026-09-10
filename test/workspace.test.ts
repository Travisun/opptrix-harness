/**
 * 会话工作区内核 E2E（真实 Kernel boot + WorkspaceService + REST）。
 *
 * 覆盖：
 * - 表迁移：新库 agent_sessions 含 user_id/parent_id、subagents 含 origin_session_id；
 *   旧库模拟（手工建旧 DDL 后 init）ALTER 守卫自动加列；
 * - 解析链：根会话直解析 / 子→父→根 / 孙→根 / subagent（origin_session_id）→根 /
 *   子 subagent 沿 parent_id→根 / 成环拒绝 / 深度超限拒绝 / 未知 scopeId 404 / 非 UUID 400；
 * - 路径安全：绝对路径拒、`..` 段拒、symlink 出逃拒（写面 + 读面）；
 * - 文件全周期：write/read 往返、list（目录排前按名排序 + 递归 + 深度/条目上限）、
 *   delete（文件/空目录/非空目录拒绝/根拒绝）、8MB 上限；
 * - REST：所有权矩阵（本人 200 / 他人 403 / admin 200 / system 会话普通用户 403）、
 *   列表按属主过滤、文件 GET 的 CSP/nosniff 头、PUT base64 往返与上限、DELETE 后 404、
 *   子会话经 REST 写根工作区（继承语义）+ 子会话不产生新目录；
 * - Part E：SubagentManager.spawn 的 originSessionId 贯通落库。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import type { AgentSessionManager } from '../src/kernel/agents/session.js';
import { AgentSessionStore } from '../src/kernel/agents/session-store.js';
import { SubagentStore, type SubagentRecord } from '../src/kernel/agents/store.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { closeDb, openSqlite } from '../src/kernel/storage/db.js';
import { MAX_CHAIN_DEPTH, MAX_FILE_BYTES, MAX_LIST_ENTRIES, WorkspaceService } from '../src/kernel/workspace/index.js';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0）+ 测试身份 provider
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let db: Knex;
let subagentStore: SubagentStore;
let workspace: WorkspaceService;
let manager: AgentSessionManager;

const TOK_USER1 = 'tok-user-1';
const TOK_USER2 = 'tok-user-2';
const TOK_ADMIN = 'tok-admin';

/** token → Authorization 头 */
function authOf(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

let rootToken = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-workspace-'));
  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
      }),
      port: 0,
    },
  });
  await kernel.boot();

  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
  db = kernel.container.resolve<Knex>(CONTAINER_KEYS.db);
  void new AgentSessionStore(db); // 旧列守卫面已由「表迁移」段直测；此处仅确认可实例化
  subagentStore = new SubagentStore(db);
  workspace = kernel.container.resolve<WorkspaceService>(CONTAINER_KEYS.workspace);
  manager = kernel.container.resolve<AgentSessionManager>('agents.sessionManager');

  // 测试身份：user-1 / user-2（normal）+ admin-1（admin）；root 走 rootToken
  kernel.container.resolve<{ register(p: unknown): void }>(CONTAINER_KEYS.authRegistry).register({
    name: 'workspace-test',
    verify: async (input: { token?: string }) => {
      if (input.token === TOK_USER1) return { userId: 'user-1', role: 'normal', scopes: [] };
      if (input.token === TOK_USER2) return { userId: 'user-2', role: 'normal', scopes: [] };
      if (input.token === TOK_ADMIN) return { userId: 'admin-1', role: 'admin', scopes: [] };
      return null;
    },
  });
}, 30_000);

afterAll(async () => {
  await kernel?.shutdown('workspace-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 会话夹具：user-1 的 根→子→孙 三代 + user-2 根会话 + system 会话
// ---------------------------------------------------------------------------

let rootU1 = '';
let childU1 = '';
let grandU1 = '';
let rootU2 = '';
let sysSession = '';

async function createSessionViaRest(
  token: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/agents/sessions',
    headers: { ...authOf(token), 'content-type': 'application/json' },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Record<string, unknown>;
}

/** 直接落库一条会话（绕过 manager：构造环/长链等 manager 不允许的形状） */
async function insertSessionRaw(id: string, parentId: string | null, userId: string | null): Promise<void> {
  await db('agent_sessions').insert({
    id,
    title: `raw-${id.slice(0, 8)}`,
    model: null,
    system_prompt: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    last_message_at: null,
    user_id: userId,
    parent_id: parentId,
  });
}

/** 直接落库一条 subagent 记录（绕过 manager：解析链夹具不需要真实执行） */
async function insertSubagent(id: string, parentId: string, originSessionId: string | null): Promise<void> {
  const rec: SubagentRecord = {
    id,
    parentId,
    depth: 1,
    model: null,
    systemPrompt: null,
    prompt: 'workspace-chain-fixture',
    toolNames: null,
    status: 'done',
    result: null,
    error: null,
    transcript: null,
    usageIn: null,
    usageOut: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    originSessionId,
  };
  await subagentStore.create(rec);
}

beforeAll(async () => {
  const r1 = await createSessionViaRest(TOK_USER1, { title: 'U1 根会话' });
  rootU1 = String(r1['id']);
  const c1 = await createSessionViaRest(TOK_USER1, { title: 'U1 子会话', parentId: rootU1 });
  childU1 = String(c1['id']);
  const g1 = await createSessionViaRest(TOK_USER1, { title: 'U1 孙会话', parentId: childU1 });
  grandU1 = String(g1['id']);
  const r2 = await createSessionViaRest(TOK_USER2, { title: 'U2 根会话' });
  rootU2 = String(r2['id']);
  sysSession = String((await manager.createSession({ title: 'system 会话' })).id);
}, 30_000);

// ---------------------------------------------------------------------------
// 表迁移（Part A）
// ---------------------------------------------------------------------------

describe('表迁移', () => {
  it('新库：内核库 agent_sessions 含 user_id/parent_id 列；subagents 惰性 ensureTable 后含 origin_session_id 列', async () => {
    expect(await db.schema.hasColumn('agent_sessions', 'user_id')).toBe(true);
    expect(await db.schema.hasColumn('agent_sessions', 'parent_id')).toBe(true);
    // subagents 是迁移 016 先建的（无新列）：惰性守卫在首次使用时补列
    await subagentStore.ensureTable();
    expect(await db.schema.hasColumn('subagents', 'origin_session_id')).toBe(true);
  });

  it('旧库模拟：旧 DDL 的 agent_sessions 经 ensureTables 自动加列，旧行归属读出 null', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'opptrix-workspace-old-'));
    const legacy = await openSqlite(path.join(dir, 'legacy.sqlite'));
    try {
      // 手工建「旧版」agent_sessions（无 user_id/parent_id）并塞一行旧数据
      await legacy.schema.createTable('agent_sessions', (t) => {
        t.text('id').primary();
        t.text('title').notNullable();
        t.text('model');
        t.text('system_prompt');
        t.text('status').notNullable().defaultTo('active');
        t.integer('created_at').notNullable();
        t.integer('updated_at').notNullable();
        t.integer('last_message_at');
      });
      await legacy('agent_sessions').insert({
        id: 'legacy-1',
        title: '旧会话',
        model: null,
        system_prompt: null,
        status: 'active',
        created_at: 1,
        updated_at: 1,
        last_message_at: null,
      });
      const legacyStore = new AgentSessionStore(legacy);
      await legacyStore.ensureTables(); // ALTER 守卫生效
      expect(await legacy.schema.hasColumn('agent_sessions', 'user_id')).toBe(true);
      expect(await legacy.schema.hasColumn('agent_sessions', 'parent_id')).toBe(true);
      // 旧行（无归属）读出 null = system 会话/根会话；新列可写
      expect(await legacyStore.getSession('legacy-1')).toMatchObject({ userId: null, parentId: null });
      await legacyStore.createSession({
        id: 'legacy-2',
        title: '新列写入',
        model: null,
        systemPrompt: null,
        status: 'active',
        created_at: 2,
        updated_at: 2,
        last_message_at: null,
        userId: 'u-legacy',
        parentId: 'legacy-1',
      });
      expect(await legacyStore.getSession('legacy-2')).toMatchObject({ userId: 'u-legacy', parentId: 'legacy-1' });
    } finally {
      await closeDb(legacy);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('旧库模拟：迁移 016 版 subagents（无 origin_session_id）经 ensureTable 补列且可写', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'opptrix-workspace-oldsub-'));
    const legacy = await openSqlite(path.join(dir, 'legacy-sub.sqlite'));
    try {
      await legacy.schema.createTable('subagents', (t) => {
        t.text('id').primary();
        t.text('parent_id').notNullable();
        t.integer('depth').notNullable();
        t.text('model');
        t.text('system_prompt');
        t.text('prompt').notNullable();
        t.text('tool_names');
        t.text('status').notNullable().defaultTo('running');
        t.text('result');
        t.text('error');
        t.text('transcript');
        t.integer('usage_in');
        t.integer('usage_out');
        t.integer('created_at');
        t.integer('started_at');
        t.integer('finished_at');
      });
      const legacyStore = new SubagentStore(legacy);
      await legacyStore.ensureTable();
      expect(await legacy.schema.hasColumn('subagents', 'origin_session_id')).toBe(true);
      await legacyStore.create({
        id: 'sub-legacy',
        parentId: 'main',
        depth: 1,
        model: null,
        systemPrompt: null,
        prompt: 'p',
        toolNames: null,
        status: 'done',
        result: null,
        error: null,
        transcript: null,
        usageIn: null,
        usageOut: null,
        createdAt: 1,
        startedAt: null,
        finishedAt: null,
        originSessionId: 'legacy-1',
      });
      expect(await legacyStore.get('sub-legacy')).toMatchObject({ originSessionId: 'legacy-1' });
    } finally {
      await closeDb(legacy);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 解析链（Part C：WorkspaceService.resolve）
// ---------------------------------------------------------------------------

describe('解析链', () => {
  it('根会话直解析：rootSessionId=自身、userId 落 identity、路径=workspaces/users/{userId}/{rootId}', async () => {
    const ws = await workspace.resolve(rootU1);
    expect(ws.rootSessionId).toBe(rootU1);
    expect(ws.userId).toBe('user-1');
    expect(ws.path).toBe(path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1));
  });

  it('子会话沿 parent 链解析到根；孙会话同样到根（目录只在根会话名下）', async () => {
    expect((await workspace.resolve(childU1)).rootSessionId).toBe(rootU1);
    const grand = await workspace.resolve(grandU1);
    expect(grand.rootSessionId).toBe(rootU1);
    expect(grand.userId).toBe('user-1');
  });

  it('subagent（origin_session_id）→ 发起根会话；子 subagent 沿 parent_id 上溯到根 subagent 再到会话', async () => {
    const subA = randomUUID();
    const subB = randomUUID(); // subB 的父是 subA
    await insertSubagent(subA, 'main', rootU1);
    await insertSubagent(subB, subA, null);
    expect((await workspace.resolve(subA)).rootSessionId).toBe(rootU1);
    expect((await workspace.resolve(subB)).rootSessionId).toBe(rootU1);
  });

  it('无 origin 的 subagent（如 /mcp 委派）→ 404 session not found', async () => {
    const sub = randomUUID();
    await insertSubagent(sub, 'main', null);
    const e = await workspace.resolve(sub).catch((e: unknown) => e as { code: string; message: string });
    expect(e).toMatchObject({ code: 'HARNESS-3004' });
    expect(e.message).toContain('session not found');
  });

  it('system 会话：userId=null，布局落 system 段', async () => {
    const ws = await workspace.resolve(sysSession);
    expect(ws.userId).toBeNull();
    expect(ws.path).toBe(path.join(dataDir, 'workspaces', 'users', 'system', sysSession));
  });

  it('未知 scopeId（合法 UUID）→ 404 EXT_NOT_FOUND，message 写明 session not found', async () => {
    const e = await workspace.resolve(randomUUID()).catch((e: unknown) => e as { code: string; message: string });
    expect(e).toMatchObject({ code: 'HARNESS-3004' });
    expect(e.message).toContain('session not found');
  });

  it('非 UUID scopeId（目录穿越形状）→ 400 VALIDATION_FAILED', async () => {
    for (const bad of ['../../etc', 'not-a-uuid', `${rootU1}/../${rootU2}`]) {
      const e = await workspace.resolve(bad).catch((e: unknown) => e as { code: string });
      expect(e, bad).toMatchObject({ code: 'HARNESS-1009' });
    }
  });

  it('成环的 parent 链 → 400 VALIDATION_FAILED（visited 防环）', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await insertSessionRaw(a, b, 'user-1');
    await insertSessionRaw(b, a, 'user-1'); // a→b→a 环（manager 校验不允许，直插构造）
    const e = await workspace.resolve(a).catch((e: unknown) => e as { code: string });
    expect(e).toMatchObject({ code: 'HARNESS-1009' });
  });

  it(`深度超限（>${MAX_CHAIN_DEPTH} 跳）→ 400 VALIDATION_FAILED`, async () => {
    const ids = Array.from({ length: MAX_CHAIN_DEPTH + 1 }, () => randomUUID());
    for (let i = 0; i < ids.length - 1; i++) {
      await insertSessionRaw(ids[i] as string, ids[i + 1] as string, 'user-1');
    }
    await insertSessionRaw(ids[ids.length - 1] as string, null, 'user-1'); // 链尾是根
    const e = await workspace.resolve(ids[0] as string).catch((e: unknown) => e as { code: string });
    expect(e).toMatchObject({ code: 'HARNESS-1009' });
  });

  it('manager.resolveWorkspace 与 WorkspaceService.resolve 结果一致（委托语义）', async () => {
    expect(await manager.resolveWorkspace(grandU1)).toEqual(await workspace.resolve(grandU1));
  });
});

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

describe('路径安全', () => {
  it('绝对路径拒（write）', async () => {
    await expect(workspace.write(rootU1, '/etc/passwd', Buffer.from('x'))).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
  });

  it('`..` 段拒（穿越）', async () => {
    await expect(workspace.write(rootU1, 'a/../../escape.txt', Buffer.from('x'))).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
    await expect(workspace.read(childU1, '../secret')).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });

  it('symlink 出逃拒（写面）：目录 symlink 指向 dataDir 外，经 link 写入被 FORBIDDEN', async () => {
    await workspace.write(rootU1, 'seed.txt', Buffer.from('seed')); // 确保工作区目录已落盘
    const outside = await mkdtemp(path.join(tmpdir(), 'opptrix-workspace-outside-'));
    try {
      symlinkSync(outside, path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'link'));
      await expect(workspace.write(rootU1, 'link/escape.txt', Buffer.from('x'))).rejects.toMatchObject({
        code: 'HARNESS-1007',
      });
      expect(existsSync(path.join(outside, 'escape.txt'))).toBe(false); // 外部目录未被写入
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('symlink 出逃拒（读面）：文件 symlink 指向外部文件，读取被 FORBIDDEN', async () => {
    const outsideFile = path.join(dataDir, `outside-secret-${randomUUID()}.txt`);
    writeFileSync(outsideFile, 'top-secret'); // dataDir 内、工作区目录外（跨目录出逃同样拒）
    try {
      symlinkSync(outsideFile, path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'leak.txt'));
      await expect(workspace.read(rootU1, 'leak.txt')).rejects.toMatchObject({ code: 'HARNESS-1007' });
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// write / read / list / delete 全周期
// ---------------------------------------------------------------------------

describe('文件全周期', () => {
  it('write 落盘（mkdir -p 语义）+ read 往返（含二进制）+ 返回 size', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x38]);
    const written = await workspace.write(rootU1, 'assets/bin/a.bin', bytes);
    expect(written).toEqual({ path: 'assets/bin/a.bin', size: bytes.byteLength });
    expect(existsSync(path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'assets', 'bin', 'a.bin'))).toBe(
      true,
    );
    expect(await workspace.read(rootU1, 'assets/bin/a.bin')).toEqual(bytes);
    await workspace.write(rootU1, 'notes/hi.txt', Buffer.from('你好工作区', 'utf8'));
    expect(await workspace.read(rootU1, 'notes/hi.txt')).toEqual(Buffer.from('你好工作区', 'utf8'));
  });

  it('list 非递归：目录排前、按名排序；path 为会话内相对 POSIX 风格', async () => {
    await workspace.write(rootU1, 'l/b.txt', Buffer.from('b'));
    await workspace.write(rootU1, 'l/a.txt', Buffer.from('a'));
    await workspace.write(rootU1, 'l/z.txt', Buffer.from('z'));
    const entries = await workspace.list(rootU1, 'l');
    expect(entries.map((e) => `${e.type}:${e.name}`)).toEqual(['file:a.txt', 'file:b.txt', 'file:z.txt']);
    expect(entries.map((e) => e.path)).toEqual(['l/a.txt', 'l/b.txt', 'l/z.txt']);
    expect(entries[0]).toMatchObject({ size: 1, mtime: expect.any(Number) });

    // 根列表：目录段整体排前（按名有序），文件段随后
    const rootEntries = await workspace.list(rootU1);
    const firstFileIdx = rootEntries.findIndex((e) => e.type === 'file');
    expect(firstFileIdx).toBeGreaterThan(0);
    expect(rootEntries.slice(firstFileIdx).every((e) => e.type === 'file')).toBe(true);
    const dirNames = rootEntries.filter((e) => e.type === 'dir').map((e) => e.name);
    expect(dirNames).toEqual([...dirNames].sort());
    expect(rootEntries.some((e) => e.type === 'file' && e.name === 'seed.txt')).toBe(true);
  });

  it('list recursive=true：嵌套全列；深度上限（第 8 层为界，更深不再下钻）', async () => {
    const deep = 'd1/d2/d3/d4/d5/d6/d7/d8/d9/deep.txt';
    await workspace.write(grandU1, deep, Buffer.from('deep'));
    await workspace.write(grandU1, 'd1/leaf.txt', Buffer.from('leaf'));
    const all = await workspace.list(grandU1, '.', true);
    expect(all.some((e) => e.path === 'd1/leaf.txt')).toBe(true);
    expect(all.some((e) => e.path === 'd1/d2' && e.type === 'dir')).toBe(true);
    // 第 8 层（d8）可见；其内的 d9 与 deep.txt 被深度上限截断
    expect(all.some((e) => e.path === 'd1/d2/d3/d4/d5/d6/d7/d8')).toBe(true);
    expect(all.some((e) => e.path === 'd1/d2/d3/d4/d5/d6/d7/d8/d9')).toBe(false);
    expect(all.some((e) => e.path === deep)).toBe(false);

    // 非递归只列一层
    const shallow = await workspace.list(grandU1, 'd1');
    expect(shallow.map((e) => e.name).sort()).toEqual(['d2', 'leaf.txt']);
  });

  it('list 条目上限截断（≤2000 条）', async () => {
    // grandU1 解析到根会话目录：物理落点在 rootU1 名下
    const wsDir = path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'bulk');
    mkdirSync(wsDir, { recursive: true });
    for (let i = 0; i < MAX_LIST_ENTRIES + 1; i++) {
      writeFileSync(path.join(wsDir, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const entries = await workspace.list(grandU1, 'bulk', true);
    expect(entries).toHaveLength(MAX_LIST_ENTRIES);
  });

  it('工作区目录尚不存在 → list 返回空数组（不隐式建目录）', async () => {
    const fresh = await manager.createSession({ title: 'fresh', userId: 'user-1' });
    expect(await workspace.list(fresh.id)).toEqual([]);
    expect(existsSync(path.join(dataDir, 'workspaces', 'users', 'user-1', fresh.id))).toBe(false);
  });

  it('delete：文件删除后 read → 404；空目录可删；非空目录拒绝；工作区根拒绝', async () => {
    await workspace.write(childU1, 'tmp/gone.txt', Buffer.from('bye'));
    await workspace.delete(childU1, 'tmp/gone.txt');
    await expect(workspace.read(childU1, 'tmp/gone.txt')).rejects.toMatchObject({ code: 'HARNESS-3004' });

    await workspace.delete(childU1, 'tmp'); // 空目录
    expect(existsSync(path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'tmp'))).toBe(false);

    await expect(workspace.delete(childU1, '.')).rejects.toMatchObject({ code: 'HARNESS-1008' });

    await workspace.write(childU1, 'full/keep.txt', Buffer.from('stay'));
    await expect(workspace.delete(childU1, 'full')).rejects.toMatchObject({ code: 'HARNESS-1008' });
  });

  it('8MB 上限：MAX_FILE_BYTES+1 → PAYLOAD_TOO_LARGE；恰好 8MB 可写', async () => {
    await expect(workspace.write(rootU1, 'big.bin', Buffer.alloc(MAX_FILE_BYTES + 1))).rejects.toMatchObject({
      code: 'HARNESS-1005',
    });
    const ok = await workspace.write(rootU1, 'exact.bin', Buffer.alloc(MAX_FILE_BYTES));
    expect(ok.size).toBe(MAX_FILE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// REST：所有权矩阵与列表过滤
// ---------------------------------------------------------------------------

describe('REST 所有权', () => {
  it('本人 200 / 他人 403 / admin 200（GET workspace 列表）', async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU1}/workspace`,
      headers: authOf(TOK_USER1),
    });
    expect(own.statusCode).toBe(200);
    expect(Array.isArray(own.json())).toBe(true);

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU1}/workspace`,
      headers: authOf(TOK_USER2),
    });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ code: 'HARNESS-1007' });

    const admin = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU1}/workspace`,
      headers: authOf(TOK_ADMIN),
    });
    expect(admin.statusCode).toBe(200);
  });

  it('system 会话：普通用户 403（system 会话仅 root/admin）、root 200', async () => {
    const normal = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${sysSession}/workspace`,
      headers: authOf(TOK_USER1),
    });
    expect(normal.statusCode).toBe(403);

    const root = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${sysSession}/workspace`,
      headers: authOf(rootToken),
    });
    expect(root.statusCode).toBe(200);
  });

  it('会话级旧端点同样过 assertAccess：GET/PATCH/DELETE/messages/cancel 他人 → 403', async () => {
    for (const spec of [
      { method: 'GET', url: `/api/v1/agents/sessions/${rootU1}` },
      { method: 'PATCH', url: `/api/v1/agents/sessions/${rootU1}` },
      { method: 'DELETE', url: `/api/v1/agents/sessions/${rootU1}` },
      { method: 'GET', url: `/api/v1/agents/sessions/${rootU1}/messages` },
      { method: 'POST', url: `/api/v1/agents/sessions/${rootU1}/messages` },
      { method: 'POST', url: `/api/v1/agents/sessions/${rootU1}/cancel` },
    ] as const) {
      const res = await app.inject({
        method: spec.method,
        url: spec.url,
        headers: authOf(TOK_USER2), // 无 body 的方法不带 json content-type（空体解析器不触发）
        ...(spec.method === 'GET' || spec.method === 'DELETE' ? {} : { payload: { content: 'x', title: 'x' } }),
      });
      expect(res.statusCode, `${spec.method} ${spec.url}`).toBe(403);
    }
  });

  it('GET /sessions 列表：普通用户只见本人；root 见全部；admin ?userId= 过滤生效', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/sessions',
      headers: authOf(TOK_USER1),
    });
    expect(mine.statusCode).toBe(200);
    const mineRows = mine.json() as Array<Record<string, unknown>>;
    expect(mineRows.length).toBeGreaterThan(0);
    expect(mineRows.every((r) => r['userId'] === 'user-1')).toBe(true);
    expect(mineRows.some((r) => r['id'] === grandU1)).toBe(true);
    expect(mineRows.some((r) => r['id'] === rootU2)).toBe(false);
    expect(mineRows.some((r) => r['id'] === sysSession)).toBe(false);

    const all = await app.inject({ method: 'GET', url: '/api/v1/agents/sessions', headers: authOf(rootToken) });
    const allRows = all.json() as Array<Record<string, unknown>>;
    expect(allRows.some((r) => r['id'] === rootU1)).toBe(true);
    expect(allRows.some((r) => r['id'] === rootU2)).toBe(true);
    expect(allRows.some((r) => r['id'] === sysSession)).toBe(true);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/agents/sessions?userId=user-2',
      headers: authOf(TOK_ADMIN),
    });
    const filteredRows = filtered.json() as Array<Record<string, unknown>>;
    expect(filteredRows.length).toBeGreaterThan(0);
    expect(filteredRows.every((r) => r['userId'] === 'user-2')).toBe(true);
  });

  it('新端点未认证 → 401', async () => {
    for (const spec of [
      { method: 'GET', url: `/api/v1/agents/sessions/${rootU1}/workspace` },
      { method: 'GET', url: `/api/v1/agents/sessions/${rootU1}/workspace/file?path=seed.txt` },
      { method: 'PUT', url: `/api/v1/agents/sessions/${rootU1}/workspace/file` },
      { method: 'DELETE', url: `/api/v1/agents/sessions/${rootU1}/workspace/file?path=seed.txt` },
    ] as const) {
      const res = await app.inject({
        method: spec.method,
        url: spec.url,
        ...(spec.method === 'PUT' ? { payload: {} } : {}),
      });
      expect(res.statusCode, `${spec.method} ${spec.url}`).toBe(401);
    }
  });

  it('未知会话（合法 UUID）访问工作区 → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${randomUUID()}/workspace`,
      headers: authOf(TOK_ADMIN),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004' });
  });
});

// ---------------------------------------------------------------------------
// REST：工作区文件面
// ---------------------------------------------------------------------------

describe('REST 文件面', () => {
  it('PUT base64 写入 → GET 原始字节往返一致；响应含 path/size；nosniff 恒在', async () => {
    const bytes = Buffer.from('REST 往返内容', 'utf8');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file`,
      headers: { ...authOf(TOK_USER2), 'content-type': 'application/json' },
      payload: { path: 'docs/rest.txt', content: bytes.toString('base64'), encoding: 'base64' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ path: 'docs/rest.txt', size: bytes.byteLength });

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file?path=docs/rest.txt`,
      headers: authOf(TOK_USER2),
    });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload).toEqual(bytes);
    expect(get.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET file Content-Type 按扩展名推断；.html/.svg 带 CSP，全部带 nosniff', async () => {
    const cases = [
      { path: 'p.html', contentType: 'text/html; charset=utf-8', csp: true },
      { path: 'p.htm', contentType: 'text/html; charset=utf-8', csp: true },
      { path: 'p.svg', contentType: 'image/svg+xml', csp: true },
      { path: 'p.png', contentType: 'image/png', csp: false },
      { path: 'p.jpg', contentType: 'image/jpeg', csp: false },
      { path: 'p.webp', contentType: 'image/webp', csp: false },
      { path: 'p.json', contentType: 'application/json', csp: false },
      { path: 'p.bin', contentType: 'application/octet-stream', csp: false },
    ];
    for (const c of cases) {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/v1/agents/sessions/${rootU2}/workspace/file`,
        headers: { ...authOf(TOK_USER2), 'content-type': 'application/json' },
        payload: { path: c.path, content: Buffer.from('x').toString('base64') },
      });
      expect(put.statusCode, c.path).toBe(200);
      const get = await app.inject({
        method: 'GET',
        url: `/api/v1/agents/sessions/${rootU2}/workspace/file?path=${encodeURIComponent(c.path)}`,
        headers: authOf(TOK_USER2),
      });
      expect(get.statusCode, c.path).toBe(200);
      expect(get.headers['content-type'], c.path).toBe(c.contentType);
      expect(get.headers['x-content-type-options'], c.path).toBe('nosniff');
      if (c.csp) {
        expect(get.headers['content-security-policy'], c.path).toBe(
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        );
      } else {
        expect(get.headers['content-security-policy'], c.path).toBeUndefined();
      }
    }
  });

  it('PUT 超 8MB（解码后）→ 413；非法 base64 → 400；缺 path → 400', async () => {
    const over = await app.inject({
      method: 'PUT',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file`,
      headers: { ...authOf(TOK_USER2), 'content-type': 'application/json' },
      payload: { path: 'over.bin', content: Buffer.alloc(MAX_FILE_BYTES + 1024).toString('base64') },
    });
    expect(over.statusCode).toBe(413);
    expect(over.json()).toMatchObject({ code: 'HARNESS-1005' });

    const badB64 = await app.inject({
      method: 'PUT',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file`,
      headers: { ...authOf(TOK_USER2), 'content-type': 'application/json' },
      payload: { path: 'bad.txt', content: 'not%%base64!!' },
    });
    expect(badB64.statusCode).toBe(400);

    const noPath = await app.inject({
      method: 'PUT',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file`,
      headers: { ...authOf(TOK_USER2), 'content-type': 'application/json' },
      payload: { content: '' },
    });
    expect(noPath.statusCode).toBe(400);
  });

  it('DELETE 文件 → 200 {ok,path}；再 GET → 404', async () => {
    await workspace.write(rootU2, 'todelete.txt', Buffer.from('delete me'));
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file?path=todelete.txt`,
      headers: authOf(TOK_USER2),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, path: 'todelete.txt' });

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU2}/workspace/file?path=todelete.txt`,
      headers: authOf(TOK_USER2),
    });
    expect(get.statusCode).toBe(404);
    expect(get.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  it('GET workspace?recursive=true 递归列出嵌套；?path= 指定子目录', async () => {
    await workspace.write(rootU2, 'w/nested/inner.txt', Buffer.from('inner'));
    const flat = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU2}/workspace?path=w`,
      headers: authOf(TOK_USER2),
    });
    expect(flat.statusCode).toBe(200);
    expect((flat.json() as Array<Record<string, unknown>>).map((e) => e['name'])).toEqual(['nested']);

    const rec = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU2}/workspace?path=w&recursive=true`,
      headers: authOf(TOK_USER2),
    });
    expect(rec.statusCode).toBe(200);
    const rows = rec.json() as Array<{ path: string; type: string }>;
    expect(rows.some((e) => e.path === 'w/nested/inner.txt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 继承语义（核心断言）与 spawn 贯通
// ---------------------------------------------------------------------------

describe('继承语义与 spawn 贯通', () => {
  it('子会话经 REST 写根工作区文件成功：字节落在 users/{userId}/{rootId}/ 下；根列表可见；孙会话可读', async () => {
    const bytes = Buffer.from('child writes into root workspace', 'utf8');
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/agents/sessions/${childU1}/workspace/file`,
      headers: { ...authOf(TOK_USER1), 'content-type': 'application/json' },
      payload: { path: 'from-child/child.txt', content: bytes.toString('base64') },
    });
    expect(put.statusCode).toBe(200);

    // 物理布局：文件在根会话目录下
    const physical = path.join(dataDir, 'workspaces', 'users', 'user-1', rootU1, 'from-child', 'child.txt');
    expect(existsSync(physical)).toBe(true);

    // 根会话视角可见
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${rootU1}/workspace?path=from-child`,
      headers: authOf(TOK_USER1),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<Record<string, unknown>>).map((e) => e['name'])).toEqual(['child.txt']);

    // 孙会话读取同一文件（同根共享）
    const viaGrand = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/sessions/${grandU1}/workspace/file?path=from-child/child.txt`,
      headers: authOf(TOK_USER1),
    });
    expect(viaGrand.statusCode).toBe(200);
    expect(viaGrand.rawPayload).toEqual(bytes);
  });

  it('子会话不产生新目录：users/{userId}/ 下只有根会话目录', () => {
    const userDir = path.join(dataDir, 'workspaces', 'users', 'user-1');
    const dirs = readdirSync(userDir);
    expect(dirs).toContain(rootU1);
    expect(dirs).not.toContain(childU1);
    expect(dirs).not.toContain(grandU1);
  });

  it('POST /sessions 带不存在的 parentId → 404；带合法 parentId 创建后 userId/parentId 落库', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/agents/sessions',
      headers: { ...authOf(TOK_USER1), 'content-type': 'application/json' },
      payload: { parentId: randomUUID() },
    });
    expect(bad.statusCode).toBe(404);

    const created = await createSessionViaRest(TOK_USER1, { parentId: rootU1 });
    expect(created['parentId']).toBe(rootU1);
    expect(created['userId']).toBe('user-1');
  });

  it('SubagentManager.spawn 的 originSessionId 落 store（工具包对接面：spawn(input & {originSessionId?})）', async () => {
    const subagentsManager = kernel.container.resolve<{
      spawn(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    }>('subagents.manager');
    const spawned = await subagentsManager.spawn({
      parentId: 'main',
      prompt: 'workspace origin passthrough',
      originSessionId: rootU1,
    });
    const row = await db('subagents').where('id', String(spawned['id'])).first();
    expect(row).toBeTruthy();
    expect(row['origin_session_id']).toBe(rootU1);
    expect((await subagentStore.get(String(spawned['id'])))?.originSessionId).toBe(rootU1);
  });

  it('服务级契约守卫：write 非 Buffer → 400', async () => {
    await expect(workspace.write(rootU1, 'x.txt', undefined as unknown as Buffer)).rejects.toMatchObject({
      code: 'HARNESS-1009',
    });
  });
});
