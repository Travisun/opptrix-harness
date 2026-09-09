/**
 * MCP 连接注册中心 — Harness OS 作为 MCP Host/Client 的连接编排层。
 *
 * 职责（协议全部委托官方 SDK @modelcontextprotocol/sdk，Package-First）：
 * - `connect(id)`：按配置的 transport 构建 ClientTransport（stdio 子进程 /
 *   StreamableHTTP / SSE）→ Client.connect（含 initialize 握手，带超时）→
 *   listTools/listResources/listPrompts 缓存目录（server 未声明对应能力时按空表容错）；
 * - `disconnect(id)` / `refreshAll()`：优雅关停与批量重连（失败逐条标记 error，不抛）；
 * - `callTool/listTools/listResources/readResource/listPrompts/getPrompt`：
 *   面向 REST 与扩展桥的统一门面，SDK 异常归一为 HarnessError
 *   （超时 → RPC_TIMEOUT；未连接 → INTERNAL（文案指明 server id 与修复动作））；
 * - stdio 子进程环境刻意最小化：SDK getDefaultEnvironment()（PATH/HOME 等安全白名单）
 *   + 配置的 env 叠加——不继承内核全量进程环境，防凭据经子进程环境泄漏。
 *
 * 状态机（每 server，进程生命周期内）：never → connect → connected | error；
 * 配置 enabled=false 时状态恒为 disabled（既有连接被 refreshAll/PATCH 断开）。
 */
import type { Logger } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { err, HarnessError } from '../errors/index.js';
import type { McpConfigStore } from './config-store.js';
import {
  DEFAULT_MCP_TIMEOUT_MS,
  type McpCallToolResult,
  type McpContentBlock,
  type McpGetPromptResult,
  type McpListToolsFilter,
  type McpPromptInfo,
  type McpRefreshResult,
  type McpResourceContents,
  type McpResourceInfo,
  type McpServerConfig,
  type McpServerStatus,
  type McpServerSummary,
  type McpToolInfo,
} from './types.js';

/** MCP 客户端身份（对 server 声明的 Implementation；版本与内核一致） */
const CLIENT_INFO = { name: 'opptrix-harness', version: '0.1.0' } as const;

/** 单条 stderr 日志的最大长度（子进程 stderr 追加进内核日志时截断，防刷屏） */
const STDERR_LOG_CAP = 4096;

/** 已建立连接的缓存记录（目录三件套 + SDK 客户端） */
interface McpConnection {
  client: Client;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

/** registry 依赖集合 */
export interface McpRegistryDeps {
  /** 配置持久化（registry 只经它读写配置） */
  configStore: McpConfigStore;
  /** 内核 pino logger（子进程 stderr / 断连事件走这里，永不打 env/headers 内容） */
  logger: Logger;
  /** 未配置 timeoutMs 时的默认 RPC 超时（毫秒；缺省 30_000） */
  defaultTimeoutMs?: number;
}

export class McpRegistry {
  readonly #configStore: McpConfigStore;
  readonly #logger: Logger;
  readonly #defaultTimeoutMs: number;
  /** 已建立连接（id → 连接缓存）；断连/出错即摘除 */
  readonly #connections = new Map<string, McpConnection>();
  /** 最后一次连接失败的归一原因（id → message），供 status(id).error 输出 */
  readonly #lastError = new Map<string, string>();

  constructor(deps: McpRegistryDeps) {
    this.#configStore = deps.configStore;
    this.#logger = deps.logger;
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------- 连接生命周期

  /**
   * 建立（或重建）一个 server 连接：构建 transport → initialize 握手（带超时）→
   * 缓存 tools/resources/prompts 目录。任何一步失败：状态置 error（保留原因供 status）
   * 并抛 HarnessError(INTERNAL)，message 指明 server id 与底层原因。
   * 已有连接时先断开旧连接（refresh 语义：每次 connect 都是新会话）。
   *
   * @returns 连接后的 status（state === 'connected'）
   */
  async connect(id: string): Promise<McpServerStatus> {
    const cfg = await this.#requireConfig(id);
    if (!cfg.enabled) {
      throw err('VALIDATION_FAILED', {
        message: `mcp server "${id}" is disabled — set enabled:true (PATCH /api/v1/mcp/servers/${id}) before connecting`,
        detail: { id },
      });
    }
    await this.#teardown(id);

    const timeoutMs = this.#timeoutOf(cfg);
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | undefined;
    let client: Client | undefined;
    try {
      transport = this.#buildTransport(cfg);
      client = new Client(CLIENT_INFO);
      // initialize 握手超时与单次 RPC 同预算；maxTotalTimeout 防进度通知无限续期
      await client.connect(transport, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      const connection: McpConnection = { client, tools: [], resources: [], prompts: [] };
      // 子进程/远端主动断开：摘除缓存连接（status 回落 disabled|never）并留痕
      transport.onclose = () => {
        if (this.#connections.get(id) === connection) {
          this.#connections.delete(id);
          this.#logger.info({ serverId: id }, 'mcp server connection closed');
        }
      };
      this.#connections.set(id, connection);
      this.#lastError.delete(id);
      await this.#refreshCapabilities(id, connection, timeoutMs);
      this.#logger.info(
        { serverId: id, transport: cfg.transport, tools: connection.tools.length },
        'mcp server connected',
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.#lastError.set(id, reason);
      // 半开连接清理：client 已构造则优雅关闭（会终止 stdio 子进程/关闭 HTTP 会话）
      await this.#closeQuietly(client);
      this.#logger.warn({ serverId: id, transport: cfg.transport, err: reason }, 'mcp server connect failed');
      throw err('INTERNAL', {
        message: `failed to connect to mcp server "${id}" (${cfg.transport}): ${reason}. ` +
          'Check the server command/url and credentials, then retry connect.',
        detail: { id, transport: cfg.transport },
        cause: e,
      });
    }
    return await this.status(id);
  }

  /**
   * 断开一个 server 连接并丢弃目录缓存（幂等：未连接直接返回）。
   * 不改配置、不清 error 痕迹（status 的 state 按配置 enabled 落 disabled|never）。
   */
  async disconnect(id: string): Promise<void> {
    await this.#teardown(id);
  }

  /**
   * 批量刷新：enabled 配置全部（重）连接；disabled 配置断开既有连接。
   * 单个失败只标记 error（status 可见），绝不抛错——启动期/定时刷新都不应被单点拖垮。
   */
  async refreshAll(): Promise<McpRefreshResult> {
    const configs = await this.#configStore.load();
    const connected: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const cfg of configs) {
      if (!cfg.enabled) {
        await this.#teardown(cfg.id);
        continue;
      }
      try {
        await this.connect(cfg.id);
        connected.push(cfg.id);
      } catch (e) {
        // connect 已标记 error 状态；这里收集原因给编排方（boot 日志/管理台）
        failed.push({ id: cfg.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { connected, failed };
  }

  /** 单个 server 的运行状态（配置不存在 → 404 语义 EXT_NOT_FOUND） */
  async status(id: string): Promise<McpServerStatus> {
    const cfg = await this.#requireConfig(id);
    const connection = this.#connections.get(id);
    const toolCount = connection?.tools.length ?? 0;
    if (!cfg.enabled) return { id, state: 'disabled', toolCount };
    if (connection !== undefined) return { id, state: 'connected', toolCount };
    const error = this.#lastError.get(id);
    if (error !== undefined) return { id, state: 'error', error, toolCount };
    return { id, state: 'never', toolCount };
  }

  /** 全部 server 的配置 + 运行态（admin 面；env/headers 原样——凭据不出 admin 边界） */
  async list(): Promise<McpServerSummary[]> {
    const configs = await this.#configStore.load();
    const out: McpServerSummary[] = [];
    for (const cfg of configs) {
      const connection = this.#connections.get(cfg.id);
      const toolCount = connection?.tools.length ?? 0;
      const error = this.#lastError.get(cfg.id);
      out.push({
        ...cfg,
        state: !cfg.enabled ? 'disabled' : connection !== undefined ? 'connected' : error !== undefined ? 'error' : 'never',
        toolCount,
        ...(error !== undefined && connection === undefined && cfg.enabled ? { error } : {}),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- 工具

  /**
   * 工具目录（连接期缓存，不触发连接）。serverId 缺省 = 全部已连接 server 合并；
   * 指定 serverId 时：配置不存在 → EXT_NOT_FOUND，存在但未连接 → 空数组。
   */
  async listTools(filter?: McpListToolsFilter): Promise<Array<McpToolInfo & { serverId: string }>> {
    let ids: string[];
    if (filter?.serverId !== undefined) {
      await this.#requireConfig(filter.serverId);
      ids = [filter.serverId];
    } else {
      ids = [...this.#connections.keys()];
    }
    const out: Array<McpToolInfo & { serverId: string }> = [];
    for (const id of ids) {
      const connection = this.#connections.get(id);
      if (connection === undefined) continue;
      for (const tool of connection.tools) {
        out.push({ serverId: id, ...tool });
      }
    }
    return out;
  }

  /**
   * 调用远程工具并归一结果。超时 → RPC_TIMEOUT（detail 含 serverId/toolName）；
   * 未连接 → INTERNAL（文案 `mcp server "<id>" not connected`，指明先 connect）；
   * server 返回 isError:true 时结果原样携带（调用方据内容裁决，不在传输层吞掉）。
   */
  async callTool(
    serverId: string,
    toolName: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<McpCallToolResult> {
    const cfg = await this.#requireConfig(serverId);
    const connection = this.#connections.get(serverId);
    if (connection === undefined) {
      throw err('INTERNAL', {
        message: `mcp server "${serverId}" not connected — POST /api/v1/mcp/servers/${serverId}/connect first (or check why refreshAll dropped it)`,
        detail: { serverId, toolName },
      });
    }
    const timeout = timeoutMs ?? this.#timeoutOf(cfg);
    try {
      const result = await connection.client.callTool(
        { name: toolName, arguments: args ?? {} },
        CallToolResultSchema,
        { timeout, maxTotalTimeout: timeout },
      );
      return normalizeCallToolResult(result);
    } catch (e) {
      if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
        throw err('RPC_TIMEOUT', {
          message: `mcp tools.call "${toolName}" on server "${serverId}" timed out after ${timeout}ms`,
          detail: { serverId, toolName, timeoutMs: timeout },
          cause: e,
        });
      }
      const reason = e instanceof Error ? e.message : String(e);
      throw err('INTERNAL', {
        message: `mcp tools.call "${toolName}" on server "${serverId}" failed: ${reason}`,
        detail: { serverId, toolName },
        cause: e,
      });
    }
  }

  // ---------------------------------------------------------------- 资源与 Prompt

  /** 资源目录（连接期缓存；未连接 → INTERNAL not connected） */
  async listResources(serverId: string): Promise<McpResourceInfo[]> {
    const connection = await this.#requireConnection(serverId, 'mcp resources.list');
    return connection.resources.map((entry) => ({ ...entry }));
  }

  /** 实时读取资源内容（文本或 base64；每次都是一次真实 RPC，带超时） */
  async readResource(serverId: string, uri: string): Promise<McpResourceContents[]> {
    const cfg = await this.#requireConfig(serverId);
    const connection = await this.#requireConnection(serverId, 'mcp resources.read');
    try {
      const result = await connection.client.readResource(
        { uri },
        { timeout: this.#timeoutOf(cfg), maxTotalTimeout: this.#timeoutOf(cfg) },
      );
      return (result.contents ?? []).map((entry) => ({
        uri: String(entry.uri),
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
        ...(typeof (entry as { text?: unknown }).text === 'string' ? { text: (entry as { text: string }).text } : {}),
        ...(typeof (entry as { blob?: unknown }).blob === 'string' ? { blob: (entry as { blob: string }).blob } : {}),
      }));
    } catch (e) {
      throw this.#rpcFailure(e, serverId, `resources.read "${uri}"`);
    }
  }

  /** Prompt 目录（连接期缓存；未连接 → INTERNAL not connected） */
  async listPrompts(serverId: string): Promise<McpPromptInfo[]> {
    const connection = await this.#requireConnection(serverId, 'mcp prompts.list');
    return connection.prompts.map((entry) => ({ ...entry }));
  }

  /** 实时渲染 Prompt（args 为 prompt 参数表；messages 原样透传） */
  async getPrompt(serverId: string, name: string, args?: Record<string, string>): Promise<McpGetPromptResult> {
    const cfg = await this.#requireConfig(serverId);
    const connection = await this.#requireConnection(serverId, 'mcp prompts.get');
    try {
      const result = await connection.client.getPrompt(
        { name, ...(args !== undefined ? { arguments: args } : {}) },
        { timeout: this.#timeoutOf(cfg), maxTotalTimeout: this.#timeoutOf(cfg) },
      );
      return {
        ...(result.description !== undefined ? { description: result.description } : {}),
        messages: result.messages ?? [],
      };
    } catch (e) {
      throw this.#rpcFailure(e, serverId, `prompts.get "${name}"`);
    }
  }

  // ---------------------------------------------------------------- 内部

  /** 配置必存在（不存在 → EXT_NOT_FOUND 404 语义） */
  async #requireConfig(id: string): Promise<McpServerConfig> {
    const cfg = await this.#configStore.get(id);
    if (cfg === undefined) {
      throw err('EXT_NOT_FOUND', {
        message: `mcp server "${id}" is not configured — add it via POST /api/v1/mcp/servers first`,
        detail: { id },
      });
    }
    return cfg;
  }

  /** 连接必存在（未连接 → INTERNAL，工作包约定的独立错误语义） */
  async #requireConnection(id: string, op: string): Promise<McpConnection> {
    await this.#requireConfig(id);
    const connection = this.#connections.get(id);
    if (connection === undefined) {
      throw err('INTERNAL', {
        message: `mcp server "${id}" not connected — ${op} requires an established connection`,
        detail: { id, op },
      });
    }
    return connection;
  }

  /** 单次 RPC 预算：调用级 timeoutMs > 配置 timeoutMs > registry 默认 */
  #timeoutOf(cfg: McpServerConfig, override?: number): number {
    return override ?? cfg.timeoutMs ?? this.#defaultTimeoutMs;
  }

  /** 按配置构建传输（不发起连接；initialize 握手在 Client.connect 内） */
  #buildTransport(cfg: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    switch (cfg.transport) {
      case 'stdio': {
        // 最小安全环境（PATH/HOME/… 白名单）+ 配置 env 叠加；绝不继承内核全量进程环境
        const transport = new StdioClientTransport({
          command: cfg.command!,
          ...(cfg.args !== undefined ? { args: cfg.args } : {}),
          env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
          stderr: 'pipe',
        });
        // 子进程 stderr 经管道进内核日志（debug 级、单条截断）——排障必需，又不刷爆日志
        transport.stderr?.on('data', (chunk: Buffer) => {
          this.#logger.debug(
            { serverId: cfg.id, stderr: chunk.toString('utf8').slice(0, STDERR_LOG_CAP) },
            'mcp stdio server stderr',
          );
        });
        return transport;
      }
      case 'streamable-http':
        return new StreamableHTTPClientTransport(new URL(cfg.url!), {
          ...(cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : {}),
        });
      case 'sse':
        return new SSEClientTransport(new URL(cfg.url!), {
          ...(cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : {}),
        });
    }
  }

  /** 连接后拉取并缓存能力目录（server 未声明某能力 → 该目录为空表，不视为失败） */
  async #refreshCapabilities(id: string, connection: McpConnection, timeoutMs: number): Promise<void> {
    const opts = { timeout: timeoutMs, maxTotalTimeout: timeoutMs };
    const [tools, resources, prompts] = await Promise.all([
      connection.client.listTools({}, opts).then((r) => r.tools ?? []).catch(() => []),
      connection.client.listResources({}, opts).then((r) => r.resources ?? []).catch(() => []),
      connection.client.listPrompts({}, opts).then((r) => r.prompts ?? []).catch(() => []),
    ]);
    connection.tools = tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    }));
    connection.resources = resources.map((res) => ({
      uri: res.uri,
      ...(res.name !== undefined ? { name: res.name } : {}),
      ...(res.description !== undefined ? { description: res.description } : {}),
      ...(res.mimeType !== undefined ? { mimeType: res.mimeType } : {}),
    }));
    connection.prompts = prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description !== undefined ? { description: prompt.description } : {}),
      ...(prompt.arguments !== undefined ? { arguments: prompt.arguments } : {}),
    }));
    void id;
  }

  /** 优雅关闭并摘除连接（幂等；错误只记 debug——teardown 失败无补救动作） */
  async #teardown(id: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (connection === undefined) return;
    this.#connections.delete(id); // 先摘再关：onclose 触发时不再重复处理
    await this.#closeQuietly(connection.client);
    this.#logger.info({ serverId: id }, 'mcp server disconnected');
  }

  /** best-effort close（永不抛错：断连失败只剩资源泄漏，无业务补救路径） */
  async #closeQuietly(client: Client | undefined): Promise<void> {
    if (client === undefined) return;
    try {
      await client.close();
    } catch (e) {
      this.#logger.debug({ err: e }, 'mcp client close raised (ignored)');
    }
  }

  /** read/getPrompt 这类实时 RPC 的失败归一（超时 → RPC_TIMEOUT，其余 → INTERNAL） */
  #rpcFailure(e: unknown, serverId: string, op: string): HarnessError {
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
      return err('RPC_TIMEOUT', {
        message: `mcp ${op} on server "${serverId}" timed out`,
        detail: { serverId, op },
        cause: e,
      });
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err('INTERNAL', {
      message: `mcp ${op} on server "${serverId}" failed: ${reason}`,
      detail: { serverId, op },
      cause: e,
    });
  }
}

/**
 * CallToolResult → 归一形状：text 块收敛为 `{ type:'text', text }`，
 * 其余块原样透传（浅拷贝去 type 后重组，保证可 JSON 序列化）；isError 仅在 true 时出现。
 * 入参取 unknown（SDK 结果是 CallToolResult | 任务结果的宽联合，由此处统一收窄）。
 */
function normalizeCallToolResult(result: unknown): McpCallToolResult {
  const record = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const raw = Array.isArray(record['content']) ? (record['content'] as unknown[]) : [];
  const content: McpContentBlock[] = raw.map((block) => {
    if (block !== null && typeof block === 'object') {
      const entry = block as Record<string, unknown>;
      if (entry['type'] === 'text' && typeof entry['text'] === 'string') {
        return { type: 'text', text: entry['text'] };
      }
      const { type, ...rest } = entry;
      return { type: typeof type === 'string' ? type : 'unknown', ...rest };
    }
    return { type: 'unknown', value: block };
  });
  return {
    content,
    ...(record['isError'] === true ? { isError: true } : {}),
  };
}
