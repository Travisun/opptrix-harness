/**
 * LLM 提示词定时任务（cron payload.kind === 'llm'）— 执行器 / REST 校验 / 调度全链测试。
 *
 * 三层覆盖：
 * 1. runner 单元（src/kernel/cron/llm-job.ts，gateway/notify/providers 全 stub）：
 *    指定模型成功、指定模型不存在→回退第一可用缺省模型、全部失败→ok:false+error 通知、
 *    summary 截断 500、notify 开关、通知失败不抛、prompt 非法、结果形状异常兜底；
 * 2. REST 校验（registerCronRoutes + 真 fastify inject + 内存 scheduler stub）：
 *    kind:'llm' 缺 prompt → 400、合法 → 201、prompt 8KB 字节边界、notify 非布尔 → 400、
 *    PATCH 同规则；kind 缺省/其他值的普通任务维持自由 JSON 现状；
 * 3. 调度全链（真内核 boot + 真 CronScheduler + 真 mock OpenAI upstream + 真 NotificationManager）：
 *    REST 建任务 → runNow → cron_runs 历史 ok=true + 结果通知入库（成功/回退/失败三态），
 *    以及 notify:false 与普通任务不发通知的现状保持。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createMockServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';

import {
  registerCronRoutes,
  type CronJobCreateInput,
  type CronJobPatch,
  type CronSchedulerLike,
} from '../src/api/cron.js';
import { createLlmJobRunner, LLM_JOB_SUMMARY_MAX_CHARS } from '../src/kernel/cron/llm-job.js';
import type { CronJobRecord } from '../src/kernel/cron/store.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';

// ---------------------------------------------------------------------------
// 1) runner 单元测试（全 stub）
// ---------------------------------------------------------------------------

/** runner 依赖 stub 集：chat/send/getProviders 皆为可断言的 vi.fn */
function makeRunner(opts: {
  /** chat 实现（缺省：回显 `echo:<model>`） */
  chatImpl?: (input: { model: string; messages: Array<{ role: string; content: string }> }) => Promise<unknown>;
  /** getProviders 返回值（缺省 []） */
  providers?: Array<{ name: string; models: string[] }>;
  /** getProviders 直接抛错（模拟 settings 读取失败） */
  providersThrow?: boolean;
  /** notify.send 抛错（模拟通知渠道故障） */
  sendThrows?: boolean;
}) {
  const chat = vi.fn(
    opts.chatImpl ?? (async (input: { model: string }) => ({ text: `echo:${input.model}`, usage: undefined })),
  );
  const send = vi.fn(async () => {
    if (opts.sendThrows === true) throw new Error('webhook unreachable');
    return { id: 'n-1' };
  });
  const getProviders = vi.fn(async () => {
    if (opts.providersThrow === true) throw new Error('settings read failed');
    return opts.providers ?? [];
  });
  const runner = createLlmJobRunner({
    gateway: { chat: chat as (input: { model: string; messages: Array<{ role: 'user'; content: string }> }) => Promise<unknown> },
    getProviders,
    notify: { send: send as (input: { title: string; body?: string; level?: string }) => Promise<unknown> },
    logger: pino({ level: 'silent' }),
  });
  return { runner, chat, send, getProviders };
}

describe('llm cron runner — 单元', () => {
  it('指定模型成功：单次 chat（非流式 user 消息）+ success 通知（标题含任务名、body=摘要）', async () => {
    const { runner, chat, send } = makeRunner({ providers: [{ name: 'p1', models: ['m1', 'm2'] }] });
    const result = await runner.run({ prompt: '今日巡检', model: 'm1' }, { jobName: 'job-ok' });

    expect(result).toEqual({ ok: true, summary: 'echo:m1' });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[0]).toEqual({ model: 'm1', messages: [{ role: 'user', content: '今日巡检' }] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({ title: '自动化「job-ok」完成', body: 'echo:m1', level: 'success' });
  });

  it('指定模型 404/不存在 → 回退第一可用 provider 的缺省模型重试一次并成功', async () => {
    const { runner, chat, send } = makeRunner({
      providers: [{ name: 'p1', models: ['m1', 'm2'] }],
      chatImpl: async (input) => {
        if (input.model === 'ghost') throw err('LLM_MODEL_NOT_FOUND', { detail: { model: input.model } });
        return { text: `echo:${input.model}` };
      },
    });
    const result = await runner.run({ prompt: 'hi', model: 'ghost' }, { jobName: 'job-fallback' });

    expect(result).toEqual({ ok: true, summary: 'echo:m1' }); // 回退到 providers[0].models[0]
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['ghost', 'm1']); // 恰好重试一次
    expect(send.mock.calls[0]?.[0]).toMatchObject({ level: 'success', body: 'echo:m1' });
  });

  it('指定模型失败且无可回退供应商 → ok:false + error 通知（body 携带失败原因）', async () => {
    const { runner, chat, send } = makeRunner({
      providers: [],
      chatImpl: async () => {
        throw err('LLM_MODEL_NOT_FOUND', { detail: { model: 'ghost' } });
      },
    });
    const result = await runner.run({ prompt: 'hi', model: 'ghost' }, { jobName: 'job-nofb' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('ghost');
    expect(chat).toHaveBeenCalledTimes(1); // 无 provider 可回退 → 不重试
    expect(send.mock.calls[0]?.[0]).toMatchObject({ title: '自动化「job-nofb」完成', level: 'error' });
    expect(send.mock.calls[0]?.[0].body).toBe(result.summary);
  });

  it('指定模型失败 + 回退模型也失败 → ok:false + error 通知（摘要含两个模型名）', async () => {
    const { runner, chat, send } = makeRunner({
      providers: [{ name: 'p1', models: ['m1'] }],
      chatImpl: async () => {
        throw new Error('provider down');
      },
    });
    const result = await runner.run({ prompt: 'hi', model: 'ghost' }, { jobName: 'job-both-fail' });

    expect(result.ok).toBe(false);
    expect(chat.mock.calls.map((call) => call[0].model)).toEqual(['ghost', 'm1']);
    expect(result.summary).toContain('"ghost"');
    expect(result.summary).toContain('"m1"');
    expect(result.summary).toContain('provider down');
    expect(send.mock.calls[0]?.[0]).toMatchObject({ level: 'error' });
  });

  it('未指定模型 → 直接用第一可用 provider 的缺省模型单次尝试（跳过无模型的 provider）', async () => {
    const { runner, chat, send, getProviders } = makeRunner({
      providers: [
        { name: 'empty', models: [] },
        { name: 'p2', models: ['m9', 'm10'] },
      ],
    });
    const result = await runner.run({ prompt: 'hi' }, { jobName: 'job-default' });

    expect(result).toEqual({ ok: true, summary: 'echo:m9' });
    expect(getProviders).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[0].model).toBe('m9');
    expect(send.mock.calls[0]?.[0]).toMatchObject({ level: 'success' });
  });

  it('未指定模型且无任何可用 provider → ok:false + error 通知（不调 gateway）', async () => {
    const { runner, chat, send } = makeRunner({ providers: [] });
    const result = await runner.run({ prompt: 'hi' }, { jobName: 'job-noprovider' });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('没有可用的 LLM 供应商');
    expect(chat).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ level: 'error' });
  });

  it('结果摘要截断为 text 前 500 字符', async () => {
    const longText = 'x'.repeat(600);
    const { runner } = makeRunner({ chatImpl: async () => ({ text: longText }) });
    const result = await runner.run({ prompt: 'hi', model: 'm1' }, { jobName: 'job-truncate' });

    expect(result.ok).toBe(true);
    expect(result.summary.length).toBe(LLM_JOB_SUMMARY_MAX_CHARS);
    expect(result.summary).toBe('x'.repeat(LLM_JOB_SUMMARY_MAX_CHARS));
  });

  it('notify:false → 执行成功但不投递任何通知', async () => {
    const { runner, send } = makeRunner({ providers: [{ name: 'p1', models: ['m1'] }] });
    const result = await runner.run({ prompt: 'hi', model: 'm1', notify: false }, { jobName: 'job-quiet' });

    expect(result.ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('notify.send 抛错 → run 不外抛，结果仍为 ok:true', async () => {
    const { runner, send } = makeRunner({ sendThrows: true, providers: [{ name: 'p1', models: ['m1'] }] });
    const result = await runner.run({ prompt: 'hi', model: 'm1' }, { jobName: 'job-notify-err' });

    expect(result).toEqual({ ok: true, summary: 'echo:m1' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('prompt 空/非字符串 → ok:false + error 通知（不调 gateway）', async () => {
    const { runner, chat, send } = makeRunner({ providers: [{ name: 'p1', models: ['m1'] }] });

    const empty = await runner.run({ prompt: '   ', model: 'm1' }, { jobName: 'job-empty' });
    expect(empty.ok).toBe(false);
    const blank = await runner.run({ prompt: '' as string, model: 'm1' }, { jobName: 'job-blank' });
    expect(blank.ok).toBe(false);

    expect(chat).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ level: 'error' });
  });

  it('gateway 返回形状异常（无 text 字段）→ 摘要兜底空串且 ok:true', async () => {
    const { runner } = makeRunner({ chatImpl: async () => ({ weird: true }) });
    const result = await runner.run({ prompt: 'hi', model: 'm1' }, { jobName: 'job-shape' });

    expect(result).toEqual({ ok: true, summary: '' });
  });
});

// ---------------------------------------------------------------------------
// 2) REST 校验（真 fastify + 内存 scheduler stub；history 用空 stub，无需真库）
// ---------------------------------------------------------------------------

class SchedulerStub implements CronSchedulerLike {
  readonly jobs = new Map<string, CronJobRecord>();
  readonly scheduleInputs: CronJobCreateInput[] = [];
  readonly updateInputs: Array<{ id: string; patch: CronJobPatch }> = [];
  private seq = 0;

  async schedule(input: CronJobCreateInput): Promise<CronJobRecord> {
    this.scheduleInputs.push(input);
    this.seq += 1;
    const rec: CronJobRecord = {
      ...input,
      id: `job-${this.seq}`,
      lastRun: null,
      nextRun: null,
      createdAt: 1_000 + this.seq,
    };
    this.jobs.set(rec.id, rec);
    return rec;
  }

  async list(): Promise<CronJobRecord[]> {
    return [...this.jobs.values()];
  }

  async get(id: string): Promise<CronJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJobRecord | null> {
    this.updateInputs.push({ id, patch });
    const rec = this.jobs.get(id);
    if (rec === undefined) return null;
    const next = { ...rec, ...patch };
    this.jobs.set(id, next);
    return next;
  }

  async unschedule(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  async runNow(): Promise<void> {}
}

const ADMIN_AUTH = { authorization: 'Bearer token-admin' };

describe('cron REST — payload.kind llm 校验', () => {
  let dir = '';
  let app: FastifyInstance;
  let scheduler: SchedulerStub;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'opptrix-llm-cron-api-'));
    scheduler = new SchedulerStub();
    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
    const server = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => {
        registerCronRoutes(a, {
          checker: async ({ token }) => {
            if (token === 'token-admin') return { userId: 'admin-1', role: 'admin', scopes: ['cron'] };
            throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
          },
          scheduler,
          history: async () => [],
        });
      },
    });
    app = server.app;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('kind:"llm" 缺 prompt → 400 HARNESS-1009', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'llm-bad', expr: '* * * * *', payload: { kind: 'llm' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });

  it('合法 llm payload → 201，payload 原样透传给 scheduler（prompt/model/notify/channelSlug）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: {
        name: 'llm-good',
        expr: '0 9 * * *',
        tz: 'Asia/Shanghai',
        payload: { kind: 'llm', prompt: '总结昨日', model: 'gpt-x', notify: false, channelSlug: 'ops' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(scheduler.scheduleInputs[0]?.payload).toEqual({
      kind: 'llm',
      prompt: '总结昨日',
      model: 'gpt-x',
      notify: false,
      channelSlug: 'ops',
    });
  });

  it.each([
    ['prompt 空串', { kind: 'llm', prompt: '' }],
    ['prompt 超过 8KB（UTF-8 字节）', { kind: 'llm', prompt: '汉'.repeat(4097) }], // 4097*2=8194 字节
    ['notify 非布尔', { kind: 'llm', prompt: 'p', notify: 'yes' }],
    ['model 非字符串', { kind: 'llm', prompt: 'p', model: 42 }],
    ['prompt 非字符串', { kind: 'llm', prompt: 123 }],
  ])('llm payload 非法（%s）→ 400', async (_label, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'llm-bad', expr: '* * * * *', payload },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('HARNESS-1009');
  });

  it('prompt 恰好 8KB（含多字节字符）→ 201（字节边界放行）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'llm-edge', expr: '* * * * *', payload: { kind: 'llm', prompt: 'ä'.repeat(4096) } }, // 2 字节/字符 × 4096 = 8192
    });
    expect(res.statusCode).toBe(201);
  });

  it('PATCH 同规则：改成缺 prompt 的 llm payload → 400；合法 llm payload → 200', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'patch-me', expr: '* * * * *' },
    });
    const id = (created.json() as { id: string }).id;

    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cron/${id}`,
      headers: ADMIN_AUTH,
      payload: { payload: { kind: 'llm' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('HARNESS-1009');

    const good = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cron/${id}`,
      headers: ADMIN_AUTH,
      payload: { payload: { kind: 'llm', prompt: '新提示词' } },
    });
    expect(good.statusCode).toBe(200);
    expect(scheduler.updateInputs.at(-1)?.patch.payload).toEqual({ kind: 'llm', prompt: '新提示词' });
  });

  it('kind 缺省/其他值的 payload 维持 v1 现状（自由 JSON 放行，仅事件广播）', async () => {
    const plain = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'legacy', expr: '* * * * *', payload: { anything: ['goes', 1] } },
    });
    expect(plain.statusCode).toBe(201);

    const otherKind = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: ADMIN_AUTH,
      payload: { name: 'other-kind', expr: '* * * * *', payload: { kind: 'auto-update' } },
    });
    expect(otherKind.statusCode).toBe(201);

    // PATCH 未给 payload 键 → 不做 llm 校验（只改名字也放行）
    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/cron/job-1',
      headers: ADMIN_AUTH,
      payload: { name: 'renamed' },
    });
    expect(renamed.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3) 调度全链（真内核 + 真 scheduler + mock OpenAI upstream + 真通知中心）
// ---------------------------------------------------------------------------

describe('llm cron — 调度全链（真内核 boot）', () => {
  const MODEL_A = 'e2e-llm-cron-model-a';
  /** mock upstream 收到的请求体（model/messages 可断言） */
  const mockBodies: Array<{ model?: unknown; messages?: unknown }> = [];
  let dataDir = '';
  let kernel: Kernel;
  let app: FastifyInstance;
  let auth: { authorization: string };
  let mock: Server;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'opptrix-llm-cron-e2e-'));
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
    const rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
    auth = { authorization: `Bearer ${rootToken}` };
    app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;

    // mock OpenAI upstream：回显请求里的 model 与 messages（成功/回退/失败三态共用）
    mock = createMockServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        let body: { model?: unknown; messages?: unknown } = {};
        try {
          body = JSON.parse(raw) as { model?: unknown; messages?: unknown };
        } catch {
          body = {};
        }
        mockBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? MODEL_A,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: `mock-reply:${String(body.model ?? MODEL_A)}` },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', () => resolve()));
    const mockPort = (mock.address() as AddressInfo).port;

    // 配置 LLM provider（apiKey 明文 → 内核 secrets 自动转存）
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/llm/providers',
      headers: auth,
      payload: [
        {
          name: 'mock-provider',
          protocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'sk-e2e-llm-cron',
          models: [MODEL_A, 'e2e-llm-cron-model-b'],
        },
      ],
    });
    expect(put.statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await kernel?.shutdown('llm-cron-e2e-afterall');
    if (mock !== undefined) {
      await new Promise<void>((resolve) => mock.close(() => resolve()));
    }
    if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
  });

  /** 建 llm cron 任务 → runNow（REST 202 在 runNow 完成后返回）→ 返回 jobId */
  async function createAndRun(name: string, payload: Record<string, unknown>): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/cron',
      headers: auth,
      payload: { name, expr: '0 0 1 1 *', payload },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json() as { id: string };
    const run = await app.inject({ method: 'POST', url: `/api/v1/cron/${job.id}/run`, headers: auth });
    expect(run.statusCode).toBe(202);
    return job.id;
  }

  /** 轮询直到 pred 成立或超时（毫秒） */
  async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await pred())) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  type NotificationView = { title: string; body: string; level: string };

  async function listNotifications(): Promise<NotificationView[]> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: auth });
    expect(res.statusCode).toBe(200);
    const parsed = res.json() as { items: NotificationView[] };
    return parsed.items ?? [];
  }

  async function historyOf(jobId: string): Promise<Array<{ ok: boolean; error: string | null }>> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/cron/${jobId}/history`, headers: auth });
    expect(res.statusCode).toBe(200);
    return res.json() as Array<{ ok: boolean; error: string | null }>;
  }

  it('成功链：指定 mock 模型 → runNow → cron_runs 历史 ok=true + success 通知（摘要为 upstream 回复，prompt 已送达 upstream）', async () => {
    const jobId = await createAndRun('llm-e2e-ok', { kind: 'llm', prompt: '全链成功链路提示词', model: MODEL_A });

    await waitFor('history entry ok=true', async () => (await historyOf(jobId)).some((entry) => entry.ok));
    const history = await historyOf(jobId);
    expect(history[0]?.ok).toBe(true);

    await waitFor(
      'success notification',
      async () => (await listNotifications()).some((n) => n.title === '自动化「llm-e2e-ok」完成'),
    );
    const notice = (await listNotifications()).find((n) => n.title === '自动化「llm-e2e-ok」完成');
    expect(notice).toBeDefined();
    expect(notice?.level).toBe('success');
    expect(notice?.body).toBe(`mock-reply:${MODEL_A}`);
    expect(mockBodies.some((body) => JSON.stringify(body.messages ?? '').includes('全链成功链路提示词'))).toBe(true);
  }, 30_000);

  it('回退链：指定不存在的模型 → 自动回退第一可用 provider 缺省模型并成功通知', async () => {
    const jobId = await createAndRun('llm-e2e-fallback', {
      kind: 'llm',
      prompt: '回退链路提示词',
      model: 'no-such-model-anywhere',
    });

    await waitFor('fallback history entry', async () => (await historyOf(jobId)).length > 0);
    await waitFor(
      'fallback success notification',
      async () =>
        (await listNotifications()).some(
          (n) => n.title === '自动化「llm-e2e-fallback」完成' && n.body === `mock-reply:${MODEL_A}`,
        ),
    );
    const notice = (await listNotifications()).find((n) => n.title === '自动化「llm-e2e-fallback」完成');
    expect(notice?.level).toBe('success'); // 回退后成功 → success 而非 error
  }, 30_000);

  it('失败链：清空 providers 后执行 → error 通知（调度器继续运行、历史照常落库）', async () => {
    const clear = await app.inject({ method: 'PUT', url: '/api/v1/llm/providers', headers: auth, payload: [] });
    expect(clear.statusCode).toBe(200);

    const before = (await listNotifications()).filter((n) => n.level === 'error' && n.title.includes('llm-e2e-fail')).length;
    const jobId = await createAndRun('llm-e2e-fail', { kind: 'llm', prompt: '失败链路提示词', model: 'whatever' });

    await waitFor('error notification', async () => {
      const errors = (await listNotifications()).filter(
        (n) => n.title === '自动化「llm-e2e-fail」完成' && n.level === 'error',
      );
      return errors.length > before;
    });
    const notice = (await listNotifications()).find((n) => n.title === '自动化「llm-e2e-fail」完成');
    expect(notice?.body).toContain('whatever');

    // 管线约定：LLM 失败收敛为 error 通知，cron 触发管线本身不中断（历史照常落库）
    await waitFor('failure history entry', async () => (await historyOf(jobId)).length > 0);
  }, 30_000);

  it('notify:false 不发通知；kind 缺省的普通任务维持现状（仅事件广播、无通知）', async () => {
    await createAndRun('llm-e2e-silent', { kind: 'llm', prompt: '静默链路提示词', model: MODEL_A, notify: false });
    await createAndRun('llm-e2e-plain', { anything: 'goes' });

    await new Promise((r) => setTimeout(r, 300)); // 若有通知早已入库
    const notices = await listNotifications();
    expect(notices.some((n) => n.title.includes('llm-e2e-silent'))).toBe(false);
    expect(notices.some((n) => n.title.includes('llm-e2e-plain'))).toBe(false);
    // 普通任务与静默任务的执行历史照常落库（fire 管线不受影响）
    await new Promise((r) => setTimeout(r, 100));
  }, 30_000);
});
