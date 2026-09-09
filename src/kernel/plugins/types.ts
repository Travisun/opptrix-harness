/**
 * plugins/types — 插件包（Plugin Package）格式契约与 plugin.json 校验。
 *
 * 插件包参考 Codex CLI 的声明式扩展包思路：**提示词（skills/prompts）+ MCP 声明 +
 * 可执行脚本**，全部由一份 `plugin.json` 清单描述，装在 `<dataDir>/plugins/<id>/` 下：
 *
 * ```
 * <plugin-id>/
 * ├─ plugin.json      # 清单（本文件 zod 全量校验）
 * ├─ skills/...       # SKILL.md 们（清单 skills[].file 指向）
 * ├─ prompts/...
 * └─ scripts/...      # node 脚本（由执行沙箱容器运行，绝不在宿主进程执行）
 * ```
 *
 * 持久与升级语义（重要约定）：插件装在 `<dataDir>/plugins/`。内核 A/B 升级**只替换
 * releases/slot 目录，绝不触碰 /data/plugins**；内核升级后由集成层调用
 * `PluginRegistry.refresh()` 重新聚合插件并重建贡献注入（skills / MCP servers）。
 *
 * 校验规则：
 * - `id`：`/^[a-z0-9][a-z0-9_-]{0,63}$/`（同时保证可安全作为目录名）；
 * - `version`：严格 semver（semver.valid 非空，如 "1.2.3"）；
 * - 数量上限：skills ≤32 / prompts ≤64 / scripts ≤16 / mcpServers ≤8；
 * - skills 条目二选一：内联 `body` 或 `file`（必须位于 `skills/` 下）；
 * - scripts[].file 必须位于 `scripts/` 下；
 * - mcpServers：stdio 须带 `command`，streamable-http/sse 须带 http(s) `url`。
 *
 * 校验失败统一抛 `HarnessError('VALIDATION_FAILED')`（detail 为 zod issues）。
 */
import { z } from 'zod';
import semver from 'semver';

import { err } from '../errors/index.js';

// ---------------------------------------------------------------------------
// 常量与正则
// ---------------------------------------------------------------------------

/** 插件包顶层 id（同时是目录名）：小写字母/数字开头，仅小写字母数字下划线连字符 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 插件内子资源（skill/prompt/script/mcp server）id：与顶层同规则但允许单字符 */
export const PLUGIN_NESTED_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 单插件资源数量上限（防单个插件包拖垮聚合层） */
export const PLUGIN_LIMITS = {
  skills: 32,
  prompts: 64,
  scripts: 16,
  mcpServers: 8,
} as const;

/** skill 文件引用必须落在插件包的 `skills/` 目录下 */
const SKILL_FILE_PREFIX = 'skills/';
/** script 文件引用必须落在插件包的 `scripts/` 目录下 */
const SCRIPT_FILE_PREFIX = 'scripts/';

/** 单条内联文本（skill body / prompt body）大小上限 */
const MAX_BODY_CHARS = 128 * 1024;

// ---------------------------------------------------------------------------
// 相对路径安全（清单 file 字段与 zip 成员共用）
// ---------------------------------------------------------------------------

/**
 * 判断路径是否为插件包内安全的相对路径：
 * 禁绝对路径、Windows 盘符、NUL、以及 '' / '.' / '..' 段（防路径穿越）。
 * 注意：反斜杠一律视为非法（清单按 POSIX 风格书写；zip 成员由 installer 归一化后再过此闸）。
 */
export function isSafePluginRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p === '') return false;
  if (p.includes('\0') || p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** file 引用的公共 zod 基础（安全相对路径） */
const safeRelPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(isSafePluginRelativePath, {
    error: 'must be a relative path inside the plugin package (no absolute path, drive letter, or ".." segment)',
  });

// ---------------------------------------------------------------------------
// 子资源 schema
// ---------------------------------------------------------------------------

/** skills 条目：内联 body 或 skills/ 下文件引用（二选一） */
const skillEntrySchema = z
  .object({
    id: z.string().regex(PLUGIN_NESTED_ID_PATTERN, {
      error: `skill id must match ${PLUGIN_NESTED_ID_PATTERN.source}`,
    }),
    name: z.string().min(1).max(128).optional(),
    description: z.string().min(1).max(1024).optional(),
    body: z.string().min(1).max(MAX_BODY_CHARS).optional(),
    file: safeRelPathSchema.optional(),
  })
  .refine((s) => (s.body !== undefined) !== (s.file !== undefined), {
    error: 'skill entry must define exactly one of "body" (inline markdown) or "file" (a path under skills/)',
  })
  .refine((s) => s.file === undefined || s.file.startsWith(SKILL_FILE_PREFIX), {
    error: `skill "file" must live under "${SKILL_FILE_PREFIX}" inside the plugin package`,
  });

/** prompts 条目：内联提示词（body 必填） */
const promptEntrySchema = z.object({
  id: z.string().regex(PLUGIN_NESTED_ID_PATTERN, {
    error: `prompt id must match ${PLUGIN_NESTED_ID_PATTERN.source}`,
  }),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024).optional(),
  body: z.string().min(1).max(MAX_BODY_CHARS),
});

/** scripts 条目：scripts/ 下的可执行脚本（由执行沙箱容器运行，非宿主） */
const scriptEntrySchema = z
  .object({
    id: z.string().regex(PLUGIN_NESTED_ID_PATTERN, {
      error: `script id must match ${PLUGIN_NESTED_ID_PATTERN.source}`,
    }),
    file: safeRelPathSchema,
    /** 容器内入口（缺省由执行沙箱按 file 推断；如 `node scripts/x.js` 的脚本路径） */
    entry: z.string().min(1).max(256).optional(),
  })
  .refine((s) => s.file.startsWith(SCRIPT_FILE_PREFIX), {
    error: `script "file" must live under "${SCRIPT_FILE_PREFIX}" inside the plugin package`,
  });

/** mcpServers 条目：stdio 或远程（streamable-http/sse）MCP 服务器声明 */
const mcpServerEntrySchema = z
  .object({
    id: z.string().regex(PLUGIN_NESTED_ID_PATTERN, {
      error: `mcp server id must match ${PLUGIN_NESTED_ID_PATTERN.source}`,
    }),
    name: z.string().min(1).max(128),
    transport: z.enum(['stdio', 'streamable-http', 'sse']),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(1024)).max(64).optional(),
    url: z.string().min(1).max(2048).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (s) =>
      s.transport === 'stdio'
        ? typeof s.command === 'string' && s.command.length > 0
        : typeof s.url === 'string' && /^https?:\/\//i.test(s.url),
    {
      error: 'mcp server: transport "stdio" requires "command"; "streamable-http"/"sse" require an http(s) "url"',
    },
  );

// ---------------------------------------------------------------------------
// 清单 schema 与类型
// ---------------------------------------------------------------------------

/** plugin.json 的 zod schema（未知键剥离，向前兼容） */
export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_PATTERN, {
    error: `plugin id must match ${PLUGIN_ID_PATTERN.source} (lowercase letters, digits, "-" or "_"; it is also the install directory name)`,
  }),
  name: z.string().min(1).max(128),
  version: z.string().refine((v) => semver.valid(v) !== null, {
    error: 'plugin version must be valid semver (e.g. "1.2.3")',
  }),
  description: z.string().min(1).max(2048).optional(),
  author: z.string().min(1).max(256).optional(),
  skills: z.array(skillEntrySchema).max(PLUGIN_LIMITS.skills).default([]),
  prompts: z.array(promptEntrySchema).max(PLUGIN_LIMITS.prompts).default([]),
  scripts: z.array(scriptEntrySchema).max(PLUGIN_LIMITS.scripts).default([]),
  mcpServers: z.array(mcpServerEntrySchema).max(PLUGIN_LIMITS.mcpServers).default([]),
});

/** plugin.json 清单（校验后形状） */
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 清单中单条 skill 声明 */
export type PluginSkillSpec = PluginManifest['skills'][number];
/** 清单中单条 prompt 声明 */
export type PluginPromptSpec = PluginManifest['prompts'][number];
/** 清单中单条 script 声明 */
export type PluginScriptSpec = PluginManifest['scripts'][number];
/** 清单中单条 MCP server 声明 */
export type PluginMcpServerSpec = PluginManifest['mcpServers'][number];

/**
 * 已安装插件的摘要（installer 返回值 / registry.list()/get(id) 元素）。
 * 安装位置：`<dataDir>/plugins/<id>/`（持久数据，内核 A/B 升级不触碰，见 registry.ts 头注释）。
 */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 贡献的 skill 数 */
  skills: number;
  /** 贡献的 prompt 数 */
  prompts: number;
  /** 声明的 MCP server 数 */
  mcpServers: number;
  /** 声明的可执行脚本数 */
  scripts: number;
  /** 安装时间（UTC ISO8601） */
  installedAt: string;
}

/**
 * 注入 skillsRegistry 的贡献 skill（`registerContributed(extId, skills)` 的元素形状）。
 * file 引用在此阶段已被读为 body（文件内容）。
 */
export interface PluginContributedSkill {
  id: string;
  name: string;
  description: string;
  body: string;
}

/**
 * 注入 mcpRegistry 的 server 配置（`addServer(cfg)` 形状）。
 * id 由 PluginRegistry 冠前缀为 `plugin:<插件id>:<server id>` 以避免与全局 server 冲突。
 */
export interface PluginMcpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

/** skillsRegistry 依赖契约（src/kernel/skills 并行包实现；缺省则跳过 skills 注入） */
export interface SkillsRegistryLike {
  /** 注册一批贡献 skills；返回注入条数 */
  registerContributed(extId: string, skills: PluginContributedSkill[]): number;
  /** 摘除某贡献方的全部 skills（幂等，未注册时静默） */
  removeContributed(extId: string): void;
}

/** mcpRegistry 依赖契约（src/kernel/mcp 并行包实现；缺省则跳过 MCP 注入） */
export interface McpRegistryLike {
  /** 注册（或覆盖同 id）MCP server */
  addServer(cfg: PluginMcpServerConfig): unknown;
  /** 按 id 摘除 server；返回是否确实摘除 */
  removeServer(id: string): boolean;
}

/** scriptRunner 依赖契约（执行沙箱集成注入；脚本在沙箱容器内执行，非宿主进程） */
export interface ScriptRunnerLike {
  run(pluginId: string, scriptId: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

// ---------------------------------------------------------------------------
// 校验入口
// ---------------------------------------------------------------------------

/**
 * 校验并规整 plugin.json 原始值。
 * @throws HarnessError('VALIDATION_FAILED') detail 为 zod issues（含路径/上限说明）
 */
export function validatePluginManifest(raw: unknown): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw err('VALIDATION_FAILED', {
      message: 'plugin.json is invalid',
      detail: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** 由清单构造 InstalledPlugin 摘要（installer 与 registry 共用） */
export function toInstalledPlugin(manifest: PluginManifest, installedAt: string): InstalledPlugin {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    skills: manifest.skills.length,
    prompts: manifest.prompts.length,
    mcpServers: manifest.mcpServers.length,
    scripts: manifest.scripts.length,
    installedAt,
  };
}
