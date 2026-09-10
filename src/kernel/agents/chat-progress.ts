/**
 * agents/chat-progress — Chat 进度事件协议与工具步骤呈现（借鉴 Opptrix chat-progress 的
 * 成熟形状的内核精简版；纯函数、零 IO，方便单测）。
 *
 * 事件流（一次 sendMessage 的生命周期）：
 *   thinking* → (tool_start → tool_done)* → reply* → done ｜ error
 *
 * - thinking：模型思考链增量（runner 节流后；round/segmentIndex 从 1 起，一段思路一个序号）；
 * - reply：回复草稿增量（节流后；content 为**累积草稿全文**，estimatedTokens 按 chars/4 估算，
 *   draft 恒 true——最终全文以 done.message.content 为准）；
 * - tool_start / tool_done：单次工具调用的生命周期（step 同对象补全后二次下发）；
 * - done：最终 assistant 消息（已落库）+ 累计 usage + 全部思考分段；
 * - error：异常收尾（消息为人类可读中文/网关错误消息）。
 */
import { randomUUID } from 'node:crypto';

import type { AgentMessageRecord, AgentMessageUsage } from './session-store.js';

// ---------------------------------------------------------------------------
// 工具步骤
// ---------------------------------------------------------------------------

/** 工具调用步骤状态：running（执行中）/ done（成功）/ error（失败） */
export type ChatToolStepStatus = 'running' | 'done' | 'error';

/** 单次工具调用的完整生命周期信息（tool_start 下发 running 版；tool_done 下发补全版） */
export interface ChatToolStep {
  /** 步骤唯一 id（UUID） */
  id: string;
  /** 工具名（系统工具原名） */
  tool: string;
  /** 用户可见中文标签（formatToolLabel 按工具名映射 + 参数摘要） */
  label: string;
  status: ChatToolStepStatus;
  /** 参数预览（JSON 单行文本，≤240 字符） */
  argsPreview: string;
  /** 结果预览（JSON 单行文本，≤180 字符；tool_done 才有） */
  resultPreview?: string;
  /** 失败原因（status=error 时出现） */
  error?: string;
  /** 开始时间（UTC epoch ms） */
  startedAt: number;
  /** 结束时间（UTC epoch ms；tool_done 才有） */
  endedAt?: number;
}

/** 参数预览上限（字符） */
export const TOOL_STEP_ARGS_PREVIEW_MAX = 240;

/** 结果预览上限（字符） */
export const TOOL_STEP_RESULT_PREVIEW_MAX = 180;

// ---------------------------------------------------------------------------
// 进度事件
// ---------------------------------------------------------------------------

/** Chat 进度事件（形状见模块头注释） */
export type ChatProgressEvent =
  | { type: 'thinking'; round: number; segmentIndex: number; content: string }
  | { type: 'reply'; content: string; estimatedTokens: number; draft: true }
  | { type: 'tool_start'; step: ChatToolStep }
  | { type: 'tool_done'; step: ChatToolStep }
  | {
      type: 'done';
      /** 最终 assistant 消息（已落库，含 reasoningSegments/toolCalls/usage） */
      message: AgentMessageRecord;
      /** 全部轮次 usage 累计 */
      usage: AgentMessageUsage;
      /** 各轮思考分段（每轮一段，按轮次序） */
      reasoningSegments: string[];
    }
  | { type: 'error'; message: string };

/** Chat 进度回调（实现方不得抛错——分发侧已兜底 warn，不中断生成） */
export type ChatProgressCallback = (event: ChatProgressEvent) => void;

/** onDelta 增量块（runner → 会话层的节流后片段；text/reasoning 至少其一非空） */
export interface AgentLoopDeltaChunk {
  text?: string;
  reasoning?: string;
}

// ---------------------------------------------------------------------------
// 文本工具（纯函数）
// ---------------------------------------------------------------------------

/** 截断文本：总长（含省略号）不超过 max，超长以「…」结尾 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** 路径 basename（分隔符归一 /；空路径原样返回） */
function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  const base = idx >= 0 ? normalized.slice(idx + 1) : normalized;
  return base || path;
}

/** URL → hostname（非法 URL 退化为截断原文） */
function urlHostname(url: string): string {
  try {
    return new URL(url).hostname || truncate(url, 40);
  } catch {
    return truncate(url, 40);
  }
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 已知系统工具的中文标签映射（未知工具回退原名）。
 * 键与 mcp/system-tools.ts 的工具目录同名（此处只做呈现映射，不依赖工具实现）。
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  files_extract: '提取文件内容',
  coding_exec: '执行命令',
  coding_run_code: '运行代码',
  coding_fs_write: '写入代码工作区文件',
  coding_fs_read: '读取代码工作区文件',
  coding_fs_list: '列出代码工作区',
  coding_sessions: '查看代码执行会话',
  browser_navigate: '打开网页',
  browser_snapshot: '读取页面内容',
  browser_click: '点击页面元素',
  browser_type: '输入文本',
  browser_press_key: '按键',
  browser_screenshot: '网页截图',
  browser_close: '关闭浏览器',
  browser_status: '查看浏览器状态',
  workspace_write: '写入工作区文件',
  workspace_read: '读取工作区文件',
  workspace_list: '列出工作区',
  workspace_delete: '删除工作区文件',
  report_create: '生成 HTML 报告',
  report_list: '查看报告列表',
  report_get: '读取报告',
  report_delete: '删除报告',
  skills_list: '列出技能',
  skills_get: '查看技能',
  skills_create: '创建技能',
  skills_refresh: '刷新技能',
  cron_list: '列出定时任务',
  cron_create: '创建定时任务',
  cron_update: '更新定时任务',
  cron_delete: '删除定时任务',
  cron_run: '立即执行定时任务',
  cron_history: '查看执行历史',
  notifications_send: '发送通知',
  notifications_list: '查看通知',
  notifications_mark_read: '标记通知已读',
  notifications_mark_all_read: '全部标记已读',
  extensions_list: '列出扩展',
  extensions_enable: '启用扩展',
  extensions_disable: '停用扩展',
  extensions_reload: '重载扩展',
  extensions_rescan: '扫描扩展',
  files_list: '列出文件',
  files_read: '读取文件',
  files_write: '写入文件',
  files_delete: '删除文件',
  mcp_servers_list: '列出 MCP 服务',
  mcp_server_add: '添加 MCP 服务',
  mcp_server_remove: '移除 MCP 服务',
  mcp_server_connect: '连接 MCP 服务',
  mcp_tools_list: '列出 MCP 工具',
  mcp_tools_call: '调用 MCP 工具',
  plugins_list: '列出插件',
  plugins_remove: '移除插件',
  plugins_refresh: '刷新插件',
  logs_list: '查看日志',
  update_check: '检查更新',
  update_history: '查看更新历史',
  system_info: '读取系统信息',
  system_doctor: '系统自检',
  subagent_spawn: '派出子代理',
  subagent_status: '查询子代理状态',
  subagent_result: '获取子代理结果',
  subagent_list: '列出子代理',
  subagent_cancel: '取消子代理',
  subagent_transcript: '查看子代理轨迹',
};

/**
 * 按参数生成「· 摘要」后缀（用户可见、≤48 字符）：
 * 路径类取 basename、命令类取命令行、URL 类取 hostname、报告取标题、子代理取任务摘要。
 */
function argSummaryOf(tool: string, args: Record<string, unknown>): string {
  const path = strArg(args, 'path');
  const command = strArg(args, 'command') || strArg(args, 'cmd');
  const url = strArg(args, 'url');
  const title = strArg(args, 'title');
  switch (tool) {
    case 'workspace_write':
    case 'workspace_read':
    case 'workspace_delete':
    case 'coding_fs_write':
    case 'coding_fs_read':
      return path === '' ? '' : truncate(pathBasename(path) || path, 48);
    case 'workspace_list':
    case 'coding_fs_list':
      return path === '' ? '' : truncate(path, 48);
    case 'coding_exec': {
      if (command === '') return '';
      const argv = Array.isArray(args['args']) ? (args['args'] as unknown[]).map(String).join(' ') : '';
      const line = argv !== '' ? `${command} ${argv}` : command;
      return truncate(line, 48);
    }
    case 'coding_run_code':
      return strArg(args, 'language');
    case 'browser_navigate':
      return url === '' ? '' : urlHostname(url);
    case 'report_create':
      return truncate(title, 28);
    case 'subagent_spawn': {
      const prompt = strArg(args, 'prompt');
      return prompt === '' ? '' : truncate(prompt.replace(/\s+/g, ' '), 28);
    }
    case 'skills_get':
    case 'skills_create':
    case 'cron_delete':
    case 'cron_run':
    case 'files_read':
    case 'files_write':
    case 'files_delete':
    case 'report_get':
    case 'report_delete':
      return truncate(title || path || strArg(args, 'id') || strArg(args, 'name'), 40);
    default:
      return '';
  }
}

/**
 * 生成工具调用的用户可见中文标签：已知工具 = 中文映射 +「· 参数摘要」后缀；
 * 未知工具回退工具原名（可带摘要后缀）。
 *
 * 纯函数（只读入参，不依赖 IO/时钟），供 session-runner 的工具步骤桥与单测直接使用。
 */
export function formatToolLabel(tool: string, args: Record<string, unknown> = {}): string {
  const base = TOOL_LABELS[tool] ?? tool;
  const summary = argSummaryOf(tool, args);
  return summary === '' ? base : `${base} · ${summary}`;
}

/** 参数 → 单行 JSON 预览（≤240 字符；不可序列化收敛为空串） */
export function formatArgsPreview(args: unknown): string {
  try {
    const text = JSON.stringify(args ?? {}) ?? '';
    return truncate(text, TOOL_STEP_ARGS_PREVIEW_MAX);
  } catch {
    return '';
  }
}

/** 工具结果 → 单行 JSON 预览（≤180 字符；不可序列化退化 String()） */
export function formatResultPreview(result: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(result ?? null) ?? 'null';
  } catch {
    text = String(result);
  }
  return truncate(text, TOOL_STEP_RESULT_PREVIEW_MAX);
}

/** 工具失败判定：结果对象显式 isError === true 或 ok === false（系统工具运行时收敛约定） */
export function isToolResultError(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const rec = result as { isError?: unknown; ok?: unknown };
  return rec.isError === true || rec.ok === false;
}

/** 失败原因提取（error 字符串优先；否则固定文案） */
export function toolErrorOf(result: unknown): string {
  if (typeof result === 'object' && result !== null) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim() !== '') return truncate(error.trim(), 180);
  }
  return '工具执行失败';
}

/** 构造 running 态工具步骤（id/startedAt 就地生成；label/argsPreview 即时计算） */
export function createToolStep(tool: string, args: unknown, now?: number): ChatToolStep {
  return {
    id: randomUUID(),
    tool,
    label: formatToolLabel(tool, typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}),
    status: 'running',
    argsPreview: formatArgsPreview(args),
    startedAt: now ?? Date.now(),
  };
}

/** 用执行结果补全工具步骤（tool_done 版；status 按 isError/ok 判定，result 就地取预览） */
export function completeToolStep(step: ChatToolStep, result: unknown, now?: number): ChatToolStep {
  if (isToolResultError(result)) {
    return {
      ...step,
      status: 'error',
      resultPreview: formatResultPreview(result),
      error: toolErrorOf(result),
      endedAt: now ?? Date.now(),
    };
  }
  return {
    ...step,
    status: 'done',
    resultPreview: formatResultPreview(result),
    endedAt: now ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 思考分段与估算
// ---------------------------------------------------------------------------

/** 估算 token 数（chars/4 向上取整；与流式进度节流同口径，仅用于 UI 展示） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 空回复守卫的用户可见提示（终轮空文本但有思考链时替代空正文；无技术黑话）。
 * 借鉴 Opptrix EMPTY_REPLY_HINT 的产品语义，文案按本 Harness 场景改写。
 */
export const EMPTY_REPLY_HINT = '思考过程占用了本轮输出上限，正文未能写出。请重试、拆分任务或降低任务复杂度。';
