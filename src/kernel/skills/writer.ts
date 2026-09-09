/**
 * skills/writer — 技能包受控写面（SKILL.md 组装落盘 / data 源技能删除）。
 *
 * 与 registry（纯读模型）互补：这里是技能目录唯一的磁盘写入口，仅作用于
 * **data 源**（`<dataDir>/skills/<id>/`）；builtin 源（repoRoot/skills）只读，
 * 不可写也不可删（FORBIDDEN）。调用方：REST /api/v1/skills 的 POST/DELETE
 * （admin 门禁与 confirm 交互在该层完成，写后由其触发 registry.refresh）。
 *
 * - `writeSkill`：校验（id 形态 / name·description 非空 / 正文非空且 ≤128KB 字节）
 *   → mkdir（**必须由本写入创建**：目录已存在 → BAD_REQUEST 'skill id already
 *   exists'）→ gray-matter 组装 frontmatter（name/description/version=1.0.0/
 *   author/tags）+ 正文 → 写 `<dataDir>/skills/<id>/SKILL.md`；写文件失败时
 *   best-effort 回滚刚创建的目录（不吞错，包装 INTERNAL 上抛）。
 *   注意：frontmatter `name` **恒写目录 id**——loader/registry 以 fm.name 为注册
 *   id（缺省回退目录 id），恒等写入保证「写后 refresh 可见且 id === name」的
 *   系统不变量；input.name 为展示名收集，仅做非空/长度校验。
 * - `deleteSkill`：仅删 data 源技能目录（rm recursive）。目标不在 data 源时：
 *   命中 builtin 源（cfg.builtinRoot，即 repoRoot/skills）→ FORBIDDEN；两处皆无
 *   → EXT_NOT_FOUND。同 id 被 builtin 遮蔽（builtin+data 并存，删 data 副本无
 *   可见效果）→ 默认 FORBIDDEN，`opts.force` 显式确认后才删 data 副本（确认
 *   交互语义由 API/UI 层负责，确认后才调用本函数）。
 *
 * id 形态（`^[a-z0-9-]{1,64}$`）同时是路径安全边界：不含分隔符与 `..`，拼接
 * 目标目录不存在越权可能。
 */
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { err } from '../errors/index.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_NAME,
  SKILL_NAME_PATTERN,
} from './types.js';

/** 技能写面配置：data 源根 = `<dataDir>/skills`；builtinRoot 提供时删除前做 FORBIDDEN 判定 */
export interface SkillWriterConfig {
  /** 内核数据卷根目录（技能落在 `<dataDir>/skills/<id>/`） */
  dataDir: string;
  /** builtin 技能根目录（repoRoot/skills）；用于删除时的来源判定与遮蔽复核 */
  builtinRoot?: string;
}

/** writeSkill 输入（全部必填字段先经 REST zod 校验，此处防御性复核） */
export interface WriteSkillInput {
  /** 技能 id（= 目录名 = frontmatter name；`^[a-z0-9-]{1,64}$`） */
  id: string;
  /** 展示名（注册 id 以 `id` 为准，见模块头注释；仅做非空/长度校验） */
  name: string;
  /** 一句话描述（非空，≤1024 字符，对齐 Anthropic 规范） */
  description: string;
  /** 正文 Markdown（frontmatter 之后；非空且 ≤128KB 字节） */
  body: string;
  /** 标签（可选；空白项剔除，全空则不写 tags 键） */
  tags?: string[];
  /** 作者（可选；空串视同未提供，不写 author 键） */
  author?: string;
}

/** writeSkill 结果：注册 id + 技能目录绝对路径 */
export interface SkillWriteResult {
  id: string;
  path: string;
}

/** 展示名长度上限（与 REST zod 上限一致；name 不进 frontmatter，仅收口校验） */
const SKILL_DISPLAY_NAME_MAX_CHARS = 200;

/**
 * 组装并落盘一个技能：`<dataDir>/skills/<id>/SKILL.md`。
 *
 * @returns `{ id, path }`（id 即注册 id；path 为技能目录绝对路径）
 * @throws BAD_REQUEST id 形态非法 / name·description·body 为空 / description 超
 *   1024 字符 / 正文超 128KB / 技能目录已存在（'skill id already exists'）
 * @throws INTERNAL 目录创建或文件写入的文件系统失败
 */
export async function writeSkill(cfg: SkillWriterConfig, input: WriteSkillInput): Promise<SkillWriteResult> {
  // ---- 校验（顺序固定：id → name/description → body；全部 BAD_REQUEST）----
  if (typeof input.id !== 'string' || !SKILL_NAME_PATTERN.test(input.id)) {
    throw err('BAD_REQUEST', {
      message: `writeSkill: invalid skill id (must match ${SKILL_NAME_PATTERN.source})`,
      detail: { id: input.id },
    });
  }
  const displayName = typeof input.name === 'string' ? input.name.trim() : '';
  if (displayName === '' || displayName.length > SKILL_DISPLAY_NAME_MAX_CHARS) {
    throw err('BAD_REQUEST', {
      message: `writeSkill: name must be a non-empty string of at most ${SKILL_DISPLAY_NAME_MAX_CHARS} chars`,
      detail: { id: input.id },
    });
  }
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    throw err('BAD_REQUEST', { message: 'writeSkill: description must be a non-empty string', detail: { id: input.id } });
  }
  if (input.description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    throw err('BAD_REQUEST', {
      message: `writeSkill: description exceeds ${SKILL_DESCRIPTION_MAX_CHARS} chars`,
      detail: { id: input.id, descriptionChars: input.description.length },
    });
  }
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    throw err('BAD_REQUEST', { message: 'writeSkill: body must be a non-empty string', detail: { id: input.id } });
  }
  const bodyBytes = Buffer.byteLength(input.body, 'utf8');
  if (bodyBytes > SKILL_BODY_MAX_BYTES) {
    throw err('BAD_REQUEST', {
      message: `writeSkill: body exceeds ${SKILL_BODY_MAX_BYTES} bytes`,
      detail: { id: input.id, bodyBytes },
    });
  }

  // ---- 目录：必须由本写入创建（已存在 → BAD_REQUEST 'skill id already exists'）----
  const skillDir = path.join(cfg.dataDir, 'skills', input.id);
  let created = false;
  try {
    // recursive mkdir 返回「本次新建的路径」；目录本就存在 → undefined
    created = (await fs.mkdir(skillDir, { recursive: true })) !== undefined;
  } catch (cause) {
    // EEXIST（同路径是文件）/ ENOTDIR（父级是文件）等 → 一律按「已存在」收口
    throw err('BAD_REQUEST', {
      message: 'skill id already exists',
      detail: { id: input.id, path: skillDir, cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
  if (!created) {
    throw err('BAD_REQUEST', { message: 'skill id already exists', detail: { id: input.id, path: skillDir } });
  }

  // ---- 组装 SKILL.md（frontmatter name 恒写 id，见模块头注释）----
  const author = typeof input.author === 'string' ? input.author.trim() : '';
  const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [];
  const frontmatter: Record<string, unknown> = {
    name: input.id,
    description: input.description,
    version: '1.0.0',
    ...(author !== '' ? { author } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  const content = matter.stringify(input.body, frontmatter);

  try {
    await fs.writeFile(path.join(skillDir, SKILL_FILE_NAME), content, 'utf8');
  } catch (cause) {
    // 写文件失败 → 回滚刚创建的目录（best-effort），错误包装上抛
    await fs.rm(skillDir, { recursive: true, force: true }).catch(() => {});
    throw err('INTERNAL', {
      message: `writeSkill: failed to write SKILL.md for "${input.id}"`,
      detail: { id: input.id, path: skillDir },
      cause,
    });
  }
  return { id: input.id, path: skillDir };
}

/**
 * 删除一个技能：仅 data 源（`<dataDir>/skills/<id>/`，rm recursive）。
 *
 * @throws BAD_REQUEST id 形态非法
 * @throws FORBIDDEN 目标是 builtin 源（repoRoot/skills）；或同 id 被 builtin 遮蔽
 *   且未显式 `opts.force`
 * @throws EXT_NOT_FOUND data 与 builtin 两处皆无此 id
 * @throws INTERNAL 目录删除的文件系统失败
 */
export async function deleteSkill(cfg: SkillWriterConfig, id: string, opts: { force?: boolean } = {}): Promise<void> {
  if (typeof id !== 'string' || !SKILL_NAME_PATTERN.test(id)) {
    throw err('BAD_REQUEST', {
      message: `deleteSkill: invalid skill id (must match ${SKILL_NAME_PATTERN.source})`,
      detail: { id },
    });
  }
  const dataSkillDir = path.join(cfg.dataDir, 'skills', id);
  const dataExists = await isDirectory(dataSkillDir);
  const builtinSkillDir = cfg.builtinRoot !== undefined ? path.join(cfg.builtinRoot, id) : null;
  const builtinExists = builtinSkillDir !== null && (await isDirectory(builtinSkillDir));

  if (!dataExists) {
    if (builtinExists) {
      throw err('FORBIDDEN', {
        message: `skill "${id}" lives in the builtin skills root and cannot be deleted`,
        detail: { id, source: 'builtin' },
      });
    }
    throw err('EXT_NOT_FOUND', { message: `skill "${id}" not found`, detail: { id } });
  }
  if (builtinExists && opts.force !== true) {
    // 遮蔽态：registry 里该 id 由 builtin 胜出，删 data 副本对列表无可见效果 → 要求显式确认
    throw err('FORBIDDEN', {
      message: `skill "${id}" is shadowed by a builtin skill with the same id; deleting the data copy has no visible effect (retry with force to remove it anyway)`,
      detail: { id, source: 'builtin', shadowed: true },
    });
  }

  try {
    await fs.rm(dataSkillDir, { recursive: true });
  } catch (cause) {
    if (isMissingFsTarget(cause)) {
      throw err('EXT_NOT_FOUND', { message: `skill "${id}" not found`, detail: { id } });
    }
    throw err('INTERNAL', {
      message: `deleteSkill: failed to remove skill directory for "${id}"`,
      detail: { id, path: dataSkillDir },
      cause,
    });
  }
}

// ---------------------------------------------------------------- 内部辅助

/** 路径存在且为目录判定（任何读取失败 → false） */
async function isDirectory(p: string): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await fs.stat(p);
  } catch {
    return false;
  }
  return stat.isDirectory();
}

/** ENOENT/ENOTDIR（目标不存在）判定：删除竞态（stat 后被外部移除）按不存在收口 */
function isMissingFsTarget(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
