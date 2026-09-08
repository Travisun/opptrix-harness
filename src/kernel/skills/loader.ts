/**
 * skills/loader — SKILL.md 目录扫描器（Anthropic Agent Skills 兼容格式解析）。
 *
 * `scanSkillDir(root)` 扫描 `root` 的**一层子目录**，每个含 `SKILL.md` 的子目录
 * 解析为一个 SkillEntry：
 * - gray-matter 解析 YAML frontmatter（解析失败 → 跳过该条目，不影响其余）；
 * - description 必填（非空字符串、≤1024 字符），缺失/非法 → 跳过；
 * - name 可选（缺省取目录 id），但提供时必须匹配 `^[a-z0-9-]{1,64}$`，非法 → 跳过；
 * - 正文（frontmatter 之后）≤128KB，超限 → 跳过；
 * - 附属文件仅登记清单（相对技能目录的 posix 路径，不含 SKILL.md），不执行；
 * - 目录不存在 → 返回 []（技能库可选语义）。
 *
 * 加载失败（缺 description、超限、YAML 损坏等）一律**跳过而非抛出**：扫描是
 * 聚合多个目录的批量操作，单个坏包不应让整个技能库不可用；调用方（SkillRegistry）
 * 负责用 logger 记录跳过原因。
 */
import * as fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { err } from '../errors/index.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILES_LIMIT,
  SKILL_FILE_NAME,
  SKILL_NAME_PATTERN,
  type SkillEntry,
  type SkillSource,
} from './types.js';

/** frontmatter 字段的事实形状（gray-matter 产物任意 JSON，先收窄再使用） */
interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  version?: unknown;
  author?: unknown;
  tags?: unknown;
  enabled?: unknown;
}

/** 单个 SKILL.md 的 stat 防护上限（正文 128KB + 宽裕的 frontmatter 余量） */
const SKILL_FILE_STAT_CAP = 4 * 1024 * 1024;

/**
 * 扫描技能根目录：一层子目录各解析 `<dir>/SKILL.md`。
 *
 * @param root 技能库根目录（不存在 → []）
 * @param source 条目来源标签（registry 按 builtin/data 根分别传入；缺省 'builtin'）
 * @returns 解析成功的条目（目录名升序；非法条目被跳过）
 */
export async function scanSkillDir(root: string, source: SkillSource = 'builtin'): Promise<SkillEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (isMissingFsTarget(e)) return []; // 目录不存在 → 技能库可选，视为空
    throw err('INTERNAL', {
      message: `scanSkillDir: cannot read skills root "${root}": ${e instanceof Error ? e.message : String(e)}`,
      detail: { root },
      cause: e,
    });
  }

  const dirs = dirents
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: SkillEntry[] = [];
  for (const dirName of dirs) {
    const skillDir = path.join(root, dirName);
    const entry = await loadSkillEntry(skillDir, dirName, source);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * 解析单个技能目录（`<skillDir>/SKILL.md`）；目录无 SKILL.md 或条目非法 → null。
 * dirName 为目录 id（name 缺省时的 fallback）。
 */
export async function loadSkillEntry(
  skillDir: string,
  dirName: string,
  source: SkillSource,
): Promise<SkillEntry | null> {
  const skillFile = path.join(skillDir, SKILL_FILE_NAME);
  let stat: Stats;
  try {
    stat = await fs.stat(skillFile);
  } catch {
    return null; // 无 SKILL.md → 不是技能目录
  }
  if (!stat.isFile() || stat.size > SKILL_FILE_STAT_CAP) return null; // 病态大文件不可信

  let raw: string;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch {
    return null; // 读失败（权限/竞态删除）→ 跳过
  }

  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(raw);
    data = parsed.data;
    body = parsed.content;
  } catch {
    return null; // YAML 损坏 → 跳过（不拖垮整库扫描）
  }

  const fm = asFrontmatter(data);

  // description：必填，非空字符串且 ≤1024 字符
  if (typeof fm.description !== 'string' || fm.description === '') return null;
  if (fm.description.length > SKILL_DESCRIPTION_MAX_CHARS) return null;

  // name：可选（缺省 = 目录 id）；提供时必须合法
  let name = dirName;
  if (fm.name !== undefined) {
    if (typeof fm.name !== 'string' || !SKILL_NAME_PATTERN.test(fm.name)) return null;
    name = fm.name;
  }
  if (!SKILL_NAME_PATTERN.test(name)) return null; // 目录 id 本身非法也无法构成合法 id

  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > SKILL_BODY_MAX_BYTES) return null; // 正文超限 → 跳过

  return {
    id: name,
    name,
    description: fm.description,
    ...(typeof fm.version === 'string' && fm.version !== '' ? { version: fm.version } : {}),
    ...(typeof fm.author === 'string' && fm.author !== '' ? { author: fm.author } : {}),
    tags: tagsOf(fm.tags),
    enabled: fm.enabled !== false, // 缺省 true；仅显式 false 关闭
    source,
    sourceRef: skillDir,
    bodyBytes,
    files: await listCompanionFiles(skillDir),
  };
}

/** 读取技能正文（registry.get 用）：剥离 frontmatter，复核 128KB 上限；失败 → null */
export async function readSkillBody(sourceRef: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceRef, SKILL_FILE_NAME), 'utf8');
  } catch {
    return null; // 扫描后被删除/不可读 → 视为不存在
  }
  try {
    const body = matter(raw).content;
    if (Buffer.byteLength(body, 'utf8') > SKILL_BODY_MAX_BYTES) return null;
    return body;
  } catch {
    return null; // YAML 被改坏 → 不可读
  }
}

// ---------------------------------------------------------------- 内部辅助

/** 附属文件清单：递归收集相对 posix 路径（跳过符号链接与 SKILL.md 本身，封顶防御） */
async function listCompanionFiles(skillDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (out.length >= SKILL_FILES_LIMIT) return;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 子目录不可读 → 清单里少几行，不影响技能本体
    }
    for (const d of dirents) {
      if (out.length >= SKILL_FILES_LIMIT) return;
      const rel = prefix === '' ? d.name : `${prefix}/${d.name}`;
      if (d.isFile()) {
        if (rel !== SKILL_FILE_NAME) out.push(rel);
      } else if (d.isDirectory()) {
        await walk(path.join(dir, d.name), rel); // 符号链接（既非 file 也非 directory）不跟随
      }
    }
  };
  await walk(skillDir, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/** tags 字段 → string[]（非数组/含非字符串项一律丢弃该项，空 → []） */
function tagsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t !== '');
}

/** gray-matter data（任意 JSON）→ frontmatter 视图 */
function asFrontmatter(data: Record<string, unknown>): SkillFrontmatter {
  return {
    name: data['name'],
    description: data['description'],
    version: data['version'],
    author: data['author'],
    tags: data['tags'],
    enabled: data['enabled'],
  };
}

/** ENOENT/ENOTDIR（目标不存在）判定：根目录缺失按空库处理 */
function isMissingFsTarget(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
