/**
 * LLM 网关类型与 provider 参数白名单过滤（内核零领域语义，协议由 adapter 承担）。
 *
 * 消息规约（跨协议中间形状，各 adapter 负责与协议结构互转）：
 * - `system` / `user`：content 为字符串（或 provider 原生结构，adapter 尽量直传）。
 * - `assistant`：content 为字符串，或富形状 `{ text?: string; toolCalls: LlmToolCall[] }`。
 * - `tool`：content 为字符串（结果文本），或富形状 `{ toolCallId: string; text?: string }`。
 */
import { err } from '../errors/index.js';

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
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call_delta'; index: number; payload: unknown }
  | { type: 'done'; usage?: LlmUsage }
  | { type: 'error'; message: string };

export interface LlmChatResult {
  text: string;
  usage?: LlmUsage;
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

/** assistant 富形状中的文本部分 */
export function assistantTextOf(content: unknown): string | undefined {
  if (isRecord(content) && typeof content.text === 'string') return content.text;
  return undefined;
}

/** 非字符串 content 的字符串兜底（adapter 内部需要纯文本时使用） */
export function textOrJson(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}
