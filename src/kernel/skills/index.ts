/**
 * skills — 技能子系统出口（Anthropic Agent Skills 兼容：SKILL.md + YAML frontmatter）。
 *
 * 组成：
 * - `scanSkillDir`（loader.ts）：扫一层子目录解析 SKILL.md；
 * - `SkillRegistry`（registry.ts）：多根聚合 + 扩展贡献的纯读模型；
 * - `writeSkill` / `deleteSkill`（writer.ts）：受控写面——data 源（`<dataDir>/skills`）
 *   的 SKILL.md 组装落盘与删除（builtin 源只读；REST admin 门禁在 api/skills.ts）；
 * - `createSkillsBridge`（本文件）：扩展注入桥——四个 handler（skills.list /
 *   skills.get / skills.register / skills.refresh）与 KERNEL_TOPICS.skills* 对齐，
 *   由总控接线合入 bridgeHandlers（与 kernel-handlers.ts 的 topic 表并表）。
 *
 * 桥的权限边界：**全部 handler requireExtId**——`from === 'kernel'` 一律
 * RPC_PERMISSION_DENIED（内核自身不走 worker→kernel 通道使用技能面）；`skills.register`
 * 按 `from` 的 extId 记贡献（来源 extension，整组替换语义）。
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_PATTERN,
  type SkillEntry,
  type SkillRegistryLike,
  type SkillSource,
} from './types.js';

export { SkillRegistry, type SkillDuplicate } from './registry.js';
export { scanSkillDir, loadSkillEntry, readSkillBody } from './loader.js';
export {
  deleteSkill,
  writeSkill,
  type SkillWriterConfig,
  type SkillWriteResult,
  type WriteSkillInput,
} from './writer.js';
export {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_FILE_NAME,
  SKILL_FILES_LIMIT,
  SKILL_NAME_PATTERN,
} from './types.js';
export type {
  ContributedSkillInput,
  SkillEntry,
  SkillRegistryDeps,
  SkillRegistryLike,
  SkillRoot,
  SkillSource,
  SkillWithBody,
} from './types.js';

/** 端点 → 裸扩展 id；'kernel' 返回 null（与 kernel-handlers 的语义一致） */
function extIdFrom(from: string): string | null {
  if (from === 'kernel') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** skills.* 全部为扩展端点服务：'kernel' 端点拒绝（内核自身不走 worker→kernel 通道） */
function requireExtId(from: string, topic: string): string {
  const extId = extIdFrom(from);
  if (extId === null || extId === '') {
    throw err('RPC_PERMISSION_DENIED', {
      message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
      detail: { topic, from },
    });
  }
  return extId;
}

/** payload 收窄为对象（非对象视为空负载） */
function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------- 线格式 schema

/** skills.list / REST GET /api/v1/skills 共用的过滤线格式 */
const skillsListPayloadSchema = z.object({
  q: z.string().min(1).max(256).optional(),
  source: z.enum(['builtin', 'data', 'extension']).optional(),
  tag: z.string().min(1).max(64).optional(),
});

/** skills.get 线格式 */
const skillsGetPayloadSchema = z.object({
  id: z.string().min(1).max(64).regex(SKILL_NAME_PATTERN),
});

/** skills.register 的单个技能 */
const contributedSkillSchema = z.object({
  id: z.string().max(64).regex(SKILL_NAME_PATTERN),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX_CHARS),
  body: z.string(),
});

/** skills.register 线格式（单次最多 256 个技能，防桥负载失控） */
const skillsRegisterPayloadSchema = z.object({
  skills: z.array(contributedSkillSchema).min(1).max(256),
});

/** createSkillsBridge 依赖：注册表的结构化最小面（SkillRegistry 满足此形状） */
export interface SkillsBridgeDeps {
  registry: Pick<SkillRegistryLike, 'refresh' | 'list' | 'get' | 'registerContributed' | 'removeContributed'>;
}

/**
 * 装配 skills.* 桥处理器（与 kernel-handlers 的表并表后由桥按 topic 分派）。
 *
 * handlers：
 * - `skills.list`（payload {q?, source?, tag?}）→ SkillEntry[]（不含正文）；
 * - `skills.get`（payload {id}）→ { entry, body }（正文 ≤128KB；未知 id → EXT_NOT_FOUND）；
 * - `skills.register`（payload {skills:[{id,name,description,body}]}，单 body ≤128KB）
 *   → 按 from extId 整组记贡献（来源 extension）→ { ok, registered }；
 * - `skills.refresh`（payload 忽略）→ { total }。
 *
 * 全部 handler requireExtId：'kernel' 端点 → RPC_PERMISSION_DENIED。
 */
export function createSkillsBridge(deps: SkillsBridgeDeps): Record<string, (payload: unknown, from: string) => Promise<unknown>> {
  const { registry } = deps;

  return {
    [KERNEL_TOPICS.skillsList]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.skillsList);
      const parsed = skillsListPayloadSchema.safeParse(asRecord(payload));
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'skills.list requires payload { q?, source?: "builtin"|"data"|"extension", tag? }',
          detail: parsed.error.issues,
        });
      }
      const filter: { source?: SkillSource; tag?: string; q?: string } = {};
      if (parsed.data.source !== undefined) filter.source = parsed.data.source;
      if (parsed.data.tag !== undefined) filter.tag = parsed.data.tag;
      if (parsed.data.q !== undefined) filter.q = parsed.data.q;
      return registry.list(filter);
    },

    [KERNEL_TOPICS.skillsGet]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.skillsGet);
      const parsed = skillsGetPayloadSchema.safeParse(asRecord(payload));
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'skills.get requires payload { id } (id must match ^[a-z0-9-]{1,64}$)',
          detail: parsed.error.issues,
        });
      }
      const found = await registry.get(parsed.data.id);
      if (found === null) {
        throw err('EXT_NOT_FOUND', {
          message: `skill "${parsed.data.id}" not found (run skills.refresh if it was installed recently)`,
          detail: { id: parsed.data.id },
        });
      }
      return found;
    },

    [KERNEL_TOPICS.skillsRegister]: async (payload, from) => {
      const extId = requireExtId(from, KERNEL_TOPICS.skillsRegister);
      const parsed = skillsRegisterPayloadSchema.safeParse(asRecord(payload));
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'skills.register requires payload { skills: [{ id, name, description, body }] } (id ^[a-z0-9-]{1,64}$, description ≤1024 chars, at most 256 skills per call)',
          detail: parsed.error.issues,
        });
      }
      // 单 body ≤128KB（字节而非字符；zod 只能按字符数校验，这里逐条复核）
      for (const [index, skill] of parsed.data.skills.entries()) {
        if (Buffer.byteLength(skill.body, 'utf8') > SKILL_BODY_MAX_BYTES) {
          throw err('RPC_PAYLOAD_TOO_LARGE', {
            message: `skills.register: body of skills[${index}] ("${skill.id}") exceeds ${SKILL_BODY_MAX_BYTES} bytes — split the skill or move bulk content into companion files once file distribution lands`,
            detail: { extId, index, id: skill.id },
          });
        }
      }
      const registered = registry.registerContributed(extId, parsed.data.skills);
      return { ok: true, registered };
    },

    [KERNEL_TOPICS.skillsRefresh]: async (payload, from) => {
      requireExtId(from, KERNEL_TOPICS.skillsRefresh);
      const entries: SkillEntry[] = await registry.refresh();
      return { total: entries.length };
    },
  };
}
