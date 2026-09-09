/**
 * 扩展子系统总装配 E2E（真实 Kernel + 真实 createHttpServer + 真实 worker 线程 + 临时 dataDir）。
 *
 * 覆盖阶段 9 接线后的完整链路：
 - 发现（repo extensions/ 与 <dataDir>/extensions/ 两个目录）→ REST 清单（disabled 起步）→
 - enable（worker host.load RPC + 贡献点校验 + 路由表提交）→ /ext/<id> 通配路由派发 →
 - disable（路由摘除 + 墓碑 503）→ re-enable 恢复 →
 - UI 资产（manifest.ui 声明但 ui/ 目录缺失 → 跳过挂载并 404）→
 - 脚手架扩展（tools/cli-core makeExtension）→ enable/reload 全流程 →
 - 服务注册目录 API（无 expose 服务时空数组不炸）→
 - GET /api/v1/ui（认证任意角色）→ 关停（manager.stop → worker terminate → shutdown resolved）。
 *
 * worker 模式：HARNESS_WORKER_MODE='dev' 显式钉死 src 入口（tsx loader），
 * 不受 dist 产物是否新鲜影响（确定性）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pino from 'pino';
import { vi, afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（模块加载期设置更稳）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { makeExtension } from '../tools/cli-core.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../src/kernel/Facades.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { createKernelHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import { ExtensionServiceRegistry } from '../src/kernel/extensions/registry.js';
import { UiRegistry } from '../src/kernel/extensions/ui-registry.js';
import { Counters } from '../src/kernel/system/info.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { err } from '../src/kernel/errors/index.js';
import { HOST_METHODS } from '../src/extension-host/protocol.js';
import { ExtensionManager } from '../src/kernel/extensions/manager.js';
import { createWorkerFactory } from '../src/extension-host/worker-factory.js';
import { EventBus } from '../src/kernel/events/bus.js';
import { HookManager } from '../src/kernel/hooks/manager.js';
import { KERNEL_MIGRATIONS } from '../src/kernel/storage/kernel-migrations.js';
import { Migrator } from '../src/kernel/storage/migrator.js';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0、静音日志、dev worker）
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
/** dataDir/extensions 下脚手架出的临时扩展 id */
const TMP_EXT_ID = 'tmp-e2e-ext';

const auth = { authorization: '' }; // beforeAll 中填充

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-ext-e2e-'));
  // 脚手架临时扩展（boot 前落盘，start() 发现）
  await makeExtension(path.join(dataDir, 'extensions'), TMP_EXT_ID);

  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
      }),
      port: 0,
    },
  });
  await kernel.boot();

  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  auth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
});

afterAll(async () => {
  await kernel?.shutdown('e2e-afterall'); // 幂等：测试内已 shutdown 时直接返回
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 发现与清单
// ---------------------------------------------------------------------------

describe('扩展子系统总装配 E2E', () => {
  it('boot 后 GET /api/v1/extensions 清单包含 hello-world 与脚手架扩展，且初始均 disabled', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: auth });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; enabled: boolean }>;
    const hello = list.find((s) => s.id === 'hello-world');
    expect(hello).toBeDefined();
    expect(hello?.enabled).toBe(false);
    expect(list.find((s) => s.id === TMP_EXT_ID)).toBeDefined();
  });

  it('GET /api/v1/extensions/routes 初始仅含 builtin auth（自动启用），hello-world/脚手架扩展未入表', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/routes', headers: auth });
    expect(res.statusCode).toBe(200);
    const routes = res.json() as Array<{ extId: string }>;
    expect(routes.some((r) => r.extId === 'hello-world')).toBe(false);
    expect(routes.some((r) => r.extId === TMP_EXT_ID)).toBe(false);
    // 阶段 10：builtin auth 默认启用，其 17 条路由在表（11 基础 + 6 onboarding/2FA）
    expect(routes.filter((r) => r.extId === 'auth')).toHaveLength(17);
  });

  it('GET /api/v1/extensions/:id 返回单个扩展详情（含 manifest）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/hello-world', headers: auth });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as { id: string; enabled: boolean; manifest?: { id?: string } };
    expect(detail.id).toBe('hello-world');
    expect(detail.manifest?.id).toBe('hello-world');
  });

  it('未知扩展的 enable → 404 EXT_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/no-such-ext/enable',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'HARNESS-3004' });
  });

  // -------------------------------------------------------------------------
  // UI 贡献目录（GET /api/v1/ui：认证任意角色）
  // -------------------------------------------------------------------------

  it('GET /api/v1/ui 未认证 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ui' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/ui 认证后 → 200 含 builtin webui 的 UI 贡献（manifest.ui ∪ h.page/h.menu 合并入册）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ui', headers: auth });
    expect(res.statusCode).toBe(200);
    // 内核补线（load 回执 ui + manifest.ui 合并 → UiRegistry）后，webui 随 boot 启用即入册
    expect(res.json()).toEqual([
      expect.objectContaining({
        extId: 'webui',
        menu: { label: 'Console' },
        pages: [{ path: '/', title: 'Console', entry: 'index.html' }],
        widgets: [],
        renderers: [],
      }),
    ]);
  });

  // -------------------------------------------------------------------------
  // hello-world 生命周期 + 扩展路由派发
  // -------------------------------------------------------------------------

  it('POST /api/v1/extensions/hello-world/enable → 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/hello-world/enable',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('enable 后 GET /api/v1/extensions/routes 含 hello-world 的 GET /hello 条目', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/routes', headers: auth });
    expect(res.statusCode).toBe(200);
    const routes = res.json() as Array<{ extId: string; method: string; path: string; auth: string }>;
    expect(routes).toContainEqual(
      expect.objectContaining({ extId: 'hello-world', method: 'GET', path: '/hello', auth: 'public' }),
    );
  });

  it('GET /ext/hello-world/hello（public 路由，无需 token）→ 200 { hello: world, from: hello-world }', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/hello-world/hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world', from: 'hello-world' });
  });

  it('disable 后同请求 → 503（扩展禁用，路由墓碑语义）', async () => {
    const off = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/hello-world/disable',
      headers: auth,
    });
    expect(off.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/ext/hello-world/hello' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: expect.stringMatching(/^HARNESS-\d+$/) });
  });

  it('再 enable → 路由恢复 200（热插拔完整回路）', async () => {
    const on = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/hello-world/enable',
      headers: auth,
    });
    expect(on.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/ext/hello-world/hello' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: 'world', from: 'hello-world' });
  });

  it('hello-world 声明了 manifest.ui 但无 ui/ 目录 → 静态资产跳过挂载，请求 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/hello-world/ui/index.html' });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 脚手架扩展（dataDir/extensions）全流程
  // -------------------------------------------------------------------------

  it(`脚手架扩展 ${TMP_EXT_ID}：enable → /ext/<id>/hello 200 → reload 后仍 200`, async () => {
    // [ext-trust 工作包最小修复] dataDir/extensions 是第三方目录：首次 enable 被信任闸
    // 拒绝（403 HARNESS-3012），确认信任后带 confirmTrust 重试才激活
    const firstEnable = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${TMP_EXT_ID}/enable`,
      headers: auth,
    });
    expect(firstEnable.statusCode).toBe(403);
    expect(firstEnable.json()).toMatchObject({ code: 'HARNESS-3012' });
    expect(firstEnable.json().detail).toMatchObject({ id: TMP_EXT_ID, permissions: expect.anything() });
    const on = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${TMP_EXT_ID}/enable`,
      headers: auth,
      payload: { confirmTrust: true },
    });
    expect(on.statusCode).toBe(200);

    const first = await app.inject({ method: 'GET', url: `/ext/${TMP_EXT_ID}/hello` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ hello: 'world' });

    const reload = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${TMP_EXT_ID}/reload`,
      headers: auth,
    });
    expect(reload.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: `/ext/${TMP_EXT_ID}/hello` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ hello: 'world' });
  });

  it('GET /api/v1/extensions/registry → 空数组不炸（无扩展 h.expose 服务）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/registry', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 关停：worker 干净退出（manager.stop → terminate；shutdown resolved 即为准）
  // -------------------------------------------------------------------------

  it('kernel.shutdown resolved，state=stopped（worker 无挂起句柄）', async () => {
    await kernel.shutdown('e2e-complete');
    expect(kernel.state()).toBe('stopped');
  });
});

// #############################################################################
// kernel-handlers 单元（KERNEL_TOPICS 的内核服务实现表，直接驱动 handler 验证）
// #############################################################################

/** 极简容器 stub：kernel-handlers 只消费 resolve() */
function makeStubContainer(bindings: Record<string, unknown>): {
  resolve<T>(key: string): T;
  instance(key: string, value: unknown): void;
  has(key: string): boolean;
} {
  const map = new Map<string, unknown>(Object.entries(bindings));
  return {
    resolve<T>(key: string): T {
      if (!map.has(key)) throw err('INTERNAL', { message: `[stub-container] missing binding: ${key}` });
      return map.get(key) as T;
    },
    instance(key: string, value: unknown): void {
      map.set(key, value);
    },
    has(key: string): boolean {
      return map.has(key);
    },
  };
}

describe('kernel-handlers 单元', () => {
  const EXT_A = 'ext-a';
  let dataDir = '';
  let kernelDb: Knex;
  let handlers: Record<string, (payload: unknown, from: string) => Promise<unknown>>;
  let registryDispatcher: { calls: Array<{ targetExtId: string; service: string; method: string; args: unknown }>; result: unknown };
  let cronCalls: { schedule: unknown[]; unschedule: string[] };
  let notifySend: ReturnType<typeof vi.fn>;
  let chatSend: ReturnType<typeof vi.fn>;
  let chatPatch: ReturnType<typeof vi.fn>;
  let chatGetMessage: ReturnType<typeof vi.fn>;
  let filesStore: ReturnType<typeof vi.fn>;
  let filesRead: ReturnType<typeof vi.fn>;
  let filesGet: ReturnType<typeof vi.fn>;
  let taskDispatch: ReturnType<typeof vi.fn>;
  let taskGet: ReturnType<typeof vi.fn>;
  let taskProgress: ReturnType<typeof vi.fn>;
  let taskDone: ReturnType<typeof vi.fn>;
  let taskFailed: ReturnType<typeof vi.fn>;
  let uiRegistry: UiRegistry;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-handlers-'));
    kernelDb = await openSqlite(path.join(dataDir, 'kernel.sqlite'));
    await kernelDb.schema.createTable('ext_kv', (t) => {
      t.text('ext_id').notNullable();
      t.text('key').notNullable();
      t.text('value').notNullable();
      t.integer('updated_at').notNullable();
      t.primary(['ext_id', 'key']);
    });

    registryDispatcher = { calls: [], result: { done: true } };
    const extSvcRegistry = new ExtensionServiceRegistry({
      dispatcher: {
        callService: async (targetExtId, service, method, args) => {
          registryDispatcher.calls.push({ targetExtId, service, method, args });
          return registryDispatcher.result;
        },
      },
      timeoutMs: 5_000,
    });
    // 目标扩展 target-ext 暴露 parse.run
    extSvcRegistry.register('target-ext', [{ name: 'parse', methods: ['run'] }]);

    cronCalls = { schedule: [], unschedule: [] };
    notifySend = vi.fn(async (input: unknown) => ({ id: 'n1', input }));
    chatSend = vi.fn(async (input: unknown) => ({ blocked: false, input }));
    chatPatch = vi.fn(async (id: string, content: unknown) => ({ id, content }));
    // SEC-4 归属判定数据源：缺省 m1 归 EXT_A（本人消息）；用例可 mockResolvedValueOnce 覆盖
    chatGetMessage = vi.fn(async (id: string) => ({ id, senderId: EXT_A, content: { text: 'orig' } }));
    filesStore = vi.fn(async (input: { data: Buffer }) => ({ id: 'f1', size: input.data.byteLength }));
    filesRead = vi.fn(async () => ({ record: { id: 'f1', visibility: 'private', extId: EXT_A }, data: Buffer.from('binary-data') }));
    filesGet = vi.fn(async () => ({ id: 'f1', origName: 'a.txt', visibility: 'private', extId: EXT_A }));
    taskDispatch = vi.fn(async (input: unknown) => ({ id: 't1', input }));
    taskGet = vi.fn(async (id: string) => ({ id, extId: EXT_A }));
    taskProgress = vi.fn();
    taskDone = vi.fn();
    taskFailed = vi.fn();
    uiRegistry = new UiRegistry();

    const container = makeStubContainer({
      [CONTAINER_KEYS.db]: kernelDb,
      [CONTAINER_KEYS.notify]: { send: notifySend },
      [CONTAINER_KEYS.chat]: { sendMessage: chatSend, patchMessage: chatPatch, getMessage: chatGetMessage },
      [CONTAINER_KEYS.files]: { store: filesStore, read: filesRead, get: filesGet },
      [CONTAINER_KEYS.tasks]: {
        dispatch: taskDispatch,
        get: taskGet,
        onProgress: taskProgress,
        onDone: taskDone,
        onFailed: taskFailed,
      },
      [FACADE_CONTAINER_KEYS.cronScheduler]: {
        schedule: async (input: unknown) => {
          cronCalls.schedule.push(input);
          return { id: 'cron-1', ...(input as object) };
        },
        unschedule: async (id: string) => {
          cronCalls.unschedule.push(id);
          return true;
        },
        list: () => [{ id: 'cron-1', extId: EXT_A, name: `${EXT_A}:tick` }],
      },
      [CONTAINER_KEYS.counters]: new Counters(),
      [CONTAINER_KEYS.uiRegistry]: uiRegistry,
      [CONTAINER_KEYS.extRegistrySvc]: extSvcRegistry,
      // getManifest 仅返回权限清单（host.call 权限门的数据源）
      [CONTAINER_KEYS.extManager]: {
        getManifest: (id: string) =>
          id === EXT_A ? { permissions: ['rpc:call', 'rpc:call:target-ext', 'storage', 'db', 'chat:write', 'files:read', 'files:write', 'tasks', 'cron', 'notify:send', 'llm', 'ui'] } : { permissions: [] },
      },
    });

    const kernelLike = {
      config: loadConfig({ NODE_ENV: 'test', HARNESS_DATA_DIR: dataDir }),
      logger: pino({ level: 'silent' }),
      state: () => 'ready',
      isReady: () => true,
      container,
    };
    handlers = createKernelHandlers({ kernel: kernelLike as unknown as Kernel });
  });

  afterAll(async () => {
    await kernelDb.destroy();
    if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
  });

  /** 按 KERNEL_TOPICS 字面量取 handler */
  const h = (topic: string): ((payload: unknown, from: string) => Promise<unknown>) => {
    const handler = handlers[topic];
    expect(handler, `handler for "${topic}" must exist`).toBeTypeOf('function');
    return handler;
  };

  it('全部 KERNEL_TOPICS（含 host.call）都有 handler', () => {
    for (const topic of [
      'log', 'storage.get', 'storage.set', 'storage.delete', 'config.get',
      'db.all', 'db.get', 'db.run', 'db.schema', 'notify.send', 'chat.send', 'chat.patch',
      'files.save', 'files.read', 'files.get', 'tasks.dispatch', 'task.progress',
      'task.complete', 'task.fail', 'cron.schedule', 'cron.unschedule', 'ui.register',
      'llm.chat', 'sandbox.exec', 'system.info', 'system.stats', 'host.call',
    ]) {
      expect(handlers[topic]).toBeTypeOf('function');
    }
  });

  it('log：info/warn/error/debug 分级 + 缺省 info + kernel 端点放行（worker 诊断通道）', async () => {
    await expect(h('log')({ level: 'warn', msg: 'w' }, EXT_A)).resolves.toEqual({ ok: true });
    await expect(h('log')({ msg: 'default-level' }, `ext:${EXT_A}`)).resolves.toEqual({ ok: true });
    await expect(h('log')({ level: 'error', msg: 'worker diagnostics' }, 'kernel')).resolves.toEqual({ ok: true });
  });

  it('非 log topic 的 kernel 端点调用一律 RPC_PERMISSION_DENIED', async () => {
    await expect(h('system.info')({}, 'kernel')).rejects.toMatchObject({ code: err('RPC_PERMISSION_DENIED').code });
  });

  it('storage set/get/delete 往返；缺失 key → null；损坏 JSON → null', async () => {
    await expect(h('storage.set')({ key: 'greet', value: { hello: 1 } }, EXT_A)).resolves.toEqual({ ok: true });
    await expect(h('storage.get')({ key: 'greet' }, EXT_A)).resolves.toEqual({ hello: 1 });
    await expect(h('storage.get')({ key: 'missing' }, EXT_A)).resolves.toBeNull();

    await kernelDb('ext_kv').insert({ ext_id: EXT_A, key: 'broken', value: '{not-json', updated_at: 1 });
    await expect(h('storage.get')({ key: 'broken' }, EXT_A)).resolves.toBeNull();

    await expect(h('storage.delete')({ key: 'greet' }, EXT_A)).resolves.toEqual({ ok: true, removed: 1 });
    await expect(h('storage.get')({ key: 'greet' }, EXT_A)).resolves.toBeNull();
  });

  it('config.get：普通路径 + fallback；敏感键（token/secret/password/apiKey）→ FORBIDDEN', async () => {
    await expect(h('config.get')({ path: 'port' }, EXT_A)).resolves.toBe(3000);
    await expect(h('config.get')({ path: 'no.such.path', fallback: 42 }, EXT_A)).resolves.toBe(42);
    for (const p of ['token', 'secrets.api', 'db.password', 'llm.apiKey']) {
      await expect(h('config.get')({ path: p }, EXT_A)).rejects.toMatchObject({ code: err('FORBIDDEN').code });
    }
  });

  it('db schema/run/all/get 全链路（每扩展独立库）；多语句 SQL → DB_STATEMENT_FORBIDDEN', async () => {
    await expect(
      h('db.schema')({ statements: ['CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)'] }, EXT_A),
    ).resolves.toEqual({ ok: true, executed: 1 });

    const run = (await h('db.run')({ sql: 'INSERT INTO items (name) VALUES (?)', params: ['x'] }, EXT_A)) as { changes: number };
    expect(run.changes).toBe(1);

    const all = (await h('db.all')({ sql: 'SELECT * FROM items' }, EXT_A)) as Array<Record<string, unknown>>;
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'x' });

    await expect(h('db.get')({ sql: 'SELECT * FROM items' }, EXT_A)).resolves.toMatchObject({ name: 'x' });
    await expect(h('db.get')({ sql: 'SELECT * FROM items WHERE id = 999' }, EXT_A)).resolves.toBeNull();

    // 3 段多语句在内核侧被禁词闸拒绝；2 段情形由 better-sqlite3 单语句 prepare 兜底拒绝
    await expect(h('db.all')({ sql: 'SELECT 1; SELECT 2; SELECT 3' }, EXT_A)).rejects.toMatchObject({
      code: err('DB_STATEMENT_FORBIDDEN').code,
    });
    await expect(h('db.all')({ sql: 'SELECT 1; SELECT 2' }, EXT_A)).rejects.toThrow();
    await expect(h('db.all')({ sql: 'ATTACH DATABASE ? AS x' }, EXT_A)).rejects.toMatchObject({
      code: err('DB_STATEMENT_FORBIDDEN').code,
    });
  });

  it('notify.send / chat.send / chat.patch 透传服务（chat 发送方强制为扩展身份）', async () => {
    await h('notify.send')({ title: 't', body: 'b' }, EXT_A);
    expect(notifySend).toHaveBeenCalledWith(expect.objectContaining({ title: 't', body: 'b' }));

    await h('chat.send')({ slug: 'general', content: { text: 'hi' } }, EXT_A);
    expect(chatSend).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'general', senderType: 'ext', senderId: EXT_A, content: { text: 'hi' } }),
    );
    await expect(h('chat.send')({ content: 'x' }, EXT_A)).rejects.toMatchObject({ code: err('BAD_REQUEST').code });

    await h('chat.patch')({ id: 'm1', content: 'edited' }, EXT_A);
    expect(chatPatch).toHaveBeenCalledWith('m1', 'edited');

    // SEC-4：chat.patch 归属校验——他人消息/不存在消息统一 EXT_NOT_FOUND（不泄露存在性）
    chatGetMessage.mockResolvedValueOnce({ id: 'm2', senderId: 'ext-b', content: { text: 'x' } });
    await expect(h('chat.patch')({ id: 'm2', content: 'hijack' }, EXT_A)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
    expect(chatPatch).not.toHaveBeenCalledWith('m2', 'hijack');
    chatGetMessage.mockResolvedValueOnce(null);
    await expect(h('chat.patch')({ id: 'missing', content: 'x' }, EXT_A)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
  });

  it('files.save（base64 解码 + extId 归属）/ read（base64 返回）/ get', async () => {
    const saved = (await h('files.save')(
      { origName: 'a.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') },
      EXT_A,
    )) as { size: number };
    expect(saved.size).toBe(5);
    expect(filesStore).toHaveBeenCalledWith(expect.objectContaining({ extId: EXT_A, origName: 'a.txt' }));

    await expect(h('files.read')({ id: 'f1' }, EXT_A)).resolves.toBe(Buffer.from('binary-data').toString('base64'));
    await expect(h('files.get')({ id: 'f1' }, EXT_A)).resolves.toEqual({ id: 'f1', origName: 'a.txt', visibility: 'private', extId: EXT_A });

    // SEC-4：他人 private 文件统一 EXT_NOT_FOUND（不泄露存在性）；public 文件任意扩展可读
    filesRead.mockResolvedValueOnce({ record: { id: 'f2', visibility: 'private', extId: 'ext-b' }, data: Buffer.from('secret') });
    await expect(h('files.read')({ id: 'f2' }, EXT_A)).rejects.toMatchObject({ code: err('EXT_NOT_FOUND').code });
    filesGet.mockResolvedValueOnce({ id: 'f2', visibility: 'private', extId: null });
    await expect(h('files.get')({ id: 'f2' }, EXT_A)).rejects.toMatchObject({ code: err('EXT_NOT_FOUND').code });
    filesRead.mockResolvedValueOnce({ record: { id: 'f3', visibility: 'public', extId: 'ext-b' }, data: Buffer.from('pub') });
    await expect(h('files.read')({ id: 'f3' }, EXT_A)).resolves.toBe(Buffer.from('pub').toString('base64'));
  });

  it('tasks.dispatch 记录 extId；task.progress/complete/fail 校验归属后转发', async () => {
    await h('tasks.dispatch')({ name: 'render', args: { n: 1 } }, EXT_A);
    expect(taskDispatch).toHaveBeenCalledWith(expect.objectContaining({ extId: EXT_A, name: 'render' }));

    await expect(h('task.progress')({ taskId: 't1', pct: 50, msg: 'half' }, EXT_A)).resolves.toEqual({ ok: true });
    expect(taskProgress).toHaveBeenCalledWith('t1', 50, 'half');

    await expect(h('task.complete')({ taskId: 't1', result: { done: 1 } }, EXT_A)).resolves.toEqual({ ok: true });
    expect(taskDone).toHaveBeenCalledWith('t1', { done: 1 });

    await expect(h('task.fail')({ taskId: 't1', error: { message: 'boom' } }, EXT_A)).resolves.toEqual({ ok: true });
    expect(taskFailed).toHaveBeenCalledWith('t1', 'boom');

    // 他扩展的任务 → FORBIDDEN
    await expect(h('task.progress')({ taskId: 't1', pct: 1 }, 'ext-other')).rejects.toMatchObject({
      code: err('FORBIDDEN').code,
    });
  });

  it('cron.schedule：内部名加 extId 前缀、应答保持原名；unschedule 按内部名命中', async () => {
    const stored = (await h('cron.schedule')({ name: 'tick', expr: '*/5 * * * *' }, EXT_A)) as { name: string };
    expect(cronCalls.schedule[0]).toMatchObject({ extId: EXT_A, name: `${EXT_A}:tick` });
    expect(stored.name).toBe('tick');

    await expect(h('cron.unschedule')({ name: 'tick' }, EXT_A)).resolves.toEqual({ ok: true, removed: true });
    expect(cronCalls.unschedule).toEqual(['cron-1']);
    await expect(h('cron.unschedule')({ name: 'ghost' }, EXT_A)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
  });

  it('ui.register 落 UiRegistry；llm.chat → NOT_IMPLEMENTED；sandbox.exec 无权限 → FORBIDDEN（阶段 11 已接管）', async () => {
    await expect(h('ui.register')({ menu: { label: 'Menu' } }, EXT_A)).resolves.toEqual({ ok: true });
    expect(uiRegistry.snapshot()).toEqual([
      expect.objectContaining({ extId: EXT_A, menu: { label: 'Menu' } }),
    ]);

    await expect(h('llm.chat')({ prompt: 'x' }, EXT_A)).rejects.toMatchObject({ code: err('NOT_IMPLEMENTED').code });
    // 阶段 11 接线后 sandbox.exec 先过 manifest 权限闸：ext-a 未声明 'sandbox' → FORBIDDEN
    await expect(h('sandbox.exec')({}, EXT_A)).rejects.toMatchObject({ code: err('FORBIDDEN').code });
  });

  it('host.call：service.method 线格式解析 + 权限门 + 参数透传；无权限/坏格式/未知目标 fail-fast', async () => {
    const result = await h('host.call')(
      { targetExtId: 'target-ext', method: 'parse.run', args: { q: 1 } },
      EXT_A,
    );
    expect(result).toEqual({ done: true });
    // 注册中心 → dispatcher 的契约：service 为全名（剥前缀到裸名是 Kernel 接线层的职责）
    expect(registryDispatcher.calls.at(-1)).toEqual({
      targetExtId: 'target-ext',
      service: 'ext.target-ext.parse',
      method: 'run',
      args: { q: 1 },
    });

    // 无权限调用方 → RPC_PERMISSION_DENIED
    await expect(
      h('host.call')({ targetExtId: 'target-ext', method: 'parse.run' }, 'ext-other'),
    ).rejects.toMatchObject({ code: err('RPC_PERMISSION_DENIED').code });

    // 坏格式 method（无 service 段）→ BAD_REQUEST
    await expect(h('host.call')({ targetExtId: 'target-ext', method: 'run' }, EXT_A)).rejects.toMatchObject({
      code: err('BAD_REQUEST').code,
    });

    // 未知目标服务 → SERVICE_UNAVAILABLE
    await expect(
      h('host.call')({ targetExtId: 'target-ext', method: 'ghost.run' }, EXT_A),
    ).rejects.toMatchObject({ code: err('SERVICE_UNAVAILABLE').code });
  });

  it('system.info / system.stats 返回只读策划面（counters/os 形状）', async () => {
    const info = (await h('system.info')({}, EXT_A)) as { name: string; env: string; counters: unknown };
    expect(info).toMatchObject({ name: 'opptrix-harness', env: 'test', state: 'ready' });
    expect(info.counters).toBeTypeOf('object');

    const stats = (await h('system.stats')({}, EXT_A)) as { pid: number; memory: { rss: number } };
    expect(stats.pid).toBeTypeOf('number');
    expect(stats.memory.rss).toBeGreaterThan(0);
  });
});

// #############################################################################
// REL-2：host.call / host.cron 按信封 to 归属定位（真 worker；同名不串味）
// #############################################################################

describe('REL-2：两个扩展同名 service/cron 各自命中、互不串味', () => {
  const logger = pino({ level: 'silent' });
  let root = '';
  let manager: ExtensionManager;
  const cronScheduled: unknown[] = [];
  /** worker→kernel log 转发捕获：[{ who }]（cron handler 用 who 标识自身） */
  const cronRuns: Array<{ who: string }> = [];

  function makeExt(id: string): void {
    const dir = path.join(root, 'extensions', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, api: 1, version: '1.0.0', main: 'index.js', permissions: ['cron'], provides: ['dup'] }),
    );
    writeFileSync(
      path.join(dir, 'index.js'),
      [
        `'use strict';`,
        `defineExtension(async (h) => {`,
        `  h.expose('dup', { ping: async () => '${id}' });`,
        `  await h.cron.schedule({ name: 'dup', expr: '0 0 31 2 *' }, async () => {`,
        `    await h.log.info('cron-ran', { who: '${id}' });`,
        `  });`,
        `});`,
        ``,
      ].join('\n'),
    );
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'opptrix-rel2-'));
    makeExt('svc-a');
    makeExt('svc-b');
    const db = await openSqlite(path.join(root, 'kernel.sqlite'));
    await new Migrator(db, { migrations: KERNEL_MIGRATIONS }).latest();
    manager = new ExtensionManager({
      config: {
        ...loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: root }),
        env: 'test',
        dataDir: root,
      },
      db,
      logger,
      workerFactory: createWorkerFactory(logger),
      bridgeHandlers: {
        'cron.schedule': async (payload) => {
          cronScheduled.push(payload);
          return { id: `cron-${cronScheduled.length}` };
        },
        'cron.unschedule': async () => ({ ok: true }),
        log: async (payload) => {
          const record = (payload ?? {}) as { msg?: string; args?: Array<{ who?: string }> };
          if (record.msg === 'cron-ran') {
            const who = record.args?.[0]?.who;
            if (typeof who === 'string') cronRuns.push({ who });
          }
          return { ok: true };
        },
      },
      scheduler: {
        schedule: async (input) => {
          cronScheduled.push(input);
          return { id: `cron-${cronScheduled.length}` };
        },
        unschedule: async () => true,
        list: () => [],
      },
      eventBus: new EventBus({ logger }),
      hooks: new HookManager({ logger }),
      extensionsDirs: [path.join(root, 'extensions')],
    });
    await manager.start();
    await manager.enable('svc-a');
    await manager.enable('svc-b');
  }, 60_000);

  afterAll(async () => {
    await manager?.stop();
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('host.call：同名 dup.ping 按信封 to 各自命中', async () => {
    const bridge = manager.bridge;
    expect(bridge).not.toBeNull();
    const pingA = await bridge?.callToWorker('svc-a', HOST_METHODS.callService, {
      service: 'dup',
      method: 'ping',
      args: {},
    });
    const pingB = await bridge?.callToWorker('svc-b', HOST_METHODS.callService, {
      service: 'dup',
      method: 'ping',
      args: {},
    });
    expect(pingA).toBe('svc-a');
    expect(pingB).toBe('svc-b');
  });

  it('host.call：目标扩展未暴露该方法 → 明确 RPC_TARGET_NOT_FOUND（不回落到其他扩展）', async () => {
    const bridge = manager.bridge;
    await expect(
      bridge?.callToWorker('svc-a', HOST_METHODS.callService, { service: 'dup', method: 'missing', args: {} }),
    ).rejects.toMatchObject({ code: err('RPC_TARGET_NOT_FOUND').code });
  });

  it('host.cron：同名 cron 按信封 to 触发各自的 handler', async () => {
    const bridge = manager.bridge;
    const firedA = (await bridge?.callToWorker('svc-a', HOST_METHODS.cronFire, { name: 'dup' })) as { ok?: boolean };
    expect(firedA).toMatchObject({ ok: true, fired: 'dup' });
    await vi.waitFor(() => {
      expect(cronRuns.some((r) => r.who === 'svc-a')).toBe(true);
    });

    const firedB = (await bridge?.callToWorker('svc-b', HOST_METHODS.cronFire, { name: 'dup' })) as { ok?: boolean };
    expect(firedB).toMatchObject({ ok: true, fired: 'dup' });
    await vi.waitFor(() => {
      expect(cronRuns.some((r) => r.who === 'svc-b')).toBe(true);
    });
  }, 30_000);
});

// #############################################################################
// ui-registry 单元
// #############################################################################

describe('ui-registry 单元', () => {
  it('register 累加合并（数组追加、menu 以最后一次为准）；remove 摘除；快照按 extId 排序', () => {
    const registry = new UiRegistry();
    registry.register('b', {
      menu: { label: 'Old' },
      pages: [{ path: '/a', title: 'A', entry: 'a.js' }],
      widgets: [{ id: 'w1', title: 'W', entry: 'w.js' }],
      renderers: ['r1'],
    });
    registry.register('a', { pages: [{ path: '/x', title: 'X', entry: 'x.js' }] });
    registry.register('b', {
      menu: { label: 'New', icon: 'bolt' },
      pages: [{ path: '/b', title: 'B', entry: 'b.js' }],
      renderers: ['r2'],
    });

    const snapshot = registry.snapshot();
    expect(snapshot.map((s) => s.extId)).toEqual(['a', 'b']); // 稳定排序
    const b = snapshot.find((s) => s.extId === 'b');
    expect(b?.menu).toEqual({ label: 'New', icon: 'bolt' });
    expect(b?.pages).toHaveLength(2);
    expect(b?.widgets).toHaveLength(1);
    expect(b?.renderers).toEqual(['r1', 'r2']);

    // 快照是防御性拷贝：外部改写不影响内部
    b?.pages.pop();
    expect(registry.snapshot().find((s) => s.extId === 'b')?.pages).toHaveLength(2);

    registry.remove('b');
    expect(registry.snapshot().map((s) => s.extId)).toEqual(['a']);
    expect(() => registry.remove('ghost')).not.toThrow(); // 幂等
  });

  it('register 校验：非对象片段/缺 title/空 label → EXT_MANIFEST_INVALID；未知 extId 拒绝', () => {
    const registry = new UiRegistry();
    expect(() => registry.register('x', null as unknown as Record<string, unknown>)).toThrow(/EXT|invalid|fragment/i);
    expect(() => registry.register('x', { pages: [{ path: '/p', title: '', entry: 'e.js' }] })).toThrow();
    expect(() => registry.register('x', { menu: { label: '' } })).toThrow();
    expect(() => registry.register('', { pages: [] })).toThrow();
    expect(registry.snapshot()).toEqual([]); // 全部被拒，无半套登记
  });
});
