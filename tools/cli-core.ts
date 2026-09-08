/**
 * CLI 可测核心：扩展脚手架（make:extension）与扩展校验（validate）。
 *
 * 本模块不含任何 process.argv / process.exit 逻辑，全部输入输出走参数与返回值，
 * 由 tools/cli.ts（薄入口）负责命令行编排，由 test/cli.test.ts 直接单测。
 *
 * 并行包依赖：`src/kernel/extensions/manifest.ts` 提供 validateManifest /
 * validatePermissions / checkApiCompat（三者失败均抛 HarnessError）。
 * 本模块用 {@link attempt} 统一接住抛错并从 HarnessError.detail 提取
 * zod issues，把「首错即停」收敛为「一次给出完整错误清单」。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { err, HarnessError } from '../src/kernel/errors/index.js';
import { checkApiCompat, validateManifest, validatePermissions } from '../src/kernel/extensions/manifest.js';

/** 校验结果的统一形状 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** 合法扩展 ID：与内核 storage/db.ts 的 EXT_ID_PATTERN、manifest schema 的 id 正则一致 */
const EXT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** manifest 固定骨架版本 */
const SCAFFOLD_API = 1;
const SCAFFOLD_VERSION = '0.1.0';
const SCAFFOLD_MAIN = 'index.js';

// ---------------------------------------------------------------------------
// make:extension
// ---------------------------------------------------------------------------

/**
 * 在 `<targetDir>/<id>/` 下生成扩展骨架三件套：
 * manifest.json / index.js / README.md。
 *
 * - 幂等保护：目标目录已存在时抛错（绝不覆盖既有文件）。
 * - id 规则与内核一致：`/^[a-z0-9][a-z0-9._-]*$/`（天然排除路径注入）。
 *
 * @param targetDir 扩展根目录（通常是仓库的 `extensions/`；相对路径基于 cwd 解析）
 * @param id 扩展 ID（manifest.id）
 * @returns 新建文件的绝对路径列表
 * @throws HarnessError（EXT_MANIFEST_INVALID）id 非法或目标目录已存在
 */
export async function makeExtension(targetDir: string, id: string): Promise<{ files: string[] }> {
  if (typeof id !== 'string' || !EXT_ID_PATTERN.test(id)) {
    throw err('EXT_MANIFEST_INVALID', {
      message:
        `extension id "${String(id)}" is invalid: must match ${EXT_ID_PATTERN.source} ` +
        '(lowercase alnum first, then lowercase alnum / dot / underscore / hyphen). ' +
        'Pick another id, e.g. "my-extension".',
      detail: { id, pattern: EXT_ID_PATTERN.source },
    });
  }

  const root = path.resolve(targetDir);
  const extDir = path.join(root, id);
  if (await pathExists(extDir)) {
    throw err('EXT_MANIFEST_INVALID', {
      message:
        `refusing to scaffold: "${extDir}" already exists. ` +
        'Remove it first or pick another id (existing extensions are never overwritten).',
      detail: { extDir },
    });
  }

  const manifest = {
    id,
    api: SCAFFOLD_API,
    version: SCAFFOLD_VERSION,
    main: SCAFFOLD_MAIN,
    permissions: ['http', 'events', 'cron', 'storage', 'ui'] as string[],
    displayName: id,
  };

  const files = [
    { name: 'manifest.json', body: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: SCAFFOLD_MAIN, body: scaffoldIndexJs(id) },
    { name: 'README.md', body: scaffoldReadme(id) },
  ];

  await mkdir(extDir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const abs = path.join(extDir, file.name);
    await writeFile(abs, file.body, 'utf8');
    written.push(abs);
  }
  return { files: written };
}

/** 生成的 index.js 骨架：defineExtension 风格，route + 注释掉的 cron 示例 */
function scaffoldIndexJs(id: string): string {
  return `'use strict';

/**
 * ${id} — Opptrix Harness OS 扩展入口。
 *
 * 由 \`npm run harness -- make:extension ${id}\` 生成。
 * defineExtension 仅在激活期执行一次：route/webhook/on/hook/expose/cron/page/menu
 * 必须在 setup 内注册（激活期之后调用会抛 EXT_REGISTRATION_PHASE）。
 * 完整 API 见仓库 types/harness.d.ts 与同目录 README.md。
 */

defineExtension(async (h) => {
  // HTTP 路由：最终挂载于 /ext/${id}/hello
  h.route('GET', '/hello', async () => ({ hello: 'world' }), { auth: 'public' });

  // 定时任务示例（默认注释；取消注释即启用。5 段 cron，内核默认时区）：
  // h.cron.schedule({ name: 'tick', expr: '*/5 * * * *' }, async () => {
  //   h.log.info('tick from ${id}');
  // });
});
`;
}

/** 生成的 README.md：结构 / h.* API 速览 / 如何启用 */
function scaffoldReadme(id: string): string {
  return `# ${id}

由 \`npm run harness -- make:extension ${id}\` 生成的 Opptrix Harness OS 扩展骨架。

## 目录结构

- \`manifest.json\` — 扩展清单：id / api（契约版本）/ version / main / permissions / displayName
- \`index.js\` — 入口（与 manifest.main 对应）：\`defineExtension((h) => { ... })\`
- \`README.md\` — 本文件

## h.* API 速览（完整类型见仓库 \`types/harness.d.ts\`）

| API | 用途 |
| --- | --- |
| \`h.route(method, path, handler, opts?)\` | HTTP 路由（挂载于 /ext/{id} 前缀） |
| \`h.webhook(path, handler, opts?)\` | HMAC 验签的外部回调 |
| \`h.on(event, handler, opts?)\` | 订阅内核事件（'.' 分段，支持 \`*\`/\`**\`） |
| \`h.hook(point, handler)\` | 注册 hook 埋点处理器 |
| \`h.expose(method, handler)\` / \`h.call(target, payload?)\` | Registry RPC 注册/跨扩展调用 |
| \`h.cron.schedule({ name, expr }, handler)\` | 定时任务（5 段 cron） |
| \`h.notify(input)\` | 发送通知（inbox/webhook/email/console 渠道） |
| \`h.chat.send(input)\` | 聊天出站消息 |
| \`h.files\` / \`h.tasks\` | 文件存储 / CPU 密集长任务 |
| \`h.db.all/get/run/schema\` | 扩展专属 SQLite |
| \`h.llm.chat(input)\` | LLM 网关（OpenAI / Anthropic） |
| \`h.sandbox.exec(input)\` | 沙箱 Workspace 容器执行命令 |
| \`h.system\` / \`h.storage\` / \`h.config\` | 系统信息（只读）/ 私有 KV / 只读配置 |
| \`h.page(def)\` / \`h.menu(def)\` | 注册 UI 页面 / 菜单（等价于 manifest 的 ui.*） |
| \`h.log.debug/info/warn/error\` | 结构化日志（自动附带 extId） |

## 如何启用

1. 本地校验：\`npm run harness -- validate extensions/${id}\`
2. 将目录置于仓库 \`extensions/\` 下（本骨架即在此），由集成方经 webui 扩展管理页
   （/admin）或内核配置启用；扩展在内核启动 / 重载时按启用清单激活。
3. 激活后路由挂载于 \`/ext/${id}\`，UI 页面挂载于 \`/ext/${id}/ui\`。
`;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * 校验扩展目录：manifest 合法性（validateManifest）→ 权限声明（validatePermissions）
 * → API 契约兼容（checkApiCompat）→ main 文件存在性 → `node --check` 语法检查
 * （仅当 main 是 .js）。
 *
 * 收集全部错误而非首错即停（一次给开发者完整清单）；目录/清单不可读也计入 errors。
 *
 * @param extDir 扩展目录（须含 manifest.json）
 * @returns { ok, errors }；ok = errors 为空
 */
export async function validateExtension(extDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const dir = path.resolve(extDir);
  const manifestPath = path.join(dir, 'manifest.json');

  let raw: unknown;
  try {
    const text = await readFile(manifestPath, 'utf8');
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    return { ok: false, errors: [describeManifestError(e, manifestPath)] };
  }

  // 1) manifest 结构与字段（validateManifest 失败抛 EXT_MANIFEST_INVALID，detail 为 zod issues）
  const parsed = await attempt(() => validateManifest(raw));
  if (!parsed.ok) {
    errors.push(...formatFailure('manifest', parsed.message, parsed.detail));
    return { ok: false, errors };
  }
  const manifest = parsed.value;

  // 2) 权限白名单（未知权限 → EXT_MANIFEST_INVALID）
  const perms = await attempt(() => validatePermissions(manifest));
  if (!perms.ok) errors.push(...formatFailure('permissions', perms.message, perms.detail));

  // 3) API 契约版本（api 不在 SUPPORTED_API_VERSIONS → EXT_API_INCOMPATIBLE）
  const compat = await attempt(() => checkApiCompat(manifest));
  if (!compat.ok) errors.push(...formatFailure('api compat', compat.message, compat.detail));

  // 4) main 文件存在性（含路径越界防护：main 不得逃出扩展目录）
  const main: string = manifest.main;
  const absMain = path.resolve(dir, main);
  if (!absMain.startsWith(dir + path.sep)) {
    errors.push(`main "${main}" escapes the extension directory; it must stay inside "${dir}"`);
  } else if (!(await isFile(absMain))) {
    errors.push(`main "${main}" not found at "${absMain}"; create the file or fix manifest.main`);
  } else if (main.endsWith('.js')) {
    // 5) 语法检查（仅 .js；node --check 不执行代码）
    const syntaxError = await nodeCheck(absMain);
    if (syntaxError !== null) errors.push(`syntax check failed for "${main}": ${syntaxError}`);
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 校验函数执行的收敛结果：成功带值，失败带 message + HarnessError.detail */
type AttemptResult<T> = { ok: true; value: T } | { ok: false; message: string; detail: unknown };

/** 执行校验函数；抛错（含 HarnessError）折算为结果而非中断整个校验流程 */
async function attempt<T>(fn: () => T): Promise<AttemptResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      detail: e instanceof HarnessError ? e.detail : undefined,
    };
  }
}

/** HarnessError → 错误串列表：优先展开 detail（zod issues），否则退回 message */
function formatFailure(context: string, message: string, detail: unknown): string[] {
  const parts = extractDetailMessages(detail);
  if (parts.length === 0) return [`${context}: ${message}`];
  return parts.map((part) => `${context}: ${part}`);
}

/** 从 HarnessError.detail 提取面向开发者的条目：zod issue 数组 / { issues: [...] } */
function extractDetailMessages(detail: unknown): string[] {
  if (Array.isArray(detail)) return detail.map(formatErrorEntry);
  if (typeof detail === 'object' && detail !== null) {
    const issues = (detail as Record<string, unknown>).issues;
    if (Array.isArray(issues)) return issues.map(formatErrorEntry);
  }
  return [];
}

/** 单条错误格式化：zod issue 取 message + 路径，其余 String() 化 */
function formatErrorEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message !== '') {
      const loc = Array.isArray(obj.path) && obj.path.length > 0 ? ` (at ${obj.path.join('.')})` : '';
      return `${obj.message}${loc}`;
    }
  }
  return safeJson(entry);
}

/** manifest 不可读/不可解析的可操作错误文案 */
function describeManifestError(e: unknown, manifestPath: string): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') {
    return `manifest.json not found at "${manifestPath}"; every extension needs one (see docs or run "npm run harness -- make:extension <id>")`;
  }
  if (e instanceof SyntaxError) {
    return `manifest.json is not valid JSON (${e.message}); fix the syntax error in "${manifestPath}"`;
  }
  return `cannot read manifest.json at "${manifestPath}": ${e instanceof Error ? e.message : String(e)}`;
}

/** 路径存在性（任意类型：文件/目录均算存在） */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 路径存在且是普通文件 */
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * `node --check <file>` 语法检查。
 * @returns 通过返回 null；失败返回含 stderr 摘要的错误串
 */
function nodeCheck(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { timeout: 10_000 });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (e) => resolve(`node --check could not start: ${e.message}`));
    child.on('close', (code) => {
      if (code === 0) resolve(null);
      else resolve(firstLine(stderr) || `node --check exited with code ${String(code)}`);
    });
  });
}

/** 取 stderr 首个非空行（错误串保持单行，便于列表展示） */
function firstLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line ?? '';
}

/** 未知值的短 JSON 视图（截断，避免错误串爆炸） */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
  } catch {
    return String(value);
  }
}
