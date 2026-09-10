/**
 * flow — 传入 Webhook（FlowTrigger）领域类型与依赖契约。
 *
 * 职责边界：
 * - 本文件只声明类型/契约，不含逻辑；编排由 manager.ts 的 FlowManager 提供，
 *   持久化由 store.ts 的 FlowEndpointStore 提供（或任何结构兼容的替身）；
 * - 语义：外部系统（Stripe 风格签名回调）POST 到公开入站路由 /hooks/flow/:slug →
 *   签名校验 → 事件落库 → 按 flow_type 分派（log 记录 / notify 通知 / llm 单轮提示词）。
 */

/** 端点 flow_type 全集（与迁移 017_flow 的 flow_endpoints.flow_type 约定一致） */
export const FLOW_TYPES = ['log', 'notify', 'llm'] as const;

/** 端点类型：log 仅记录 / notify 发通知 / llm 单轮提示词处理 */
export type FlowType = (typeof FLOW_TYPES)[number];

/** 事件状态全集（received 为入库初态；processed / failed 为终态） */
export const FLOW_EVENT_STATUSES = ['received', 'processed', 'failed'] as const;

/** 入站事件状态 */
export type FlowEventStatus = (typeof FLOW_EVENT_STATUSES)[number];

/** 端点记录（flow_endpoints 行的 camelCase 视图；时间字段均为 UTC epoch ms） */
export interface FlowEndpointRecord {
  id: string;
  name: string;
  /** url-safe、全局唯一（name slugify + 4 位随机后缀；/hooks/flow/:slug 的路由键） */
  slug: string;
  /** secrets 层引用（`flow.<id>.secret`）；null = 无密钥（入站跳过签名校验） */
  secretRef: string | null;
  enabled: boolean;
  flowType: FlowType;
  /** 按 flow_type 结构化的配置（JSON 反序列化；notify = { notification }, llm = { model? }） */
  flowConfig: unknown;
  /** llm 型提示词（支持 {{payload}} / {{字段路径}} 占位符）；notify/log 型为 null */
  llmPrompt: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 入站事件记录（flow_events 行的 camelCase 视图；时间字段为 UTC epoch ms） */
export interface FlowEventRecord {
  id: string;
  endpointId: string;
  status: FlowEventStatus;
  /** 原始 payload 的 SHA-256 hex 摘要（刻意不落原始 payload 全文——事件面天然脱敏） */
  payloadDigest: string;
  sourceIp: string | null;
  error: string | null;
  /** JSON 反序列化（llm 输出 {text,usage} / 通知 {notificationId} / log {logged:true}） */
  result: unknown;
  createdAt: number;
}

/** 端点创建入参（manager 侧做 flow_type 相关结构校验） */
export interface FlowEndpointCreateInput {
  name: string;
  flowType: FlowType;
  flowConfig?: unknown;
  llmPrompt?: string;
}

/** 端点更新入参（全字段可选；patch 语义） */
export interface FlowEndpointPatchInput {
  name?: string;
  enabled?: boolean;
  flowType?: FlowType;
  flowConfig?: unknown;
  llmPrompt?: string | null;
}

/** handleInbound 的 HTTP 头形状（fastify request.headers 的结构子集） */
export type FlowHeaders = Record<string, string | string[] | undefined>;

/** handleInbound 返回：事件 id + 处理终态（processed / failed；401/403/404 以 HarnessError 抛出） */
export interface FlowInboundResult {
  eventId: string;
  status: Extract<FlowEventStatus, 'processed' | 'failed'>;
}

/**
 * LLM 网关的 flow 域最小结构视图（LlmGateway 结构兼容；测试可注入 mock）。
 * chat 契约：非流式单轮，返回 { text, usage? }（LlmChatResult 的结构子集）。
 */
export interface FlowLlmGatewayLike {
  chat(input: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: unknown }>;
    stream?: boolean;
  }): Promise<{ text?: string; usage?: { inputTokens: number; outputTokens: number } }>;
  /** 供应商目录（可选）：flow_config 未指定 model 时取第一可用 provider 的缺省模型 */
  getProviders?(): Promise<Array<{ name: string; models: string[] }>>;
}

/** NotificationManager 的 flow 域最小结构视图（测试可注入 mock） */
export interface FlowNotifierLike {
  send(input: {
    title: string;
    body?: string;
    level?: string;
    data?: unknown;
  }): Promise<{ id: string }>;
}

/** SSE 广播门面（SseHub.publish 契约；fire-and-forget，同步返回） */
export type FlowPublishFn = (topic: string, event: string, data: unknown) => void;

/** FlowManager 依赖集合（结构化契约，测试可注入替身） */
export interface FlowManagerDeps {
  /** 内核主库（knex） */
  db: import('knex').Knex;
  /** 密钥存储（kernel secrets；HMAC 密钥按 `flow.<id>.secret` 引用存取） */
  secrets: {
    set(name: string, value: string): Promise<void>;
    get(name: string): Promise<string | null>;
    delete(name: string): Promise<boolean>;
  };
  /** kernel logger（pino）；密钥与签名头永不入日志 */
  logger: import('pino').Logger;
  /**
   * LLM 网关懒解析（llm 型端点用）。返回 undefined = 网关不可用 → 创建 llm 型端点
   * 报 VALIDATION_FAILED。刻意做成调用期 getter：装配时序无关（core-services 装配
   * 早于部分容器键登记），测试也可在 boot 后替换容器实现（mock gateway）。
   */
  gateway?: () => FlowLlmGatewayLike | undefined;
  /** 通知管理器懒解析（notify 型端点用；同 gateway 的懒解析语义） */
  notifications?: () => FlowNotifierLike | undefined;
  /** SSE 广播（topic `flow:{endpointId}`，事件 received / processed / failed；可缺省） */
  publish?: FlowPublishFn;
}

/** 端点持久化存储契约（FlowEndpointStore 结构兼容；测试可注入内存替身） */
export interface FlowEndpointStoreLike {
  insert(rec: FlowEndpointRecord): Promise<void>;
  get(id: string): Promise<FlowEndpointRecord | null>;
  getBySlug(slug: string): Promise<FlowEndpointRecord | null>;
  list(): Promise<FlowEndpointRecord[]>;
  update(id: string, patch: FlowEndpointPatch): Promise<void>;
  delete(id: string): Promise<void>;
  insertEvent(rec: FlowEventRecord): Promise<void>;
  updateEventStatus(
    id: string,
    patch: { status: FlowEventStatus; error?: string | null; result?: unknown },
  ): Promise<void>;
  listEvents(
    endpointId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<FlowEventRecord[]>;
  deleteEventsByEndpoint(endpointId: string): Promise<void>;
}

/** store.update() 允许的补丁字段（store 负责映射 snake_case 列与 JSON 序列化） */
export interface FlowEndpointPatch {
  name?: string;
  enabled?: boolean;
  flowType?: FlowType;
  flowConfig?: unknown | null;
  llmPrompt?: string | null;
  /** 仅 rotateSecret 为历史无密钥端点补引用时写入（常规路径不改列） */
  secretRef?: string | null;
  updatedAt: number;
}
