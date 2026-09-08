import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';

import { extractToken } from '../../auth/authProxy.js';
import type { AuthIdentity, AuthVerifyInput } from '../../auth/types.js';
import { err, HarnessError } from '../../errors/HarnessError.js';

/** 默认心跳间隔（毫秒）：SSE 注释行保活 */
const DEFAULT_HEARTBEAT_MS = 15_000;
/** 单 topic 订阅数上限（默认） */
const DEFAULT_MAX_CLIENTS_PER_TOPIC = 200;
/** 默认挂载路径 */
const DEFAULT_PATH = '/api/v1/stream';
/** 单连接 topic 数上限 */
const MAX_TOPICS_PER_CONNECTION = 16;
/** 单个 topic 名长度上限 */
const MAX_TOPIC_NAME_LENGTH = 128;
/** 每 topic 重放环形缓冲条数上限（默认） */
const DEFAULT_REPLAY_BUFFER_PER_TOPIC = 100;
/** 重放缓冲覆盖的 topic 数上限：超出按最久未发布淘汰（防动态 topic 撑爆内存） */
const MAX_REPLAY_TOPICS = 256;

export interface SseHubDeps {
  /** 统一认证入口（authProxy.createAuthChecker 的产物） */
  checker: (input: AuthVerifyInput) => Promise<AuthIdentity>;
  /** 心跳间隔毫秒数；默认 15000 */
  heartbeatMs?: number;
  /** 单 topic 订阅数上限；默认 200 */
  maxClientsPerTopic?: number;
  /** 是否启用 Last-Event-ID 断线重放；默认 true。false 时与旧版行为完全一致（不缓冲、不重放、无 replay-gap） */
  replay?: boolean;
  /** 每 topic 重放环形缓冲条数上限；默认 100（0 = 不缓冲，游标一律触发 replay-gap） */
  replayBufferPerTopic?: number;
  /** kernel logger（可选；用于服务端记录 checker 异常与 publish 序列化失败，客户端不泄露细节） */
  logger?: Logger;
}

/** SSE query 契约：topics/token/lastEventId 均须为字符串（重复参数产生的数组等形状一律 400） */
const sseQuerySchema = z.object({
  topics: z.string().optional(),
  token: z.string().optional(),
  lastEventId: z.string().optional(),
});

interface SseClient {
  /** 订阅的 topic 列表 */
  topics: string[];
  raw: ServerResponse;
  heartbeat: NodeJS.Timeout | undefined;
  detached: boolean;
}

/** 重放缓冲条目：发布时序列化好的帧载荷（data 为 JSON 字符串，重放时零开销） */
interface ReplayEvent {
  seq: number;
  event: string;
  data: string;
}

/**
 * SSE Hub（含 Last-Event-ID 断线重放）。
 *
 * - 挂载 `GET <path>`（默认 `/api/v1/stream`）：query.topics 逗号分隔，缺省 'system'；
 *   query 经 zod 校验（topics/token/lastEventId 须为字符串）→ 否则 400 BAD_REQUEST；
 *   单连接 topic 数 >16 或单个 topic 名 >128 字符 → 400 BAD_REQUEST；
 *   认证失败 → 401 HarnessError JSON；topic 订阅超额 → 429 RATE_LIMITED（附 Retry-After: 5）。
 * - checker 抛出的非 HarnessError 异常一律以 INTERNAL（无原始 message）回给客户端，
 *   原始错误仅记服务端日志。
 * - 响应 text/event-stream，按 heartbeatMs 写注释行 `: ping\n\n` 保活。
 * - publish 写标准帧：`id: <topic自增seq>\nevent: <event>\ndata: <JSON>\n\n`；
 *   data 无法 JSON 序列化时记日志并跳过该事件（不崩连接，不占序列）。
 * - 断线重放（replay 开启时，默认）：每 topic 维护环形缓冲（replayBufferPerTopic 条，默认 100），
 *   无订阅者也照常入缓冲；连接可经 query `lastEventId=topic:seq,...`（多 topic）或标准
 *   `Last-Event-ID` 头（单 topic 裸 seq；亦接受 `topic:seq`）携带游标，重放 seq 更新的缓冲事件
 *   （每帧前置注释行 `: replay`）；游标超前/过旧 → 先回 `event: replay-gap`（data 含 latestSeq）
 *   再进实时流。缓冲为内存态，进程重启即失。
 * - 连接关闭自动清理；close() 结束全部客户端连接（幂等）。
 */
export class SseHub {
  readonly #checker: SseHubDeps['checker'];
  readonly #heartbeatMs: number;
  readonly #maxClientsPerTopic: number;
  readonly #replay: boolean;
  readonly #replayBufferPerTopic: number;
  readonly #logger: Logger | undefined;
  /** topic → 订阅客户端集合 */
  readonly #topics = new Map<string, Set<SseClient>>();
  /** topic → 自增序列（帧 id；replay 开启时无订阅者也前移） */
  readonly #topicSeq = new Map<string, number>();
  /** topic → 重放环形缓冲（seq 升序；Map 迭代序 = 最近发布序，用于淘汰最久未发布的 topic） */
  readonly #replayBuffers = new Map<string, ReplayEvent[]>();
  /** 全部存活客户端（clientCount() 无参时去重计数用） */
  readonly #clients = new Set<SseClient>();
  #attached = false;

  constructor(deps: SseHubDeps) {
    this.#checker = deps.checker;
    this.#heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#maxClientsPerTopic = deps.maxClientsPerTopic ?? DEFAULT_MAX_CLIENTS_PER_TOPIC;
    this.#replay = deps.replay ?? true;
    this.#replayBufferPerTopic = Math.max(0, Math.floor(deps.replayBufferPerTopic ?? DEFAULT_REPLAY_BUFFER_PER_TOPIC));
    this.#logger = deps.logger;
  }

  /** 向 Fastify 实例挂载 SSE 端点；重复 attach 抛 INTERNAL */
  attach(app: FastifyInstance, path: string = DEFAULT_PATH): void {
    if (this.#attached) {
      throw err('INTERNAL', { message: `SseHub already attached (path: ${path})` });
    }
    this.#attached = true;
    app.get(path, (req: FastifyRequest, reply: FastifyReply) => {
      void this.#handle(req, reply);
    });
    app.addHook('onClose', async () => {
      await this.close();
    });
  }

  /** 向 topic 广播事件帧；replay 关闭且无订阅者时为 no-op（序列不前移） */
  publish(topic: string, event: string, data: unknown): void {
    const subscribers = this.#topics.get(topic);
    let payload: string;
    try {
      payload = JSON.stringify(data) ?? 'null';
    } catch (e) {
      // 序列化失败（如循环引用）：记日志并跳过该事件，不影响连接与其余事件
      this.#logger?.warn({ err: e, topic, event }, '[sse] publish data not serializable; event skipped');
      return;
    }
    if (this.#replay) {
      // 无订阅者也照常占序列并入缓冲：断连窗口内的事件重连后可重放
      const seq = (this.#topicSeq.get(topic) ?? 0) + 1;
      this.#topicSeq.set(topic, seq);
      this.#bufferEvent(topic, { seq, event, data: payload });
      this.#writeFrame(subscribers, `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
      return;
    }
    // replay 关闭：保持既有语义——无订阅者直接 no-op、序列不前移
    if (subscribers === undefined || subscribers.size === 0) return;
    const seq = (this.#topicSeq.get(topic) ?? 0) + 1;
    this.#topicSeq.set(topic, seq);
    this.#writeFrame(subscribers, `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
  }

  /** 订阅数：带 topic 返回该 topic 订阅数；不带返回全部去重客户端数 */
  clientCount(topic?: string): number {
    if (topic !== undefined) return this.#topics.get(topic)?.size ?? 0;
    return this.#clients.size;
  }

  /** 向订阅集合写帧（集合为空/undefined 即 no-op）；写失败由 'close' 事件统一清理 */
  #writeFrame(subscribers: Set<SseClient> | undefined, frame: string): void {
    if (subscribers === undefined || subscribers.size === 0) return;
    for (const client of subscribers) {
      try {
        if (!client.raw.destroyed && client.raw.writable) client.raw.write(frame);
      } catch {
        // 写失败的连接由 'close' 事件统一清理
      }
    }
  }

  /** 追加重放缓冲（环形：超 replayBufferPerTopic 挤掉最旧）；同步维护 topic LRU 淘汰序 */
  #bufferEvent(topic: string, entry: ReplayEvent): void {
    let buffer = this.#replayBuffers.get(topic);
    if (buffer === undefined) {
      // 动态 topic（如 chat:<slug>）可能无限增多：缓冲 topic 数超上限按最久未发布淘汰，防内存失控
      while (this.#replayBuffers.size >= MAX_REPLAY_TOPICS) {
        const oldestTopic = this.#replayBuffers.keys().next().value;
        if (oldestTopic === undefined) break;
        this.#replayBuffers.delete(oldestTopic);
      }
      buffer = [];
      this.#replayBuffers.set(topic, buffer);
    } else {
      // 触碰 LRU 顺序（Map 迭代序 = 插入序）：先删后插移到队尾
      this.#replayBuffers.delete(topic);
      this.#replayBuffers.set(topic, buffer);
    }
    buffer.push(entry);
    if (buffer.length > this.#replayBufferPerTopic) {
      buffer.splice(0, buffer.length - this.#replayBufferPerTopic);
    }
  }

  /**
   * 解析断线重放游标：query `lastEventId`（逗号分隔 `topic:seq` 列表）与标准 `Last-Event-ID` 头。
   * 头先应用、query 后应用（同 topic 时显式 query 契约优先）；非法条目忽略（不报错——
   * 保证 EventSource 自动重连永不因游标被 400）。裸数字条目（EventSource 回发的帧 id）
   * 仅单 topic 订阅可归属。返回 topic → seq。
   */
  #parseCursors(headerValue: string | undefined, queryValue: string | undefined, topics: string[]): Map<string, number> {
    const cursors = new Map<string, number>();
    const apply = (value: string | undefined): void => {
      if (value === undefined || value === '') return;
      for (const entry of value.split(',')) this.#applyCursorEntry(entry, topics, cursors);
    };
    apply(headerValue);
    apply(queryValue);
    return cursors;
  }

  /** 解析单条游标条目（`topic:seq` 或裸数字）；非法即忽略（topic 名可含冒号，取最后一个冒号） */
  #applyCursorEntry(entry: string, topics: string[], cursors: Map<string, number>): void {
    const trimmed = entry.trim();
    if (trimmed === '') return;
    let topic: string | undefined;
    let seqText: string | undefined;
    const sep = trimmed.lastIndexOf(':');
    if (sep > 0 && sep < trimmed.length - 1) {
      topic = trimmed.slice(0, sep);
      seqText = trimmed.slice(sep + 1);
    } else if (/^\d+$/.test(trimmed)) {
      if (topics.length !== 1) return; // 裸数字在多 topic 订阅下无法归属 → 忽略
      topic = topics[0];
      seqText = trimmed;
    }
    if (topic === undefined || seqText === undefined || !/^\d+$/.test(seqText)) return;
    cursors.set(topic, Number(seqText));
  }

  /**
   * 按游标重放或提示缺口（在注册实时订阅之后同步调用：重放与实时衔接之间无事件缝隙、不重复）：
   * - 游标超前（如服务端重启序列重置）或所需事件已被挤出缓冲 → 先回一帧
   *   `event: replay-gap`（data: {topic, latestSeq}），不做部分重放，由客户端 REST 对账；
   * - 否则按序重放缓冲中 seq > 游标的事件，每帧前置注释行 `: replay`。
   */
  #writeReplay(topic: string, cursor: number, raw: ServerResponse): void {
    const latest = this.#topicSeq.get(topic) ?? 0;
    const buffer = this.#replayBuffers.get(topic);
    const first = buffer !== undefined ? buffer[0] : undefined;
    const oldest = first !== undefined ? first.seq : latest + 1;
    if (cursor > latest || cursor + 1 < oldest) {
      try {
        if (!raw.destroyed && raw.writable) {
          raw.write(`event: replay-gap\ndata: ${JSON.stringify({ topic, latestSeq: latest })}\n\n`);
        }
      } catch {
        // 连接已坏由 'close' 事件统一清理
      }
      return;
    }
    if (buffer === undefined) return;
    for (const entry of buffer) {
      if (entry.seq <= cursor) continue;
      try {
        if (!raw.destroyed && raw.writable) {
          raw.write(`: replay\nid: ${entry.seq}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`);
        }
      } catch {
        // 连接已坏由 'close' 事件统一清理
      }
    }
  }

  /** 结束全部客户端连接并清理（幂等，可安全重复调用/与 onClose 钩子叠加） */
  async close(): Promise<void> {
    for (const client of [...this.#clients]) {
      this.#detach(client);
      try {
        client.raw.end();
      } catch {
        // 已销毁的连接忽略
      }
    }
    this.#topics.clear();
  }

  /** 以 HarnessError 形状回写错误响应（含可选自定义响应头，如 Retry-After） */
  #sendError(reply: FastifyReply, e: HarnessError): void {
    if (e.headers !== undefined) {
      for (const [name, value] of Object.entries(e.headers)) {
        reply.header(name, value);
      }
    }
    reply.code(e.status).type('application/json').send(e.toJSON());
  }

  async #handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    let parsedQuery: z.infer<typeof sseQuerySchema>;
    try {
      parsedQuery = sseQuerySchema.parse(query);
    } catch {
      const bad = err('BAD_REQUEST', {
        detail: 'invalid query: "topics" and "token" must be plain strings',
      });
      this.#sendError(reply, bad);
      return;
    }
    const input: AuthVerifyInput = {
      token: extractToken(req.headers, parsedQuery),
      headers: req.headers,
    };

    let identity: AuthIdentity;
    try {
      identity = await this.#checker(input);
    } catch (e) {
      if (e instanceof HarnessError) {
        this.#sendError(reply, e);
        return;
      }
      // 非 HarnessError：客户端只收到 INTERNAL 形状（不带原始 message），细节仅记服务端日志
      this.#logger?.error({ err: e }, '[sse] auth checker raised non-harness error');
      this.#sendError(reply, err('INTERNAL'));
      return;
    }
    void identity; // 阶段 2 不做 scope 级判定；身份仅供日志/后续扩展

    const topics = this.#parseTopics(parsedQuery.topics);
    if (topics.length > MAX_TOPICS_PER_CONNECTION) {
      const bad = err('BAD_REQUEST', {
        detail: `too many topics: got ${topics.length}, max ${MAX_TOPICS_PER_CONNECTION} per connection`,
      });
      this.#sendError(reply, bad);
      return;
    }
    const tooLong = topics.find((t) => t.length > MAX_TOPIC_NAME_LENGTH);
    if (tooLong !== undefined) {
      const bad = err('BAD_REQUEST', {
        detail: `topic name too long (${tooLong.length} chars, max ${MAX_TOPIC_NAME_LENGTH})`,
      });
      this.#sendError(reply, bad);
      return;
    }
    for (const topic of topics) {
      if ((this.#topics.get(topic)?.size ?? 0) >= this.#maxClientsPerTopic) {
        const limited = err('RATE_LIMITED', {
          detail: `topic "${topic}" reached max clients (${this.#maxClientsPerTopic})`,
          headers: { 'Retry-After': '5' },
        });
        this.#sendError(reply, limited);
        return;
      }
    }

    // 断线重放游标：标准 Last-Event-ID 头 + query lastEventId（replay 关闭时不解析，零行为变化）
    let cursors: Map<string, number> | undefined;
    if (this.#replay) {
      const headerRaw = req.headers['last-event-id'];
      const headerValue = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;
      cursors = this.#parseCursors(headerValue, parsedQuery.lastEventId, topics);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const client: SseClient = { topics, raw, heartbeat: undefined, detached: false };
    this.#clients.add(client);
    for (const topic of topics) {
      let set = this.#topics.get(topic);
      if (set === undefined) {
        set = new Set<SseClient>();
        this.#topics.set(topic, set);
      }
      set.add(client);
    }

    raw.on('close', () => {
      this.#detach(client);
    });

    // 立即 flush 响应头，客户端 fetch 才能拿到 headers
    raw.write(': connected\n\n');

    // 重放：须在注册实时订阅之后同步执行——publish 同为同步，衔接处既无缝隙也不重复
    if (cursors !== undefined) {
      for (const topic of topics) {
        const cursor = cursors.get(topic);
        if (cursor !== undefined) this.#writeReplay(topic, cursor, raw);
      }
    }

    const heartbeat = setInterval(() => {
      if (!raw.destroyed && raw.writable) raw.write(': ping\n\n');
    }, this.#heartbeatMs);
    heartbeat.unref(); // 不阻止进程退出
    client.heartbeat = heartbeat;
  }

  /** query.topics 解析：逗号分隔、去重去空白；缺省 'system'（入参已由 zod 保证为 string） */
  #parseTopics(raw: string | undefined): string[] {
    const parts = (raw ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    const unique = [...new Set(parts)];
    return unique.length > 0 ? unique : ['system'];
  }

  #detach(client: SseClient): void {
    if (client.detached) return;
    client.detached = true;
    if (client.heartbeat !== undefined) clearInterval(client.heartbeat);
    this.#clients.delete(client);
    for (const topic of client.topics) {
      const set = this.#topics.get(topic);
      if (set === undefined) continue;
      set.delete(client);
      if (set.size === 0) this.#topics.delete(topic);
    }
  }
}
