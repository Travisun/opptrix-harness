import { describe, expect, it } from 'vitest';

import {
  HOST_METHODS,
  KERNEL_TOPICS,
  isRpcEnvelope,
  rpcEnvelopeSchema,
  type RpcEnvelope,
} from '../src/extension-host/protocol.js';

/** 合法 call 信封基样例（每个用例按需覆写） */
function callEnvelope(overrides: Partial<RpcEnvelope> = {}): RpcEnvelope {
  return {
    v: 1,
    id: '0b9e6c1e-1111-4222-8333-444455556666',
    from: 'kernel',
    to: 'ext:hello-world',
    type: 'call',
    topic: HOST_METHODS.loadExt,
    payload: { manifestPath: '/x/manifest.json' },
    ...overrides,
  };
}

describe('isRpcEnvelope：合法信封', () => {
  it('内核→扩展 call（HOST_METHODS topic）通过', () => {
    const env = callEnvelope();
    expect(isRpcEnvelope(env)).toBe(true);
  });

  it('扩展→内核 call（KERNEL_TOPICS topic）通过', () => {
    const env = callEnvelope({
      from: 'ext:echo-bot',
      to: 'kernel',
      topic: KERNEL_TOPICS.dbAll,
      payload: { table: 'notes' },
    });
    expect(isRpcEnvelope(env)).toBe(true);
  });

  it('reply 成功（ok:true）与失败（ok:false + err）都通过', () => {
    expect(
      isRpcEnvelope(
        callEnvelope({ from: 'ext:echo-bot', to: 'kernel', type: 'reply', topic: KERNEL_TOPICS.log, ok: true, payload: undefined }),
      ),
    ).toBe(true);
    expect(
      isRpcEnvelope(
        callEnvelope({
          from: 'ext:echo-bot',
          to: 'kernel',
          type: 'reply',
          topic: KERNEL_TOPICS.dbAll,
          ok: false,
          payload: undefined,
          err: { code: 'HARNESS-4003', message: 'database error', detail: { table: 'notes' } },
        }),
      ),
    ).toBe(true);
  });

  it('dispatch（evt-<uuid> id、无 ok/err）通过', () => {
    const env = callEnvelope({
      id: 'evt-9f1c2b3a-0000-4aaa-bbbb-ccccddddeeee',
      type: 'dispatch',
      topic: 'chat.message.created',
      payload: { text: 'hi' },
    });
    expect(isRpcEnvelope(env)).toBe(true);
  });

  it('payload 可以是任意形状（对象/数组/原始值/undefined 缺省）', () => {
    for (const payload of [{ a: 1 }, [1, 2], 's', 0, false, null, undefined]) {
      expect(isRpcEnvelope(callEnvelope({ payload })), String(payload)).toBe(true);
    }
    const noPayload = callEnvelope();
    delete noPayload.payload;
    expect(isRpcEnvelope(noPayload)).toBe(true);
  });

  it('zod 往返：safeParse 输出与输入字段一一对应（剥离未知键）', () => {
    const env = callEnvelope();
    const parsed = rpcEnvelopeSchema.parse(JSON.parse(JSON.stringify(env)));
    expect(parsed).toEqual(env);
  });

  it('未知键被剥离（向前兼容：新版字段不炸旧内核）', () => {
    const parsed = rpcEnvelopeSchema.parse({ ...callEnvelope(), extraFutureField: 1 });
    expect(parsed).toEqual(callEnvelope());
    expect((parsed as Record<string, unknown>).extraFutureField).toBeUndefined();
  });
});

describe('isRpcEnvelope：拒收', () => {
  it('非对象输入（null/数字/字符串/数组）一律拒绝', () => {
    for (const bad of [null, undefined, 42, 'envelope', [], true]) {
      expect(isRpcEnvelope(bad), String(bad)).toBe(false);
    }
  });

  it('协议版本错误：缺 v / v !== 1', () => {
    const { v: _v, ...noV } = callEnvelope();
    expect(isRpcEnvelope(noV)).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ v: 2 as unknown as 1 }))).toBe(false);
  });

  it('id 缺失或空串拒绝', () => {
    const { id: _id, ...noId } = callEnvelope();
    expect(isRpcEnvelope(noId)).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ id: '' }))).toBe(false);
  });

  it('from/to 只认 kernel / ext:<任意后缀>，其余形状拒绝', () => {
    // 接口类型为 `ext:${string}`：'ext:' 之后允许任意后缀（id 本身的合法性由 manifest 层把关）
    const badEndpoints = ['ext', 'kernel:1', 'worker', 'EXT:abc', 'ext-x', 'kernel ', 7, null, ''];
    for (const bad of badEndpoints) {
      expect(
        isRpcEnvelope(callEnvelope({ from: bad as RpcEnvelope['from'] })),
        `from=${String(bad)}`,
      ).toBe(false);
      expect(
        isRpcEnvelope(callEnvelope({ to: bad as RpcEnvelope['to'] })),
        `to=${String(bad)}`,
      ).toBe(false);
    }
    expect(isRpcEnvelope(callEnvelope({ from: 'ext:hello-world' }))).toBe(true);
    expect(isRpcEnvelope(callEnvelope({ to: 'kernel' }))).toBe(true);
  });

  it('type 非法（缺省/未知值）拒绝', () => {
    const { type: _type, ...noType } = callEnvelope();
    expect(isRpcEnvelope(noType)).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ type: 'notify' as RpcEnvelope['type'] }))).toBe(false);
  });

  it('topic 缺失或空串拒绝', () => {
    const { topic: _topic, ...noTopic } = callEnvelope();
    expect(isRpcEnvelope(noTopic)).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ topic: '' }))).toBe(false);
  });

  it('reply.err 形状损坏（缺 code / 缺 message / 非对象）拒绝', () => {
    const base = { type: 'reply' as const, ok: false, payload: undefined };
    expect(isRpcEnvelope(callEnvelope({ ...base, err: { message: 'x' } } as RpcEnvelope))).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ ...base, err: { code: 'E1' } } as RpcEnvelope))).toBe(false);
    expect(isRpcEnvelope(callEnvelope({ ...base, err: 'boom' as unknown as RpcEnvelope['err'] }))).toBe(false);
    // 合法 err（仅 code+message，detail 缺省）应通过
    expect(isRpcEnvelope(callEnvelope({ ...base, err: { code: 'E1', message: 'x' } }))).toBe(true);
  });

  it('ok 非布尔拒绝', () => {
    expect(isRpcEnvelope(callEnvelope({ ok: 'yes' as unknown as boolean }))).toBe(false);
  });
});

describe('HOST_METHODS / KERNEL_TOPICS 契约', () => {
  it('HOST_METHODS 全量且值精确（内核→扩展线程的唯一入口名）', () => {
    expect(HOST_METHODS).toEqual({
      loadExt: 'host.load',
      unloadExt: 'host.unload',
      routeRequest: 'host.route',
      eventDispatch: 'host.event',
      hookApply: 'host.hook',
      cronFire: 'host.cron',
      callService: 'host.call',
      taskRun: 'host.task',
      authVerify: 'host.authVerify',
    });
  });

  it('KERNEL_TOPICS 全量且值精确（扩展→内核服务分发表）', () => {
    expect(KERNEL_TOPICS).toEqual({
      log: 'log',
      storageGet: 'storage.get',
      storageSet: 'storage.set',
      storageDelete: 'storage.delete',
      configGet: 'config.get',
      dbAll: 'db.all',
      dbGet: 'db.get',
      dbRun: 'db.run',
      dbSchema: 'db.schema',
      notifySend: 'notify.send',
      chatSend: 'chat.send',
      chatPatch: 'chat.patch',
      filesSave: 'files.save',
      filesRead: 'files.read',
      filesGet: 'files.get',
      tasksDispatch: 'tasks.dispatch',
      taskProgress: 'task.progress',
      taskComplete: 'task.complete',
      taskFail: 'task.fail',
      cronSchedule: 'cron.schedule',
      cronUnschedule: 'cron.unschedule',
      uiRegister: 'ui.register',
      llmChat: 'llm.chat',
      sandboxExec: 'sandbox.exec',
      systemInfo: 'system.info',
      systemStats: 'system.stats',
      // 出站 HTTP（内核 fetch 代理 + SSRF 防护；需 net:out / net:out:<host>）
      httpFetch: 'http.fetch',
      // ---- Skills / MCP / 插件（OS 能力目录）----
      skillsList: 'skills.list',
      skillsGet: 'skills.get',
      skillsRefresh: 'skills.refresh',
      skillsRegister: 'skills.register',
      mcpServersList: 'mcp.servers.list',
      mcpServerAdd: 'mcp.servers.add',
      mcpServerRemove: 'mcp.servers.remove',
      mcpToolsList: 'mcp.tools.list',
      mcpToolsCall: 'mcp.tools.call',
      mcpResourcesList: 'mcp.resources.list',
      mcpResourcesRead: 'mcp.resources.read',
      mcpPromptsList: 'mcp.prompts.list',
      mcpPromptsGet: 'mcp.prompts.get',
      pluginsList: 'plugins.list',
  extractFile: 'extract.file',
  extractStatus: 'extract.status',
  memorySearch: 'memory.search',
  memoryAdd: 'memory.add',
  memoryExtract: 'memory.extract',
  memoryList: 'memory.list',
  memoryForget: 'memory.forget',
  asrStatus: 'asr.status',
  asrTranscribe: 'asr.transcribe',
      // ---- auth 内置扩展支撑（auth:provider）----
      authHashToken: 'auth.hashToken',
      authTotpGenerate: 'auth.totpGenerate',
      authTotpVerify: 'auth.totpVerify',
      authVerifyRootToken: 'auth.verifyRootToken',
      authHashPassword: 'auth.hashPassword',
      authVerifyPassword: 'auth.verifyPassword',
      authRegisterProvider: 'auth.registerProvider',
      authUnregisterProvider: 'auth.unregisterProvider',
    });
  });

  it('两族 topic 无交集且无前缀串线（host.* 只属内核入口，其余只属扩展调用）', () => {
    const hostValues = new Set(Object.values(HOST_METHODS));
    const kernelValues = Object.values(KERNEL_TOPICS);
    for (const t of kernelValues) {
      expect(hostValues.has(t as never), t).toBe(false);
    }
    for (const t of hostValues) {
      expect(t.startsWith('host.'), t).toBe(true);
    }
  });

  it('isRpcEnvelope 类型守卫收窄后可安全读写字段', () => {
    const raw: unknown = callEnvelope({ topic: KERNEL_TOPICS.storageGet });
    if (isRpcEnvelope(raw)) {
      expect(raw.v).toBe(1);
      expect(raw.to.startsWith('ext:')).toBe(true);
    } else {
      expect.unreachable('合法信封不应被拒');
    }
  });
});
