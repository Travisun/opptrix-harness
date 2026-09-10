/**
 * agents — LLM 代理运行时模块出口。
 * 使用方统一 `import { SubagentManager, AgentSessionManager, ... } from '../agents/index.js'`。
 *
 * 两套运行时共享 runner.ts 的 Agent 循环：
 * - Subagent*（manager/store/types）：严格父子树的子代理委派运行时；
 * - AgentSession*（session/session-store/session-runner）：类 Codex 全屏 Chat 的
 *   会话运行时（会话/消息持久化 + sendMessage LLM 循环 + SSE 实时推送）。
 */
export {
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_AGENT_MAX_TOKENS,
  defaultAgentSystemPrompt,
  runAgentLoop,
} from './runner.js';
export type {
  AgentLoopDeps,
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopToolRuntime,
} from './runner.js';
export { SubagentManager } from './manager.js';
export type { SubagentManagerDeps } from './manager.js';
export { SubagentStore } from './store.js';
export {
  SUBAGENT_STATUSES,
  SUBAGENT_TERMINAL_STATUSES,
} from './types.js';
export type {
  SubagentNotifier,
  SubagentPatch,
  SubagentRecord,
  SubagentRunner,
  SubagentRunnerEvent,
  SubagentSpawnInput,
  SubagentStatus,
  SubagentStoreLike,
} from './types.js';
export {
  AGENTS_DEFAULT_MODEL_SETTINGS_KEY,
  AGENT_SESSION_EVENT_CANCELLED,
  AGENT_SESSION_EVENT_MESSAGE,
  AgentSessionManager,
  DEFAULT_SESSION_TITLE,
  CONTEXT_MESSAGE_LIMIT,
  agentSessionTopic,
} from './session.js';
export type {
  AgentSessionGateway,
  AgentSessionManagerDeps,
  AgentSessionPublisher,
  AgentSessionSettings,
} from './session.js';
export {
  AGENT_MESSAGES_TABLE,
  AGENT_SESSIONS_TABLE,
  AGENT_SESSION_STATUSES,
  AgentSessionStore,
} from './session-store.js';
export type {
  AgentMessageRecord,
  AgentMessageRole,
  AgentMessageToolCall,
  AgentMessageUsage,
  AgentSessionPatch,
  AgentSessionRecord,
  AgentSessionStatus,
} from './session-store.js';
export { createSessionRunner } from './session-runner.js';
export type {
  SessionRunner,
  SessionRunnerDeps,
  SessionRunnerInput,
  SystemToolRuntimeLike,
} from './session-runner.js';
