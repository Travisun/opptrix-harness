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

export interface SseHubDeps {
  /** 统一认证入口（authProxy.createAuthChecker 的产物） */
  checker: (input: AuthVerifyInput) => Promise<AuthIdentity>;
  /** 心跳间隔毫秒数；默认 15000 */
  heartbeatMs?: number;
  /** 单 topic 订阅数上限；默认 200 */
  maxClientsPerTopic?: number;
  /** kernel logger（可选；用于服务端记录 checker 异常与 publish 序列化失败，客户端不泄露细节） */
  logger?: Logger;
}

/** SSE query 契约：topics/token 均须为字符串（重复参数产生的数组等形状一律 400） */
const sseQuerySchema = z.object({
  topics: z.string().optional(),
  token: z.string().optional(),
});

interface SseClient {
  /** 订阅的 topic 列表 */
  topics: string[];
  raw: ServerResponse;
  heartbeat: NodeJS.Timeout | undefined;
  detached: boolean;
}

/**
 * SSE Hub（阶段 2 骨架；阶段 6 扩展离线重放）。
 *
 * - 挂载 `GET <path>`（默认 `/api/v1/stream`）：query.topics 逗号分隔，缺省 'system'；
 *   query 经 zod 校验（topics/token 须为字符串）→ 否则 400 BAD_REQUEST；
 *   单连接 topic 数 >16 或单个 topic 名 >128 字符 → 400 BAD_REQUEST；
 *   认证失败 → 401 HarnessError JSON；topic 订阅超额 → 429 RATE_LIMITED（附 Retry-After: 5）。
 * - checker 抛出的非 HarnessError 异常一律以 INTERNAL（无原始 message）回给客户端，
 *   原始错误仅记服务端日志。
 * - 响应 text/event-stream，按 heartbeatMs 写注释行 `: ping\n\n` 保活。
 * - publish 写标准帧：`id: <topic自增seq>\nevent: <event>\ndata: <JSON>\n\n`；
 *   data 无法 JSON 序列化时记日志并跳过该事件（不崩连接）。
 * - 连接关闭自动清理；close() 结束全部客户端连接（幂等）。
 */
export class SseHub {
  readonly #checker: SseHubDeps['checker'];
  readonly #heartbeatMs: number;
  readonly #maxClientsPerTopic: number;
  readonly #logger: Logger | undefined;
  /** topic → 订阅客户端集合 */
  readonly #topics = new Map<string, Set<SseClient>>();
  /** topic → 自增序列（帧 id，阶段 6 重放基于此扩展） */
  readonly #topicSeq = new Map<string, number>();
  /** 全部存活客户端（clientCount() 无参时去重计数用） */
  readonly #clients = new Set<SseClient>();
  #attached = false;

  constructor(deps: SseHubDeps) {
    this.#checker = deps.checker;
    this.#heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#maxClientsPerTopic = deps.maxClientsPerTopic ?? DEFAULT_MAX_CLIENTS_PER_TOPIC;
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

  /** 向 topic 广播事件帧；无订阅者时为 no-op */
  publish(topic: string, event: string, data: unknown): void {
    const subscribers = this.#topics.get(topic);
    if (subscribers === undefined || subscribers.size === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(data) ?? 'null';
    } catch (e) {
      // 序列化失败（如循环引用）：记日志并跳过该事件，不影响连接与其余事件
      this.#logger?.warn({ err: e, topic, event }, '[sse] publish data not serializable; event skipped');
      return;
    }
    const seq = (this.#topicSeq.get(topic) ?? 0) + 1;
    this.#topicSeq.set(topic, seq);
    const frame = `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`;
    for (const client of subscribers) {
      try {
        if (!client.raw.destroyed && client.raw.writable) client.raw.write(frame);
      } catch {
        // 写失败的连接由 'close' 事件统一清理
      }
    }
  }

  /** 订阅数：带 topic 返回该 topic 订阅数；不带返回全部去重客户端数 */
  clientCount(topic?: string): number {
    if (topic !== undefined) return this.#topics.get(topic)?.size ?? 0;
    return this.#clients.size;
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
