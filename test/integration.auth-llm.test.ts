/**
 * integration.auth-llm — 阶段 10 总装配 E2E（真实 Kernel + 真实 HTTP + 真实 worker 线程 + 临时 dataDir）。
 *
 * 覆盖 auth 内置扩展与 LLM Gateway 的完整接线链路：
 * - builtin 自动启用：boot 后 auth 扩展 enabled=true（manager 首次登记 builtin 行即 enabled）；
 * - rootToken 注入链：Kernel loadBootstrap（仅 builtin auth）→ worker 注入闸 → h.boot/ctx →
 *   auth 扩展 owner 引导 → POST /api/v1/auth/login（owner 密码 = rootToken）→
 *   强制 2FA：enrollmentRequired → /2fa/setup + /2fa/enroll（真实 otplib TOTP）→ ses_ 会话；
 * - AuthProvider 接线：ses/ak 令牌经 authChecker → AuthProviderRegistry → host.authVerify
 *   → worker 校验（核心断言：GET /api/v1/system/info 用 ses 令牌 200）；
 * - mount 路由：auth 扩展声明的 '/auth/*'、'/users*' 挂载到 /api/v1 前缀；
 * - break-glass：disable auth 后 rootToken 直连仍可用（authChecker root 分支），
 *   re-enable 后 login 恢复；
 * - LLM 全链路穿透：PUT /api/v1/llm/providers（apiKey 明文 → secrets）→ settings →
 *   LlmGateway → openai-chat adapter → 本地 mock OpenAI server → POST /chat 200；
 * - doc-demo：h.expose('parse') 服务 + 路由（files API 上传真文件 → /ext/doc-demo/parse）；
 * - 权限与 boot 隔离：非 'auth:provider' 扩展调 h.auth.* → FORBIDDEN；h.boot 不泄露 rootToken。
 *
 * worker 模式：HARNESS_WORKER_MODE='dev' 钉死 src 入口（与 integration.extensions 同约定）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createMockServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

// worker 入口解析在工厂调用期读 env：boot 之前设置即可（模块加载期设置更稳）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
// 强制 2FA E2E：enroll 码用 otplib 按 setup 返回的真 secret 现算（内核 totpVerify 同库校验）
import { generate as totpGenerateCode } from 'otplib';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0、静音日志、dev worker、固定 rootToken）
// ---------------------------------------------------------------------------

/** 固定 rootToken（≥32 字符；owner 引导密码 + break-glass 直连） */
const ROOT_TOKEN = 'e2e-root-token-0000000000000000000000000000000000000000000000000000';
/** mock OpenAI 供应商的模型名与明文 apiKey（PUT providers 携带 → secrets 转存） */
const MODEL = 'e2e-mock-model';
const API_KEY = 'sk-e2e-plain-key';
/** 权限/boot 隔离探测用临时扩展 id */
const PROBE_EXT_ID = 'tmp-perm-probe';

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
/** 本地 mock OpenAI server（openai-chat adapter 的 baseURL 指向它） */
let mock: Server;
let mockPort = 0;
/** mock 收到的调用记录（authorization 头 + body） */
const mockSeen: { authz: Array<string | undefined>; bodies: unknown[] } = { authz: [], bodies: [] };

/** 顺序用例间共享的凭据 */
let ownerSes = '';
let akToken = '';
let bobSes = '';
/** owner enrollment 时的 TOTP secret（re-enable 用例走"login 带 totp 直登"分支复用） */
let ownerTotpSecret = '';

/**
 * 强制 2FA enrollment 全链（真实内核 totpGenerate/totpVerify）：
 * login → enrollmentRequired → GET /api/v1/auth/2fa/setup → otplib 现算码 → POST /api/v1/auth/2fa/enroll → 会话。
 * 注：/2fa/* 未加入内核 auth-mount 前缀（auth→/api/v1/auth|users），此处走 /ext/{id}/* 通配派发；
 * mount 前缀接线属内核集成工作包（见 extensions/auth/README.md「集成对齐点」）。
 */
async function enrollLogin(username: string, password: string): Promise<{
  token: string;
  user: { username: string; role: string };
  secret: string;
}> {
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
  const body = enroll.json() as { token: string; user: { username: string; role: string } };
  return { ...body, secret };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-auth-llm-'));

  // 权限/boot 隔离探测扩展（boot 前落盘，start() 发现；不 builtin → 不自动启用）
  const probeDir = path.join(dataDir, 'extensions', PROBE_EXT_ID);
  await mkdir(probeDir, { recursive: true });
  await writeFile(
    path.join(probeDir, 'manifest.json'),
    JSON.stringify({ id: PROBE_EXT_ID, api: 1, version: '1.0.0', main: 'index.js', permissions: ['http'] }),
  );
  await writeFile(
    path.join(probeDir, 'index.js'),
    [
      "'use strict';",
      'defineExtension(async (h) => {',
      "  h.route('GET', '/probe', async () => {",
      '    let frozen = false;',
      "    try { h.boot['__probe__'] = 1; } catch (e) { frozen = true; }",
      '    return {',
      '      bootKeys: Object.keys(h.boot || {}),',
      '      bootFrozen: frozen,',
      '      hasAuth: typeof (h.auth && h.auth.hashPassword) === "function",',
      '    };',
      '  });',
      "  h.route('GET', '/tryhash', async () => {",
      '    try {',
      "      const r = await h.auth.hashPassword('probe-password');",
      '      return { ok: true, hashPrefix: String(r).slice(0, 7) };',
      '    } catch (e) {',
      "      return { code: (e && e.code) || 'UNKNOWN' };",
      '    }',
      '  });',
      '});',
    ].join('\n'),
  );

  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
        HARNESS_TOKEN: ROOT_TOKEN,
      }),
      port: 0,
    },
  });
  await kernel.boot();
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;

  // mock OpenAI：任意路径回 OpenAI chat.completion 形状（记录 authorization 与 body）
  mock = createMockServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      mockSeen.authz.push(req.headers['authorization']);
      try {
        mockSeen.bodies.push(JSON.parse(raw) as unknown);
      } catch {
        mockSeen.bodies.push(raw);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'mock-hello' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', () => resolve()));
  mockPort = (mock.address() as AddressInfo).port;
});

afterAll(async () => {
  await kernel?.shutdown('e2e-afterall'); // 幂等：测试内已 shutdown 时直接返回
  if (mock !== undefined) {
    await new Promise<void>((resolve, reject) => mock.close((e) => (e === null || e === undefined ? resolve() : reject(e))));
  }
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('阶段 10 总装配 E2E：auth 内置扩展 + LLM Gateway', () => {
  it('boot 后 extensions 清单：auth 为 builtin 且 enabled=true（内置默认启用）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: { authorization: `Bearer ${ROOT_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; enabled: boolean; builtin: boolean; mount: string | null }>;
    const authExt = list.find((s) => s.id === 'auth');
    expect(authExt).toBeDefined();
    expect(authExt?.builtin).toBe(true);
    expect(authExt?.enabled).toBe(true);
    expect(authExt?.mount).toBe('auth');
  });

  it('POST /api/v1/auth/login owner/rootToken → 强制 2FA enrollment → ses_ 令牌（rootToken 注入 → owner 引导生效）', async () => {
    const body = await enrollLogin('owner', ROOT_TOKEN);
    expect(body.token).toMatch(/^ses_[0-9a-f]{48}$/);
    expect(body.user).toMatchObject({ username: 'owner', role: 'admin' });
    ownerSes = body.token;
    ownerTotpSecret = body.secret;
  });

  it('GET /api/v1/auth/me（ses ?token=）→ owner/admin/session（SEC-7：auth mount 派发裁剪 authorization，凭据走 query 通道）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${ownerSes}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: 'owner', role: 'admin', tokenType: 'session' });
  });

  it('GET /api/v1/system/info（ses Bearer）→ 200：AuthProvider 经 worker 校验生效（核心断言）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: `Bearer ${ownerSes}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'opptrix-harness' });
  });

  it('POST /api/v1/auth/api-keys → ak_ 令牌；ak 调 GET /api/v1/notifications → 200', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/api-keys?token=${ownerSes}`,
      payload: { name: 'ci', scopes: ['*'] },
    });
    expect(created.statusCode).toBe(200);
    const key = created.json() as { token: string };
    expect(key.token).toMatch(/^ak_[0-9a-f]{48}$/);
    akToken = key.token;

    // API Key 经 AuthProvider 校验（scopes ['*']，owner → admin 角色）访问内核受保护 API
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: { authorization: `Bearer ${akToken}` } });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray((list.json() as { items: unknown[] }).items)).toBe(true);
  });

  it('错密码 login → 401 HARNESS-1006 形状', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'definitely-wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'HARNESS-1006' });
  });

  it('bob（normal）：admin 建号 → login（强制 2FA 同样 enrollment）→ PUT /api/v1/llm/providers → 403', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/users?token=${ownerSes}`,
      payload: { username: 'bob', password: 'bob-pass-8', role: 'normal' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ username: 'bob', role: 'normal' });

    const body = await enrollLogin('bob', 'bob-pass-8'); // 强制 2FA 对 normal 用户一视同仁
    bobSes = body.token;

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/llm/providers',
      headers: { authorization: `Bearer ${bobSes}` },
      payload: [],
    });
    expect(put.statusCode).toBe(403);
    expect(put.json()).toMatchObject({ code: 'HARNESS-1007' });
  });

  it('PUT /api/v1/llm/providers（admin，apiKey 明文 + mock baseUrl）→ 200；models 聚合含模型；配置脱敏', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/llm/providers',
      headers: { authorization: `Bearer ${ownerSes}` },
      payload: [
        {
          name: 'mock-openai',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: API_KEY,
          models: [MODEL],
        },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ok: true });

    const models = await app.inject({ method: 'GET', url: '/api/v1/llm/models', headers: { authorization: `Bearer ${ownerSes}` } });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual([{ provider: 'mock-openai', models: [MODEL] }]);

    // 配置层脱敏：settings 里只有 secret 引用，明文不回显
    const providers = await app.inject({ method: 'GET', url: '/api/v1/llm/providers', headers: { authorization: `Bearer ${ownerSes}` } });
    expect(providers.statusCode).toBe(200);
    const list = providers.json() as Array<{ apiKeySecretRef?: string; apiKey?: string }>;
    expect(list[0]?.apiKeySecretRef).toBe('llm.mock-openai');
    expect(JSON.stringify(list)).not.toContain(API_KEY);
  });

  it('POST /api/v1/llm/chat → 200 text 正确（settings → gateway → adapter → 本地 mock 全链路穿透）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/llm/chat',
      headers: { authorization: `Bearer ${ownerSes}` },
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { text: string; usage?: { inputTokens: number; outputTokens: number } };
    expect(body.text).toBe('mock-hello');
    expect(body.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    // 密钥经 secrets 解析后以 Bearer 到达 mock（apiKey 明文 → secrets → gateway 全链路）
    expect(mockSeen.authz.at(-1)).toBe(`Bearer ${API_KEY}`);
  });

  it('doc-demo：enable → files 上传真文件 → POST /ext/doc-demo/parse → 200 统计正确', async () => {
    const enable = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/doc-demo/enable',
      headers: { authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(enable.statusCode).toBe(200);

    // multipart 上传（field 名 file）：内容 'hello world\nsecond line\n' → 2 行 / 4 词 / 24 字符
    const text = 'hello world\nsecond line\n';
    const boundary = '----opptrix-e2e-doc';
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="note.txt"\r\n' +
        'Content-Type: text/plain\r\n' +
        '\r\n' +
        text +
        `\r\n--${boundary}--\r\n`,
      'utf8',
    );
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/files?extId=doc-demo',
      headers: {
        authorization: `Bearer ${ROOT_TOKEN}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(upload.statusCode).toBe(201);
    const fileId = (upload.json() as { id: string }).id;

    const parsed = await app.inject({ method: 'POST', url: '/ext/doc-demo/parse', payload: { fileId } });
    expect(parsed.statusCode).toBe(200);
    expect(parsed.json()).toEqual({ fileId, lines: 2, words: 4, chars: text.length });
  });

  it('disable auth → /api/v1/auth/me 503（路由墓碑）；system/info 用 ses → 401（provider 已注销）', async () => {
    const off = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/auth/disable',
      headers: { authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(off.statusCode).toBe(200);

    // auth 路由已摘表：503 SERVICE_UNAVAILABLE（与 /ext/* 禁用墓碑语义一致）
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${ownerSes}` } });
    expect(me.statusCode).toBe(503);

    // worker 已卸载 + provider 已注销：ses 令牌在内核受保护 API 上不再被认可
    const info = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: `Bearer ${ownerSes}` } });
    expect(info.statusCode).toBe(401);
    const infoAk = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: `Bearer ${akToken}` } });
    expect(infoAk.statusCode).toBe(401);
  });

  it('break-glass：disable auth 后 system/info 用 rootToken 仍 200（authChecker root 直连）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/info', headers: { authorization: `Bearer ${ROOT_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'opptrix-harness' });
  });

  it('re-enable auth → login 又可用（owner 已绑 2FA：带 totp 直登新会话，路由恢复）', async () => {
    const on = await app.inject({
      method: 'POST',
      url: '/api/v1/extensions/auth/enable',
      headers: { authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(on.statusCode).toBe(200);

    // owner 已绑定 TOTP：不带码 → mfaRequired；带码 → 直接签发会话
    const noTotp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: ROOT_TOKEN },
    });
    expect(noTotp.statusCode).toBe(200);
    expect(noTotp.json()).toMatchObject({ mfaRequired: true });

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'owner',
        password: ROOT_TOKEN,
        totp: await totpGenerateCode({ secret: ownerTotpSecret }),
      },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as { token: string }).token).toMatch(/^ses_[0-9a-f]{48}$/);

    const me = await app.inject({ method: 'GET', url: `/api/v1/auth/me?token=${ownerSes}` });
    expect(me.statusCode).toBe(200);
  });

  it('权限/boot 隔离：非 auth:provider 扩展 h.auth.hashPassword → FORBIDDEN；h.boot 无 rootToken', async () => {
    // [ext-trust 工作包最小修复] probe 位于 dataDir/extensions（第三方目录）：
    // 首次 enable 被信任闸拒绝（403 HARNESS-3012），confirmTrust 重试后激活
    const trustGate = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${PROBE_EXT_ID}/enable`,
      headers: { authorization: `Bearer ${ROOT_TOKEN}` },
    });
    expect(trustGate.statusCode).toBe(403);
    expect(trustGate.json()).toMatchObject({ code: 'HARNESS-3012' });
    const enable = await app.inject({
      method: 'POST',
      url: `/api/v1/extensions/${PROBE_EXT_ID}/enable`,
      headers: { authorization: `Bearer ${ROOT_TOKEN}` },
      payload: { confirmTrust: true },
    });
    expect(enable.statusCode).toBe(200);

    const tryhash = await app.inject({ method: 'GET', url: `/ext/${PROBE_EXT_ID}/tryhash` });
    expect(tryhash.statusCode).toBe(200);
    expect(tryhash.json()).toEqual({ code: 'HARNESS-1007' }); // FORBIDDEN：manifest 未声明 'auth:provider'

    const probe = await app.inject({ method: 'GET', url: `/ext/${PROBE_EXT_ID}/probe` });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toEqual({ bootKeys: [], bootFrozen: true, hasAuth: true });
  });
});
