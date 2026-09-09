/**
 * Mcp/json-import — 「粘贴 JSON 配置」识别与 headers 粘贴解析的纯函数集。
 *
 * 设计约束：**零导入**（不依赖 React / `@/` 别名 / DOM）——本文件同时被两条工具链消费：
 * - ui-src（vite + tsc，`@/` 别名可用但刻意不用）；
 * - 根 vitest（node 环境，test/mcp-json-import.test.ts 经相对路径直测）。
 *
 * 兼容三种粘贴形状（create Dialog 的「粘贴 JSON 配置」Tab）：
 * ① 单服务器对象 `{ transport|type, command|url, args?, env?, headers? }` —— 兼容
 *    Claude Desktop / Cursor 的 `type` 词汇（'stdio' | 'sse' | 'http'），映射
 *    type→transport（'http' / 'streamable-http' → streamable-http）；
 * ② `{ mcpServers: { <id>: {...} } }` —— Claude Desktop 官方格式，展开为候选列表
 *    供用户勾选导入（解析失败条目列入 skipped 摘要）；
 * ③ 已是本系统形状（`transport` 词汇 + name/id/timeoutMs）。
 *
 * 另含 headers 粘贴解析（编辑 Dialog 的「粘贴 JSON」模式）与表单填充辅助
 * （args→命令行文本、id 去重）。`slugifyId` / `MCP_ID_PATTERN` 与
 * `@/pages/Mcp/shared` 同规则镜像（为保持零导入而本地实现）。
 */

/** 传输形态（与本系统 McpTransport 一致；Claude 的 'http' 词汇归一为 streamable-http） */
export type ImportTransport = 'stdio' | 'streamable-http' | 'sse';

/** 识别成功后填充表单的服务器草稿（未提供的可选项为空值） */
export interface PastedServerDraft {
  /** 建议名称（mcpServers 键 / raw.name；缺省空串由用户补填） */
  name: string;
  /** 建议 id（mcpServers 键 / raw.id；仅当匹配 id 形态时携带，否则 null=留空自动生成） */
  id: string | null;
  transport: ImportTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number | null;
}

/** mcpServers 形状的候选条目（多选导入用；id 为 mcpServers 的键） */
export interface ImportCandidate {
  id: string;
  draft: PastedServerDraft;
}

/** 粘贴识别结果：单服务器（直接填充表单）/ 多候选（勾选导入）/ 失败（含缺失字段清单） */
export type JsonImportOutcome =
  | { ok: true; kind: 'single'; draft: PastedServerDraft; summary: string }
  | { ok: true; kind: 'multi'; candidates: ImportCandidate[]; skipped: string[]; summary: string }
  | { ok: false; message: string; missing: string[] };

/** headers 粘贴解析结果 */
export type HeadersParseResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; message: string };

/** server id 形态约束（与内核 MCP_ID_PATTERN、@/pages/Mcp/shared 同规则镜像） */
export const MCP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** timeoutMs 允许区间（与内核、@/pages/Mcp/shared 一致） */
export const MCP_TIMEOUT_MIN_MS = 1_000;
export const MCP_TIMEOUT_MAX_MS = 600_000;

// ---------------------------------------------------------------------------
// 基础纯函数
// ---------------------------------------------------------------------------

/** plain object 判定（排除 null / 数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 名称 → 建议 id（小写、非法字符折叠为连字符、去首尾连字符、截断 64；shared.tsx 镜像） */
export function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+/, '')
    .replace(/[-_]+$/, '')
    .slice(0, 64);
}

/**
 * transport/type 词汇归一：接受本系统 'stdio' | 'streamable-http' | 'sse' 与
 * Claude Desktop / Cursor 的 'http'（→ streamable-http）；下划线/空白折叠为连字符，
 * 大小写不敏感。未知词汇返回 null（计入缺失/不支持清单）。
 */
export function normalizeTransportKey(raw: unknown): ImportTransport | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (key === 'stdio') return 'stdio';
  if (key === 'sse') return 'sse';
  if (key === 'http' || key === 'streamable-http') return 'streamable-http';
  return null;
}

/**
 * 字符串记录解析（env / headers 通用）：值为 string 原样保留，number/boolean 宽容
 * String() 化（Claude 导出偶见端口类数值），嵌套对象/数组/null 拒绝。
 */
function parseStringRecord(
  value: unknown,
  label: string,
): { ok: true; value: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) {
    return { ok: false, message: `${label} 需为对象（如 {"KEY":"value"}）` };
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      out[key] = item;
      continue;
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item);
      continue;
    }
    return { ok: false, message: `${label} 的「${key}」值需为字符串（当前为 ${item === null ? 'null' : Array.isArray(item) ? '数组' : '对象'}）` };
  }
  return { ok: true, value: out };
}

/** 字符串数组解析（args）：全为字符串才通过（对齐内核 `args: array(string())`） */
function parseStringArray(
  value: unknown,
  label: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: `${label} 需为字符串数组（如 ["--port","8080"]）` };
  }
  for (let i = 0; i < value.length; i += 1) {
    if (typeof value[i] !== 'string') {
      return { ok: false, message: `${label}[${i}] 需为字符串` };
    }
  }
  return { ok: true, value: value as string[] };
}

// ---------------------------------------------------------------------------
// 单服务器配置 → 草稿（形状 ① / ③ 的核心，mcpServers 条目复用）
// ---------------------------------------------------------------------------

type DraftResult = { ok: true; draft: PastedServerDraft } | { ok: false; missing: string[]; message: string | null };

/** 从原始配置对象装配草稿；缺失必填字段时返回 missing 清单（fail 死缺清单，不做半填充） */
function draftFromConfig(raw: Record<string, unknown>, fallbackName: string, fallbackId: string | null): DraftResult {
  const missing: string[] = [];
  const unsupported: string[] = [];

  // transport 解析优先级：transport（本系统形状）> type（Claude/Cursor 词汇）>
  // command 推断（仅 command 的配置必为 stdio）；其余视为缺失/不支持词汇
  const hasTransportKey = raw['transport'] !== undefined;
  const hasTypeKey = raw['type'] !== undefined;
  let transport: ImportTransport | null = normalizeTransportKey(raw['transport']);
  if (transport === null && hasTypeKey) transport = normalizeTransportKey(raw['type']);
  if (transport === null) {
    if (hasTransportKey && typeof raw['transport'] !== 'string') {
      missing.push('transport 需为字符串');
    } else if (hasTypeKey && typeof raw['type'] !== 'string') {
      missing.push('type 需为字符串');
    } else if (hasTransportKey || hasTypeKey) {
      const vocab = hasTransportKey ? raw['transport'] : raw['type'];
      unsupported.push(`「${String(vocab)}」不是受支持的传输词汇（可用：stdio / sse / http / streamable-http）`);
    } else if (typeof raw['command'] === 'string' && raw['command'].trim() !== '') {
      transport = 'stdio'; // 仅 command 的粘贴 → 唯一可能的传输形态
    } else {
      missing.push('transport 或 type（stdio / sse / http）');
    }
  }

  // env / headers / args 先行解析（结构错误即使 transport 已失败也要一并列出）
  let env: Record<string, string> = {};
  let headers: Record<string, string> = {};
  let args: string[] = [];
  const envRes = parseStringRecord(raw['env'], 'env');
  if (!envRes.ok) missing.push(envRes.message);
  else env = envRes.value;
  const headersRes = parseStringRecord(raw['headers'], 'headers');
  if (!headersRes.ok) missing.push(headersRes.message);
  else headers = headersRes.value;
  const argsRes = parseStringArray(raw['args'], 'args');
  if (!argsRes.ok) missing.push(argsRes.message);
  else args = argsRes.value;

  let command = '';
  let url = '';
  if (transport === 'stdio') {
    const rawCommand = raw['command'];
    if (typeof rawCommand !== 'string' || rawCommand.trim() === '') {
      missing.push('command（stdio 必填）');
    } else if (rawCommand.length > 2048) {
      missing.push('command 过长（≤2048 字符）');
    } else {
      command = rawCommand.trim();
    }
  } else if (transport === 'streamable-http' || transport === 'sse') {
    const rawUrl = raw['url'];
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      missing.push(`url（${transport} 必填，http/https）`);
    } else if (!/^https?:\/\//i.test(rawUrl.trim())) {
      missing.push('url 需以 http:// 或 https:// 开头');
    } else {
      url = rawUrl.trim();
    }
  }

  // timeoutMs：提供时必须为区间内的有限数值（无法安全落库的值直接报缺失）
  let timeoutMs: number | null = null;
  const rawTimeout = raw['timeoutMs'];
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isFinite(rawTimeout) || !Number.isInteger(rawTimeout)) {
      missing.push('timeoutMs 需为整数毫秒');
    } else if (rawTimeout < MCP_TIMEOUT_MIN_MS || rawTimeout > MCP_TIMEOUT_MAX_MS) {
      missing.push(`timeoutMs 允许 ${MCP_TIMEOUT_MIN_MS} - ${MCP_TIMEOUT_MAX_MS} 毫秒`);
    } else {
      timeoutMs = rawTimeout;
    }
  }

  if (missing.length > 0 || unsupported.length > 0 || transport === null) {
    return { ok: false, missing: [...missing, ...unsupported], message: null };
  }

  const rawName = raw['name'];
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : fallbackName;
  const rawId = raw['id'];
  const id =
    fallbackId !== null && MCP_ID_PATTERN.test(fallbackId)
      ? fallbackId
      : typeof rawId === 'string' && MCP_ID_PATTERN.test(rawId)
        ? rawId
        : null;

  return {
    ok: true,
    draft: {
      name,
      id,
      transport,
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? args : [],
      env: transport === 'stdio' ? env : {},
      url,
      headers: transport === 'stdio' ? {} : headers,
      timeoutMs,
    },
  };
}

/** 草稿 → 一行识别摘要（识别成功提示用） */
export function describeDraft(draft: PastedServerDraft): string {
  const target =
    draft.transport === 'stdio'
      ? [draft.command, ...draft.args].join(' ')
      : draft.url;
  const extras: string[] = [];
  if (draft.transport === 'stdio' && Object.keys(draft.env).length > 0) {
    extras.push(`env ${Object.keys(draft.env).length} 项`);
  }
  if (draft.transport !== 'stdio' && Object.keys(draft.headers).length > 0) {
    extras.push(`headers ${Object.keys(draft.headers).length} 项`);
  }
  if (draft.timeoutMs !== null) extras.push(`timeout ${draft.timeoutMs}ms`);
  const suffix = extras.length > 0 ? ` · ${extras.join(' · ')}` : '';
  return `${draft.transport} · ${target}${suffix}`;
}

// ---------------------------------------------------------------------------
// 三形状识别入口
// ---------------------------------------------------------------------------

/** 粘贴文本 → 识别结果（三形状自动识别；失败携带缺失字段清单） */
export function parsePastedServerConfig(text: string): JsonImportOutcome {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, message: '请先粘贴 JSON 配置', missing: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const reason = e instanceof Error ? e.message : '解析失败';
    return { ok: false, message: `不是合法的 JSON：${reason}`, missing: [] };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, message: 'JSON 顶层需为对象（{...}），例如 { "mcpServers": ... } 或单个服务器配置', missing: [] };
  }

  // 形状 ②：{ mcpServers: { <id>: {...} } }（Claude Desktop 官方格式）
  if (isPlainObject(parsed['mcpServers'])) {
    const entries = Object.entries(parsed['mcpServers']);
    if (entries.length === 0) {
      return { ok: false, message: 'mcpServers 为空：至少需要一个服务器条目', missing: [] };
    }
    const candidates: ImportCandidate[] = [];
    const skipped: string[] = [];
    for (const [key, value] of entries) {
      if (!isPlainObject(value)) {
        skipped.push(`${key}（条目需为对象）`);
        continue;
      }
      const res = draftFromConfig(value, key, key);
      if (res.ok) {
        const candidateId = res.draft.id ?? (slugifyId(key) !== '' ? slugifyId(key) : slugifyId(key.slice(0, 32)));
        candidates.push({ id: candidateId, draft: res.draft });
      } else {
        skipped.push(`${key}（缺 ${res.missing.join('；')}）`);
      }
    }
    if (candidates.length === 0) {
      const firstKey = entries[0]?.[0] ?? '';
      return {
        ok: false,
        message: `mcpServers 中没有可识别的服务器条目（${entries.length} 个全部失败，首个「${firstKey}」见缺失项）`,
        missing: skipped,
      };
    }
    const names = candidates.map((c) => c.draft.name || c.id);
    return {
      ok: true,
      kind: 'multi',
      candidates,
      skipped,
      summary: `识别为 mcpServers 批量配置：${candidates.length} 个可导入（${names.join('、')}）${skipped.length > 0 ? `；跳过 ${skipped.length} 个无法识别的条目` : ''}`,
    };
  }

  // 形状 ① / ③：单服务器对象（transport 或 type / command 或 url 任一在场即尝试识别）
  const looksLikeServer =
    parsed['transport'] !== undefined ||
    parsed['type'] !== undefined ||
    parsed['command'] !== undefined ||
    parsed['url'] !== undefined;
  if (!looksLikeServer) {
    return {
      ok: false,
      message: '无法识别的粘贴形状：既不是 {mcpServers:...}，也不含 transport/type/command/url 字段',
      missing: ['transport 或 type', 'command 或 url'],
    };
  }
  const fallbackName = typeof parsed['name'] === 'string' ? parsed['name'] : '';
  const fallbackId = typeof parsed['id'] === 'string' ? parsed['id'] : null;
  const res = draftFromConfig(parsed, fallbackName, fallbackId);
  if (!res.ok) {
    return { ok: false, message: '识别到单服务器配置，但缺少必填字段', missing: res.missing };
  }
  return {
    ok: true,
    kind: 'single',
    draft: res.draft,
    summary: `识别为单服务器配置：${describeDraft(res.draft)}`,
  };
}

// ---------------------------------------------------------------------------
// headers 粘贴（编辑 Dialog 的「粘贴 JSON」模式）
// ---------------------------------------------------------------------------

/**
 * headers 粘贴解析：`{"X-API-Key":"...","Authorization":"Bearer ..."}` 形状 →
 * Record<string,string>。空对象合法（整表清空语义由调用方决定）。
 */
export function parseHeadersJson(text: string): HeadersParseResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, message: '请先粘贴 JSON（如 {"Authorization":"Bearer xxx"}）' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    const reason = e instanceof Error ? e.message : '解析失败';
    return { ok: false, message: `不是合法的 JSON：${reason}` };
  }
  return parseStringRecord(parsed, 'headers');
}

// ---------------------------------------------------------------------------
// 表单填充辅助
// ---------------------------------------------------------------------------

/**
 * args 数组 → 命令行输入文本（tokenizeArgs 的逆）：含空白/引号的参数用双引号包裹
 * 并转义 `"` 与 `\`，保证回填后再分词结果一致。
 */
export function argsToText(args: string[]): string {
  return args
    .map((arg) => {
      if (arg === '') return '""';
      if (/[\s"\\]/.test(arg)) return `"${arg.replace(/([\\"])/g, '\\$1')}"`;
      return arg;
    })
    .join(' ');
}

/** id 占位去重：与 existing 冲突时追加 -2、-3…（批量导入用；结果仍满足 id 形态与长度） */
export function dedupeId(base: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const stem = (MCP_ID_PATTERN.test(base) ? base : slugifyId(base) || 'mcp-server').slice(0, 60);
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
