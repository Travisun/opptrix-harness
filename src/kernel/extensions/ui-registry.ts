/**
 * ui-registry — 扩展 UI 贡献注册表（菜单 / 页面 / 小部件 / 自定义渲染器）。
 *
 * 数据来源：扩展激活期经 `h.ui.register(fragment)` → KERNEL_TOPICS.uiRegister 送达
 * 内核（本类是 KERNEL_TOPICS.uiRegister 的内核侧落点，容器键 'ui.registry'）。
 *
 * 语义：
 * - register 为**累加合并**：同一扩展在 setup 期可多次调用（每次一个片段），
 *   pages/widgets/renderers 追加、menu 以最后一次提供的为准（菜单是单值语义）；
 * - remove：整扩展摘除（disable/uninstall 时由接线方调用）；
 * - snapshot：GET /api/v1/ui 的只读视图（按 extId 稳定排序；返回防御性拷贝）。
 *
 * 入参校验：片段为跨线程外部入参，zod 校验后才可使用（ENGINEERING 规则）；
 * 非法形状 → EXT_MANIFEST_INVALID（来源是扩展贡献点，错误面向扩展开发者可操作）。
 */
import { z } from 'zod';

import { err } from '../errors/index.js';

/** 一个扩展 UI 贡献片段（h.ui.register 的入参） */
export interface UiContribution {
  menu?: { label: string; icon?: string };
  pages?: Array<{ path: string; title: string; entry: string }>;
  widgets?: Array<{ id: string; title: string; entry: string }>;
  renderers?: string[];
}

/** snapshot 条目：一个扩展累计后的完整 UI 贡献视图 */
export interface UiSnapshotEntry {
  extId: string;
  menu?: { label: string; icon?: string };
  pages: Array<{ path: string; title: string; entry: string }>;
  widgets: Array<{ id: string; title: string; entry: string }>;
  renderers: string[];
}

/** 片段 zod schema（全部键可选；数组元素形状与 manifest uiSchema 对齐） */
const uiContributionSchema = z.object({
  menu: z.object({ label: z.string().min(1), icon: z.string().min(1).optional() }).optional(),
  pages: z
    .array(z.object({ path: z.string().min(1), title: z.string().min(1), entry: z.string().min(1) }))
    .optional(),
  widgets: z
    .array(z.object({ id: z.string().min(1), title: z.string().min(1), entry: z.string().min(1) }))
    .optional(),
  renderers: z.array(z.string().min(1)).optional(),
});

/** 单个扩展的累计贡献（内部存储形状） */
interface ExtUiRecord {
  menu?: { label: string; icon?: string };
  pages: Array<{ path: string; title: string; entry: string }>;
  widgets: Array<{ id: string; title: string; entry: string }>;
  renderers: string[];
}

/** 扩展 UI 注册表：ui.register 落点 + GET /api/v1/ui 数据源 */
export class UiRegistry {
  readonly #byExt = new Map<string, ExtUiRecord>();

  /**
   * 累加合并一个 UI 贡献片段（同扩展多次调用按序合并；见模块头注释的合并语义）。
   * @throws HarnessError（EXT_MANIFEST_INVALID）片段缺失/非对象/形状非法
   */
  register(extId: string, contrib: UiContribution): void {
    if (typeof extId !== 'string' || extId === '') {
      throw err('EXT_MANIFEST_INVALID', { message: 'ui.register: extId must be a non-empty string', detail: { extId } });
    }
    if (contrib === null || typeof contrib !== 'object' || Array.isArray(contrib)) {
      throw err('EXT_MANIFEST_INVALID', {
        message: 'ui.register: contribution fragment must be an object { menu?, pages?, widgets?, renderers? }',
        detail: { extId, got: contrib === null ? 'null' : typeof contrib },
      });
    }
    const parsed = uiContributionSchema.safeParse(contrib);
    if (!parsed.success) {
      throw err('EXT_MANIFEST_INVALID', {
        message: 'ui.register: contribution fragment is invalid (need { menu?, pages?, widgets?, renderers? })',
        detail: { extId, issues: parsed.error.issues },
      });
    }
    const record = this.#byExt.get(extId) ?? { pages: [], widgets: [], renderers: [] };
    if (parsed.data.menu !== undefined) record.menu = parsed.data.menu;
    if (parsed.data.pages !== undefined) record.pages.push(...parsed.data.pages);
    if (parsed.data.widgets !== undefined) record.widgets.push(...parsed.data.widgets);
    if (parsed.data.renderers !== undefined) record.renderers.push(...parsed.data.renderers);
    this.#byExt.set(extId, record);
  }

  /** 整扩展摘除（未知 extId 幂等 no-op） */
  remove(extId: string): void {
    this.#byExt.delete(extId);
  }

  /** 只读快照（按 extId 稳定排序；深拷贝，外部修改不影响内部状态） */
  snapshot(): UiSnapshotEntry[] {
    const out: UiSnapshotEntry[] = [];
    for (const [extId, record] of this.#byExt) {
      const entry: UiSnapshotEntry = {
        extId,
        pages: record.pages.map((p) => ({ ...p })),
        widgets: record.widgets.map((w) => ({ ...w })),
        renderers: [...record.renderers],
      };
      if (record.menu !== undefined) entry.menu = { ...record.menu };
      out.push(entry);
    }
    out.sort((a, b) => (a.extId < b.extId ? -1 : a.extId > b.extId ? 1 : 0));
    return out;
  }
}
