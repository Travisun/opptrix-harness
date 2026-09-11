/**
 * LLM 网关类型与 provider 参数白名单过滤（内核零领域语义，协议由 adapter 承担）。
 *
 * 消息规约（跨协议中间形状，各 adapter 负责与协议结构互转）：
 * - `system` / `user`：content 为字符串（或 provider 原生结构，adapter 尽量直传）。
 * - `assistant`：content 为字符串，或富形状
 *   `{ text?: string; toolCalls: LlmToolCall[]; reasoning?: string }`——`reasoning` 为该轮
 *   思考链（DeepSeek/LongCat 等要求 tool 轮续写时 assistant 富形状回写
 *   `reasoning_content`；**空串也必须携带**，见 assistantReasoningOf）。
 * - `tool`：content 为字符串（结果文本），或富形状 `{ toolCallId: string; text?: string }`。
 */
import { err } from '../errors/index.js';
import type { ProviderHealthLike, ProviderHealthStat } from './health.js';

export type LlmProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
}

/** harness 层工具调用规约：arguments 为 JSON 字符串 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** chat 结果中的结构化工具调用（非流式路径自 provider 响应提取；argsJson 为原始 JSON 字符串） */
export interface LlmResultToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface LlmChatInput {
  model: string;
  messages: LlmMessage[];
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: unknown[];
  /**
   * 会话级缓存键（runner 经 input.sessionKey 传 sessionId）：非空时 openai-chat 适配器在
   * payload 追加 `prompt_cache_key`（provider 侧前缀缓存亲和）。该键由适配器直写 payload，
   * **不经 providerParams 白名单**。
   */
  sessionKey?: string;
  /** 透传给 provider 的额外参数；键必须命中 provider 的 paramAllowlist */
  providerParams?: Record<string, unknown>;
}

export interface LlmProviderConfig {
  name: string;
  protocol: LlmProtocol;
  baseUrl: string;
  /** 密钥引用（经 gateway 的 resolveSecret 解析，密钥本体不入配置） */
  apiKeySecretRef: string;
  models: string[];
  /** 允许透传的 providerParams 键，缺省 ['user','metadata'] */
  paramAllowlist?: string[];
  /** 请求超时（毫秒），缺省 120_000 */
  timeoutMs?: number;
  /** SDK 传输层重试次数（缺省 2；波动链路/兼容网关建议 ≥1，0 = 关闭） */
  maxRetries?: number;
  /**
   * 流式请求是否携带 `stream_options:{include_usage:true}`（缺省 true）。
   * 部分兼容网关对该键回 400——置 false 时请求不含该键（usage 缺失，done 不带用量）。
   */
  streamOptions?: boolean;
  /**
   * 是否携带 `prompt_cache_key`（缺省 true；input.sessionKey 非空时生效）。
   * OpenAI 官方与多数国内网关（DeepSeek 上下文缓存 / Qwen implicit cache）支持该键做
   * 会话级前缀缓存亲和；个别网关校验未知键回 400 时可显式关闭。
   */
  promptCacheKey?: boolean;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmStreamEvent =
  | { type: 'delta'; text: string }
  /**
   * 思考链增量（DeepSeek 等推理模型的 `reasoning_content`；openai-chat 适配器兼容
   * camelCase `reasoningContent`）。仅推理模型/开启思考的请求产生，普通流不含此事件。
   */
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; payload: unknown }
  | { type: 'done'; usage?: LlmUsage }
  | { type: 'error'; message: string };

export interface LlmChatResult {
  text: string;
  usage?: LlmUsage;
  /**
   * 本轮思考链全文（非流式自 `message.reasoning_content` 提取；流式路径由消费方聚合
   * reasoning_delta 自行累积）。缺省 = 本轮无思考链。
   */
  reasoning?: string;
  /** provider 原始响应（透传给上层诊断用；禁止入日志） */
  raw?: unknown;
  /**
   * 模型请求的结构化工具调用（非流式路径提取；无工具调用时缺省不出现）。
   * 流式路径不填充——tool_call_delta 增量由调用方自行聚合。
   */
  toolCalls?: LlmResultToolCall[];
}

export interface LlmAdapter {
  protocol: LlmProtocol;
  chat(cfg: LlmProviderConfig, apiKey: string, input: LlmChatInput): Promise<LlmChatResult>;
  stream(cfg: LlmProviderConfig, apiKey: string, input: LlmChatInput): AsyncGenerator<LlmStreamEvent>;
}

/** 网关依赖（含 HA 回退开关探测）。由 gateway.ts 转出口（保持既有 import 路径不变） */
export interface LlmGatewayDeps {
  getProviders(): Promise<LlmProviderConfig[]>;
  resolveSecret(ref: string): Promise<string | null>;
  logger: import('pino').Logger;
  /**
   * HA 自动回退开关探测（可选；**缺省 undefined = 关闭**）。返回非 true / 自身抛错一律视为关闭。
   * 集成层闭包接 settings('llm.ha.enabled')（REST 面 GET/PUT /api/v1/llm/ha 持久化同一键）；
   * core-services 装配归集成改动，见 src/api/llm.ts 模块注释的接线说明。
   */
  haEnabled?: () => Promise<boolean>;
  /**
   * provider 健康断路器（可选；缺省 = 每网关独立 ProviderHealthRegistry 实例）。
   * 集成传 `sharedProviderHealth` 即获得进程内全局断路语义（同 provider 跨网关共享冷却）。
   */
  health?: ProviderHealthLike;
  /** HA failover 尝试间退避 sleep（缺省 setTimeout 实现；测试注入记录器/空实现） */
  sleep?: (ms: number) => Promise<void>;
}

/** HA 回退链中的单次尝试记录（gateway LLM_PROVIDER_ERROR 的 detail.attempts 项） */
export interface LlmHaAttempt {
  /** 尝试的 provider 名（配置序） */
  provider: string;
  /** 尝试的模型（回退链为该 provider 的 models[0] 缺省模型；provider 无模型时空串） */
  model: string;
  /** 失败归因（HarnessError 的 code/message；message 不含密钥材料） */
  error: { code: string; message: string };
}

/** providerParams 缺省白名单 */
export const DEFAULT_PARAM_ALLOWLIST: readonly string[] = ['user', 'metadata'];

/** 请求超时缺省值（毫秒） */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 过滤 providerParams：键不在 provider 白名单内 → LLM_PARAM_REJECTED（detail.rejected 列出被拒键）；
 * 全部合法时返回透传集（浅拷贝，调用方可自由展开）。
 */
export function filterProviderParams(input: LlmChatInput, cfg: LlmProviderConfig): Record<string, unknown> {
  const allow = cfg.paramAllowlist ?? DEFAULT_PARAM_ALLOWLIST;
  const params = input.providerParams ?? {};
  const rejected = Object.keys(params).filter((key) => !allow.includes(key));
  if (rejected.length > 0) {
    throw err('LLM_PARAM_REJECTED', { detail: { rejected } });
  }
  return { ...params };
}

/** 结构化对象判定（内部辅助，供 adapter 做消息形状收窄） */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * tool 消息 content 规约读取：
 * 字符串 → 结果文本（无关联 id）；`{ toolCallId, text }` → 富形状；其余 → 空值兜底。
 */
export function toolContentOf(content: unknown): { toolCallId: string; text: string } {
  if (typeof content === 'string') return { toolCallId: '', text: content };
  if (isRecord(content)) {
    return {
      toolCallId: typeof content.toolCallId === 'string' ? content.toolCallId : '',
      text: typeof content.text === 'string' ? content.text : '',
    };
  }
  return { toolCallId: '', text: '' };
}

/** assistant 消息 content 中的工具调用；非富形状返回 undefined */
export function assistantToolCallsOf(content: unknown): LlmToolCall[] | undefined {
  if (isRecord(content) && Array.isArray(content.toolCalls)) return content.toolCalls as LlmToolCall[];
  return undefined;
}

/**
 * assistant 富形状中的思考链字段：**键存在且为 string 即返回（含空串）**，键不存在返回
 * undefined。空串与缺失的区分是刻意的——DeepSeek/LongCat 等推理模型要求 tool 轮续写时
 * assistant 消息必须带 `reasoning_content` 键（空串也要带），adapter 据此决定是否回写。
 */
export function assistantReasoningOf(content: unknown): string | undefined {
  if (isRecord(content) && typeof content['reasoning'] === 'string') return content['reasoning'];
  return undefined;
}

/**
 * baseUrl 规范化（容错用户常填错的形态；纯字符串操作、不抛错）：
 * - trim + 去尾部斜杠；
 * - 无协议前缀（非 `http://` / `https://` 开头）→ 补 `https://`（内网网关普遍 TLS 终止在前端）；
 * - 以 `/chat/completions` 结尾 → 剥掉（用户常把完整端点当 baseUrl 填，SDK 会再拼一次导致 404）；
 * - **不自动补 `/v1`**：国内网关路径各异（`/v1`、`/paas/v4`、`/compatible-mode/v1`、`/openai`
 *   或无版本后缀），自动补齐只会制造另一种错——路径由配置方填写完整根。
 */
export function normalizeBaseUrl(url: string): string {
  let out = url.trim();
  if (out === '') return '';
  if (!/^https?:\/\//i.test(out)) out = `https://${out}`;
  out = out.replace(/\/+$/, '');
  out = out.replace(/\/chat\/completions$/i, '');
  return out;
}

/** assistant 富形状中的文本部分 */
export function assistantTextOf(content: unknown): string | undefined {
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return undefined;
}

/** 非字符串 content 的字符串兜底（adapter 内部需要纯文本时使用） */
export function textOrJson(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}
