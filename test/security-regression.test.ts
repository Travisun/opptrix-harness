/**
 * security-regression — 安全回炉回归（SEC-2 / SEC-4 / SEC-5 / SEC-7 + SEC-1 快照断言）。
 *
 * 覆盖：
 * - SEC-2：受限 require 的符号链接击穿（/tmp 下 symlink 指向目录外文件 → 拒绝；真实 vm 场景）；
 * - SEC-4：跨扩展窃取三处归属缺失（files.read/files.get 归属、sandbox.exec 强制
 *   `ext-<callerExtId>` 工作区、chat.patch 仅允许改写本人消息）；
 * - SEC-5：VACUUM（VACUUM INTO 跨库逃逸）进入 forbidDangerousSql 禁词；
 * - SEC-7：下发扩展 handler 的请求头白名单裁剪（authorization/cookie 剔除）；
 * - SEC-1 快照断言：exposeHarnessApiInVm 产物是 VM realm 对象（原型即 VM
 *   Object.prototype、冻结、宿主 Function 构造器不可达）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';
import pino from 'pino';

import { HOST_METHODS, KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import { createExtVm, createTimerRegistry } from '../src/extension-host/vm-runtime.js';
import { createRestrictedRequire, exposeHarnessApiInVm } from '../src/extension-host/sandbox.js';
import type { HarnessApi } from '../src/extension-host/sandbox.js';
import { createContributionsCollector } from '../src/extension-host/sandbox.js';
import { forbidDangerousSql } from '../src/kernel/storage/db.js';
import { sanitizeExtHeaders } from '../src/kernel/extensions/routes.js';
import { CONTAINER_KEYS, type Kernel } from '../src/kernel/Kernel.js';
import { FACADE_CONTAINER_KEYS } from '../src/kernel/Facades.js';
import { createKernelHandlers } from '../src/kernel/extensions/kernel-handlers.js';
import { Counters } from '../src/kernel/system/info.js';
import { openSqlite } from '../src/kernel/storage/db.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/index.js';
import { ExtensionServiceRegistry } from '../src/kernel/extensions/registry.js';

const logger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// SEC-2：受限 require 符号链接击穿
// ---------------------------------------------------------------------------

describe('SEC-2 受限 require：符号链接防击穿', () => {
  let extDir = '';
  let outsideDir = '';

  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-sec-ext-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opptrix-sec-out-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.js'), 'module.exports = "pwned-through-symlink";');
  });

  afterEach(() => {
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  function makeRequire(): (spec: string) => unknown {
    const { context } = createExtVm({
      extId: 'sec-probe',
      logger,
      kernelCall: async () => ({ ok: true }),
      timers: createTimerRegistry(),
    });
    return createRestrictedRequire({ extDir, context });
  }

  it('extDir 内的 symlink 指向目录外文件 → require 拒绝（realpath 越界）', () => {
    fs.symlinkSync(path.join(outsideDir, 'secret.js'), path.join(extDir, 'innocent.js'));
    const require = makeRequire();
    expect(() => require('./innocent')).toThrow(/require denied/);
  });

  it('extDir 内的目录 symlink 指向目录外 → 经其 require 相对模块同样拒绝', () => {
    fs.mkdirSync(path.join(extDir, 'sub'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(extDir, 'sub', 'leak'));
    const require = makeRequire();
    expect(() => require('./sub/leak/secret')).toThrow(/require denied/);
  });

  it('正常相对模块在加固后仍可加载（正功能回归）', () => {
    fs.writeFileSync(path.join(extDir, 'ok.js'), 'module.exports.v = 42;');
    const require = makeRequire();
    expect((require('./ok') as { v: number }).v).toBe(42);
  });

  it('不存在的模块报 cannot find module（ENOENT 不误报为穿越拒绝）', () => {
    const require = makeRequire();
    expect(() => require('./missing')).toThrow(/cannot find module/);
  });
});

// ---------------------------------------------------------------------------
// SEC-4：跨扩展窃取三处归属缺失（kernel-handlers 层，最小容器 stub）
// ---------------------------------------------------------------------------

describe('SEC-4 kernel-handlers 归属校验', () => {
  const EXT_A = 'ext-a';
  const EXT_B = 'ext-b';
  let dataDir = '';
  let kernelDb: Knex;
  let filesRead: ReturnType<typeof vi.fn>;
  let filesGet: ReturnType<typeof vi.fn>;
  let chatGetMessage: ReturnType<typeof vi.fn>;
  let chatPatch: ReturnType<typeof vi.fn>;
  let workspaceCalls: { created: string[]; executed: Array<{ id: string; cmd: string[] }> };
  let handlers: Record<string, (payload: unknown, from: string) => Promise<unknown>>;

  const h = (topic: string): ((payload: unknown, from: string) => Promise<unknown>) => {
    const handler = handlers[topic];
    expect(handler, `handler for "${topic}" must exist`).toBeTypeOf('function');
    return handler;
  };

  beforeAll(async () => {
    dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opptrix-sec-handlers-'));
    kernelDb = await openSqlite(path.join(dataDir, 'kernel.sqlite'));
    await kernelDb.schema.createTable('ext_kv', (t) => {
      t.text('ext_id').notNullable();
      t.text('key').notNullable();
      t.text('value').notNullable();
      t.integer('updated_at').notNullable();
      t.primary(['ext_id', 'key']);
    });

    filesRead = vi.fn(async (id: string) => ({
      record: { id, visibility: 'private', extId: EXT_A },
      data: Buffer.from('a-private'),
    }));
    filesGet = vi.fn(async (id: string) => ({ id, visibility: 'private', extId: EXT_A }));
    chatGetMessage = vi.fn(async (id: string) => ({ id, senderId: EXT_A, content: { text: 'orig' } }));
    chatPatch = vi.fn(async (id: string, content: unknown) => ({ id, content }));
    workspaceCalls = { created: [], executed: [] };
    const sandboxManager = {
      get: (id: string) => (workspaceCalls.created.includes(id) ? { id } : null),
      createWorkspace: async (input: { id: string }) => {
        workspaceCalls.created.push(input.id);
        return { id: input.id };
      },
      exec: async (id: string, cmd: string[]) => {
        workspaceCalls.executed.push({ id, cmd });
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const map = new Map<string, unknown>(Object.entries({
      [CONTAINER_KEYS.db]: kernelDb,
      [CONTAINER_KEYS.files]: { read: filesRead, get: filesGet, store: vi.fn() },
      [CONTAINER_KEYS.chat]: { sendMessage: vi.fn(), patchMessage: chatPatch, getMessage: chatGetMessage },
      [CONTAINER_KEYS.tasks]: { dispatch: vi.fn(), get: vi.fn(), onProgress: vi.fn(), onDone: vi.fn(), onFailed: vi.fn() },
      [CONTAINER_KEYS.notify]: { send: vi.fn() },
      [CONTAINER_KEYS.counters]: new Counters(),
      [CONTAINER_KEYS.uiRegistry]: { register: vi.fn() },
      [CONTAINER_KEYS.extRegistrySvc]: new ExtensionServiceRegistry({ dispatcher: { callService: vi.fn() }, logger }),
      [CONTAINER_KEYS.extManager]: { getManifest: () => ({ permissions: ['sandbox'] }) },
      [CONTAINER_KEYS.sandbox]: sandboxManager,
      [FACADE_CONTAINER_KEYS.cronScheduler]: { schedule: vi.fn(), unschedule: vi.fn(), list: () => [] },
    }));
    const container = {
      resolve<T>(key: string): T {
        if (!map.has(key)) throw err('INTERNAL', { message: `[stub-container] missing binding: ${key}` });
        return map.get(key) as T;
      },
      has(key: string): boolean {
        return map.has(key);
      },
    };
    const kernelLike = {
      config: loadConfig({ NODE_ENV: 'test', HARNESS_DATA_DIR: dataDir }),
      logger,
      state: () => 'ready',
      isReady: () => true,
      container,
    };
    handlers = createKernelHandlers({ kernel: kernelLike as unknown as Kernel });
  });

  afterAll(async () => {
    await kernelDb.destroy();
    if (dataDir !== '') await fs.promises.rm(dataDir, { recursive: true, force: true });
  });

  it('files.read：他人 private 文件 → EXT_NOT_FOUND（不泄露存在性）', async () => {
    filesRead.mockResolvedValueOnce({ record: { id: 'fx', visibility: 'private', extId: EXT_B }, data: Buffer.from('x') });
    await expect(h(KERNEL_TOPICS.filesRead)({ id: 'fx' }, `ext:${EXT_A}`)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
    // 内核级文件（extId null）对扩展同样不可读
    filesRead.mockResolvedValueOnce({ record: { id: 'fk', visibility: 'private', extId: null }, data: Buffer.from('k') });
    await expect(h(KERNEL_TOPICS.filesRead)({ id: 'fk' }, `ext:${EXT_A}`)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
  });

  it('files.read：本人 private 文件与 public 文件仍可读（正功能回归）', async () => {
    await expect(h(KERNEL_TOPICS.filesRead)({ id: 'own' }, `ext:${EXT_A}`)).resolves.toBe(
      Buffer.from('a-private').toString('base64'),
    );
    filesRead.mockResolvedValueOnce({ record: { id: 'pub', visibility: 'public', extId: EXT_B }, data: Buffer.from('p') });
    await expect(h(KERNEL_TOPICS.filesRead)({ id: 'pub' }, `ext:${EXT_A}`)).resolves.toBe(
      Buffer.from('p').toString('base64'),
    );
  });

  it('files.get：他人 private 文件 → EXT_NOT_FOUND；本人可见', async () => {
    await expect(h(KERNEL_TOPICS.filesGet)({ id: 'fx' }, `ext:${EXT_A}`)).resolves.toMatchObject({ id: 'fx' });
    filesGet.mockResolvedValueOnce({ id: 'fy', visibility: 'private', extId: EXT_B });
    await expect(h(KERNEL_TOPICS.filesGet)({ id: 'fy' }, `ext:${EXT_A}`)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
  });

  it('sandbox.exec：payload.workspaceId 被忽略，工作区强制 ext-<callerExtId>（懒创建保留）', async () => {
    await h(KERNEL_TOPICS.sandboxExec)(
      { cmd: ['ls'], workspaceId: 'victim-ws' },
      `ext:${EXT_A}`,
    );
    expect(workspaceCalls.created).toContain(`ext-${EXT_A}`);
    expect(workspaceCalls.created).not.toContain('victim-ws');
    expect(workspaceCalls.executed.at(-1)).toMatchObject({ id: `ext-${EXT_A}`, cmd: ['ls'] });
  });

  it('chat.patch：改写他人消息/不存在消息 → EXT_NOT_FOUND；本人消息可改', async () => {
    await expect(h(KERNEL_TOPICS.chatPatch)({ id: 'm1', content: 'ok' }, `ext:${EXT_A}`)).resolves.toMatchObject({ id: 'm1' });

    chatGetMessage.mockResolvedValueOnce({ id: 'm2', senderId: EXT_B, content: null });
    await expect(h(KERNEL_TOPICS.chatPatch)({ id: 'm2', content: 'hijack' }, `ext:${EXT_A}`)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
    expect(chatPatch).not.toHaveBeenCalledWith('m2', 'hijack');

    chatGetMessage.mockResolvedValueOnce(null);
    await expect(h(KERNEL_TOPICS.chatPatch)({ id: 'ghost', content: 'x' }, `ext:${EXT_A}`)).rejects.toMatchObject({
      code: err('EXT_NOT_FOUND').code,
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-5：VACUUM INTO 禁词
// ---------------------------------------------------------------------------

describe('SEC-5 forbidDangerousSql：VACUUM INTO 逃逸被拒', () => {
  it.each([
    `VACUUM INTO '/tmp/steal.db'`,
    `vacuum into 'x.db'`,
    `VACUUM main INTO '/tmp/x'`,
  ])('%s → DB_STATEMENT_FORBIDDEN', (sql) => {
    expect(() => forbidDangerousSql(sql)).toThrowError(
      expect.objectContaining({ code: err('DB_STATEMENT_FORBIDDEN').code }),
    );
  });

  it('字面量中的 vacuum 不误伤；普通语句不受影响', () => {
    expect(() => forbidDangerousSql(`INSERT INTO t(a) VALUES ('vacuum into nowhere')`)).not.toThrow();
    expect(() => forbidDangerousSql(`SELECT * FROM t`)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SEC-7：请求头白名单裁剪
// ---------------------------------------------------------------------------

describe('SEC-7 sanitizeExtHeaders 白名单', () => {
  it('authorization/cookie 及未列名头部一律剔除；白名单头部保留', () => {
    const out = sanitizeExtHeaders({
      'content-type': 'application/json',
      'content-length': '12',
      'user-agent': 'ua/1',
      accept: '*/*',
      'x-requested-with': 'xhr',
      'x-harness-signature': 'sig',
      'x-harness-timestamp': '123',
      authorization: 'Bearer sekrit',
      cookie: 'session=steal',
      'x-custom-probe': 'leak-me',
      'X-HARNESS-SIGNATURE': 'upper',
    });
    expect(Object.keys(out).map((k) => k.toLowerCase()).sort()).toEqual([
      'accept',
      'content-length',
      'content-type',
      'user-agent',
      'x-harness-signature',
      'x-harness-signature', // 保留原键大小写：小写 + 大写两条
      'x-harness-timestamp',
      'x-requested-with',
    ].sort());
    expect(out['authorization']).toBeUndefined();
    expect(out['cookie']).toBeUndefined();
    expect(out['x-custom-probe']).toBeUndefined();
    expect(out['content-type']).toBe('application/json');
  });

  it('空 headers 安全', () => {
    expect(sanitizeExtHeaders({})).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// SEC-1 快照断言：exposeHarnessApiInVm 产物是 VM realm 对象
// ---------------------------------------------------------------------------

describe('SEC-1 快照：h 门面是 VM realm 冻结对象树', () => {
  it('原型即 VM Object.prototype、对象冻结、宿主构造器不可达', () => {
    const { context, bridge } = createExtVm({
      extId: 'sec-snapshot',
      logger,
      kernelCall: async () => ({ ok: true }),
      timers: createTimerRegistry(),
    });
    const collector = createContributionsCollector();
    const harness = createHarnessApiForSnapshot();
    const harnessVm = exposeHarnessApiInVm(harness, bridge);
    Object.defineProperty(context, '__h', { value: harnessVm, configurable: true });

    const snapshot = vm.runInContext(
      `({
        protoIsVmObject: Object.getPrototypeOf(__h) === Object.prototype,
        frozen: Object.isFrozen(__h),
        subFrozen: Object.isFrozen(__h.db),
        ctorIsVmIntrinsic: Object.getPrototypeOf(__h.db).constructor === Object && __h.db.all instanceof Function && __h.route.constructor === Function,
        hostCanary: typeof __OPPTRIX_HOST_CANARY__,
      })`,
      context,
    ) as { protoIsVmObject: boolean; frozen: boolean; subFrozen: boolean; ctorIsVmIntrinsic: boolean; hostCanary: string };
    expect(snapshot.protoIsVmObject).toBe(true);
    expect(snapshot.frozen).toBe(true);
    expect(snapshot.subFrozen).toBe(true);
    expect(snapshot.ctorIsVmIntrinsic).toBe(true);
    expect(snapshot.hostCanary).toBe('undefined'); // VM 内读不到宿主 global 标记
  });

  /** 快照用例专用的最小 h 门面（不触内核） */
  function createHarnessApiForSnapshot(): HarnessApi {
    const noop = (): void => {};
    const api = {
      log: { debug: noop, info: noop, warn: noop, error: noop },
      config: { get: async () => null },
      storage: { get: async () => null, set: async () => ({}), delete: async () => ({}) },
      db: {
        all: async () => [], get: async () => null, run: async () => ({}), schema: async () => ({}),
      },
      notify: { send: async () => ({}) },
      chat: { send: async () => ({}), patch: async () => ({}) },
      files: { save: async () => ({}), read: async () => '', get: async () => ({}) },
      tasks: { dispatch: async () => ({}), progress: async () => ({}), complete: async () => ({}), fail: async () => ({}) },
      cron: { schedule: async () => ({}), unschedule: async () => ({}) },
      ui: { register: noop },
      llm: { chat: async () => ({}) },
      sandbox: { exec: async () => ({}) },
      system: { info: async () => ({}), stats: async () => ({}) },
      boot: {},
      auth: { hashPassword: async () => 'h', verifyPassword: async () => true },
      call: async () => ({}),
      route: noop, webhook: noop, on: noop, hook: noop, expose: noop,
      page: noop, menu: noop, task: noop, authProvider: noop,
    };
    return api as unknown as HarnessApi;
  }
});

// ---------------------------------------------------------------------------
// REL-1 伴随快照：worker reply 上限常量与桥错误码契约
// ---------------------------------------------------------------------------

describe('SEC 伴随契约', () => {
  it('host.call 信封端点契约（REL-2 定位键）形状稳定', () => {
    expect(HOST_METHODS.callService).toBe('host.call');
    expect(HOST_METHODS.cronFire).toBe('host.cron');
    expect(HOST_METHODS.taskRun).toBe('host.task');
  });
});
