/**
 * system-server — 系统操作 MCP Server（/mcp 端点 + 工具运行时）。
 *
 * 信任模型（JSDoc 即契约）：
 * - `/mcp` 前置统一鉴权（authProxy.createAuthChecker 产物）：Bearer/query token 校验，
 *   通过后要求 role ∈ {root, admin} 或 scopes 含 'mcp:call'/'*'——外部系统用 admin
 *   Bearer 或带 'mcp:call' scope 的 API Key 调用；未通过分别落 401/403 HarnessError JSON；
 * - 工具执行身份固定为内核 admin（系统操作不按调用者做行级过滤）：能通过上述门禁的
 *   调用方即是系统管理员的可信代理，工具只操作既有 REST 面同一批服务（单一事实来源，
 *   不新增越权面）；API Key 管理类操作刻意不做成工具，防密钥进 LLM 上下文。
 *
 * 协议选择（Streamable HTTP，官方 SDK @modelcontextprotocol/sdk server 侧）：
 * - **无状态模式（stateless）**：`sessionIdGenerator: undefined` + `enableJsonResponse: true`。
 *   每个 POST 请求独立构建 McpServer + Transport（官方 stateless 示例同款），响应为
 *   application/json（不走 SSE 流）；客户端无需维护会话 id，重复 initialize 也合法。
 *   选择理由：系统操作全是短平快的请求/响应式调用，无服务端主动推送诉求；无状态化
 *   免去会话表与 DELETE 生命周期管理，负载均衡/重启天然友好。
 * - GET/DELETE 不提供（无状态模式无会话流可订阅/可关闭）→ 405 METHOD_NOT_ALLOWED。
 * - 工具失败语义：目录 execute 永不抛错（统一 {ok:false,error}），因此 tools/call 的
 *   结果恒为 CallToolResult(isError 缺省)；协议级错误（未知工具/参数不符 schema）由
 *   SDK 产生 JSON-RPC error（-32602 等），本层不重复映射。
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { extractToken } from '../auth/authProxy.js';
import type { AuthIdentity, AuthVerifyInput } from '../auth/types.js';
import { err, HarnessError } from '../errors/index.js';
import { CONTAINER_KEYS, type Kernel, type UpdaterFacade } from '../Kernel.js';
import type { CronRunEntry } from '../cron/store.js';
import {
  createExtractTools,
  createSystemTools,
  SYSTEM_TOOLS_CONTAINER_KEY,
  type SystemTool,
  type SystemToolContext,
} from './system-tools.js';
import type { FileExtractService } from '../fileextract/service.js';

/**
 * 系统工具目录：内置目录 + fileextract 域的 files_extract（容器 'fileextract.service'
 * 懒解析——core-services 已登记该服务，裸装配缺失时工具收敛为 HARNESS-9001 结果对象）。
 * SystemToolRuntime（执行）与 buildMcpServer（SDK 注册）共用同一清单，防目录漂移。
 */
function buildSystemToolCatalog(kernel: Kernel): SystemTool[] {
  return createSystemTools(
    createExtractTools(() => ({
      service: kernel.container.has(CONTAINER_KEYS.fileExtract)
        ? kernel.container.resolve<FileExtractService>(CONTAINER_KEYS.fileExtract)
        : undefined,
    })),
  );
}

/** 对外声明的 server 信息（tools/list 的 serverVersion 之外，也用于客户端识别） */
const SERVER_INFO = { name: 'opptrix-harness', version: '0.1.0' } as const;

/** 工具结果的 JSON 文本块上限防御（超大结果截断提示；目录内工具正常不会触达） */
const MAX_RESULT_TEXT_BYTES = 2 * 1024 * 1024;

/** scopes 中允许调用系统工具的授权范围 */
const MCP_CALL_SCOPE = 'mcp:call';

// ---------------------------------------------------------------------------
// 工具运行时（bridge 合并 + /mcp 网关共用的执行器）
// ---------------------------------------------------------------------------

/** 目录工具的投影（bridge 的 mcp.tools.list 合并用；serverId 由桥补 'system'） */
export interface SystemToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * 系统工具执行器：目录的运行时面。
 * - `listTools()`：目录投影（不含执行器）；
 * - `call(name, args)`：zod 校验 → execute；未知工具/校验失败/执行异常一律收敛为
 *   `{ ok:false, error:{code,message} }` 结果对象（工具不抛）。
 *
 * Kernel 在 /mcp 接线时把实例登记进容器（键 SYSTEM_TOOLS_CONTAINER_KEY），
 * createCoreServices 装配的 mcp 桥按需懒解析（装配顺序解耦）。
 */
export class SystemToolRuntime {
  readonly #tools: SystemTool[];
  readonly #kernel: Kernel;
  readonly #updater: UpdaterFacade;
  readonly #cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;

  constructor(deps: {
    kernel: Kernel;
    /** 升级器门面（update_check / update_history） */
    updater: UpdaterFacade;
    /** cron 执行历史读取（cronHistory 绑定，Kernel registerExtra 闭包内注入） */
    cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
  }) {
    this.#tools = buildSystemToolCatalog(deps.kernel);
    this.#kernel = deps.kernel;
    this.#updater = deps.updater;
    this.#cronHistory = deps.cronHistory;
  }

  /** 完整工具目录（buildMcpServer 注册 SDK 工具与运行时执行共用同一清单） */
  get catalog(): SystemTool[] {
    return this.#tools;
  }

  /** 工具目录投影（MCP tools/list / 桥合并共用同一顺序） */
  listTools(): SystemToolInfo[] {
    return this.#tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** 目录大小（诊断/测试断言用） */
  get size(): number {
    return this.#tools.length;
  }

  /** 按名执行一个系统工具（未知工具 / 校验失败 / 抛错 → {ok:false,error} 结果对象）；audit 附加调用方审计信息（子代理工具循环） */
  async call(name: string, rawArgs: unknown, audit?: { agentId?: string; depth?: number }): Promise<Record<string, unknown>> {
    const tool = this.#tools.find((t) => t.name === name);
    if (tool === undefined) {
      return { ok: false, error: { code: 'HARNESS-3004', message: `system tool "${name}" not found` } };
    }
    const parsed = z.object(tool.input).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'HARNESS-1009',
          message: `system tool "${name}" arguments are invalid`,
          detail: parsed.error.issues,
        },
      };
    }
    const ctx: SystemToolContext = {
      kernel: this.#kernel,
      updater: this.#updater,
      cronHistory: this.#cronHistory,
      ...(audit?.agentId !== undefined ? { agentId: audit.agentId } : {}),
      ...(audit?.depth !== undefined ? { depth: audit.depth } : {}),
    };
    try {
      return await tool.execute(parsed.data as Record<string, unknown>, ctx);
    } catch (e) {
      // execute 约定不抛；此处兜底保证网关/桥两条路径的形状一致
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: `system tool "${name}" raised unexpectedly: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// /mcp 网关（SystemMcpServer）
// ---------------------------------------------------------------------------

/**
 * 系统操作 MCP Server：构建 SDK McpServer（工具注册）+ 处理挂到 Fastify 的 /mcp 路由。
 * 一次装配、每请求一个协议实例（stateless；见模块头注释的协议选择说明）。
 */
export class SystemMcpServer {
  readonly #kernel: Kernel;
  readonly #checker: (input: AuthVerifyInput) => Promise<AuthIdentity>;
  readonly #updater: UpdaterFacade;
  readonly #cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
  readonly #runtime: SystemToolRuntime;

  constructor(deps: {
    kernel: Kernel;
    /** 统一认证入口（createAuthChecker 产物；Kernel 接线时传既有实例） */
    checker: (input: AuthVerifyInput) => Promise<AuthIdentity>;
    /** 升级器门面（Kernel registerExtra 闭包内传入） */
    updater: UpdaterFacade;
    /** cron 执行历史读取（cronStore.history 绑定） */
    cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
  }) {
    this.#kernel = deps.kernel;
    this.#checker = deps.checker;
    this.#updater = deps.updater;
    this.#cronHistory = deps.cronHistory;
    this.#runtime = new SystemToolRuntime({
      kernel: deps.kernel,
      updater: deps.updater,
      cronHistory: deps.cronHistory,
    });
  }

  /** 工具运行时（Kernel 接线时登记进容器，供 bridge 懒解析合并） */
  get runtime(): SystemToolRuntime {
    return this.#runtime;
  }

  /**
   * 构建一个注册了全部系统工具的 SDK McpServer（无状态协议实例，每次请求新建）。
   * 结果块统一为单个 text 块（JSON 序列化的结果对象）——目录工具恒不抛、恒 isError 缺省。
   */
  buildMcpServer(): McpServer {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
    for (const tool of this.#runtime.catalog) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.input },
        async (args: unknown) => {
          const result = await this.#runtime.call(tool.name, (args ?? {}) as Record<string, unknown>);
          let text = JSON.stringify(result);
          if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_TEXT_BYTES) {
            // 防御性截断：目录内工具正常不触达；触达说明结果对象异常膨胀
            text = JSON.stringify({
              ok: false,
              error: { code: 'INTERNAL', message: `system tool "${tool.name}" result exceeded ${MAX_RESULT_TEXT_BYTES} bytes` },
            });
          }
          return { content: [{ type: 'text', text }] };
        },
      );
    }
    return server;
  }

  /**
   * 处理挂到 Fastify 的 /mcp 请求（POST = JSON-RPC；GET/DELETE = 405）。
   *
   * 鉴权前置：token 缺失/无效 → 401 HarnessError JSON；身份合法但 role 不是
   * root|admin 且 scopes 不含 'mcp:call'/'*' → 403。通过后进入无状态协议处理：
   * 每请求独立 McpServer + stateless transport，响应按 Web Response 原样回写
   * （reply.hijack 接管，绕开 Fastify 序列化以保持 JSON-RPC 帧原样）。
   */
  async handleRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // ---- 1. 鉴权前置（401：无效/缺失凭据；403：身份合法但无系统工具调用权）----
    let identity: AuthIdentity;
    try {
      const query = (request.query ?? {}) as Record<string, unknown>;
      identity = await this.#checker({
        token: extractToken(request.headers, query),
        headers: request.headers,
      });
    } catch (e) {
      const unauthorized = e instanceof HarnessError ? e : err('UNAUTHORIZED', {});
      reply.code(unauthorized.status).send(unauthorized.toJSON());
      return;
    }
    const authorized =
      identity.role === 'root' ||
      identity.role === 'admin' ||
      identity.scopes.includes(MCP_CALL_SCOPE) ||
      identity.scopes.includes('*');
    if (!authorized) {
      const forbidden = err('FORBIDDEN', {
        message: 'system mcp tools require role admin/root or the "mcp:call" scope',
        detail: { role: identity.role, scopes: identity.scopes },
      });
      reply.code(forbidden.status).send(forbidden.toJSON());
      return;
    }

    // ---- 2. 方法闸：无状态模式只提供 POST（GET/DELETE 会话流不存在 → 405）----
    if (request.method !== 'POST') {
      const notAllowed = err('METHOD_NOT_ALLOWED', {
        message: `/mcp is a stateless Streamable HTTP endpoint: only POST (JSON-RPC) is supported (got ${request.method})`,
        detail: { method: request.method },
      });
      reply.code(notAllowed.status).send(notAllowed.toJSON());
      return;
    }

    // ---- 3. 每请求独立的协议实例（官方 stateless 模式）----
    const server = this.buildMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // 无状态：不发会话 id、不做会话校验
      enableJsonResponse: true, // 请求/响应式：JSON 而非 SSE 流
    });
    reply.hijack();
    const raw = reply.raw;
    raw.on('close', () => {
      // 响应收尾即弃实例：协议状态（若有）不跨请求存活
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      const origin = `${request.protocol}://${request.headers.host ?? 'localhost'}`;
      const url = new URL(request.raw.url ?? '/mcp', origin);
      // 只透传协议相关头（content-type/accept 等），凭据头不进入协议层
      const headers: Record<string, string> = {};
      for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version'] as const) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const webRequest = new Request(url, { method: 'POST', headers });
      const response = await transport.handleRequest(webRequest, {
        parsedBody: request.body ?? {},
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== 'transfer-encoding') responseHeaders[name] = value;
      });
      const body = await response.text();
      responseHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
      raw.writeHead(response.status, responseHeaders);
      raw.end(body);
    } catch (e) {
      // 协议层异常兜底：以 JSON-RPC error 帧回 500（保持 JSON-RPC 形状）
      if (!raw.headersSent) {
        const message = e instanceof Error ? e.message : String(e);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `internal error: ${message}` },
        });
        raw.writeHead(500, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
        raw.end(body);
      } else {
        raw.end();
      }
    }
  }
}

/** 供 Kernel/bridge 使用的导出面（容器键一并从本模块出口，避免散落魔法字符串） */
export { SYSTEM_TOOLS_CONTAINER_KEY };

// ---------------------------------------------------------------------------
// 进程级共享运行时槽
// ---------------------------------------------------------------------------

/**
 * 当前进程的系统工具运行时（单内核/进程模型）。
 *
 * Kernel 在 /mcp 接线时调用 attachSystemRuntime 挂入实例；createCoreServices 装配的
 * mcp 桥（无法感知 Kernel 接线时序）经 currentSystemRuntime() 懒读——桥 handler 在
 * 请求期才解引用，挂入早晚不影响正确性。容器登记（SYSTEM_TOOLS_CONTAINER_KEY）仍是
 * 规范事实来源，此槽只为免改 core-services 装配的桥默认解析路径。
 */
let sharedRuntime: SystemToolRuntime | undefined;

/** 挂入（或覆盖）进程级系统工具运行时（Kernel /mcp 接线时调用） */
export function attachSystemRuntime(runtime: SystemToolRuntime): void {
  sharedRuntime = runtime;
}

/** 读取进程级系统工具运行时（未接线 → undefined；桥据此把 system 目录视为空） */
export function currentSystemRuntime(): SystemToolRuntime | undefined {
  return sharedRuntime;
}
