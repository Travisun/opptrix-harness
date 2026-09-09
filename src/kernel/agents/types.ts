/**
 * agents — 子代理领域类型与依赖契约（SubagentManager 的对外形状）。
 *
 * 职责边界：
 * - 本文件只声明类型/契约，不含逻辑；执行循环由 runner.ts 的 runAgentLoop 提供
 *   （集成方把它包装成 {@link SubagentRunner} 注入），持久化由 store.ts 的
 *   SubagentStore 提供（或任何结构兼容的替身）；
 * - 树语义：'main' 表示主会话（根）；subagent 的 parent_id 指向其直接父；
 *   跨代/兄弟访问一律 FORBIDDEN（严格父子树，见 manager.assertDirectParent）。
 */

/** 子代理全量状态集合（状态机与 zod 枚举共用） */
export const SUBAGENT_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

/** 子代理状态：queued（等并发槽）/ running / done / failed / cancelled（终态） */
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];

/** 终态集合（waitFor 的轮询退出条件） */
export const SUBAGENT_TERMINAL_STATUSES: readonly SubagentStatus[] = ['done', 'failed', 'cancelled'];

/** 子代理记录（subagents 行的 camelCase 视图；时间字段均为 UTC epoch ms） */
export interface SubagentRecord {
  id: string;
  /** 直接父：'main' = 主会话；否则为父 subagent id */
  parentId: string;
  /** 树深度：main 的直接子代 = 1，每往下一层 +1 */
  depth: number;
  /** 模型标识（null = 由 LLM 网关按默认链解析） */
  model: string | null;
  /** 系统提示词（null = runner 侧默认） */
  systemPrompt: string | null;
  /** 任务提示词 */
  prompt: string;
  /** 工具白名单（null = 未限制；反序列化后为字符串数组） */
  toolNames: string[] | null;
  status: SubagentStatus;
  /** 最终结果文本（done 时写入） */
  result: string | null;
  /** 失败原因（failed 时写入） */
  error: string | null;
  /** 完整消息轨迹（runner 上报后 JSON 反序列化；损坏/未上报为 null） */
  transcript: unknown[] | null;
  /** 输入 token 用量 */
  usageIn: number | null;
  /** 输出 token 用量 */
  usageOut: number | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** SubagentManagerDeps.store 的 update() 允许的补丁字段（store 负责映射 snake_case 列） */
export interface SubagentPatch {
  status?: SubagentStatus;
  result?: string | null;
  error?: string | null;
  transcript?: unknown[] | null;
  usageIn?: number | null;
  usageOut?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}

/** 子代理持久化存储契约（SubagentStore 结构兼容；测试可注入内存替身） */
export interface SubagentStoreLike {
  /** 新增记录（id 由 manager 生成并保证唯一） */
  create(rec: SubagentRecord): Promise<void>;
  /** 按 ID 读取；不存在返回 null */
  get(id: string): Promise<SubagentRecord | null>;
  /** 按条件列出（created_at 升序）；filter 缺省 = 全量 */
  list(filter?: { parentId?: string; status?: SubagentStatus; depth?: number }): Promise<SubagentRecord[]>;
  /** 按 ID 更新允许的字段（行不存在时静默 no-op） */
  update(id: string, patch: SubagentPatch): Promise<void>;
}

/** runner 事件（SubagentRunner 的 onEvent 回调载荷） */
export type SubagentRunnerEvent =
  | { type: 'progress'; iteration: number }
  | { type: 'transcript'; messages: unknown[] }
  | { type: 'done'; result: string; usageIn?: number; usageOut?: number }
  | { type: 'error'; error: string };

/**
 * 子代理执行器契约：单次执行一个子代理任务，经 onEvent 上报生命周期事件。
 *
 * - 集成方包装 runner.ts 的 runAgentLoop（把循环回调映射到 onEvent）；
 * - input.signal 被 abort 时应尽快停止执行并返回（不要求发出 error 事件——
 *   manager 侧已把记录落为 cancelled，迟到事件会被丢弃）；
 * - 契约上 runner 不 reject（失败经 {type:'error'} 上报）；manager 仍对 reject 兜底落 failed；
 * - 'transcript' 与 done 的 usageIn/usageOut 为可选扩展：上报则落库（transcript 列 / usage_* 列）。
 */
export type SubagentRunner = (
  input: {
    agentId: string;
    depth: number;
    systemPrompt?: string;
    prompt: string;
    model?: string;
    toolNames?: string[];
    /** spawn 入参透传（执行循环的最大迭代数；undefined = runner 侧默认） */
    maxIterations?: number;
    signal?: AbortSignal;
  },
  onEvent: (e: SubagentRunnerEvent) => Promise<void>,
) => Promise<void>;

/** 失败通知器（可选；notify.send 抛错只记日志，不影响生命周期） */
export interface SubagentNotifier {
  send(input: { title: string; body: string; level?: 'info' | 'warn' | 'error' }): Promise<unknown>;
}

/** spawn 入参（parentId='main' 表示由主会话发起） */
export interface SubagentSpawnInput {
  parentId: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  toolNames?: string[];
  maxIterations?: number;
}
