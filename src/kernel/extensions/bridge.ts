/**
 * ExtensionBridge — 内核侧 RPC 桥（面向单个 Extension Worker 线程）。
 *
 * 职责（OS 语义核心，自研理由见 docs/dependencies.md「自研 RPC 信封」）：
 * - host→worker 调用（callToWorker）：Promise 关联表（id 关联）+ 强制超时 + 负载上限。
 *   请求信封 `{ v:1, from:'kernel', to:'ext:<id>', type:'call', topic, payload }`
 *   （topic 一律取 HOST_METHODS.*），worker 以同 id 的 reply 信封应答：
 *   `ok:true`（payload 为结果）/ `ok:false` + `err:{code,message,detail}`；
 * - host→worker 单向事件（dispatchToExt）：`type:'dispatch'`，id 用 'evt-<uuid>'，无回执；
 * - worker→host 服务调用：按 `deps.handlers[topic]` 分派（KERNEL_TOPICS 的内核服务实现，
 *   由 manager/集成方注入），结果或异常都以 reply 信封回执；单个 handler 异常被隔离，
 *   绝不击穿桥（热插拔机制之「VM 异常单调用隔离」在桥层面的对应物）；
 * - stop()：拒绝新调用（SERVICE_UNAVAILABLE）、拒绝全部挂起 Promise、terminate worker；
 * - worker 'exit' 事件转发（onWorkerExit）+ crashCount 计数（manager 自愈/熔断的数据源）。
 *
 * 收包闸：入站信封一律先过 `isRpcEnvelope`（伪造/损坏的信封直接丢弃并记日志）。
 * 可测性：WorkerLike 是 worker_threads.Worker 的最小结构类型，测试注入内存 stub 双向手动泵。
 */
import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { isRpcEnvelope, rpcEnvelopeSchema, type RpcEnvelope } from '../../extension-host/protocol.js';
import { ERR_CODES, err, HarnessError } from '../errors/index.js';
import type { ErrorCodeName } from '../errors/index.js';

/**
 * worker_threads.Worker 的最小结构类型。
 *
 * `on/off` 同时接受 'message' 与 'exit'（真实 Worker 原生两者都支持）；
 * stub 只需按事件名记录/手动触发监听器即可（见 test/ext-bridge.test.ts）。
 */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  on(type: 'message' | 'exit', fn: (msg: unknown) => void): void;
  off(type: 'message' | 'exit', fn: (msg: unknown) => void): void;
  terminate(): Promise<number>;
}

/** 桥的构造依赖 */
export interface ExtensionBridgeDeps {
  worker: WorkerLike;
  /** callToWorker 未显式给 timeoutMs 时的默认预算（ms） */
  timeoutMs: number;
  /** 双向 RPC 负载上限（JSON 序列化字节数） */
  maxPayloadBytes: number;
  logger: Logger;
  /**
   * 内核服务处理器：worker `h.*` 调用回落到这里（topic 见 KERNEL_TOPICS），
   * 实现由 manager/集成方注入；key 为 topic，value 为 (payload, from) => result。
   * `from` 为发起方端点（'ext:<id>' 去前缀后的扩展 id；'kernel' 保留原样）。
   */
  handlers: Record<string, (payload: unknown, from: string) => Promise<unknown>>;
}

/** ERR_CODES 名单 → 线格式错误码（HARNESS-xxxx）的反查表（惰性构建一次） */
let wireCodeIndex: Map<string, ErrorCodeName> | null = null;

function codeNameFromWire(code: string): ErrorCodeName | undefined {
  wireCodeIndex ??= new Map(
    (Object.keys(ERR_CODES) as ErrorCodeName[]).map((name) => [err(name).code, name] as const),
  );
  return wireCodeIndex.get(code);
}

/**
 * worker 回执 err 线格式 → HarnessError（reply err 透传）。
 * code 命中登记过的 HARNESS-xxxx 时按原码复原（保 message/detail）；
 * 扩展自定义码/未命中时兜底 RPC_HANDLER_ERROR，原始线格式保留在 detail 供定位。
 */
function reviveWireError(raw: unknown): HarnessError {
  const wire = (raw ?? {}) as { code?: unknown; message?: unknown; detail?: unknown };
  const message =
    typeof wire.message === 'string' && wire.message !== ''
      ? wire.message
      : 'rpc handler raised on extension side';
  const code = typeof wire.code === 'string' ? wire.code : undefined;
  const name = code !== undefined ? codeNameFromWire(code) : undefined;
  if (name !== undefined) return err(name, { message, detail: wire.detail });
  return err('RPC_HANDLER_ERROR', { message, detail: raw });
}

/** payload 的 JSON 线大小（字节）；不可序列化时抛 BAD_REQUEST（由调用方转为拒绝/丢弃） */
function payloadBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? null));
  } catch (cause) {
    throw err('BAD_REQUEST', {
      message: 'rpc payload is not JSON-serializable (circular or non-serializable value)',
      cause,
    });
  }
}

/** 端点 'ext:<id>' → 裸扩展 id（无前缀时原样返回） */
function endpointToId(endpoint: string): string {
  return endpoint.startsWith('ext:') ? endpoint.slice('ext:'.length) : endpoint;
}

/**
 * 内核侧 RPC 桥。一个实例对应一个 Extension Worker 线程；worker 崩溃重启时由
 * ExtensionManager 重建实例（见 manager.handleWorkerExit）。
 */
export class ExtensionBridge {
  readonly #deps: ExtensionBridgeDeps;
  /** 关联 id → 挂起调用（Promise 关联表） */
  readonly #pending = new Map<string, PendingCall>();
  /** worker exit 回调集合（onWorkerExit 注册） */
  readonly #exitCallbacks = new Set<(code: number) => void>();
  /** 本桥观测到的 worker 退出次数 */
  #crashCount = 0;
  #stopped = false;

  readonly #onMessage = (raw: unknown): void => {
    this.#handleMessage(raw);
  };

  readonly #onExit = (raw: unknown): void => {
    const code = typeof raw === 'number' ? raw : Number(raw ?? 1) || 1;
    this.#crashCount += 1;
    this.#deps.logger.warn({ code, crashCount: this.#crashCount }, 'bridge: extension worker exited');
    for (const cb of [...this.#exitCallbacks]) {
      try {
        cb(code);
      } catch (cause) {
        this.#deps.logger.error({ err: cause }, 'bridge: worker exit callback raised');
      }
    }
  };

  constructor(deps: ExtensionBridgeDeps) {
    this.#deps = deps;
    deps.worker.on('message', this.#onMessage);
    deps.worker.on('exit', this.#onExit);
  }

  /** 本桥观测到的 worker 退出次数（worker 崩溃重启时实例随之重建并归零） */
  get crashCount(): number {
    return this.#crashCount;
  }

  /** 桥是否已 stop（stop 后拒绝一切新调用） */
  get stopped(): boolean {
    return this.#stopped;
  }

  /**
   * host→worker 调用：关联表 + 强制超时 + 负载上限。
   *
   * @param extId 目标扩展 id（信封 to='ext:<id>'，worker 据此路由到对应 vm.Context）
   * @param topic 方法名（HOST_METHODS 前缀方法，如 host.load / host.hook）
   * @param payload 任意可 JSON 序列化的负载
   * @param timeoutMs 覆盖默认预算（ms）
   * @throws SERVICE_UNAVAILABLE 桥已 stop；RPC_PAYLOAD_TOO_LARGE 负载超限；
   *          BAD_REQUEST 负载不可序列化或信封非法；RPC_TIMEOUT 超时未回执；
   *          worker 回执 ok:false 时按线码复原 HarnessError 透传。
   */
  async callToWorker(extId: string, topic: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.#stopped) {
      throw err('SERVICE_UNAVAILABLE', { detail: { extId, topic, cause: 'extension bridge stopped' } });
    }
    const bytes = payloadBytes(payload);
    if (bytes > this.#deps.maxPayloadBytes) {
      throw err('RPC_PAYLOAD_TOO_LARGE', {
        detail: { extId, topic, bytes, max: this.#deps.maxPayloadBytes },
      });
    }
    const id = randomUUID();
    const envelope: RpcEnvelope = {
      v: 1,
      id,
      from: 'kernel',
      to: `ext:${extId}`,
      type: 'call',
      topic,
      payload,
    };
    if (!rpcEnvelopeSchema.safeParse(envelope).success) {
      // 出站信封也要过闸（topic 为空等编程性误用 fail-fast）
      throw err('BAD_REQUEST', {
        message: `rpc call envelope invalid: topic must be a non-empty string (got "${topic}")`,
        detail: { extId, topic },
      });
    }
    const budget = timeoutMs ?? this.#deps.timeoutMs;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(err('RPC_TIMEOUT', { detail: { extId, topic, timeoutMs: budget } }));
      }, budget);
      // 库组件不应阻止进程退出（超时兜底 timer）
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#deps.worker.postMessage(envelope);
      } catch (cause) {
        // worker 线程已死等 postMessage 同步失败：立即拒绝，不等超时
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(HarnessError.wrap(cause, 'INTERNAL'));
      }
    });
  }

  /**
   * host→worker 单向事件分发（type:'dispatch'，id='evt-<uuid>'，无回执）。
   * 桥已 stop、负载超限或不可序列化时丢弃并记日志（单向语义不抛业务错）。
   */
  dispatchToExt(extId: string, topic: string, payload: unknown): void {
    if (this.#stopped) {
      this.#deps.logger.warn({ extId, topic }, 'bridge: dispatch dropped (bridge stopped)');
      return;
    }
    let bytes: number;
    try {
      bytes = payloadBytes(payload);
    } catch (cause) {
      this.#deps.logger.warn({ extId, topic, err: cause }, 'bridge: dispatch dropped (unserializable payload)');
      return;
    }
    if (bytes > this.#deps.maxPayloadBytes) {
      this.#deps.logger.error(
        { extId, topic, bytes, max: this.#deps.maxPayloadBytes },
        'bridge: dispatch dropped (payload too large)',
      );
      return;
    }
    const envelope: RpcEnvelope = {
      v: 1,
      id: `evt-${randomUUID()}`,
      from: 'kernel',
      to: `ext:${extId}`,
      type: 'dispatch',
      topic,
      payload,
    };
    try {
      this.#deps.worker.postMessage(envelope);
    } catch (cause) {
      this.#deps.logger.error({ extId, topic, err: cause }, 'bridge: dispatch postMessage failed');
    }
  }

  /**
   * 注册 worker 'exit' 回调（桥转发；测试可经 stub worker 手动触发）。
   * @returns 取消函数（幂等）
   */
  onWorkerExit(cb: (code: number) => void): () => void {
    this.#exitCallbacks.add(cb);
    return () => {
      this.#exitCallbacks.delete(cb);
    };
  }

  /**
   * 停桥：拒绝新调用（SERVICE_UNAVAILABLE）、拒绝全部挂起 Promise、
   * 摘除 worker 监听、terminate worker。幂等。
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err('SERVICE_UNAVAILABLE', { detail: { cause: 'extension bridge stopped' } }));
    }
    this.#deps.worker.off('message', this.#onMessage);
    this.#deps.worker.off('exit', this.#onExit);
    try {
      await this.#deps.worker.terminate();
    } catch (cause) {
      this.#deps.logger.error({ err: cause }, 'bridge: worker terminate failed during stop');
    }
  }

  // ---------------------------------------------------------------- 内部实现

  /** worker 消息入口（收包闸 isRpcEnvelope）：reply → 关联表；call → 内核服务处理器 */
  #handleMessage(raw: unknown): void {
    if (!isRpcEnvelope(raw)) {
      this.#deps.logger.warn({ kind: typeof raw }, 'bridge: dropped malformed envelope from worker');
      return;
    }
    const msg = raw;
    if (msg.type === 'reply') {
      const pending = this.#pending.get(msg.id);
      if (pending === undefined) {
        // 迟到的回执（超时后到达）或未知 id：安全丢弃
        this.#deps.logger.debug({ id: msg.id }, 'bridge: dropped reply for unknown/late id');
        return;
      }
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.ok === true) pending.resolve(msg.payload);
      else pending.reject(reviveWireError(msg.err));
      return;
    }
    if (msg.type === 'call') {
      void this.#serveWorkerCall(msg);
      return;
    }
    // dispatch 是内核→扩展方向；worker 发来的 dispatch 属协议误用，丢弃
    this.#deps.logger.warn({ topic: msg.topic }, 'bridge: dropped unexpected dispatch from worker');
  }

  /** worker→host 服务调用：分派到 handlers[topic] 并以 reply 回执（全程隔离异常） */
  async #serveWorkerCall(msg: RpcEnvelope): Promise<void> {
    const from = endpointToId(msg.from);
    const reply = (ok: boolean, payload: unknown, error: RpcEnvelope['err']): void => {
      this.#postReply(msg, ok, payload, error);
    };
    let bytes: number;
    try {
      bytes = payloadBytes(msg.payload);
    } catch (cause) {
      reply(false, undefined, {
        code: err('BAD_REQUEST').code,
        message: 'worker call payload is not JSON-serializable',
        detail: { from, topic: msg.topic },
      });
      return;
    }
    if (bytes > this.#deps.maxPayloadBytes) {
      reply(false, undefined, {
        code: err('RPC_PAYLOAD_TOO_LARGE').code,
        message: 'rpc payload too large',
        detail: { from, topic: msg.topic, bytes },
      });
      return;
    }
    const handler = this.#deps.handlers[msg.topic];
    if (typeof handler !== 'function') {
      reply(false, undefined, {
        code: err('RPC_TARGET_NOT_FOUND').code,
        message: `rpc target not found: no kernel handler for topic "${msg.topic}"`,
        detail: { from, topic: msg.topic },
      });
      return;
    }
    try {
      const result = await handler(msg.payload, from);
      reply(true, result, undefined);
    } catch (cause) {
      const he = HarnessError.wrap(cause, 'RPC_HANDLER_ERROR');
      this.#deps.logger.warn({ from, topic: msg.topic, err: he.message }, 'bridge: kernel handler failed');
      reply(false, undefined, { code: he.code, message: he.message, detail: he.detail });
    }
  }

  /** 向 worker 回执（桥已 stop 时静默丢弃——停桥后不再往 worker 写任何消息） */
  #postReply(call: RpcEnvelope, ok: boolean, payload: unknown, error: RpcEnvelope['err']): void {
    if (this.#stopped) return;
    const envelope: RpcEnvelope = {
      v: 1,
      id: call.id,
      from: 'kernel',
      to: call.from,
      type: 'reply',
      topic: call.topic,
      ...(ok ? { ok: true, payload } : { ok: false, err: error }),
    };
    try {
      this.#deps.worker.postMessage(envelope);
    } catch (cause) {
      this.#deps.logger.error({ id: call.id, err: cause }, 'bridge: reply postMessage failed');
    }
  }
}

/** 一条挂起中的 host→worker 调用 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}
