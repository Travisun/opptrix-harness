/**
 * 最终回炉 E2E 终验（完整用户旅程，真实 Kernel + 真实 createHttpServer + 真实 worker 线程）。
 *
 * 覆盖链路（每步即一个用例组）：
 * 1. boot：builtin auth/webui 自动启用；GET /ext/webui/ui/ → 200（P0-1 资产补挂时序）；
 * 2. owner 引导（v0.2 语义）：POST /api/v1/auth/onboarding（root 令牌所有权门）创建 owner
 *    （激活期不再自动建号）→ auth 登录：POST /api/v1/auth/login（owner/onboarding 密码）→
 *    强制 2FA enrollment（/ext/auth/2fa/setup + /2fa/enroll，真实 otplib TOTP）→ ses token；
 * 3. ses token 调 API：GET /api/v1/auth/me → 200；
 * 4. enable doc-demo + echo-bot；GET /api/v1/ui 含 doc-demo（P0-3 contributions.ui 透传）；
 * 5. 建 general 频道 → webhook 入站消息 → echo-bot 自动回复出现（轮询 messages）；
 * 6. 上传 txt → POST /ext/doc-demo/parse → 200 统计 + 通知已发（notifications 列表）；
 * 7. GET /admin → 302 → follow /ext/webui/ui/ → 200 含 <div id="app">（P0-2）；
 * 8. disable echo-bot → 再 webhook 入站 → 无自动回复；
 * 9. shutdown 干净（state stopped、manager stop 幂等）。
 *
 * worker 模式：HARNESS_WORKER_MODE='dev'（src 入口经 tsx loader，确定性）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
// 强制 2FA E2E：enroll 码用 otplib 按 setup 返回的真 secret 现算（内核 totpVerify 同库校验）
import { generate as totpGenerateCode } from 'otplib';

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';

/** owner 账号密码（v0.2 语义：owner 一律经 POST /auth/onboarding 创建，root 令牌不再是登录密码） */
const OWNER_PASSWORD = 'owner-pass-8';

/** root 令牌直连头（bootstrap 面） */
const rootAuth = { authorization: '' };
/** 会话令牌头（auth 扩展签发的 ses token） */
const sesAuth = { authorization: '' };
/** 会话令牌原文（SEC-7 后 auth mount 派发裁剪 authorization，凭据走 ?token= 通道） */
let sesToken = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-final-e2e-'));
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
  rootAuth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
});

afterAll(async () => {
  await kernel?.shutdown('final-e2e-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

/** 轮询直到 pred 成立或超时（毫秒） */
async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * owner 引导（v0.2 语义，boot 后登录前必须先执行）：
 * POST /api/v1/auth/onboarding（root 令牌所有权门）——users 空表 → fresh 创建首个 admin。
 * 激活期不再自动建号（needsOnboarding=users 空表），owner 不存在时 login 一律 401。
 */
async function onboardOwner(): Promise<void> {
  const status = await app.inject({ method: 'GET', url: '/api/v1/auth/onboarding/status' });
  expect(status.statusCode).toBe(200);
  expect((status.json() as { needsOnboarding: boolean }).needsOnboarding).toBe(true); // users 空表

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/onboarding',
    payload: { rootToken, password: OWNER_PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ enrollmentRequired: true }); // 返回 enr 注册令牌，续走 2FA 绑定
}

/**
 * 强制 2FA enrollment 全链（真实内核 totpGenerate/totpVerify）：
 * login → enrollmentRequired → GET /api/v1/auth/2fa/setup → otplib 现算码 → POST /api/v1/auth/2fa/enroll → 会话。
 * 注：/2fa/* 未加入内核 auth-mount 前缀（auth→/api/v1/auth|users），此处走 /ext/{id}/* 通配派发；
 * mount 前缀接线属内核集成工作包（见 extensions/auth/README.md「集成对齐点」）。
 */
async function enrollLogin(username: string, password: string): Promise<string> {
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(first.statusCode).toBe(200);
  const step1 = first.json() as { enrollmentRequired?: boolean; enrollToken?: string; token?: string };
  expect(step1.enrollmentRequired).toBe(true);
  expect(step1.token).toBeUndefined(); // 强制 2FA：未绑定不放行会话

  const setup = await app.inject({ method: 'GET', url: `/api/v1/auth/2fa/setup?enrollToken=${step1.enrollToken}` });
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { uri: string; secret: string };

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/2fa/enroll',
    payload: { enrollToken: step1.enrollToken, code: await totpGenerateCode({ secret }) },
  });
  expect(enroll.statusCode).toBe(200);
  return (enroll.json() as { token: string }).token;
}

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'，与 @fastify/multipart 对齐） */
function multipartBody(filename: string, mime: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----opptrixfinale2eboundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

interface ChatMessage {
  id: string;
  senderType: string;
  content: { type?: string; text?: string } | null;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('最终回炉 E2E 终验', () => {
  it('boot：builtin auth/webui 自动启用；扩展 UI 资产随 boot 可服务（P0-1 时序修复）', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: rootAuth });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{ id: string; enabled: boolean }>;
    expect(items.find((s) => s.id === 'auth')?.enabled).toBe(true);
    expect(items.find((s) => s.id === 'webui')?.enabled).toBe(true);

    // P0-1：registerExtAssets 在 extManager.start() 之后补挂（此前恒 404）
    const ui = await app.inject({ method: 'GET', url: '/ext/webui/ui/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain('<div id="app">');
  });

  it('owner 引导 + auth 登录：onboarding 建号 → 强制 2FA enrollment → ses token 调 API（/auth/me 200）', async () => {
    // v0.2 语义：激活不自动建号——boot 后第一步先经 onboarding（root 令牌门）创建 owner
    await onboardOwner();

    // 强制 2FA：owner 首登不放行会话，走 enrollment（真实 otplib TOTP 全链）后拿到 ses token
    const body = { token: await enrollLogin('owner', OWNER_PASSWORD) };
    expect(body.token).toMatch(/^ses_/);
    sesAuth.authorization = `Bearer ${body.token}`;
    sesToken = body.token;

    // SEC-7：auth mount 派发不再透传 authorization——/auth/me 凭据走 ?token= 查询通道
    const me = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${sesToken}` });
    expect(me.statusCode).toBe(200);
    // auth 扩展 /auth/me 契约：扁平身份 { userId, username, role, scopes, tokenType }
    expect(me.json()).toMatchObject({ username: 'owner', role: 'admin', tokenType: 'session' });
  });

  it('enable doc-demo + echo-bot → GET /api/v1/ui 含 doc-demo 条目（P0-3 contributions.ui 透传）', async () => {
    for (const id of ['doc-demo', 'echo-bot']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/extensions/${id}/enable`,
        headers: rootAuth,
      });
      expect(res.statusCode).toBe(200);
    }
    const list = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: rootAuth });
    const items = list.json() as Array<{ id: string; enabled: boolean }>;
    expect(items.find((s) => s.id === 'doc-demo')?.enabled).toBe(true);
    expect(items.find((s) => s.id === 'echo-bot')?.enabled).toBe(true);

    // doc-demo 的 manifest.ui（menu + 根页面）经 enable 提交进 UiRegistry
    const ui = await app.inject({ method: 'GET', url: '/api/v1/ui', headers: sesAuth });
    expect(ui.statusCode).toBe(200);
    const catalog = ui.json() as Array<{ extId: string; pages: unknown[]; menu?: unknown }>;
    const doc = catalog.find((e) => e.extId === 'doc-demo');
    expect(doc).toBeDefined();
    expect(doc?.menu).toEqual({ label: 'Doc Demo' });
    expect(doc?.pages).toEqual([{ path: '/', title: 'Doc Demo', entry: 'ui/index.html' }]);
    // webui 条目仍在
    expect(catalog.some((e) => e.extId === 'webui')).toBe(true);

    // doc-demo 启用后其 ui 资产在 boot 后补挂语义下随 enable 可见（同前缀已注册）
    const docUi = await app.inject({ method: 'GET', url: '/ext/doc-demo/ui/index.html' });
    expect(docUi.statusCode).toBe(200);
    expect(docUi.body).toContain('Doc Demo');
  });

  it('建 general 频道 → webhook 入站 → echo-bot 自动回复出现（轮询 messages）', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: sesAuth,
      payload: { name: 'General', slug: 'general' },
    });
    expect(created.statusCode).toBe(201);
    const channel = created.json() as { slug: string; webhookToken: string };
    expect(channel.slug).toBe('general');
    expect(typeof channel.webhookToken).toBe('string');

    // webhook 入站（公开免鉴权）→ chat.message.created → echo-bot 订阅回显
    const hook = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${channel.webhookToken}`,
      payload: { text: 'hello harness', sender: 'ci' },
    });
    expect(hook.statusCode).toBe(202);

    await waitFor('echo-bot auto reply', async () => {
      const messages = await app.inject({
        method: 'GET',
        url: '/api/v1/channels/general/messages',
        headers: sesAuth,
      });
      if (messages.statusCode !== 200) return false;
      const items = messages.json() as ChatMessage[];
      return items.some(
        (m) => m.senderType === 'ext' && m.content?.text === 'echo: hello harness',
      );
    });
  });

  it('上传 txt → POST /ext/doc-demo/parse → 200 统计；通知已发（notifications 列表）', async () => {
    const content = Buffer.from('hello harness\necho bot doc demo\n', 'utf8');
    const body = multipartBody('sample.txt', 'text/plain', content);
    const upload = await app.inject({
      method: 'POST',
      // SEC-4：扩展仅可读自己（extId 归属）的 private 文件——以 ?extId=doc-demo 上传归属
      url: '/api/v1/files?extId=doc-demo',
      headers: { ...sesAuth, ...body.headers },
      payload: body.payload,
    });
    expect(upload.statusCode).toBe(201);
    const file = upload.json() as { id: string; origName: string; mime: string };
    expect(file.origName).toBe('sample.txt');

    // doc-demo 扩展路由（/ext/doc-demo/parse）解析文件：行/词/字符统计 + 发成功通知
    // 'hello harness\necho bot doc demo\n' → lines 2（尾换行不另计）、words 6、chars 32
    const parse = await app.inject({
      method: 'POST',
      url: '/ext/doc-demo/parse',
      headers: sesAuth,
      payload: { fileId: file.id },
    });
    expect(parse.statusCode).toBe(200);
    expect(parse.json()).toEqual({
      fileId: file.id,
      lines: 2,
      words: 6,
      chars: 32,
    });

    // doc-demo 的 parseDocument 内 h.notify.send → 通知中心入库（GET 返回 { items, unread }）
    await waitFor('parse notification in inbox', async () => {
      const notes = await app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: sesAuth,
      });
      if (notes.statusCode !== 200) return false;
      const { items } = notes.json() as { items: Array<{ title: string; level: string }> };
      return items.some((n) => n.title === '文档解析完成' && n.level === 'success');
    });
  });

  it('GET /admin → 302 → follow /ext/webui/ui/ → 200 含 <div id="app">（P0-2 mount ui 接管）', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ext/webui/ui/');
    const followed = await app.inject({ method: 'GET', url: '/ext/webui/ui/' });
    expect(followed.statusCode).toBe(200);
    expect(followed.body).toContain('<div id="app">');
  });

  it('disable echo-bot → 再 webhook 入站 → 无自动回复（摘除即失效）；doc-demo/ui 条目仍在', async () => {
    const off = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/echo-bot/disable',
      headers: rootAuth,
    });
    expect(off.statusCode).toBe(200);

    const channel = await app.inject({
      method: 'GET',
      url: '/api/v1/channels/general',
      headers: sesAuth,
    });
    expect(channel.statusCode).toBe(200);
    const { webhookToken } = channel.json() as { webhookToken: string };

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/channels/general/messages',
      headers: sesAuth,
    });
    const beforeCount = (before.json() as unknown[]).length;

    const hook = await app.inject({
      method: 'POST',
      url: `/hooks/chat/${webhookToken}`,
      payload: { text: 'after disable', sender: 'ci' },
    });
    expect(hook.statusCode).toBe(202);

    // 入站消息本身落库（webhook 消息），但 echo-bot 不再产生 ext 回复
    await new Promise((r) => setTimeout(r, 300));
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/channels/general/messages',
      headers: sesAuth,
    });
    const items = after.json() as ChatMessage[];
    expect(items.length).toBe(beforeCount + 1); // 仅入站消息自身
    expect(items.some((m) => m.content?.text === 'echo: after disable')).toBe(false);

    // webui/doc-demo 的 UI 贡献不受 echo-bot disable 影响
    const ui = await app.inject({ method: 'GET', url: '/api/v1/ui', headers: sesAuth });
    const catalog = ui.json() as Array<{ extId: string }>;
    expect(catalog.some((e) => e.extId === 'doc-demo')).toBe(true);
    expect(catalog.some((e) => e.extId === 'webui')).toBe(true);
  });

  it('shutdown 干净：state stopped；重复 shutdown 幂等', async () => {
    await kernel.shutdown('final-e2e-explicit');
    expect(kernel.state()).toBe('stopped');
    // 幂等：重复调用直接返回
    await kernel.shutdown('final-e2e-again');
    expect(kernel.state()).toBe('stopped');
  });
});
