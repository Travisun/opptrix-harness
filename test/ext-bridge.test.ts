/**
 * ExtensionBridge 契约测试：内存 WorkerLike stub 双向手动泵。
 *
 * 覆盖：call 关联 / 超时（RPC_TIMEOUT）/ 负载上限（RPC_PAYLOAD_TOO_LARGE）/
 * reply err 透传（登记码复原 + 扩展自定义码兜底）/ dispatch 单向（evt-<uuid>）/
 * worker→host 服务调用分派与异常隔离 / 收包闸（坏信封丢弃）/ stop 语义
 * （SERVICE_UNAVAILABLE + 拒绝挂起 + terminate）/ exit 转发与 crashCount / 迟到回执安全。
 */
import { describe, expect, it } from 'vitest';
import pino from 'pino';

import type { RpcEnvelope } from '../src/extension-host/protocol.js';
import { HOST_METHODS } from '../src/extension-host/protocol.js';
import { err } from '../src/kernel/errors/index.js';
import { ExtensionBridge, type ExtensionBridgeDeps, type WorkerLike } from '../src/kernel/extensions/bridge.js';

const logger = pino({ level: 'silent' });

/** 等待一个宏任务（stub 的自动回执经 setTimeout(0) 投递） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 内存 WorkerLike stub：双向手动泵（测试直接 emitMessage/emitExit 驱动桥） */
interface WorkerStub extends WorkerLike {
  /** host→worker 的全部出站信封（按序） */
  sent: RpcEnvelope[];
  /** 桥是否已 off 全部监听 */
  detached: boolean;
  terminated: boolean;
  emitMessage(msg: unknown): void;
  emitExit(code: number): void;
}

function createWorkerStub(): WorkerStub {
  const listeners = new Set<(msg: unknown) => void>();
  const exitListeners = new Set<(code: number) => void>();
  const stub: WorkerStub = {
    sent: [],
    detached: false,
    terminated: false,
    postMessage(msg: unknown) {
      stub.sent.push(msg as RpcEnvelope);
    },
    on(type, fn) {
      (type === 'exit' ? exitListeners : listeners).add(fn);
    },
    off(type, fn) {
      (type === 'exit' ? exitListeners : listeners).delete(fn);
      if (listeners.size === 0 && exitListeners.size === 0) stub.detached = true;
    },
    async terminate() {
      stub.terminated = true;
      return 0;
    },
    emitMessage(msg: unknown) {
      for (const fn of [...listeners]) fn(msg);
    },
    emitExit(code: number) {
      for (const fn of [...exitListeners]) fn(code);
    },
  };
  return stub;
}

function makeBridge(over: Partial<ExtensionBridgeDeps> = {}): { worker: WorkerStub; bridge: ExtensionBridge } {
  const worker = createWorkerStub();
  const bridge = new ExtensionBridge({
    worker,
    timeoutMs: 200,
    maxPayloadBytes: 1024,
    logger,
    handlers: {},
    ...over,
  });
  return { worker, bridge };
}

/** 测试侧替 worker 回执一次成功（同 id 关联） */
function replyOk(worker: WorkerStub, call: RpcEnvelope, payload: unknown): void {
  worker.emitMessage({
    v: 1,
    id: call.id,
    from: call.to,
    to: 'kernel',
    type: 'reply',
    topic: call.topic,
    ok: true,
    payload,
  });
}

/** 测试侧替 worker 回执一次失败 */
function replyErr(worker: WorkerStub, call: RpcEnvelope, code: string, message: string, detail?: unknown): void {
  worker.emitMessage({
    v: 1,
    id: call.id,
    from: call.to,
    to: 'kernel',
    type: 'reply',
    topic: call.topic,
    ok: false,
    err: { code, message, detail },
  });
}

/** 取出桥发出的第 n 条 call 信封 */
function sentCall(worker: WorkerStub, index = 0): RpcEnvelope {
  const env = worker.sent[index];
  expect(env, `expected an outgoing envelope at #${index}`).toBeDefined();
  expect(env?.type).toBe('call');
  return env as RpcEnvelope;
}

describe('ExtensionBridge', () => {
  it('call 关联：id 关联回执并 resolve payload；出站信封符合协议', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.callToWorker('hello', HOST_METHODS.loadExt, { id: 'hello' });
    const call = sentCall(worker);
    expect(call.v).toBe(1);
    expect(call.from).toBe('kernel');
    expect(call.to).toBe('ext:hello');
    expect(call.topic).toBe(HOST_METHODS.loadExt);
    expect(call.id).toBeTruthy();
    expect(call.payload).toEqual({ id: 'hello' });

    replyOk(worker, call, { contributions: { routes: [] } });
    await expect(pending).resolves.toEqual({ contributions: { routes: [] } });
  });

  it('超时：worker 不回执 → RPC_TIMEOUT（HARNESS-2001），detail 带 extId/topic', async () => {
    const { worker, bridge } = makeBridge({ timeoutMs: 20 });
    await expect(bridge.callToWorker('sleepy', 'host.route', {})).rejects.toMatchObject({
      code: err('RPC_TIMEOUT').code,
      detail: { extId: 'sleepy', topic: 'host.route' },
    });
    expect(worker.sent).toHaveLength(1);
  });

  it('负载上限：超限 → RPC_PAYLOAD_TOO_LARGE 且不产生出站消息', async () => {
    const { worker, bridge } = makeBridge({ maxPayloadBytes: 16 });
    await expect(bridge.callToWorker('a', 'host.route', { blob: 'x'.repeat(64) })).rejects.toMatchObject({
      code: err('RPC_PAYLOAD_TOO_LARGE').code,
    });
    expect(worker.sent).toHaveLength(0);
  });

  it('不可序列化 payload → BAD_REQUEST 拒绝', async () => {
    const { bridge } = makeBridge();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(bridge.callToWorker('a', 'host.route', circular)).rejects.toMatchObject({
      code: err('BAD_REQUEST').code,
    });
  });

  it('reply err 透传：登记码（HARNESS-xxxx）按原码复原，message/detail 保留', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.callToWorker('guarded', 'host.route', { q: 1 });
    const call = sentCall(worker);
    replyErr(worker, call, err('RPC_PERMISSION_DENIED').code, 'scope missing', { scope: 'x' });
    await expect(pending).rejects.toMatchObject({
      code: err('RPC_PERMISSION_DENIED').code,
      message: 'scope missing',
      detail: { scope: 'x' },
    });
  });

  it('reply err 透传：扩展自定义码未登记 → 兜底 RPC_HANDLER_ERROR 且原始线格式进 detail', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.callToWorker('b', 'host.route', {});
    const call = sentCall(worker);
    replyErr(worker, call, 'EXT_CUSTOM_42', 'boom');
    await expect(pending).rejects.toMatchObject({
      code: err('RPC_HANDLER_ERROR').code,
      message: 'boom',
      detail: { code: 'EXT_CUSTOM_42', message: 'boom' },
    });
  });

  it('dispatch 单向：type=dispatch、id 前缀 evt-、payload 原样透传', () => {
    const { worker, bridge } = makeBridge();
    bridge.dispatchToExt('chat', 'chat.message', { text: 'hi' });
    expect(worker.sent).toHaveLength(1);
    const env = worker.sent[0] as RpcEnvelope;
    expect(env.type).toBe('dispatch');
    expect(env.id.startsWith('evt-')).toBe(true);
    expect(env.to).toBe('ext:chat');
    expect(env.topic).toBe('chat.message');
    expect(env.payload).toEqual({ text: 'hi' });
  });

  it('worker→host 服务调用：按 handlers[topic] 分派并以 reply(ok) 回执，from 为裸扩展 id', async () => {
    const handlerCalls: Array<{ payload: unknown; from: string }> = [];
    const { worker, bridge } = makeBridge({
      handlers: {
        'kv.get': async (payload, from) => {
          handlerCalls.push({ payload, from });
          return { got: payload };
        },
      },
    });
    worker.emitMessage({
      v: 1,
      id: 'w-1',
      from: 'ext:docsvc',
      to: 'kernel',
      type: 'call',
      topic: 'kv.get',
      payload: { key: 'k' },
    });
    await flush();
    expect(handlerCalls).toEqual([{ payload: { key: 'k' }, from: 'docsvc' }]);
    const reply = worker.sent[0] as RpcEnvelope;
    expect(reply.type).toBe('reply');
    expect(reply.ok).toBe(true);
    expect(reply.payload).toEqual({ got: { key: 'k' } });
    expect(reply.to).toBe('ext:docsvc');
  });

  it('worker→host 未知 topic → reply(ok:false) RPC_TARGET_NOT_FOUND', async () => {
    const { worker, bridge } = makeBridge();
    worker.emitMessage({
      v: 1,
      id: 'w-2',
      from: 'ext:a',
      to: 'kernel',
      type: 'call',
      topic: 'nope.topic',
      payload: null,
    });
    await flush();
    const reply = worker.sent[0] as RpcEnvelope;
    expect(reply.ok).toBe(false);
    expect(reply.err?.code).toBe(err('RPC_TARGET_NOT_FOUND').code);
  });

  it('worker→host handler 抛错被隔离：登记码透传、普通异常规整为 RPC_HANDLER_ERROR，桥不击穿', async () => {
    const { worker, bridge } = makeBridge({
      handlers: {
        'ok.topic': async () => {
          throw err('EXT_DB_QUOTA', { detail: { quota: 1 } });
        },
        'raw.topic': async () => {
          throw new Error('raw failure');
        },
      },
    });
    worker.emitMessage({ v: 1, id: 'w-3', from: 'ext:a', to: 'kernel', type: 'call', topic: 'ok.topic' });
    worker.emitMessage({ v: 1, id: 'w-4', from: 'ext:a', to: 'kernel', type: 'call', topic: 'raw.topic' });
    await flush();
    const first = worker.sent[0] as RpcEnvelope;
    expect(first.ok).toBe(false);
    expect(first.err?.code).toBe(err('EXT_DB_QUOTA').code);
    const second = worker.sent[1] as RpcEnvelope;
    expect(second.ok).toBe(false);
    expect(second.err?.code).toBe(err('RPC_HANDLER_ERROR').code);
    expect(second.err?.message).toBe('raw failure');
  });

  it('worker→host 负载上限：超限直接回 RPC_PAYLOAD_TOO_LARGE，不调用 handler', async () => {
    let called = 0;
    const { worker, bridge } = makeBridge({
      maxPayloadBytes: 16,
      handlers: {
        'kv.get': async () => {
          called += 1;
          return null;
        },
      },
    });
    worker.emitMessage({
      v: 1,
      id: 'w-5',
      from: 'ext:a',
      to: 'kernel',
      type: 'call',
      topic: 'kv.get',
      payload: { blob: 'x'.repeat(64) },
    });
    await flush();
    expect(called).toBe(0);
    const reply = worker.sent[0] as RpcEnvelope;
    expect(reply.ok).toBe(false);
    expect(reply.err?.code).toBe(err('RPC_PAYLOAD_TOO_LARGE').code);
  });

  it('收包闸：伪造/损坏信封被丢弃，不触发 handler 也不回执', async () => {
    let called = 0;
    const { worker, bridge } = makeBridge({
      handlers: {
        'kv.get': async () => {
          called += 1;
          return null;
        },
      },
    });
    worker.emitMessage({ garbage: true });
    worker.emitMessage({
      v: 2,
      id: 'w-6',
      from: 'ext:a',
      to: 'kernel',
      type: 'call',
      topic: 'kv.get',
    });
    worker.emitMessage({
      v: 1,
      id: '',
      from: 'ext:a',
      to: 'kernel',
      type: 'call',
      topic: 'kv.get',
    });
    expect(called).toBe(0);
    expect(worker.sent).toHaveLength(0);
  });

  it('stop：拒绝挂起 Promise 与新调用（SERVICE_UNAVAILABLE）、terminate worker、摘除监听', async () => {
    const { worker, bridge } = makeBridge();
    const pending = bridge.callToWorker('a', 'host.route', {});
    const stopping = bridge.stop();
    await expect(pending).rejects.toMatchObject({ code: err('SERVICE_UNAVAILABLE').code });
    await stopping;
    await expect(bridge.callToWorker('a', 'host.route', {})).rejects.toMatchObject({
      code: err('SERVICE_UNAVAILABLE').code,
    });
    expect(worker.terminated).toBe(true);
    expect(worker.detached).toBe(true);
    expect(bridge.stopped).toBe(true);
    // stop 后 dispatch 静默丢弃
    bridge.dispatchToExt('a', 'chat.message', {});
    expect(worker.sent).toHaveLength(1); // 仅 stop 前那条 call
  });

  it('stop 幂等：重复 stop 不再 terminate/拒绝', async () => {
    const { worker, bridge } = makeBridge();
    await bridge.stop();
    await bridge.stop();
    expect(worker.terminated).toBe(true);
  });

  it('worker exit 转发：onWorkerExit 回调带退出码、crashCount 递增、可退订', () => {
    const { worker, bridge } = makeBridge();
    const seen: number[] = [];
    const off = bridge.onWorkerExit((code) => seen.push(code));
    worker.emitExit(7);
    expect(seen).toEqual([7]);
    expect(bridge.crashCount).toBe(1);
    off();
    worker.emitExit(7);
    expect(seen).toEqual([7]);
    expect(bridge.crashCount).toBe(2);
  });

  it('迟到回执：超时拒绝后到达的 reply 被安全丢弃（不影响后续调用）', async () => {
    const { worker, bridge } = makeBridge({ timeoutMs: 20 });
    await expect(bridge.callToWorker('late', 'host.route', {})).rejects.toMatchObject({
      code: err('RPC_TIMEOUT').code,
    });
    // 迟到回执（超时后才到达）——不得击穿桥或误 resolve 他人
    worker.emitMessage({
      v: 1,
      id: (worker.sent[0] as RpcEnvelope).id,
      from: 'ext:late',
      to: 'kernel',
      type: 'reply',
      topic: 'host.route',
      ok: true,
      payload: 'ghost',
    });
    // 后续调用不受迟到回执影响
    const next = bridge.callToWorker('late', 'host.route', { n: 2 });
    replyOk(worker, sentCall(worker, 1), 'fine');
    await expect(next).resolves.toBe('fine');
  });
});
