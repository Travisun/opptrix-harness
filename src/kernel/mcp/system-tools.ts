/**
 * system-tools — 系统操作 MCP 工具目录（单一事实来源）。
 *
 * 把 Harness OS 的全部系统操作暴露为标准 MCP 工具（按域前缀命名：
 * skills_ / cron_ / notifications_ / extensions_ / files_ / mcp_ / plugins_ /
 * subagents_ / logs_ / update_ / system_ / workspace_ / report_ / coding_ / browser_），
 * 供两类调用方复用：
 * - 外部 LLM/系统：经 `/mcp` 端点（Streamable HTTP，见 system-server.ts）调用；
 * - 内部扩展：经 h.mcp 桥（serverId='system'，见 bridge.ts 的目录合并）调用。
 *
 * 设计约定：
 * - **全部经容器懒解析现有服务**（CONTAINER_KEYS / FACADE_CONTAINER_KEYS），工具层
 *   只做参数校验 + 编排 + 结果归一，不重复实现任何领域逻辑；
 * - **admin 身份执行**：工具运行时（SystemToolRuntime，见 system-server.ts）在入口
 *   已完成鉴权（root|admin 或 scopes 含 'mcp:call'/'*'），执行期固定为内核 admin
 *   语义——系统操作不按调用者再做行级过滤（信任模型见 system-server.ts 模块注释）；
 * - **永不抛错**：每个 execute 的失败统一转 `{ ok:false, error:{code,message} }`
 *   返回（isError 语义由网关层映射，MCP 工具本身不抛）；成功统一 `{ ok:true, ...结果 }`；
 * - **API Key 管理刻意不做成工具**（LLM providers 的 apiKey、secrets 读写等）——
 *   防密钥进入 LLM 上下文；密钥操作只保留 REST/UI 管理员面；
 * - inputSchema（JSON Schema draft 2020-12）由 zod shape 经 `z.toJSONSchema` 派生，
 *   单一事实来源：目录表（本文件）→ SDK 注册（system-server.ts）/ 目录下发（bridge.ts）。
 *
 * update_apply 刻意不暴露：apply 会切换 A/B slot 并触发进程重启——重启是宿主动作，
 * 交由管理员经 UI/运维链路显式触发，不开放给 LLM/扩展的自动化调用。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Knex } from 'knex';
import { z } from 'zod';

import { HOST_METHODS } from '../../extension-host/protocol.js';
import { MAX_ACTIVATED_SKILLS_PER_SESSION, sharedSkillActivationSession, type SkillActivationSession } from '../agents/skill-session.js';
import { CONTAINER_KEYS, type Kernel, type UpdaterFacade } from '../Kernel.js';
import { SUBAGENT_STATUSES, SUBAGENT_TERMINAL_STATUSES } from '../agents/types.js';
import {
  BrowserBusyError,
  BrowserNotInstalledError,
  BrowserScreenshotNameError,
  BrowserUrlRejectedError,
} from '../browser/index.js';
import { FACADE_CONTAINER_KEYS } from '../Facades.js';
import type { HarnessConfig } from '../config/index.js';
import type { CronJobRecord } from '../cron/scheduler.js';
import type { CronRunEntry } from '../cron/store.js';
import { err, HarnessError } from '../errors/index.js';
import { NotificationStore } from '../notification/index.js';
import { runDoctor } from '../system/doctor.js';
import { writeSkill } from '../skills/index.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
} from '../skills/types.js';

// ---------------------------------------------------------------------------
// 目录契约
// ---------------------------------------------------------------------------

/**
 * 工具目录的容器登记键（SystemToolRuntime 实例；Kernel 在 /mcp 接线时登记，
 * bridge.ts 懒解析它实现 mcp.tools.list/call 的 system 合并）。
 */
export const SYSTEM_TOOLS_CONTAINER_KEY = 'system.tools';

/** system 工具在目录合并时的 serverId（h.mcp 桥与外部 /mcp 共用同一目录） */
export const SYSTEM_SERVER_ID = 'system';

/** 工具执行上下文：内核懒解析 + 升级器/执行历史两个闭包依赖（见 SystemToolRuntime） */
export interface SystemToolContext {
  /** 内核（容器 / config / logger 的懒解析根） */
  kernel: Kernel;
  /** 调用方子代理审计信息（经 SubagentRunner 工具循环执行时由集成方附加） */
  agentId?: string;
  depth?: number;
  /** 升级器门面（update_check / update_history 用；Kernel 接线时注入） */
  updater: UpdaterFacade;
  /** cron 执行历史读取（cron_history 用；Kernel 接线时注入 cronStore.history 绑定） */
  cronHistory: (jobId: string, limit?: number) => Promise<CronRunEntry[]>;
}

/** 单个系统工具定义 */
export interface SystemTool {
  /** 全局工具名（域前缀：skills_/cron_/…，MCP tools/list 原样下发） */
  name: string;
  /** 中文描述（面向 LLM 的用途说明） */
  description: string;
  /** 入参 JSON Schema（draft 2020-12；由 input zod shape 派生，勿手改） */
  inputSchema: Record<string, unknown>;
  /** 入参 zod shape（inputSchema 的单一事实来源；SDK registerTool 直用） */
  input: z.ZodRawShape;
  /**
   * 执行器：入参已由调用方（SDK 网关 / bridge / runtime）按 input 校验。
   * **约定：永不抛错**——失败一律返回 `{ ok:false, error:{code,message} }`。
   */
  execute(args: Record<string, unknown>, ctx: SystemToolContext): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 结果归一辅助
// ---------------------------------------------------------------------------

/** 统一成功形状 */
function ok(value: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, ...value };
}

/** 统一失败形状（code 用 HarnessError 全码如 'HARNESS-3004'，或 'VALIDATION'/'INTERNAL'） */
function fail(code: string, message: string, detail?: unknown): Record<string, unknown> {
  return { ok: false, error: { code, message, ...(detail !== undefined ? { detail } : {}) } };
}

/**
 * 执行器兜底包装：HarnessError → { ok:false, error:{code,message,detail} }；
 * 其余异常 → INTERNAL。工具层任何遗漏的抛错路径都收敛为结果对象（MCP 工具不抛）。
 */
async function guard(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HarnessError) {
      return fail(e.code, e.message, e.detail);
    }
    return fail('INTERNAL', e instanceof Error ? e.message : String(e));
  }
}

/** 容器懒解析（键未登记 → INTERNAL，提示装配缺失而非裸 TypeError） */
function required<T>(ctx: SystemToolContext, key: string): T {
  if (!ctx.kernel.container.has(key)) {
    throw err('INTERNAL', { message: `kernel service "${key}" is not registered in this kernel assembly` });
  }
  return ctx.kernel.container.resolve<T>(key);
}

/** 目录条目工厂：inputSchema 由 zod shape 派生（draft 2020-12） */
function defineTool(
  name: string,
  description: string,
  input: z.ZodRawShape,
  execute: SystemTool['execute'],
): SystemTool {
  const jsonSchema = z.toJSONSchema(z.object(input)) as Record<string, unknown>;
  return { name, description, inputSchema: jsonSchema, input, execute };
}

// ---------------------------------------------------------------------------
// 通用入参 schema 片段
// ---------------------------------------------------------------------------

/** 分页 limit 片段（1..500，与各 REST 模块的上下限一致） */
const limitShape: z.ZodRawShape = {
  limit: z.number().int().min(1).max(500).optional(),
};

/** 通知级别（与 ChannelLevel / NotificationManager 的 zod 枚举一致） */
const notifyLevelSchema = z.enum(['info', 'success', 'warn', 'error']);

/** 日志级别（pino 级别，与 api/system.ts logsQuerySchema 一致） */
const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// ---------------------------------------------------------------------------
// 子代理域（subagent_*）——委派机制的工具面
// ---------------------------------------------------------------------------

/**
 * 子代理管理器的容器登记键候选（**容错延迟绑定**）。
 *
 * 子代理树形运行时落 `src/kernel/agents/`（SubagentManager，由 Kernel 装配登记）；
 * 工具层只依赖下方 `SubagentManagerLike` 结构视图，调用期按候选键顺序解析首个已登记
 * 实现。两个键均未登记时（子代理子系统未装配/未落盘）subagent_* 工具统一收敛为
 * `{ok:false, error:{code:'HARNESS-9001'}}`（KERNEL_NOT_READY 语义），不影响其余域工具。
 */
export const SUBAGENT_MANAGER_CONTAINER_KEYS = ['subagents.manager', 'agents.manager'] as const;

/** 子代理 prompt 上限：64KB（UTF-8 字节口径，与 agents/manager.ts 的 MAX_PROMPT_BYTES 一致；
 * zod 层为字符数上限，execute 内再按字节精确校验） */
const SUBAGENT_PROMPT_MAX_BYTES = 64 * 1024;

/** subagent_result 的 wait 轮询：默认上限 120s、schema 上限 600s、轮询间隔 100ms
 * （与 agents/manager.ts 的 DEFAULT_WAIT_FOR_TIMEOUT_MS / WAIT_FOR_POLL_MS 一致） */
const SUBAGENT_WAIT_DEFAULT_MS = 120_000;
const SUBAGENT_WAIT_MAX_MS = 600_000;
const SUBAGENT_POLL_INTERVAL_MS = 100;

/**
 * 子代理管理器结构视图（src/kernel/agents/manager.ts 的契约面；工具层只依赖此形状）。
 * - `spawn({parentId,prompt,systemPrompt?,model?,toolNames?,maxIterations?}) → record`；
 * - `assertDirectParent(childId, callerId)`：树断言（跨代禁令落点）——subagent 的
 *   transcript/result 读取仅限直接父（或 main）；兄弟/孙辈 → HARNESS-1007 FORBIDDEN；
 * - `waitFor(id, timeoutMs?)`：轮询等待终态（超时抛 HARNESS-2001 RPC_TIMEOUT）；
 * - record 归一形状 `{id, parentId, depth, status, result?, error?, usageIn, usageOut, transcript}`。
 */
interface SubagentManagerLike {
  spawn(input: {
    parentId: string;
    prompt: string;
    systemPrompt?: string;
    model?: string;
    toolNames?: string[];
    maxIterations?: number;
  }): Promise<Record<string, unknown>>;
  cancel(id: string): Promise<unknown>;
  get(id: string): Promise<Record<string, unknown> | null>;
  list(filter?: { parentId?: string; status?: string }): Promise<unknown[]>;
  assertDirectParent(childId: string, callerId: string): Promise<void>;
}

/** 容错延迟绑定：返回首个已登记的管理器实现；全部未登记 → undefined */
function resolveSubagentManager(ctx: SystemToolContext): SubagentManagerLike | undefined {
  for (const key of SUBAGENT_MANAGER_CONTAINER_KEYS) {
    if (ctx.kernel.container.has(key)) {
      return ctx.kernel.container.resolve<SubagentManagerLike>(key);
    }
  }
  return undefined;
}

/** 管理器未登记时的统一失败形状（提示装配缺失，而非裸 TypeError/硬失败） */
function subagentManagerMissing(): Record<string, unknown> {
  return fail(
    'HARNESS-9001',
    'subagent manager is not registered in this kernel assembly (see SUBAGENT_MANAGER_CONTAINER_KEYS / src/kernel/agents/manager.ts)',
  );
}

/** 子代理记录的 id 归一（契约字段 agentId；容忍缩写 id 的实现漂移） */
function agentIdOf(record: Record<string, unknown>): string {
  return String(record['agentId'] ?? record['id'] ?? '');
}

/** 是否终态：已知终态（done/failed/cancelled）即终态；未知状态按终态处理（避免未知枚举导致无限轮询） */
function isTerminalSubagentStatus(status: unknown): boolean {
  return typeof status !== 'string' || (SUBAGENT_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 工具目录（43 项；顺序即 tools/list 下发顺序，按域分组）
// ---------------------------------------------------------------------------

/**
 * 构建系统工具目录（每次调用返回全新数组；定义本身无状态，可安全复用）。
 * execute 的入参已在 runtime/SDK 层校验，此处再以 guard 兜底保证「工具不抛」。
 *
 * @param extraGroups 集成方追加的工具组（如 createExtractTools 产出的 files_extract、
 *   createHtmlReportTools 产出的报告四工具；由 Kernel /mcp 接线处合并，保持既有目录
 *   零破坏）。
 */
export function createSystemTools(...extraGroups: SystemTool[][]): SystemTool[] {
  return [...createBuiltinSystemTools(), ...extraGroups.flat()];
}

// ---------------------------------------------------------------------------
// 文件提取工具（fileextract 域；经 createExtractTools 注入 createSystemTools）
// ---------------------------------------------------------------------------

/**
 * files_extract 工具的依赖注入面（**直接注入模式**：内核装配不经过容器登记，
 * 集成方在 /mcp 接线处传 `() => ({ service })`；fileextract 服务未装配时返回
 * `{ service: undefined }`，工具收敛为 {ok:false,error:HARNESS-9001}，不影响其余工具）。
 */
export type ExtractToolsDeps = {
  service?: {
    extractFile(
      fileId: string,
      opts?: { ocr?: 'auto' | 'never' | 'always'; deep?: boolean },
    ): Promise<{
      fileId: string;
      engine: string;
      ocrUsed: boolean;
      pages?: number;
      charCount: number;
      text: string;
      warnings: string[];
      needsOcr?: boolean;
      durationMs: number;
    }>;
  };
};

/** files_extract 返回文本的截断上限（32KB，与扩展桥 extract.file 一致；全文已落 file_extracts） */
const EXTRACT_TOOL_TEXT_MAX_BYTES = 32 * 1024;

/**
 * 构建文件提取工具目录（当前仅 files_extract；集成方：
 * `createSystemTools(createExtractTools(() => ({ service: fileExtractService })))`）。
 */
export function createExtractTools(getDeps: () => ExtractToolsDeps | undefined): SystemTool[] {
  return [
    defineTool(
      'files_extract',
      '提取已上传文件的文本内容（txt/md/csv/json/html/pdf/word/excel/ppt，图片与扫描件按 OCR 模型可用性识别；'
      + '全文同时落库（file_extracts）供 files_read 关联读取；返回文本截断到 32KB）。',
      {
        fileId: z.string().min(1).max(128),
        ocr: z.enum(['auto', 'never', 'always']).optional(),
        deep: z.boolean().optional(),
      },
      (args, _ctx) =>
        guard(async () => {
          void _ctx;
          const service = getDeps()?.service;
          if (!service) {
            return fail(
              'HARNESS-9001',
              'file extract service is not registered in this kernel assembly (see src/kernel/fileextract/service.ts / createExtractTools)',
            );
          }
          const result = await service.extractFile(String(args['fileId']), {
            ...(args['ocr'] !== undefined ? { ocr: args['ocr'] as 'auto' | 'never' | 'always' } : {}),
            ...(args['deep'] !== undefined ? { deep: args['deep'] === true } : {}),
          });
          const truncated = Buffer.byteLength(result.text, 'utf8') > EXTRACT_TOOL_TEXT_MAX_BYTES;
          return ok({
            fileId: result.fileId,
            engine: result.engine,
            ocrUsed: result.ocrUsed,
            pages: result.pages ?? null,
            charCount: result.charCount,
            needsOcr: result.needsOcr ?? false,
            warnings: result.warnings,
            truncated,
            text: truncated ? result.text.slice(0, EXTRACT_TOOL_TEXT_MAX_BYTES) : result.text,
          });
        }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 代码执行工具（coding_ 域；沙箱化会话引擎 src/kernel/coding）
// ---------------------------------------------------------------------------

/**
 * CodingEngine 的结构视图（src/kernel/coding/engine.ts 的契约面；工具层只依赖此形状）。
 * 安全边界（白名单 / argv 直传 / 路径钉死 / 超时 / 截断 / BUSY）由引擎统一收口，
 * 工具层只做转发与结果归一。`rootPath` 为可选的物理目录覆写：ctx.agentId 可解析出
 * 对话工作区时由工具层传入（会话产物落对话工作区），解析失败缺省（默认 coding-workspaces）。
 */
interface CodingEngineLike {
  runInSession(
    sessionId: string,
    input: {
      cmd: string;
      args?: string[];
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      rootPath?: string;
    },
  ): Promise<Record<string, unknown>>;
  runCode(
    sessionId: string,
    input: { language: 'node' | 'python'; code: string; timeoutMs?: number; rootPath?: string },
  ): Promise<Record<string, unknown>>;
  fsWrite(sessionId: string, relPath: string, content: string, rootPath?: string): Promise<unknown>;
  fsRead(sessionId: string, relPath: string, rootPath?: string): Promise<unknown>;
  fsList(sessionId: string, relPath?: string, rootPath?: string): Promise<unknown>;
  listSessions(): Promise<unknown>;
  resetSession(sessionId: string): Promise<unknown>;
  deleteSession(sessionId: string): Promise<unknown>;
}

/** 容器懒解析 CodingEngine（未登记 → undefined，工具收敛为 HARNESS-9001 结果对象） */
function resolveCodingEngine(ctx: SystemToolContext): CodingEngineLike | undefined {
  if (!ctx.kernel.container.has(CONTAINER_KEYS.coding)) return undefined;
  return ctx.kernel.container.resolve<CodingEngineLike>(CONTAINER_KEYS.coding);
}

/** coding_* 工具共用sessionId schema（缺省 "default"，语义由引擎侧归一） */
const codingSessionIdShape = z.string().min(1).max(128).optional();

/**
 * 会话上下文 → 物理目录覆写（coding_* 工具共用）：ctx.agentId 存在且能解析出
 * 对话工作区时返回工作区路径（会话产物落对话工作区，coding_fs_* 读写的就是工作区）；
 * 无会话上下文 / 工作区未装配 / 解析失败 → undefined（引擎回退默认 coding-workspaces）。
 */
async function codingRootPathOverride(ctx: SystemToolContext): Promise<{ rootPath: string } | Record<string, never>> {
  const path = (await tryResolveWorkspace(ctx))?.path;
  return path === undefined ? {} : { rootPath: path };
}

/**
 * 构建代码执行工具目录（coding_exec / coding_run_code / coding_fs_write /
 * coding_fs_read / coding_fs_list / coding_sessions；集成方在 buildSystemToolCatalog
 * 合并）。安全红线：不提供任意 shell——命令面受内核引擎白名单门约束（见
 * src/kernel/coding/engine.ts 模块头注释的安全基线与已知局限）。
 * 会话目录语义：sessionId 仍为并发/mutex 键；ctx.agentId 可解析出对话工作区时物理
 * 目录覆写为工作区路径（internal 目录在工作区根下），解析失败回退默认 coding-workspaces。
 */
export function createCodingTools(): SystemTool[] {
  return [
    defineTool(
      'coding_exec',
      '在持久代码会话目录内执行白名单命令（node/python3/pip/npm/npx/git/curl/ls/cat/grep 等；'
        + '非 shell：args 为 argv 数组，shell 元字符按字面量传递；输出各 256KB 截断；'
        + '每会话并发 1 进程；超时上限 120s）。有会话上下文时会话目录即当前对话工作区。',
      {
        sessionId: codingSessionIdShape,
        cmd: z.string().min(1).max(128),
        args: z.array(z.string()).max(256).optional(),
        cwd: z.string().max(1024).optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          const result = await engine.runInSession(
            typeof args['sessionId'] === 'string' ? String(args['sessionId']) : 'default',
            {
              cmd: String(args['cmd']),
              ...(Array.isArray(args['args']) ? { args: (args['args'] as unknown[]).map(String) } : {}),
              ...(typeof args['cwd'] === 'string' ? { cwd: String(args['cwd']) } : {}),
              ...(typeof args['timeoutMs'] === 'number' ? { timeoutMs: args['timeoutMs'] as number } : {}),
              ...(args['env'] !== undefined && typeof args['env'] === 'object'
                ? { env: args['env'] as Record<string, string> }
                : {}),
              ...(await codingRootPathOverride(ctx)),
            },
          );
          return ok({ ...result });
        }),
    ),
    defineTool(
      'coding_run_code',
      '在持久代码会话内执行一段源码（language: node|python；写入会话临时文件运行后清理；'
        + '受同一白名单/超时/输出上限约束；stdout/stderr 返回给模型）。有会话上下文时会话目录即当前对话工作区。',
      {
        sessionId: codingSessionIdShape,
        language: z.enum(['node', 'python']),
        code: z.string().min(1).max(256 * 1024),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          const result = await engine.runCode(
            typeof args['sessionId'] === 'string' ? String(args['sessionId']) : 'default',
            {
              language: args['language'] === 'python' ? 'python' : 'node',
              code: String(args['code']),
              ...(typeof args['timeoutMs'] === 'number' ? { timeoutMs: args['timeoutMs'] as number } : {}),
              ...(await codingRootPathOverride(ctx)),
            },
          );
          return ok({ ...result });
        }),
    ),
    defineTool(
      'coding_fs_write',
      '向代码会话目录写文件（path 为会话内相对路径，绝对路径与 .. 穿越拒绝；content 为 UTF-8 文本，上限 2MB）。'
        + '有会话上下文时读写的即当前对话工作区（与 workspace_* 同一物理目录）。',
      {
        sessionId: codingSessionIdShape,
        path: z.string().min(1).max(1024),
        content: z.string().max(2 * 1024 * 1024),
      },
      (args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          const result = await engine.fsWrite(
            typeof args['sessionId'] === 'string' ? String(args['sessionId']) : 'default',
            String(args['path']),
            String(args['content'] ?? ''),
            (await codingRootPathOverride(ctx))['rootPath'],
          );
          return ok({ ...(result as Record<string, unknown>) });
        }),
    ),
    defineTool(
      'coding_fs_read',
      '读取代码会话目录内文件（path 会话内相对；文本返回，256KB 截断）。'
        + '有会话上下文时读写的即当前对话工作区。',
      {
        sessionId: codingSessionIdShape,
        path: z.string().min(1).max(1024),
      },
      (args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          const result = await engine.fsRead(
            typeof args['sessionId'] === 'string' ? String(args['sessionId']) : 'default',
            String(args['path']),
            (await codingRootPathOverride(ctx))['rootPath'],
          );
          return ok({ ...(result as Record<string, unknown>) });
        }),
    ),
    defineTool(
      'coding_fs_list',
      '列出代码会话目录的一级内容（path 缺省会话根；返回 [{name,size,dir}]）。'
        + '有会话上下文时列的即当前对话工作区。',
      {
        sessionId: codingSessionIdShape,
        path: z.string().max(1024).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          const result = await engine.fsList(
            typeof args['sessionId'] === 'string' ? String(args['sessionId']) : 'default',
            typeof args['path'] === 'string' ? String(args['path']) : undefined,
            (await codingRootPathOverride(ctx))['rootPath'],
          );
          return ok({ entries: result });
        }),
    ),
    defineTool(
      'coding_sessions',
      '列出全部代码执行会话（[{id, dir, createdAt}]；会话目录即工作区，coding_exec 等按 sessionId 复用）。',
      {},
      (_args, ctx) =>
        guard(async () => {
          const engine = resolveCodingEngine(ctx);
          if (!engine) {
            return fail(
              'HARNESS-9001',
              'coding engine is not registered in this kernel assembly (see src/kernel/coding/engine.ts)',
            );
          }
          return ok({ sessions: await engine.listSessions() });
        }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 浏览器自动化工具（browser_ 域；内核引擎 src/kernel/browser，Playwright 跑内核主线程）
// ---------------------------------------------------------------------------

/**
 * BrowserEngine 的结构视图（src/kernel/browser/engine.ts 的契约面；工具层只依赖此形状）。
 * 安全边界（URL 白名单 / 单例 mutex / 空闲回收 / 崩溃恢复 / 截图防穿越）由引擎统一收口，
 * 工具层只做转发与结果归一。`screenshot.targetDir` 为可选落盘目录覆写：传入对话工作区的
 * screenshots/ 绝对路径时引擎落盘该目录并返回工作区相对 path（url 由工具层拼装 REST 预览端点）。
 */
interface BrowserEngineLike {
  navigate(url: string): Promise<{ title: string; url: string; status: number }>;
  snapshot(): Promise<{ snapshot: string; truncated: boolean }>;
  click(input: { selector: string }): Promise<unknown>;
  type(input: { selector: string; text: string }): Promise<unknown>;
  pressKey(input: { key: string }): Promise<unknown>;
  screenshot(input: { fullPage?: boolean; targetDir?: string }): Promise<{ path: string; file: string; url: string }>;
  close(): Promise<void>;
  status(): Promise<{ installed: boolean; running: boolean; installing: boolean; lastError: string | null }>;
}

/**
 * browser_* 工具的依赖注入面（**直接注入模式**，与 createExtractTools 同款）：
 * 集成方在 buildSystemToolCatalog 传 `() => ({ engine })`；引擎未装配（裸装配）时
 * 工具收敛为 HARNESS-9001 结果对象，不影响其余域工具。
 */
export type BrowserToolsDeps = { engine?: BrowserEngineLike };

/**
 * 引擎错误 → 结构化结果对象（业务码直出；HarnessError 保留全码，其余 INTERNAL）。
 * browser_not_installed 按需求形状携带 `hint`（如何安装浏览器），面向 LLM 可操作。
 */
function browserErrorResult(e: unknown): Record<string, unknown> {
  if (e instanceof BrowserNotInstalledError) {
    return { ok: false, error: { code: e.code, message: e.message, hint: e.hint } };
  }
  if (e instanceof BrowserUrlRejectedError) {
    return fail(e.code, e.message, { url: e.url });
  }
  if (e instanceof BrowserBusyError || e instanceof BrowserScreenshotNameError) {
    return fail(e.code, e.message);
  }
  if (e instanceof HarnessError) {
    return fail(e.code, e.message, e.detail);
  }
  return fail('INTERNAL', e instanceof Error ? e.message : String(e));
}

/** browser_* 工具共用执行壳：引擎缺失 → HARNESS-9001；引擎异常 → 结构化结果（工具不抛） */
async function runBrowserTool(
  engine: BrowserEngineLike | undefined,
  run: (engine: BrowserEngineLike) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (engine === undefined) {
    return fail(
      'HARNESS-9001',
      'browser engine is not registered in this kernel assembly (see src/kernel/browser/engine.ts)',
    );
  }
  try {
    return await run(engine);
  } catch (e) {
    return browserErrorResult(e);
  }
}

/**
 * 构建浏览器自动化工具目录（browser_navigate / browser_snapshot / browser_click /
 * browser_type / browser_press_key / browser_screenshot / browser_close / browser_status；
 * 集成方在 buildSystemToolCatalog 注入容器懒解析的引擎 getter）。
 * 浏览器二进制默认不下载：未安装时全部页面类工具收敛为 browser_not_installed
 * 结构化错误（携带 hint），browser_status / browser_close 不受影响。
 */
export function createBrowserTools(getDeps: () => BrowserToolsDeps | undefined): SystemTool[] {
  return [
    defineTool(
      'browser_navigate',
      '导航单例浏览器到指定 URL 并返回页面 { title, url, status }（仅允许 http/https，'
      + 'file:// 与其余协议被拒；导航超时 30s；浏览器 10 分钟空闲自动关闭，调用时按需冷启动）。',
      { url: z.string().min(1).max(2048) },
      (args) =>
        runBrowserTool(getDeps()?.engine, async (engine) =>
          ok({ ...(await engine.navigate(String(args['url']))) })),
    ),
    defineTool(
      'browser_snapshot',
      '获取当前页面的可访问性 aria 快照文本（≤50KB 截断）——阅读页面结构/文本的首选工具。',
      {},
      () =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          const result = await engine.snapshot();
          return ok({ snapshot: result.snapshot, truncated: result.truncated });
        }),
    ),
    defineTool(
      'browser_click',
      '点击当前页面中匹配 selector 的元素（CSS/文本选择器；30s 内未出现则超时）。',
      { selector: z.string().min(1).max(2048) },
      (args) =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          await engine.click({ selector: String(args['selector']) });
          return ok({ done: true });
        }),
    ),
    defineTool(
      'browser_type',
      '向当前页面中匹配 selector 的输入元素输入文本（fill 语义：先清空原值再写入）。',
      { selector: z.string().min(1).max(2048), text: z.string().max(64 * 1024) },
      (args) =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          await engine.type({ selector: String(args['selector']), text: String(args['text'] ?? '') });
          return ok({ done: true });
        }),
    ),
    defineTool(
      'browser_press_key',
      '向当前页面发送一次键盘按键（如 Enter / Tab / Escape / ArrowDown；page.keyboard.press 语义）。',
      { key: z.string().min(1).max(64) },
      (args) =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          await engine.pressKey({ key: String(args['key']) });
          return ok({ done: true });
        }),
    ),
    defineTool(
      'browser_screenshot',
      '对当前页面截图（PNG；fullPage=true 时整页滚动截图），返回 { path, file, url }。'
        + '有会话上下文时 PNG 落当前对话工作区 screenshots/（path 为工作区相对路径，'
        + 'url 指向工作区 REST 预览端点）；无会话上下文或解析失败回退数据目录'
        + '（url 即扩展路由 GET /ext/browser/screenshots/:file，auth:user）。',
      { fullPage: z.boolean().optional() },
      (args, ctx) =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          const fullPage = args['fullPage'] === true;
          // MCP-First：截图默认进对话工作区（path 工作区相对、url 走 REST 预览端点）；
          // 无会话上下文 / 工作区未装配 / resolve 失败 → 回退既有默认目录，不阻断
          const ws = await tryResolveWorkspace(ctx);
          if (ws !== undefined) {
            const shot = await engine.screenshot({ fullPage, targetDir: join(ws.path, 'screenshots') });
            return ok({ ...shot, url: workspaceFileUrl(ws.rootSessionId, shot.path) });
          }
          return ok({ ...(await engine.screenshot({ fullPage })) });
        }),
    ),
    defineTool(
      'browser_close',
      '关闭浏览器实例释放资源（幂等；下次页面类工具调用会自动重新冷启动）。',
      {},
      () =>
        runBrowserTool(getDeps()?.engine, async (engine) => {
          await engine.close();
          return ok({ done: true });
        }),
    ),
    defineTool(
      'browser_status',
      '查询浏览器引擎运行态：{ installed, running, installing, lastError }（installed=false 时先调'
      + ' POST /ext/browser/install 触发后台安装，完成后再用页面类工具）。',
      {},
      () =>
        runBrowserTool(getDeps()?.engine, async (engine) =>
          ok({ ...(await engine.status()) })),
    ),
  ];
}



// ---------------------------------------------------------------------------
// 对话工作区（workspace 域）—— MCP-First 的共享落盘面
// ---------------------------------------------------------------------------

/**
 * WorkspaceService 的容器登记键（冻结契约：'workspace.service'；内核侧常量为
 * CONTAINER_KEYS.workspace）。刻意用字面量而非 import 常量：本模块经
 * system-server.ts 被 Kernel.ts 循环导入，模块求值期读 CONTAINER_KEYS 会撞上
 * 未完成初始化（此处工具执行期才经 ctx.kernel.container 查询，无时序问题）。
 * 工具层只依赖下方 `WorkspaceServiceLike` 结构视图（与内核实现解耦）。
 */
export const WORKSPACE_CONTAINER_KEY = 'workspace.service';

/**
 * WorkspaceService 的结构视图（src/kernel/workspace/index.ts 的冻结契约面）。
 * - scopeId：工作区作用域 id（chat 会话 id 或子代理 id，resolve 内部归一到根会话）；
 * - path 语义：全部为工作区内相对路径（穿越/绝对路径由服务侧拒绝）。
 */
export interface WorkspaceServiceLike {
  resolve(scopeId: string): Promise<{ rootSessionId: string; userId: string | null; path: string }>;
  write(scopeId: string, relPath: string, data: Buffer): Promise<{ path: string; size: number }>;
  read(scopeId: string, relPath: string): Promise<Buffer>;
  list(
    scopeId: string,
    relPath?: string,
    recursive?: boolean,
  ): Promise<Array<{ name: string; path: string; type: 'file' | 'dir'; size: number; mtime: number }>>;
  delete(scopeId: string, relPath: string): Promise<void>;
}

/** workspace_write 的内容字节上限（8MB；zod 层为码元上限，execute 内按 UTF-8 字节精确复核） */
export const WORKSPACE_WRITE_MAX_BYTES = 8 * 1024 * 1024;

/** workspace_read 的文本预览阈值：≤256KB 直接回文本，超限收敛为提示形状（正文走 REST 文件端点） */
export const WORKSPACE_READ_PREVIEW_MAX_BYTES = 256 * 1024;

/** 超限/二进制正文统一提示（如何取全文：REST 预览端点，见 workspaceFileUrl） */
export const WORKSPACE_READ_HINT = 'use REST file endpoint';

/**
 * 工作区文件的 REST 预览端点形状（正文不经工具目录回传全文时的取用通道）：
 * `GET /api/v1/agents/sessions/{rootSessionId}/workspace/file?path=<relPath>`。
 */
export function workspaceFileUrl(rootSessionId: string, relPath: string): string {
  return `/api/v1/agents/sessions/${rootSessionId}/workspace/file?path=${encodeURIComponent(relPath)}`;
}

/** 容器懒解析 WorkspaceService（未登记 → undefined；工具收敛为 HARNESS-9001 结果对象） */
function resolveWorkspaceService(ctx: SystemToolContext): WorkspaceServiceLike | undefined {
  if (!ctx.kernel.container.has(WORKSPACE_CONTAINER_KEY)) return undefined;
  return ctx.kernel.container.resolve<WorkspaceServiceLike>(WORKSPACE_CONTAINER_KEY);
}

/** 工作区服务未登记时的统一失败形状（提示装配缺失，而非裸 TypeError） */
function workspaceServiceMissing(): Record<string, unknown> {
  return fail(
    'HARNESS-9001',
    `workspace service is not registered in this kernel assembly (expected container key "${WORKSPACE_CONTAINER_KEY}", see src/kernel/workspace)`,
  );
}

/** 无会话上下文的统一失败形状（工作区/报告类工具必须有调用方会话 id 才有落盘位置） */
function noSessionContext(): Record<string, unknown> {
  return fail('HARNESS-1009', 'no session context');
}

/** agentId 归一：undefined/空串 → undefined（子代理审计随行；缺省即「无会话上下文」） */
function agentScopeIdOf(ctx: SystemToolContext): string | undefined {
  return typeof ctx.agentId === 'string' && ctx.agentId !== '' ? ctx.agentId : undefined;
}

/**
 * 「解析当前对话工作区」的组合辅助（browser 截图 / coding 目录覆写共用）：
 * ctx.agentId 缺席或服务未登记或 resolve 失败 → undefined（调用方回退既有默认行为，
 * 不阻断工具调用——工作区是增强面而非硬依赖）。
 */
async function tryResolveWorkspace(
  ctx: SystemToolContext,
): Promise<{ service: WorkspaceServiceLike; scopeId: string; rootSessionId: string; path: string } | undefined> {
  const scopeId = agentScopeIdOf(ctx);
  const service = resolveWorkspaceService(ctx);
  if (scopeId === undefined || service === undefined) return undefined;
  try {
    const resolved = await service.resolve(scopeId);
    return { service, scopeId, rootSessionId: resolved.rootSessionId, path: resolved.path };
  } catch {
    return undefined;
  }
}

/**
 * 构建工作区工具目录（workspace_write / workspace_read / workspace_list /
 * workspace_delete；MCP-First：对话工作区是系统工具的一等落盘面）。
 *
 * 语义约定：
 * - ctx.agentId 即工作区 scopeId（chat 会话 id 或子代理 id；resolve 内部归一根会话）；
 *   缺失（外部 /mcp 直调等无会话场景）→ 收敛 `{ok:false, error:'no session context'}` 形状；
 * - path 一律「相对当前对话工作区」（zod 描述同步声明）；穿越/绝对路径由
 *   WorkspaceService 拒绝，工具层忠实透传其错误；
 * - workspace_read 是**文本预览**：≤256KB 直接回 content；超限/二进制回
 *   {truncated|binary, size, hint}（全文经 REST 预览端点取，防上下文爆炸）。
 */
export function createWorkspaceTools(): SystemTool[] {
  return [
    defineTool(
      'workspace_write',
      '向当前对话工作区写文件（path 相对当前对话工作区，如 "notes/a.md"；content 为 UTF-8 文本，'
        + '上限 8MB；父目录自动创建）。会话产物、报告草稿等一切需要跨轮次/跨工具可见的文件都落这里。',
      {
        path: z.string().min(1).max(1024).describe('文件路径，相对当前对话工作区'),
        content: z.string().max(WORKSPACE_WRITE_MAX_BYTES).describe('UTF-8 文本内容（≤8MB）'),
      },
      (args, ctx) =>
        guard(async () => {
          const service = resolveWorkspaceService(ctx);
          if (service === undefined) return workspaceServiceMissing();
          const scopeId = agentScopeIdOf(ctx);
          if (scopeId === undefined) return noSessionContext();
          const content = String(args['content']);
          const bytes = Buffer.byteLength(content, 'utf8');
          if (bytes > WORKSPACE_WRITE_MAX_BYTES) {
            return fail('HARNESS-1005', `content exceeds ${WORKSPACE_WRITE_MAX_BYTES} bytes`, {
              bytes,
              maxBytes: WORKSPACE_WRITE_MAX_BYTES,
            });
          }
          const written = await service.write(scopeId, String(args['path']), Buffer.from(content, 'utf8'));
          return ok({ path: written.path, size: written.size });
        }),
    ),
    defineTool(
      'workspace_read',
      '读取当前对话工作区内文件的文本预览（path 相对当前对话工作区）。≤256KB 直接返回 content；'
        + '超限或二进制文件返回 {size, hint}（不回正文）——全文经 REST 文件端点取用。',
      {
        path: z.string().min(1).max(1024).describe('文件路径，相对当前对话工作区'),
      },
      (args, ctx) =>
        guard(async () => {
          const service = resolveWorkspaceService(ctx);
          if (service === undefined) return workspaceServiceMissing();
          const scopeId = agentScopeIdOf(ctx);
          if (scopeId === undefined) return noSessionContext();
          const relPath = String(args['path']);
          const buf = await service.read(scopeId, relPath);
          const size = buf.byteLength;
          const text = buf.toString('utf8');
          // 二进制标记：utf8 解码不可逆（round-trip 不等）即视为二进制
          const binary = !Buffer.from(text, 'utf8').equals(buf);
          if (binary) {
            return ok({ path: relPath, size, binary: true, truncated: false, hint: WORKSPACE_READ_HINT });
          }
          if (size > WORKSPACE_READ_PREVIEW_MAX_BYTES) {
            return ok({ path: relPath, size, binary: false, truncated: true, hint: WORKSPACE_READ_HINT });
          }
          return ok({ path: relPath, size, binary: false, truncated: false, content: text });
        }),
    ),
    defineTool(
      'workspace_list',
      '列出当前对话工作区的条目（path 缺省=工作区根；recursive=true 递归全树；'
        + '返回 [{name, path, type, size, mtime}]）。',
      {
        path: z.string().max(1024).optional().describe('目录路径，相对当前对话工作区（缺省根目录）'),
        recursive: z.boolean().optional().describe('是否递归列出子目录'),
      },
      (args, ctx) =>
        guard(async () => {
          const service = resolveWorkspaceService(ctx);
          if (service === undefined) return workspaceServiceMissing();
          const scopeId = agentScopeIdOf(ctx);
          if (scopeId === undefined) return noSessionContext();
          const entries = await service.list(
            scopeId,
            typeof args['path'] === 'string' ? String(args['path']) : undefined,
            args['recursive'] === true,
          );
          return ok({ entries });
        }),
    ),
    defineTool(
      'workspace_delete',
      '删除当前对话工作区内文件（path 相对当前对话工作区；目标不存在时幂等成功）。',
      {
        path: z.string().min(1).max(1024).describe('文件路径，相对当前对话工作区'),
      },
      (args, ctx) =>
        guard(async () => {
          const service = resolveWorkspaceService(ctx);
          if (service === undefined) return workspaceServiceMissing();
          const scopeId = agentScopeIdOf(ctx);
          if (scopeId === undefined) return noSessionContext();
          await service.delete(scopeId, String(args['path']));
          return ok({ deleted: true });
        }),
    ),
  ];
}

/**
 * html-report 扩展 id（extensions/html-report；本域工具桥接的唯一目标）。
 *
 * 报告正文与元数据的存储分工（MCP-First 重构）：
 * - **正文一律落对话工作区**：内核工具经 WorkspaceService.write(session_id,
 *   `reports/{uuid}.html`, html) 落盘——跨工具/跨轮次可见，经 REST 预览端点取用；
 * - **索引元数据落扩展自有 SQLite**（extensions/html-report 的 h.expose('reports').index）：
 *   {reportId, title, path, sessionId, size, createdAt}，扩展不再存正文（扩展沙箱无 fs）。
 * 工具执行桥接扩展：容器 extManager（扩展注册表）→ 目标扩展已启用 → bridgeFor →
 * host.call('reports.<method>')。扩展侧逻辑见 extensions/html-report/index.js。
 */
export const HTML_REPORT_EXT_ID = 'html-report';

/** html-report 扩展暴露的服务名（h.expose('reports', { index/list/get/delete })） */
const HTML_REPORT_SERVICE = 'reports';

/** report_create 的 HTML 字节上限（2MB；扩展侧以 UTF-8 字节精确复核） */
export const HTML_REPORT_MAX_BYTES = 2 * 1024 * 1024;

/** reportId 形状（UUID；路径穿越防护的第一道闸——`../` 等形状在此被拒） */
const HTML_REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ExtensionManager 的结构视图（工具层不 import manager 实现，只依赖此形状） */
interface ExtManagerLike {
  list(): Array<{ id: string; enabled: boolean }>;
  bridgeFor(extId: string): {
    callToWorker(extId: string, topic: string, payload: unknown, timeoutMs?: number): Promise<unknown>;
  } | null;
}

/**
 * 解析 html-report 扩展的桥接调用器（读扩展注册表 → 启用位 → 所在池的桥）。
 * 未装配 extManager / 扩展未发现 / 未启用 / worker 不在 → 抛 HarnessError，
 * 由 guard 统一收敛为 {ok:false,error} 结果对象（工具不抛契约）。
 */
function htmlReportCall(ctx: SystemToolContext): (method: string, args: unknown) => Promise<unknown> {
  const manager = required<ExtManagerLike>(ctx, CONTAINER_KEYS.extManager);
  const summary = manager.list().find((s) => s.id === HTML_REPORT_EXT_ID);
  if (summary === undefined) {
    throw err('EXT_NOT_FOUND', {
      message: `extension "${HTML_REPORT_EXT_ID}" is not discovered (expected under the extensions directories)`,
    });
  }
  if (summary.enabled !== true) {
    throw err('SERVICE_UNAVAILABLE', {
      message: `extension "${HTML_REPORT_EXT_ID}" is not enabled (enable it first, e.g. POST /api/v1/extensions/${HTML_REPORT_EXT_ID}/enable)`,
      detail: { extId: HTML_REPORT_EXT_ID },
    });
  }
  const bridge = manager.bridgeFor(HTML_REPORT_EXT_ID);
  if (bridge === null || bridge === undefined) {
    throw err('SERVICE_UNAVAILABLE', {
      message: `extension "${HTML_REPORT_EXT_ID}" worker is not running`,
      detail: { extId: HTML_REPORT_EXT_ID },
    });
  }
  return (method, args) =>
    bridge.callToWorker(HTML_REPORT_EXT_ID, HOST_METHODS.callService, {
      service: HTML_REPORT_SERVICE,
      method,
      args,
    });
}

/**
 * 构建报告工具目录（html-report 域；MCP-First 存储分工见 HTML_REPORT_EXT_ID 的 JSDoc）。
 *
 * 契约（对旧版的变化）：
 * - report_create：**session_id 必填**（无会话上下文不产生报告）——正文经 WorkspaceService
 *   落对话工作区 `reports/{uuid}.html`，扩展只登记索引；返回 {reportId, path, sessionId,
 *   size, createdAt, url}，url 为工作区 REST 预览端点形状（正文不再回传/不再存扩展库）；
 * - report_get：{reportId} → {title, meta, url}，**不再回 html 全文**（正文经 url 端点取）；
 * - report_list：索引列表（session_id 缺省=全部可见）；
 * - report_delete：删扩展索引 + 删工作区正文（正文缺失不报错，幂等）。
 */
export function createHtmlReportTools(): SystemTool[] {
  return [
    defineTool(
      'report_create',
      '把一份 LLM 生成的 HTML 报告（≤2MB）落盘到指定会话的工作区并登记索引，供 WebUI 预览。'
        + '返回 reportId、工作区相对 path 与预览 url（GET /api/v1/agents/sessions/{rootId}/workspace/file?path=…）；'
        + '正文存对话工作区，索引由 html-report 扩展维护。',
      {
        title: z.string().min(1).max(256),
        html: z.string().min(1).max(HTML_REPORT_MAX_BYTES),
        session_id: z.string().min(1).max(256).describe('目标会话 id（正文落到该会话的工作区 reports/ 下）'),
      },
      (args, ctx) =>
        guard(async () => {
          const sessionId = args['session_id'];
          if (typeof sessionId !== 'string' || sessionId === '') {
            return fail('HARNESS-1009', 'report_create requires session_id (reports always belong to a conversation workspace)');
          }
          // 字节精确复核（zod max 按 UTF-16 码元计，多字节字符可绕过，此处兜底 2MB）
          const html = String(args['html']);
          const bytes = Buffer.byteLength(html, 'utf8');
          if (bytes > HTML_REPORT_MAX_BYTES) {
            return fail('HARNESS-1005', `html exceeds ${HTML_REPORT_MAX_BYTES} bytes`, {
              bytes,
              maxBytes: HTML_REPORT_MAX_BYTES,
            });
          }
          const service = resolveWorkspaceService(ctx);
          if (service === undefined) return workspaceServiceMissing();
          const resolved = await service.resolve(sessionId);
          const reportId = randomUUID();
          const relPath = `reports/${reportId}.html`;
          const createdAt = Date.now();
          // 1. 正文先落工作区（失败即整体失败，无半态）
          await service.write(sessionId, relPath, Buffer.from(html, 'utf8'));
          // 2. 再登记扩展索引；登记失败回滚正文（防索引缺行而正文成孤儿）
          try {
            const call = htmlReportCall(ctx);
            await call('index', {
              reportId,
              title: String(args['title']),
              path: relPath,
              sessionId,
              size: bytes,
              createdAt,
            });
          } catch (cause) {
            await service.delete(sessionId, relPath).catch(() => {
              // 回滚失败不掩盖原始错误：孤儿正文无索引不可达，可被工作区清理兜底
            });
            throw cause;
          }
          return ok({
            reportId,
            title: String(args['title']),
            path: relPath,
            sessionId,
            size: bytes,
            createdAt,
            url: workspaceFileUrl(resolved.rootSessionId, relPath),
          });
        }),
    ),
    defineTool(
      'report_list',
      '列出已保存的 HTML 报告索引（按创建时间降序；可按 session_id 过滤，缺省=全部可见；'
        + '不含正文，正文经各条目的 url 预览端点取用）。',
      {
        session_id: z.string().min(1).max(256).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const call = htmlReportCall(ctx);
          const listed = (await call('list', {
            ...(args['session_id'] !== undefined ? { sessionId: String(args['session_id']) } : {}),
            ...(args['limit'] !== undefined ? { limit: Number(args['limit']) } : {}),
            ...(args['offset'] !== undefined ? { offset: Number(args['offset']) } : {}),
          })) as { reports?: Array<Record<string, unknown>> } & Record<string, unknown>;
          // 每条目补预览 url（rootId 按 sessionId 解析缓存；解析失败 url=null 不影响列表）
          const service = resolveWorkspaceService(ctx);
          const rootCache = new Map<string, string | null>();
          const reports = await Promise.all(
            (Array.isArray(listed.reports) ? listed.reports : []).map(async (entry) => {
              const sessionId = typeof entry['sessionId'] === 'string' ? entry['sessionId'] : '';
              const relPath = typeof entry['path'] === 'string' ? entry['path'] : '';
              let rootId: string | null = null;
              if (service !== undefined && sessionId !== '' && relPath !== '') {
                if (!rootCache.has(sessionId)) {
                  rootCache.set(
                    sessionId,
                    await service.resolve(sessionId).then((r) => r.rootSessionId).catch(() => null),
                  );
                }
                rootId = rootCache.get(sessionId) ?? null;
              }
              return {
                ...entry,
                url: rootId !== null ? workspaceFileUrl(rootId, relPath) : null,
              };
            }),
          );
          return ok({ ...listed, reports });
        }),
    ),
    defineTool(
      'report_get',
      '读取单个 HTML 报告的标题/元数据与预览 url（reportId 为 UUID；不回正文——'
        + '正文经返回的 url 即 GET /api/v1/agents/sessions/{rootId}/workspace/file?path=… 取用）。',
      { reportId: z.string().regex(HTML_REPORT_ID_RE, 'reportId must be a UUID') },
      (args, ctx) =>
        guard(async () => {
          const call = htmlReportCall(ctx);
          const got = (await call('get', { reportId: String(args['reportId']) })) as Record<string, unknown>;
          const meta = { ...got };
          delete meta['html']; // 兼容旧实现残留：索引面永不回正文
          const sessionId = typeof meta['sessionId'] === 'string' ? meta['sessionId'] : '';
          const relPath = typeof meta['path'] === 'string' ? meta['path'] : '';
          const service = resolveWorkspaceService(ctx);
          let url: string | null = null;
          if (service !== undefined && sessionId !== '' && relPath !== '') {
            url = await service
              .resolve(sessionId)
              .then((r) => workspaceFileUrl(r.rootSessionId, relPath))
              .catch(() => null);
          }
          return ok({ title: meta['title'], meta, url });
        }),
    ),
    defineTool(
      'report_delete',
      '删除单个 HTML 报告：扩展索引 + 工作区正文一并删除（正文已缺失不报错，幂等；reportId 为 UUID）。',
      { reportId: z.string().regex(HTML_REPORT_ID_RE, 'reportId must be a UUID') },
      (args, ctx) =>
        guard(async () => {
          const call = htmlReportCall(ctx);
          // 扩展删索引并返回被删行的坐标（path/sessionId），供内核删工作区正文
          const removed = (await call('delete', { reportId: String(args['reportId']) })) as Record<string, unknown>;
          const sessionId = typeof removed['sessionId'] === 'string' ? removed['sessionId'] : '';
          const relPath = typeof removed['path'] === 'string' ? removed['path'] : '';
          if (sessionId !== '' && relPath !== '') {
            const service = resolveWorkspaceService(ctx);
            if (service !== undefined) {
              // 正文缺失（已被手工清理等）不报错：删除语义幂等
              await service.delete(sessionId, relPath).catch(() => {});
            }
          }
          return ok({ reportId: String(args['reportId']), deleted: true });
        }),
    ),
  ];
}

/** 内置目录（不含集成方追加项；createSystemTools 的实现主体） */
function createBuiltinSystemTools(): SystemTool[] {
  return [
    // ------------------------------------------------------------ skills ----
    defineTool(
      'skills_list',
      '列出技能目录全部条目（id 升序；不含正文）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{
            list(filter?: { source?: string; tag?: string; q?: string }): unknown[];
          }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const skills = registry.list();
          return ok({ skills, total: skills.length });
        }),
    ),
    defineTool(
      'skills_get',
      '读取单个技能（含 SKILL.md 正文）。',
      { id: z.string().min(1).max(256) },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            get(id: string): Promise<{ entry: unknown; body: string } | null>;
          }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const found = await registry.get(String(args['id']));
          if (found === null) {
            return fail('HARNESS-3004', `skill "${String(args['id'])}" not found`, { id: args['id'] });
          }
          const entry = found.entry as Record<string, unknown>;
          return ok({ skill: { ...entry, body: found.body } });
        }),
    ),
    defineTool(
      'skills_create',
      '创建数据域技能：写 <dataDir>/skills/<id>/SKILL.md（frontmatter 由 name/description 组装，注册 id = 目录 id），并重扫目录使其立即可见。',
      {
        id: z.string().regex(SKILL_NAME_PATTERN, `id must match ${SKILL_NAME_PATTERN.source}`),
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
        body: z.string().min(1).max(SKILL_BODY_MAX_BYTES),
      },
      (args, ctx) =>
        guard(async () => {
          const config = required<HarnessConfig>(ctx, CONTAINER_KEYS.config);
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.skillsRegistry);
          // 委托 skills/writer 的受控写面（单一事实来源：校验 + frontmatter 组装 + 原子语义 +
          // 已存在拒绝 + 失败回滚）；写后 refresh 让 REST/桥/工具三面立即一致
          const written = await writeSkill(
            { dataDir: config.dataDir },
            {
              id: String(args['id']),
              name: String(args['name']),
              description: String(args['description']),
              body: String(args['body']),
            },
          );
          await registry.refresh();
          return ok({ id: written.id, dir: written.path });
        }),
    ),
    defineTool(
      'skills_refresh',
      '重扫技能库全部根目录（builtin + data）并重放扩展贡献。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const entries = await registry.refresh();
          return ok({ total: entries.length, skills: entries });
        }),
    ),

    // ------------------------------------------------------------- cron ----
    defineTool(
      'cron_list',
      '列出全部定时任务（含扩展任务）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const scheduler = required<{ list(opts?: { extId?: string }): CronJobRecord[] }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          return ok({ jobs: scheduler.list() });
        }),
    ),
    defineTool(
      'cron_create',
      '创建内核级定时任务（cron 表达式 + IANA 时区；payload 随触发事件广播）。',
      {
        name: z.string().min(1).max(128),
        expr: z.string().min(1).max(256),
        tz: z.string().min(1).max(64).optional(),
        payload: z.unknown().optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const scheduler = required<{
            schedule(input: {
              name: string;
              expr: string;
              tz?: string;
              payload?: unknown;
              enabled?: boolean;
              extId?: string | null;
            }): Promise<CronJobRecord>;
          }>(ctx, FACADE_CONTAINER_KEYS.cronScheduler);
          const job = await scheduler.schedule({
            name: String(args['name']),
            expr: String(args['expr']),
            ...(args['tz'] !== undefined ? { tz: String(args['tz']) } : {}),
            ...(args['payload'] !== undefined ? { payload: args['payload'] } : {}),
            enabled: true,
            extId: null, // 系统工具创建的任务恒为内核级
          });
          return ok({ job });
        }),
    ),
    defineTool(
      'cron_update',
      '部分更新定时任务（只改给出的字段；enabled 走启停语义并联动重排期）。',
      {
        id: z.string().min(1).max(128),
        name: z.string().min(1).max(128).optional(),
        expr: z.string().min(1).max(256).optional(),
        tz: z.string().min(1).max(64).optional(),
        payload: z.unknown().optional(),
        enabled: z.boolean().optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{
            get(id: string): Promise<CronJobRecord | null>;
            update(id: string, patch: { name?: string; expr?: string; tz?: string; payload?: unknown }): Promise<CronJobRecord | null>;
            setEnabled(id: string, enabled: boolean): Promise<CronJobRecord | null>;
          }>(ctx, FACADE_CONTAINER_KEYS.cronScheduler);
          const patch: { name?: string; expr?: string; tz?: string; payload?: unknown } = {};
          if (args['name'] !== undefined) patch.name = String(args['name']);
          if (args['expr'] !== undefined) patch.expr = String(args['expr']);
          if (args['tz'] !== undefined) patch.tz = String(args['tz']);
          if (args['payload'] !== undefined) patch.payload = args['payload'];
          let job: CronJobRecord | null =
            Object.keys(patch).length > 0 ? await scheduler.update(id, patch) : await scheduler.get(id);
          if (job !== null && args['enabled'] !== undefined) {
            job = await scheduler.setEnabled(id, args['enabled'] === true);
          }
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          return ok({ job });
        }),
    ),
    defineTool(
      'cron_delete',
      '删除定时任务（出堆 + 删库，立即生效）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ unschedule(id: string): Promise<boolean>; get(id: string): Promise<CronJobRecord | null> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          // 存在性先行：unschedule 对未知 id 返回 false，无法区分「已删」与「从未存在」
          const job = await scheduler.get(id);
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          await scheduler.unschedule(id);
          return ok({ id, deleted: true });
        }),
    ),
    defineTool(
      'cron_run',
      '立即触发一次定时任务（不等待执行完成；结果经 cron_history 查看）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ get(id: string): Promise<CronJobRecord | null>; runNow(id: string): Promise<void> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          const job = await scheduler.get(id);
          if (job === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          await scheduler.runNow(id);
          return ok({ id, started: true });
        }),
    ),
    defineTool(
      'cron_history',
      '读取定时任务执行历史（最新在前）。',
      { id: z.string().min(1).max(128), ...limitShape },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const scheduler = required<{ get(id: string): Promise<CronJobRecord | null> }>(
            ctx,
            FACADE_CONTAINER_KEYS.cronScheduler,
          );
          if ((await scheduler.get(id)) === null) {
            return fail('HARNESS-3004', `cron job "${id}" not found`, { id });
          }
          const history = await ctx.cronHistory(id, typeof args['limit'] === 'number' ? args['limit'] : undefined);
          return ok({ id, history });
        }),
    ),

    // ----------------------------------------------------- notifications ----
    defineTool(
      'notifications_send',
      '发送一条通知（入库 + SSE 广播；渠道投递按默认路由规则执行）。',
      {
        title: z.string().min(1).max(256),
        body: z.string().max(10_000).optional(),
        level: notifyLevelSchema.optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const notify = required<{
            send(input: { title: string; body?: string; level?: string; data?: unknown; channels?: unknown[] }): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.notify);
          const notification = await notify.send({
            title: String(args['title']),
            body: args['body'] !== undefined ? String(args['body']) : '',
            level: args['level'] !== undefined ? String(args['level']) : 'info',
            data: null,
            channels: [], // 系统工具直发只入库 + SSE；外发渠道路由交给默认规则
          });
          return ok({ notification });
        }),
    ),
    defineTool(
      'notifications_list',
      '列出通知（最新在前）与未读计数。',
      {
        ...limitShape,
        unreadOnly: z.boolean().optional(),
        level: notifyLevelSchema.optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const store = new NotificationStore(db);
          const opts: { unreadOnly?: boolean; level?: string; limit?: number } = {
            limit: typeof args['limit'] === 'number' ? args['limit'] : 50,
          };
          if (args['unreadOnly'] === true) opts.unreadOnly = true;
          if (args['level'] !== undefined) opts.level = String(args['level']);
          const [items, unread] = await Promise.all([store.list(opts), store.unreadCount()]);
          return ok({ items, unread });
        }),
    ),
    defineTool(
      'notifications_mark_read',
      '标记单条通知为已读。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const store = new NotificationStore(db);
          const read = await store.markRead(String(args['id']));
          if (!read) {
            return fail('HARNESS-3004', `notification "${String(args['id'])}" not found`, { id: args['id'] });
          }
          return ok({ id: args['id'] });
        }),
    ),
    defineTool(
      'notifications_mark_all_read',
      '全部通知标记为已读。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const updated = await new NotificationStore(db).markAllRead();
          return ok({ updated });
        }),
    ),

    // ------------------------------------------------------- extensions ----
    defineTool(
      'extensions_list',
      '列出全部扩展（含启用状态、宿主池、挂载与最近错误）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const manager = required<{ list(): unknown[] }>(ctx, CONTAINER_KEYS.extManager);
          return ok({ extensions: manager.list() });
        }),
    ),
    defineTool(
      'extensions_enable',
      '启用扩展（第三方目录扩展首次启用需先在管理台授信）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{ enable(id: string, input?: { confirmTrust?: boolean }): Promise<void> }>(
            ctx,
            CONTAINER_KEYS.extManager,
          );
          await manager.enable(id);
          return ok({ id, enabled: true });
        }),
    ),
    defineTool(
      'extensions_disable',
      '停用扩展。builtin 内置扩展不可停用（返回 ok:false 的 builtin locked，而非抛错）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{
            list(): Array<{ id: string; builtin: boolean }>;
            disable(id: string): Promise<void>;
          }>(ctx, CONTAINER_KEYS.extManager);
          const summary = manager.list().find((s) => s.id === id);
          if (summary === undefined) {
            return fail('HARNESS-3004', `extension "${id}" not found`, { id });
          }
          if (summary.builtin) {
            // 约定形状：{ ok:false, error:{...message:'builtin locked'} } —— 不抛错
            return fail('HARNESS-1007', 'builtin locked', { id, reason: 'core-builtin' });
          }
          await manager.disable(id);
          return ok({ id, enabled: false });
        }),
    ),
    defineTool(
      'extensions_reload',
      '重载扩展（disable → enable；仅对已启用扩展有意义，disabled 扩展为 no-op）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const manager = required<{ reload(id: string): Promise<void> }>(ctx, CONTAINER_KEYS.extManager);
          await manager.reload(id);
          return ok({ id, reloaded: true });
        }),
    ),
    defineTool(
      'extensions_rescan',
      '重扫扩展目录（发现新增/移除已消失的扩展）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const manager = required<{ rescan(): Promise<{ discovered: string[] }> }>(ctx, CONTAINER_KEYS.extManager);
          const report = await manager.rescan();
          return ok(report);
        }),
    ),

    // ------------------------------------------------------------ files ----
    defineTool(
      'files_list',
      '列出已存文件（按创建时间倒序，不含内容）。',
      { ...limitShape },
      (args, ctx) =>
        guard(async () => {
          const files = required<{ list(opts?: { limit?: number }): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.files);
          const records = await files.list({ limit: typeof args['limit'] === 'number' ? args['limit'] : 50 });
          return ok({ files: records });
        }),
    ),
    defineTool(
      'files_read',
      '按 id 读取文件内容（base64 返回，admin 身份可读 private 文件）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const files = required<{
            read(id: string, opts?: { allowPrivate?: boolean }): Promise<{
              record: { id: string; origName: string; mime: string; size: number };
              data: Buffer;
            }>;
          }>(ctx, CONTAINER_KEYS.files);
          const { record, data } = await files.read(String(args['id']), { allowPrivate: true });
          return ok({
            id: record.id,
            origName: record.origName,
            mime: record.mime,
            size: record.size,
            contentBase64: data.toString('base64'),
          });
        }),
    ),
    defineTool(
      'files_write',
      '写入一个文件（base64 内容；落盘 + 落库，返回文件记录）。',
      {
        origName: z.string().min(1).max(512),
        contentBase64: z.string().min(1),
        mime: z.string().min(1).max(255).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const files = required<{
            store(input: { data: Buffer; origName: string; mime?: string }): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.files);
          const data = Buffer.from(String(args['contentBase64']), 'base64');
          if (data.byteLength === 0) {
            return fail('HARNESS-1009', 'contentBase64 is not valid base64 (decoded to 0 bytes)');
          }
          const record = await files.store({
            data,
            origName: String(args['origName']),
            ...(args['mime'] !== undefined ? { mime: String(args['mime']) } : {}),
          });
          return ok({ file: record });
        }),
    ),
    defineTool(
      'files_delete',
      '删除文件（磁盘 + 数据库行）。',
      { id: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const files = required<{ remove(id: string): Promise<unknown> }>(ctx, CONTAINER_KEYS.files);
          await files.remove(id);
          return ok({ id, deleted: true });
        }),
    ),

    // --------------------------------------------------------------- mcp ----
    defineTool(
      'mcp_servers_list',
      '列出全部外部 MCP server 配置与连接状态（env/headers 凭据字段刻意裁剪，防密钥进上下文）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{
            list(): Promise<Array<Record<string, unknown> & { id: string }>>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const servers = (await registry.list()).map((s) => {
            // 安全裁剪：env/headers 可含凭据，永不经工具目录下发（admin 修改走 REST/UI）
            const { env: _env, headers: _headers, ...safe } = s;
            return safe;
          });
          return ok({ servers });
        }),
    ),
    defineTool(
      'mcp_server_add',
      '新增外部 MCP server 配置并立即连接（id 由 name 派生 slug；stdio 需 command，远程需 url）。',
      {
        name: z.string().min(1).max(200),
        transport: z.enum(['stdio', 'streamable-http', 'sse']),
        command: z.string().min(1).max(2048).optional(),
        args: z.array(z.string().min(1).max(4096)).max(128).optional(),
        url: z.string().min(1).max(2048).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const configStore = required<{
            add(cfg: Record<string, unknown>): Promise<Record<string, unknown>>;
            get(id: string): Promise<Record<string, unknown> | undefined>;
          }>(ctx, CONTAINER_KEYS.mcpConfig);
          const registry = required<{
            connect(id: string): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          // id 由 name 派生：小写、非法字符折叠为 '-'，保证 ^[a-z0-9][a-z0-9_-]*$；冲突追加序号
          const baseId = String(args['name'])
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .slice(0, 48)
            .replace(/^-+|-+$/g, '');
          const stem = baseId === '' ? 'server' : baseId;
          let id = stem;
          for (let n = 2; (await configStore.get(id)) !== undefined; n += 1) id = `${stem}-${n}`;
          const added = await configStore.add({
            id,
            name: String(args['name']),
            transport: args['transport'],
            ...(args['command'] !== undefined ? { command: String(args['command']) } : {}),
            ...(args['args'] !== undefined ? { args: args['args'] } : {}),
            ...(args['url'] !== undefined ? { url: String(args['url']) } : {}),
            ...(args['headers'] !== undefined ? { headers: args['headers'] } : {}),
            ...(args['env'] !== undefined ? { env: args['env'] } : {}),
            enabled: true,
          });
          // 与 REST 面不同：工具语义是「加好即用」，连接失败如实上报（配置保留，可修复后重连）
          try {
            const status = await registry.connect(id);
            return ok({ server: added, status });
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            return fail(
              'INTERNAL',
              `mcp server "${id}" was added (config persisted) but the initial connect failed: ${reason}`,
              { id },
            );
          }
        }),
    ),
    defineTool(
      'mcp_server_remove',
      '删除外部 MCP server（断开连接 + 删配置）。',
      { id: z.string().min(1).max(64) },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const configStore = required<{ remove(id: string): Promise<boolean> }>(ctx, CONTAINER_KEYS.mcpConfig);
          const registry = required<{ disconnect(id: string): Promise<void> }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const removed = await configStore.remove(id);
          if (!removed) {
            return fail('HARNESS-3004', `mcp server "${id}" is not configured`, { id });
          }
          await registry.disconnect(id);
          return ok({ id, deleted: true });
        }),
    ),
    defineTool(
      'mcp_server_connect',
      '（重）连接外部 MCP server（refresh 语义：每次都是新会话）。',
      { id: z.string().min(1).max(64) },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{ connect(id: string): Promise<unknown> }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const status = await registry.connect(String(args['id']));
          return ok({ status });
        }),
    ),
    defineTool(
      'mcp_tools_list',
      '列出外部 MCP server 的工具目录（serverId 缺省 = 全部已连接 server 合并）。',
      { serverId: z.string().min(1).max(64).optional() },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            listTools(filter?: { serverId?: string }): Promise<unknown[]>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const tools = await registry.listTools(
            args['serverId'] !== undefined ? { serverId: String(args['serverId']) } : undefined,
          );
          return ok({ tools });
        }),
    ),
    defineTool(
      'mcp_tools_call',
      '调用外部 MCP server 的工具（归一 CallToolResult；isError 由 server 声明）。',
      {
        serverId: z.string().min(1).max(64),
        toolName: z.string().min(1).max(256),
        args: z.record(z.string(), z.unknown()).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const registry = required<{
            callTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
          }>(ctx, CONTAINER_KEYS.mcpRegistry);
          const result = await registry.callTool(
            String(args['serverId']),
            String(args['toolName']),
            args['args'] !== undefined ? (args['args'] as Record<string, unknown>) : undefined,
          );
          return ok({ result });
        }),
    ),

    // ----------------------------------------------------------- plugins ----
    defineTool(
      'plugins_list',
      '列出已安装插件（含贡献的 skills / mcpServers / scripts 摘要）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ list(): unknown[] }>(ctx, CONTAINER_KEYS.pluginsRegistry);
          return ok({ plugins: registry.list() });
        }),
    ),
    defineTool(
      'plugins_remove',
      '卸载插件（有贡献在用且未给 force 时会被拒绝，先看 plugins_list 的贡献摘要）。',
      { id: z.string().min(1).max(128), force: z.boolean().optional() },
      (args, ctx) =>
        guard(async () => {
          const id = String(args['id']);
          const registry = required<{ remove(id: string, opts?: { force?: boolean }): Promise<void> }>(
            ctx,
            CONTAINER_KEYS.pluginsRegistry,
          );
          await registry.remove(id, { force: args['force'] === true });
          return ok({ id, removed: true });
        }),
    ),
    defineTool(
      'plugins_refresh',
      '重扫插件目录并重建贡献注入（幂等）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const registry = required<{ refresh(): Promise<unknown[]> }>(ctx, CONTAINER_KEYS.pluginsRegistry);
          const plugins = await registry.refresh();
          return ok({ total: plugins.length, plugins });
        }),
    ),

    // -------------------------------------------------------------- logs ----
    defineTool(
      'logs_list',
      '查询内核日志（SQLite 日志汇，倒序最新在前；与 GET /api/v1/system/logs 同源）。',
      { ...limitShape, level: logLevelSchema.optional() },
      (args, ctx) =>
        guard(async () => {
          // 与 Kernel.ts registerExtra 里 logs.list 闭包同款实现：logs 表倒序，损坏 data → null
          const db = required<Knex>(ctx, CONTAINER_KEYS.db);
          const limit = typeof args['limit'] === 'number' ? args['limit'] : 200;
          const base = db('logs');
          const filtered = args['level'] !== undefined ? base.where('level', String(args['level'])) : base;
          const rows = (await filtered
            .select('ts', 'level', 'scope', 'message', 'data')
            .orderBy('id', 'desc')
            .limit(limit)) as Array<{
            ts: number;
            level: string;
            scope: string | null;
            message: string;
            data: string | null;
          }>;
          const logs = rows.map((row) => {
            let data: unknown = null;
            if (typeof row.data === 'string' && row.data !== '') {
              try {
                data = JSON.parse(row.data);
              } catch {
                data = null; // 损坏行不拖垮整个列表
              }
            }
            return {
              ts: Number(row.ts),
              level: String(row.level),
              scope: row.scope == null ? '' : String(row.scope),
              message: row.message == null ? '' : String(row.message),
              data,
            };
          });
          return ok({ logs });
        }),
    ),

    // ------------------------------------------------------------ update ----
    // update_apply 刻意不暴露：apply 提交新 slot 后会触发进程重启——重启动作交由
    // 管理员经 UI/运维链路显式触发，不开放给 LLM/扩展的自动化调用（防误触发重启）。
    defineTool(
      'update_check',
      '检查升级：拉取升级 feed，报告当前版本与可用更新。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const check = await ctx.updater.check();
          return ok({ check });
        }),
    ),
    defineTool(
      'update_history',
      '读取升级历史（slot 发布记录）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const history = await ctx.updater.history();
          return ok({ history });
        }),
    ),

    // ------------------------------------------------------------ system ----
    defineTool(
      'system_info',
      '内核运行时信息（版本、运行时长、Node 版本、时区）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const config = required<{ env: string; timezone: string }>(ctx, CONTAINER_KEYS.config);
          return ok({
            info: {
              name: 'opptrix-harness',
              env: config.env,
              version: '0.1.0',
              uptimeMs: Math.round(process.uptime() * 1000),
              node: process.versions.node,
              timezone: config.timezone,
              state: ctx.kernel.isReady() ? 'ready' : ctx.kernel.state(),
            },
          });
        }),
    ),
    defineTool(
      'system_doctor',
      '运行环境体检（磁盘 / Node 版本 / 内存 / 数据目录可写等检查项）。',
      {},
      (args, ctx) =>
        guard(async () => {
          void args;
          const config = required<HarnessConfig>(ctx, CONTAINER_KEYS.config);
          const report = await runDoctor(config);
          return ok({ report });
        }),
    ),

    // -------------------------------------------------------- subagents ----
    // 子代理 MCP 工具面（LLM 驱动核心的**委派机制**）。树形运行时落
    // src/kernel/agents/（SubagentManager/runner），本目录只做「参数校验 + 委派 +
    // 结果归一」，经 ctx.kernel 容器按 SUBAGENT_MANAGER_CONTAINER_KEYS 容错延迟绑定。
    //
    // 安全（JSDoc 即契约）：
    // - **全部以内核 admin 身份执行**（/mcp 门禁 root|admin 或 mcp:call scope、
    //   h.mcp 的 mcp:client 权限在入口裁决，见 system-server.ts 信任模型）；
    // - **树断言**：subagent 的 status/result/transcript 读取统一经
    //   manager.assertDirectParent(agentId, 'main')——MCP 层调用方恒为主会话
    //   （caller='main'：外部 LLM 经 /mcp、扩展经 h.mcp 到达皆同，管理器侧放行 main）；
    //   非 main 调用方（一级子代理在其自身循环内读取时）由同一断言拒绝兄弟/孙辈
    //   （HARNESS-1007 FORBIDDEN），本工具面忠实透传该拒绝；
    // - **深度规则**：MCP 工具只能创建 depth=1（parentId 恒 'main'）——跨代语义不在
    //   MCP 层表达；二级子代理由一级子代理在其自身循环内经 runner 下发的工具白名单
    //   创建（manager 强制 maxDepth=2，depth 3 被拒）。
    defineTool(
      'subagent_spawn',
      '派生一个子代理异步执行任务（立即返回 agentId 与 status；并发槽满时 status=queued 排队；MCP 层视为主会话委派，子代理固定挂在 main 之下，depth=1；模型缺省按 显式 model → subagents.defaultModel 设置 → 第一可用 provider 模型 解析）。',
      {
        prompt: z.string().min(1).max(SUBAGENT_PROMPT_MAX_BYTES),
        systemPrompt: z.string().min(1).max(SUBAGENT_PROMPT_MAX_BYTES).optional(),
        model: z.string().min(1).max(256).optional(),
        toolNames: z.array(z.string().min(1).max(256)).max(64).optional(),
        maxIterations: z.number().int().min(1).max(1000).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const prompt = String(args['prompt']);
          // 字节精确校验（zod max 按 UTF-16 码元计，多字节字符可绕过，此处兜底 64KB）
          const promptBytes = Buffer.byteLength(prompt, 'utf8');
          if (promptBytes > SUBAGENT_PROMPT_MAX_BYTES) {
            return fail('HARNESS-1005', `prompt exceeds ${SUBAGENT_PROMPT_MAX_BYTES} bytes`, {
              bytes: promptBytes,
              maxBytes: SUBAGENT_PROMPT_MAX_BYTES,
            });
          }
          const record = await manager.spawn({
            parentId: 'main', // MCP 层恒为主会话委派（depth=1；跨代由一级子代理在其自身循环内创建）
            prompt,
            ...(args['systemPrompt'] !== undefined ? { systemPrompt: String(args['systemPrompt']) } : {}),
            ...(args['model'] !== undefined ? { model: String(args['model']) } : {}),
            ...(args['toolNames'] !== undefined ? { toolNames: args['toolNames'] as string[] } : {}),
            ...(args['maxIterations'] !== undefined ? { maxIterations: Number(args['maxIterations']) } : {}),
          });
          return ok({ agentId: agentIdOf(record), status: record['status'] ?? 'running', depth: record['depth'] ?? 1 });
        }),
    ),
    defineTool(
      'subagent_status',
      '查询子代理当前状态（status、result?、error?、usage、transcript 进度；内容读取经树断言，兄弟/孙辈访问拒绝）。',
      { agentId: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const agentId = String(args['agentId']);
          await manager.assertDirectParent(agentId, 'main'); // 树断言：caller 恒 'main'；不存在→3004，越权→1007
          const record = await manager.get(agentId);
          if (record === null) {
            return fail('HARNESS-3004', `subagent "${agentId}" not found`, { agentId });
          }
          return ok({
            agentId,
            status: record['status'],
            ...(record['result'] !== undefined && record['result'] !== null ? { result: record['result'] } : {}),
            ...(record['error'] !== undefined && record['error'] !== null ? { error: record['error'] } : {}),
            usage: { in: record['usageIn'] ?? null, out: record['usageOut'] ?? null },
            iterations: typeof record['iterations'] === 'number' ? record['iterations'] : null,
          });
        }),
    ),
    defineTool(
      'subagent_result',
      '读取子代理最终结果（wait=true 时等待至终态再返回，最长 timeoutMs，缺省 120s；内容读取经树断言）。',
      {
        agentId: z.string().min(1).max(128),
        wait: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(SUBAGENT_WAIT_MAX_MS).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const agentId = String(args['agentId']);
          await manager.assertDirectParent(agentId, 'main'); // 树断言：不存在→3004，越权→1007
          const timeoutMs =
            typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : SUBAGENT_WAIT_DEFAULT_MS;
          // 等待面优先委托 manager.waitFor（超时抛 HARNESS-2001 RPC_TIMEOUT，结构视图缺省时
          // 回退本层轮询，行为一致）；wait=false 只读当前快照。
          const withWait = manager as SubagentManagerLike & {
            waitFor?: (id: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
          };
          let record: Record<string, unknown> | null;
          if (args['wait'] === true) {
            if (typeof withWait.waitFor === 'function') {
              record = await withWait.waitFor(agentId, timeoutMs);
            } else {
              // 回退轮询：与 manager.waitFor 同语义（超时 → HARNESS-2001，不存在 → HARNESS-3004）
              const deadline = Date.now() + timeoutMs;
              record = await manager.get(agentId);
              while (record !== null && !isTerminalSubagentStatus(record['status'])) {
                if (Date.now() >= deadline) {
                  return fail(
                    'HARNESS-2001',
                    `subagent "${agentId}" did not reach a terminal state within ${timeoutMs}ms`,
                    { agentId, status: record['status'], timeoutMs },
                  );
                }
                await sleep(SUBAGENT_POLL_INTERVAL_MS);
                record = await manager.get(agentId);
              }
            }
          } else {
            record = await manager.get(agentId);
          }
          if (record === null) {
            return fail('HARNESS-3004', `subagent "${agentId}" not found`, { agentId });
          }
          return ok({
            agentId,
            status: record['status'],
            ...(record['result'] !== undefined && record['result'] !== null ? { result: record['result'] } : {}),
            ...(record['error'] !== undefined && record['error'] !== null ? { error: record['error'] } : {}),
          });
        }),
    ),
    defineTool(
      'subagent_list',
      '列出子代理（可按 parentId / status 过滤；树形可观测与审计用）。',
      {
        parentId: z.string().min(1).max(128).optional(),
        status: z.enum(SUBAGENT_STATUSES).optional(),
      },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const filter: { parentId?: string; status?: string } = {};
          if (args['parentId'] !== undefined) filter.parentId = String(args['parentId']);
          if (args['status'] !== undefined) filter.status = String(args['status']);
          const agents = await manager.list(Object.keys(filter).length > 0 ? filter : undefined);
          return ok({ agents, total: agents.length });
        }),
    ),
    defineTool(
      'subagent_cancel',
      '取消子代理（queued/running → cancelled；终态幂等返回 cancelled=false；协作式中断 runner）。',
      { agentId: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const agentId = String(args['agentId']);
          const cancelled = (await manager.cancel(agentId)) === true;
          return ok({ agentId, cancelled });
        }),
    ),
    defineTool(
      'subagent_transcript',
      '读取子代理完整消息轨迹 transcript（审计用；内容读取经树断言，兄弟/孙辈访问拒绝）。',
      { agentId: z.string().min(1).max(128) },
      (args, ctx) =>
        guard(async () => {
          const manager = resolveSubagentManager(ctx);
          if (manager === undefined) return subagentManagerMissing();
          const agentId = String(args['agentId']);
          await manager.assertDirectParent(agentId, 'main'); // 树断言：不存在→3004，越权→1007
          // transcript 读取面：优先 manager.transcript(agentId)（若实现提供）；
          // 缺省回退 get(agentId) 记录上的 transcript 字段（容错延迟绑定，形状不变）。
          const withTranscript = manager as SubagentManagerLike & {
            transcript?: (id: string) => Promise<unknown>;
          };
          if (typeof withTranscript.transcript === 'function') {
            return ok({ agentId, transcript: (await withTranscript.transcript(agentId)) ?? [] });
          }
          const record = await manager.get(agentId);
          if (record === null) {
            return fail('HARNESS-3004', `subagent "${agentId}" not found`, { agentId });
          }
          return ok({ agentId, transcript: record['transcript'] ?? [] });
        }),
    ),
  ];
}

// ---------------------------------------------------------------------------
// 技能激活工具（skill_ 域）——两层技能注入的激活面
// ---------------------------------------------------------------------------

/**
 * skill_* 激活工具的依赖注入面（**直接注入模式**，与 createExtractTools 同款）：
 * `activation` 缺省 = 进程内共享单例（sharedSkillActivationSession）——工具执行
 * （LLM 调 skill_activate）与 system prompt 组装方（assembleSystemPrompt 的调用方）
 * 必须读到同一份登记表；多实例/测试场景经此注入隔离实例。
 * 技能注册表不走此面：与 skills_list 等一致，经容器键 CONTAINER_KEYS.skillsRegistry
 * 懒解析（未登记 → INTERNAL，提示装配缺失）。
 */
export type SkillActivationToolsDeps = { activation?: SkillActivationSession };

/**
 * 构建技能激活工具目录（skill_activate / skill_list_activated）。
 *
 * 两层技能注入（见 src/kernel/agents/skill-catalog.ts 模块注释）：
 * - 短目录（buildSkillCatalog）恒入 system prompt，模型据此发现技能；
 * - 本工具面是**第二层的登记入口**：激活只登记名字（正文不随工具结果回传，防重复
 *   膨胀上下文），组装方在 runner 组装 system prompt 时按登记表经
 *   buildActivatedSkillsPrompt 注入消毒后的正文；
 * - 会话语义：ctx.agentId 即会话 id（chat 会话或子代理 id，与 workspace_* 同款）；
 *   缺失（外部 /mcp 直调等无会话场景）→ 收敛 no session context，不落登记。
 */
export function createSkillActivationTools(
  getDeps?: () => SkillActivationToolsDeps | undefined,
): SystemTool[] {
  return [
    defineTool(
      'skill_activate',
      '激活一个技能：把该技能的完整指引正文登记进当前会话（每会话最多 '
        + `${MAX_ACTIVATED_SKILLS_PER_SESSION} 个，重复激活幂等）。激活后正文将在后续轮次的 `
        + 'system prompt 中生效；本工具只返回确认与正文长度，不回传正文。',
      { name: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN, `name must match ${SKILL_NAME_PATTERN.source}`) },
      (args, ctx) =>
        guard(async () => {
          const activation = getDeps?.()?.activation ?? sharedSkillActivationSession();
          const sessionId = agentScopeIdOf(ctx);
          if (sessionId === undefined) return noSessionContext();
          const registry = required<{
            get(id: string): Promise<{ entry: unknown; body: string } | null>;
          }>(ctx, CONTAINER_KEYS.skillsRegistry);
          const name = String(args['name']);
          const found = await registry.get(name);
          if (found === null) {
            return fail('HARNESS-3004', `skill "${name}" not found (see skills_list for the catalog)`, {
              id: name,
            });
          }
          const outcome = activation.activate(sessionId, name);
          if (outcome.ok) activation.cacheBody(sessionId, name, found.body);
          if (!outcome.ok) {
            return fail(
              'VALIDATION',
              `skill activation limit reached: at most ${MAX_ACTIVATED_SKILLS_PER_SESSION} skills may be active per session (already active: ${outcome.activated.join(', ')})`,
              { activated: outcome.activated },
            );
          }
          return ok({
            name,
            activated: outcome.activated,
            total: outcome.activated.length,
            contentLength: found.body.length,
          });
        }),
    ),
    defineTool(
      'skill_list_activated',
      '列出当前会话已激活的技能清单（激活登记见 skill_activate；不含正文）。',
      {},
      (_args, ctx) =>
        guard(async () => {
          void _args;
          const activation = getDeps?.()?.activation ?? sharedSkillActivationSession();
          const sessionId = agentScopeIdOf(ctx);
          if (sessionId === undefined) return noSessionContext();
          const names = activation.list(sessionId);
          return ok({ names, total: names.length });
        }),
    ),
  ];
}
