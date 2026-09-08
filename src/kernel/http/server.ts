import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { Logger } from 'pino';
import type { HarnessConfig } from '../config/index.js';
import { HarnessError, err } from '../errors/HarnessError.js';

/**
 * HTTP 服务器依赖注入集合。
 */
export interface HttpServerDeps {
  config: HarnessConfig;
  logger: Logger;
  /** 内核就绪态（/readyz 用） */
  isReady(): boolean;
  /** 内核生命周期状态标签（/health、/readyz 回显用） */
  state(): string;
  /** 额外路由挂载钩子：在内核路由注册之后调用（stage 2+ 扩展模块用） */
  registerExtra?: (app: FastifyInstance) => void;
}

/**
 * createHttpServer 返回值：app 供注入与测试（fastify.inject），start/stop 管理进程生命周期。
 */
export interface HttpServer {
  app: FastifyInstance;
  /** 监听端口；config.port 传 0 时返回操作系统分配的实际端口 */
  start(): Promise<number>;
  /** 优雅关闭：停止接受新连接并等待在途请求完成 */
  stop(): Promise<void>;
}

/** webui 扩展未启用时的应急提示页（纯内联样式，无外部资源） */
const FALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opptrix Harness OS</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
<main style="max-width:560px;padding:48px 32px;text-align:center;">
<h1 style="margin:0 0 16px;font-size:28px;letter-spacing:.04em;">Opptrix Harness OS</h1>
<p style="margin:0;color:#9aa3b2;font-size:15px;line-height:1.8;">webui 扩展未启用。管理台启用后此页将替换为控制台。</p>
</main>
</body>
</html>
`;

/** 405 判定时用于探测路由存在性的常见 HTTP 方法（find-my-way 支持集的实用子集） */
const PROBE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] as const;

/**
 * 解析 CORS origin 配置：'*' 或单一 origin 原样传给 @fastify/cors；
 * 逗号分隔（如 "https://a.com, https://b.com"）拆为 origin 白名单数组。
 */
function parseCorsOrigins(corsOrigin: string): string | string[] {
  if (!corsOrigin.includes(',')) return corsOrigin;
  const list = corsOrigin
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return list.length > 0 ? list : corsOrigin;
}

/** 截去 URL 的 query 部分，只留 path（日志/错误 detail 一律不带 query，防敏感参数入日志） */
function pathOnlyOf(url: string): string {
  const qIdx = url.indexOf('?');
  return qIdx === -1 ? url : url.slice(0, qIdx);
}

/**
 * 创建内核 HTTP 服务器（不启动监听）。
 *
 * - `/health` 公开探活；`/readyz` 就绪探针（未就绪 503）；`/` 应急提示页
 * - 404 → HARNESS-1001；路径存在但方法不匹配 → HARNESS-1010
 * - HarnessError → status/retryable/headers + {code,message,detail,retryable}
 * - 其余异常 → 500 INTERNAL（服务端记日志，客户端不泄露内部信息）
 */
export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { config, logger } = deps;

  const app = fastify({
    // 日志由 kernel logger 统一负责，关闭 fastify 内置 pino
    logger: false,
    bodyLimit: config.maxBodyBytes,
    // trustProxy 由配置控制（HARNESS_TRUST_PROXY，默认 false）：仅反向代理部署应开启，
    // 直连暴露时信任 X-Forwarded-* 会被伪造（remote ip / 协议判定失真）
    trustProxy: config.trustProxy,
  });

  // CORS：允许配置的 origin（'*' 或逗号分隔白名单），不开 credentials
  app.register(cors, { origin: parseCorsOrigins(config.corsOrigin) });

  // 限速插件就位（global:false——不施加任何全局限制，仅注册插件与装饰器；
  // per-route 的 rateLimit 路由选项留给后续版本按路由逐个启用）。当前无路由
  // 携带 rateLimit 配置，因此对现有测试零影响。
  app.register(rateLimit, { global: false });

  // OpenAPI 文档（动态模式）。这里以插件函数直接同步装配 @fastify/swagger：
  // 其文档采集依赖 onRoute 钩子，而 app.register 要到 ready 阶段才加载插件，
  // 会错过本工厂函数里同步注册的全部根作用域路由（实测文档 paths 为空）。
  // 直接调用等价于 register 的插件体，使采集钩子在下方路由定义前就位。
  // 注：@fastify/swagger v9 已移除 exposeRoute 选项且默认不暴露任何文档路由，
  // 故文档 JSON 由下方手动路由暴露为 GET /api/v1/openapi.json（swagger 装饰器经
  // fastify-plugin 解封装挂在根实例，请求期可用）。
  swagger(
    app,
    {
      openapi: {
        info: { title: 'Opptrix Harness OS API', version: '0.1.0' },
        tags: [{ name: 'system' }],
      },
    },
    () => {},
  );

  app.get('/health', async () => ({ ok: true, state: deps.state() }));

  app.get('/readyz', async (_request, reply) => {
    if (!deps.isReady()) {
      reply.code(503);
      return { ok: false, state: deps.state() };
    }
    return { ok: true, state: deps.state() };
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(FALLBACK_PAGE);
  });

  // OpenAPI JSON 端点（与 /health、/ 一样属内核公开路由；文档内容含各模块注册的路由）
  app.get('/api/v1/openapi.json', async () => app.swagger());

  // 供后续模块挂载路由（必须在内核路由之后、listen 之前）
  deps.registerExtra?.(app);

  // fastify 对未知路径与未知方法统一走 notFound（刻意以 404 兜底），
  // 这里用 hasRoute 区分出「路径存在但方法不匹配」并映射为 METHOD_NOT_ALLOWED。
  app.setNotFoundHandler((request, reply) => {
    const method = request.method.toUpperCase();
    const rawUrl = request.raw.url ?? request.url;
    const pathOnly = pathOnlyOf(rawUrl);

    const matched = PROBE_METHODS.filter((m) => app.hasRoute({ method: m, url: pathOnly }));
    if (matched.length > 0) {
      reply.header('Allow', matched.join(', '));
      const e = err('METHOD_NOT_ALLOWED', { detail: { method, url: pathOnly } });
      reply.code(e.status).send(e.toJSON());
      return;
    }

    const e = err('ROUTE_NOT_FOUND', { detail: { method, url: rawUrl } });
    reply.code(e.status).send(e.toJSON());
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HarnessError) {
      if (error.headers) {
        for (const [name, value] of Object.entries(error.headers)) {
          reply.header(name, value);
        }
      }
      reply.code(error.status).send(error.toJSON());
      return;
    }

    // fastify body 超限 → PAYLOAD_TOO_LARGE（413），不落 INTERNAL
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const tooLarge = err('PAYLOAD_TOO_LARGE', { detail: { limit: config.maxBodyBytes } });
      reply.code(tooLarge.status).send(tooLarge.toJSON());
      return;
    }

    // 非内核异常：服务端记录完整错误，客户端只收到 INTERNAL 形状（不泄露堆栈/内部信息）；
    // 日志只记 path（截去 query），避免 token 等敏感 query 参数进入日志
    const rawUrl = request.raw.url ?? request.url;
    logger.error(
      { err: error, reqId: request.id, method: request.method, url: pathOnlyOf(rawUrl) },
      'unhandled error in http handler',
    );
    const internal = err('INTERNAL');
    reply.code(internal.status).send(internal.toJSON());
  });

  async function start(): Promise<number> {
    await app.listen({ port: config.port, host: config.host });
    const address = app.server.address();
    if (address !== null && typeof address === 'object') {
      return address.port;
    }
    return config.port;
  }

  async function stop(): Promise<void> {
    await app.close();
  }

  return { app, start, stop };
}
