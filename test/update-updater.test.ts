/**
 * updater 单测（真实本地 http server 假 feed + 真 tar.gz 发布包 + 真子进程预检）。
 *
 * 覆盖：check 选频道 / feed 未配置与网络失败（feedOk=false 不抛）/ Bearer 透传 /
 * 版本比较（同版 available=null）；apply 全链路成功（slot 交换 + 文件落位 +
 * README 跳过 + history 追加 + requestRestart + 升级前备份 + incoming 清理）；
 * sha256 不匹配（verify 清理 + notifier warn）；预检失败与超时（preflight + slots 未交换）；
 * 实例并发闸与跨进程 updateInFlight 闸；路径穿越成员被拒；显式 target 覆盖；
 * history 空态；settlePendingUpdate 在途结算与正常态 no-op。
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack, type Pack } from 'tar-stream';
import knex, { type Knex } from 'knex';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settlePendingUpdate, Updater } from '../src/kernel/update/updater.js';
import {
  commitNewSlot,
  markUpdateSettled,
  readSlots,
  writeSlots,
  type SlotsCfg,
} from '../src/kernel/update/slots.js';
import { listBackups } from '../src/kernel/storage/backup.js';

/* ---------- fixtures ---------- */

let dataDir = '';
let db: Knex;
let portSeq = 39871;

/** 每个用例独立的临时 dataDir + sqlite 库 */
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-updater-'));
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: path.join(dataDir, 'app.sqlite') },
    useNullAsDefault: true,
  });
  await db.schema.createTable('items', (t) => {
    t.increments('id');
    t.text('name');
  });
});

afterEach(async () => {
  await db.destroy();
  await rm(dataDir, { recursive: true, force: true });
});

const logger = pino({ level: 'silent' });

/** notifier spy：记录 send 入参（不抛错） */
function makeNotifierSpy(): {
  notifier: { send(input: { title: string; body: string; level?: string }): Promise<unknown> };
  calls: Array<{ title: string; body: string; level?: string }>;
} {
  const calls: Array<{ title: string; body: string; level?: string }> = [];
  return {
    calls,
    notifier: {
      send: async (input) => {
        calls.push({ ...input });
        return null;
      },
    },
  };
}

/* ---------- 本地 http server（假 feed / 假发布包） ---------- */

interface Route {
  status?: number;
  body: Buffer | string;
  contentType?: string;
}

interface RecordedRequest {
  path: string;
  authorization?: string | string[];
}

interface TestServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * 起本地 http server。routes 按引用捕获：listen 之后仍可补写路由
 * （feed 里的 release url 需要端口，端口要 listen 后才可知）。
 */
function startHttpServer(routes: Record<string, Route>): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const route = routes[req.url ?? ''];
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization });
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': route.contentType ?? 'application/json' });
    res.end(route.body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') throw new Error('no address');
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/* ---------- tar.gz 构造 ---------- */

interface TarEntrySpec {
  name: string;
  content?: string;
  type?: 'file' | 'directory';
}

function addEntry(p: Pack, spec: TarEntrySpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (e?: Error | null) => (e ? reject(e) : resolve());
    if (spec.type === 'directory') {
      p.entry({ name: spec.name, type: 'directory' }, done);
      return;
    }
    const buf = Buffer.from(spec.content ?? '', 'utf8');
    p.entry({ name: spec.name, type: 'file', size: buf.length }, buf, done);
  });
}

/** 构造真 tar.gz（内存），返回 buffer 与 sha256 */
async function buildTarGz(entries: TarEntrySpec[]): Promise<{ buffer: Buffer; sha256: string }> {
  const p = pack();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const done = pipeline(Readable.from(p), createGzip(), sink);
  for (const spec of entries) await addEntry(p, spec);
  p.finalize();
  await done;
  const buffer = Buffer.concat(chunks);
  return { buffer, sha256: createHash('sha256').update(buffer).digest('hex') };
}

/* ---------- 预检用假 main.js ---------- */

/** 预检通过：监听 HARNESS_PORT 并对 /readyz 返回 200 */
const MAIN_JS_OK = [
  "const http = require('node:http');",
  'const port = Number(process.env.HARNESS_PORT);',
  'const server = http.createServer((req, res) => {',
  "  if (req.url === '/readyz') {",
  "    res.writeHead(200, { 'content-type': 'application/json' });",
  "    res.end(JSON.stringify({ ok: true }));",
  '    return;',
  '  }',
  '  res.writeHead(404);',
  '  res.end();',
  '});',
  "server.listen(port, '127.0.0.1');",
].join('\n');

/** 预检失败：立即退出码 1 */
const MAIN_JS_EXIT1 = 'process.exit(1);';

/** 预检超时：常驻但永不监听端口 */
const MAIN_JS_HANG = 'setInterval(() => {}, 60_000);';

/* ---------- 组合助手 ---------- */

interface UpdaterOpts {
  feedUrl?: string;
  channel?: 'stable' | 'beta';
  token?: string;
  fetchFn?: typeof fetch;
  notifier?: { send(input: { title: string; body: string; level?: string }): Promise<unknown> };
  restarts?: number[];
  preflightTimeoutMs?: number;
}

function makeUpdater(opts: UpdaterOpts = {}): Updater {
  const restarts = opts.restarts ?? [];
  return new Updater({
    config: {
      dataDir,
      updateFeed: opts.feedUrl ?? '',
      updateChannel: opts.channel ?? 'stable',
      updateToken: opts.token ?? '',
    },
    db,
    logger,
    ...(opts.notifier !== undefined ? { notifier: opts.notifier } : {}),
    requestRestart: () => {
      restarts.push(1);
    },
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    preflightTimeoutMs: opts.preflightTimeoutMs ?? 10_000,
    preflightPort: portSeq++,
  });
}

/** 指向当前用例 dataDir 的 slots 配置（dataDir 由 beforeEach 重建，故用 getter） */
const slotsCfg: SlotsCfg = {
  get dataDir(): string {
    return dataDir;
  },
};

/** 预置当前版本（保持初始 slot-a/slot-b 布局） */
async function seedVersion(version: string | null): Promise<void> {
  const s = await readSlots(slotsCfg);
  await writeSlots(slotsCfg, { ...s, version });
}

/** 发布包条目（dist/main.js 内容可换失败变体） */
function releaseEntries(mainJs: string): TarEntrySpec[] {
  return [
    { name: 'dist', type: 'directory' },
    { name: 'dist/main.js', content: mainJs },
    { name: 'node_modules', type: 'directory' },
    { name: 'node_modules/x', type: 'directory' },
    { name: 'node_modules/x/index.js', content: "module.exports = 'x';" },
    { name: 'README.md', content: 'should be skipped' },
  ];
}

interface ReleaseServer {
  server: TestServer;
  releaseUrl: string;
  tarball: { buffer: Buffer; sha256: string };
  /** 覆盖 /feed 路由内容（请求期生效） */
  setFeed(doc: unknown): void;
}

/** 假 feed + 假发布包的标准组合（mainJs 可换失败变体） */
async function makeReleaseServer(mainJs: string): Promise<ReleaseServer> {
  const tarball = await buildTarGz(releaseEntries(mainJs));
  const routes: Record<string, Route> = {
    '/release.tgz': { body: tarball.buffer, contentType: 'application/gzip' },
  };
  const server = await startHttpServer(routes);
  const releaseUrl = `${server.baseUrl}/release.tgz`;
  const setFeed = (doc: unknown): void => {
    routes['/feed'] = { body: JSON.stringify(doc) };
  };
  setFeed({
    stable: { channel: 'stable', version: '2.0.0', url: releaseUrl, sha256: tarball.sha256, notes: 'the big one' },
    beta: { channel: 'beta', version: '3.0.0-beta.1', url: releaseUrl, sha256: tarball.sha256 },
  });
  return { server, releaseUrl, tarball, setFeed };
}

/* ---------- check ---------- */

describe('Updater.check', () => {
  it('未配置 feed → feedOk=false + error（不抛）', async () => {
    const result = await makeUpdater().check();
    expect(result.feedOk).toBe(false);
    expect(result.available).toBeNull();
    expect(result.currentVersion).toBeNull();
    expect(result.error).toContain('not configured');
  });

  it('feed HTTP 500 → feedOk=false + error（不抛）', async () => {
    const server = await startHttpServer({ '/feed': { status: 500, body: 'boom', contentType: 'text/plain' } });
    try {
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed` }).check();
      expect(result.feedOk).toBe(false);
      expect(result.error).toContain('500');
    } finally {
      await server.close();
    }
  });

  it('feed 非 JSON → feedOk=false + error（不抛）', async () => {
    const server = await startHttpServer({ '/feed': { body: '<html>not json</html>', contentType: 'text/html' } });
    try {
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed` }).check();
      expect(result.feedOk).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('feed schema 非法（sha256 缺失）→ feedOk=false + error', async () => {
    const server = await startHttpServer({
      '/feed': { body: JSON.stringify({ stable: { channel: 'stable', version: '2.0.0', url: 'http://x/y.tgz' } }) },
    });
    try {
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed` }).check();
      expect(result.feedOk).toBe(false);
      expect(result.error).toContain('sha256');
    } finally {
      await server.close();
    }
  });

  it('配置 updateToken 时携带 Authorization: Bearer 头', async () => {
    const server = await startHttpServer({ '/feed': { body: JSON.stringify({}) } });
    try {
      await makeUpdater({ feedUrl: `${server.baseUrl}/feed`, token: 's3cret-feed-token' }).check();
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.authorization).toBe('Bearer s3cret-feed-token');
    } finally {
      await server.close();
    }
  });

  it('stable 与 beta 并存时按配置频道取分支（stable → 2.0.0）', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed`, channel: 'stable' }).check();
      expect(result.feedOk).toBe(true);
      expect(result.available?.channel).toBe('stable');
      expect(result.available?.version).toBe('2.0.0');
      expect(result.available?.notes).toBe('the big one');
    } finally {
      await server.close();
    }
  });

  it('beta 频道取 beta 分支（3.0.0-beta.1）', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed`, channel: 'beta' }).check();
      expect(result.feedOk).toBe(true);
      expect(result.available?.channel).toBe('beta');
      expect(result.available?.version).toBe('3.0.0-beta.1');
    } finally {
      await server.close();
    }
  });

  it('feed 无该频道分支 → feedOk=true 但 available=null（无 error）', async () => {
    const { server, releaseUrl, tarball, setFeed } = await makeReleaseServer(MAIN_JS_OK);
    try {
      setFeed({
        stable: { channel: 'stable', version: '2.0.0', url: releaseUrl, sha256: tarball.sha256 },
      });
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed`, channel: 'beta' }).check();
      expect(result.feedOk).toBe(true);
      expect(result.available).toBeNull();
      expect(result.error).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('已是该版本 → available=null（版本比较）', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('2.0.0');
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed` }).check();
      expect(result.feedOk).toBe(true);
      expect(result.currentVersion).toBe('2.0.0');
      expect(result.available).toBeNull();
    } finally {
      await server.close();
    }
  });

  it('有新版本 → available 可用且 currentVersion 来自 slots', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('1.9.0');
      const result = await makeUpdater({ feedUrl: `${server.baseUrl}/feed` }).check();
      expect(result.currentVersion).toBe('1.9.0');
      expect(result.available?.version).toBe('2.0.0');
      expect(result.available?.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });
});

/* ---------- apply ---------- */

describe('Updater.apply', () => {
  it('全链路成功：slot 交换 + 文件落位 + README 跳过 + history + 备份 + requestRestart + incoming 清理', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('1.0.0');
      await commitNewSlot(slotsCfg, { newSlot: 'slot-a', version: '1.0.0' }).catch(() => {}); // 确保状态文件存在
      const restarts: number[] = [];
      const spy = makeNotifierSpy();
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, notifier: spy.notifier, restarts });

      const result = await updater.apply();
      expect(result).toEqual({ ok: true, slot: 'slot-b', version: '2.0.0' });

      // slots 交换 + 进入更新窗口（等待重启 settle）
      const state = await readSlots(slotsCfg);
      expect(state.current).toBe('slot-b');
      expect(state.previous).toBe('slot-a');
      expect(state.version).toBe('2.0.0');
      expect(state.previousVersion).toBe('1.0.0');
      expect(state.updateInFlight).toBe(true);

      // 文件落位（dist/node_modules），非发布内容（README.md）被跳过
      const mainJs = await readFile(path.join(dataDir, 'releases', 'slot-b', 'dist', 'main.js'), 'utf8');
      expect(mainJs).toContain('require');
      const xIndex = await readFile(path.join(dataDir, 'releases', 'slot-b', 'node_modules', 'x', 'index.js'), 'utf8');
      expect(xIndex).toContain('module.exports');
      await expect(stat(path.join(dataDir, 'releases', 'slot-b', 'README.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // history 追加
      expect(await updater.history()).toEqual([expect.objectContaining({ version: '2.0.0', ok: true })]);

      // 升级前备份产物存在
      expect(await listBackups({ dataDir })).toHaveLength(1);

      // requestRestart 被调 + incoming/预检数据目录清理
      expect(restarts).toHaveLength(1);
      await expect(stat(path.join(dataDir, 'releases', 'incoming.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.join(dataDir, 'releases', '.preflight-data'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(spy.calls).toHaveLength(0); // 成功通知延迟到重启后的 settlePendingUpdate
    } finally {
      await server.close();
    }
  }, 30_000);

  it('显式 target 覆盖：feed 无新版时仍可按给定 url/sha256 升级', async () => {
    const { server, releaseUrl, tarball } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('2.0.0'); // feed 同版 → check 无 available
      const restarts: number[] = [];
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, restarts });

      const result = await updater.apply({ version: '9.9.9', url: releaseUrl, sha256: tarball.sha256 });
      expect(result).toEqual({ ok: true, slot: 'slot-b', version: '9.9.9' });
      expect((await readSlots(slotsCfg)).version).toBe('9.9.9');
      expect(restarts).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('无可用更新（feed 同版且 target 缺 url/sha256）→ UPDATE_CHECK_FAILED（HARNESS-8001）', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('2.0.0');
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed` });
      await expect(updater.apply()).rejects.toMatchObject({ code: 'HARNESS-8001' });
    } finally {
      await server.close();
    }
  });

  it('实例并发闸：进行中第二次 apply → UPDATE_IN_PROGRESS（HARNESS-8004）', async () => {
    const { server, releaseUrl, tarball } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('1.0.0');
      const realFetch = fetch;
      let calls = 0;
      let releaseFeed!: (res: Response) => void;
      const feedGate = new Promise<Response>((resolve) => {
        releaseFeed = resolve;
      });
      const fetchFn: typeof fetch = (input, init) => {
        calls += 1;
        if (calls === 1) return feedGate; // 首个 feed 请求挂起，制造“进行中”窗口
        return realFetch(input, init);
      };
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, fetchFn });

      const first = updater.apply();
      await new Promise((r) => setTimeout(r, 50));
      await expect(updater.apply()).rejects.toMatchObject({ code: 'HARNESS-8004' });

      releaseFeed(new Response(
        JSON.stringify({
          stable: { channel: 'stable', version: '2.0.0', url: releaseUrl, sha256: tarball.sha256 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ));
      expect(await first).toEqual({ ok: true, slot: 'slot-b', version: '2.0.0' });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('跨进程在途升级（slots.updateInFlight=true）→ apply 拒绝 UPDATE_IN_PROGRESS', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('2.0.0');
      await writeSlots(slotsCfg, { ...(await readSlots(slotsCfg)), updateInFlight: true });
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed` });
      await expect(updater.apply()).rejects.toMatchObject({ code: 'HARNESS-8004' });
    } finally {
      await server.close();
    }
  });

  it('sha256 不匹配 → stage=verify + incoming 清理 + slots 未交换 + notifier warn', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_OK);
    try {
      await seedVersion('1.0.0');
      const spy = makeNotifierSpy();
      const restarts: number[] = [];
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, notifier: spy.notifier, restarts });

      // feed 的 sha256 正确 → 用 target 显式给错误 sha256 触发 verify 失败
      const result = await updater.apply({ sha256: '0'.repeat(64) });
      expect(result).toMatchObject({ ok: false, stage: 'verify' });
      if (!result.ok) expect(result.error).toContain('sha256 mismatch');

      await expect(stat(path.join(dataDir, 'releases', 'incoming.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
      const state = await readSlots(slotsCfg);
      expect(state.current).toBe('slot-a');
      expect(state.version).toBe('1.0.0');
      expect(state.updateInFlight).toBe(false);
      expect(restarts).toHaveLength(0);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.level).toBe('warn');
      expect(spy.calls[0]?.title).toContain('checksum');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('预检失败（main.js 直接 exit 1）→ stage=preflight + slots 未交换 + notifier error', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_EXIT1);
    try {
      await seedVersion('1.0.0');
      const spy = makeNotifierSpy();
      const restarts: number[] = [];
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, notifier: spy.notifier, restarts });

      const result = await updater.apply();
      expect(result).toMatchObject({ ok: false, stage: 'preflight' });
      if (!result.ok) expect(result.error).toContain('exited prematurely');

      const state = await readSlots(slotsCfg);
      expect(state.current).toBe('slot-a');
      expect(state.version).toBe('1.0.0');
      expect(state.updateInFlight).toBe(false);
      expect(restarts).toHaveLength(0);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.level).toBe('error');
      expect(spy.calls[0]?.title).toContain('preflight');
      // incoming 已清理
      await expect(stat(path.join(dataDir, 'releases', 'incoming.tar.gz'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await server.close();
    }
  }, 30_000);

  it('预检超时（main.js 永不就绪）→ stage=preflight', async () => {
    const { server } = await makeReleaseServer(MAIN_JS_HANG);
    try {
      await seedVersion('1.0.0');
      const updater = makeUpdater({ feedUrl: `${server.baseUrl}/feed`, preflightTimeoutMs: 1_200 });
      const result = await updater.apply();
      expect(result).toMatchObject({ ok: false, stage: 'preflight' });
      if (!result.ok) expect(result.error).toContain('timed out');
      expect((await readSlots(slotsCfg)).current).toBe('slot-a');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('包内路径穿越成员（../evil.txt）被拒 → stage=extract 且无文件外泄', async () => {
    const evilTar = await buildTarGz([
      { name: 'dist/main.js', content: MAIN_JS_OK },
      { name: '../evil.txt', content: 'pwned' },
    ]);
    const routes: Record<string, Route> = {
      '/release.tgz': { body: evilTar.buffer, contentType: 'application/gzip' },
    };
    const server = await startHttpServer(routes);
    try {
      await seedVersion('1.0.0');
      const updater = makeUpdater();
      // 用显式 target 绕开 feed，url 直指穿越包
      const result = await updater.apply({
        version: '2.0.0',
        url: `${server.baseUrl}/release.tgz`,
        sha256: createHash('sha256').update(evilTar.buffer).digest('hex'),
      });
      expect(result).toMatchObject({ ok: false, stage: 'extract' });
      if (!result.ok) expect(result.error).toContain('unsafe path');
      await expect(stat(path.join(dataDir, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.join(dataDir, 'releases', 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readSlots(slotsCfg)).current).toBe('slot-a');
    } finally {
      await server.close();
    }
  }, 30_000);

  it('history：无记录时返回 []', async () => {
    const updater = makeUpdater();
    expect(await updater.history()).toEqual([]);
  });
});

/* ---------- settlePendingUpdate ---------- */

describe('settlePendingUpdate', () => {
  it('updateInFlight=true → markUpdateSettled(ok) + 成功通知', async () => {
    await seedVersion('2.0.0');
    // 模拟上一进程 commit 后的状态：current=slot-b、updateInFlight=true
    await writeSlots(slotsCfg, {
      ...(await readSlots(slotsCfg)),
      current: 'slot-b',
      previous: 'slot-a',
      version: '2.0.0',
      previousVersion: '1.0.0',
      updateInFlight: true,
    });
    const spy = makeNotifierSpy();

    await settlePendingUpdate({ config: slotsCfg, logger, notifier: spy.notifier });

    const state = await readSlots(slotsCfg);
    expect(state.updateInFlight).toBe(false);
    expect(state.current).toBe('slot-b');
    expect(state.version).toBe('2.0.0');
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.level).toBe('success');
    expect(spy.calls[0]?.body).toContain('2.0.0');
  });

  it('正常态（无在途升级）→ no-op，不发通知', async () => {
    await seedVersion('1.0.0');
    const spy = makeNotifierSpy();
    const before = await readSlots(slotsCfg);

    await settlePendingUpdate({ config: slotsCfg, logger, notifier: spy.notifier });

    const after = await readSlots(slotsCfg);
    expect(after).toEqual(before);
    expect(spy.calls).toHaveLength(0);
  });

  it('slots 契约验证：markUpdateSettled(ok=false) 回滚互换（updater 依赖的底层语义）', async () => {
    await seedVersion('2.0.0');
    await writeSlots(slotsCfg, {
      ...(await readSlots(slotsCfg)),
      current: 'slot-b',
      previous: 'slot-a',
      version: '2.0.0',
      previousVersion: '1.0.0',
      updateInFlight: true,
    });
    const rolled = await markUpdateSettled(slotsCfg, { ok: false });
    expect(rolled.current).toBe('slot-a');
    expect(rolled.version).toBe('1.0.0');
    expect(rolled.updateInFlight).toBe(false);
  });
});
