/**
 * skill-session — 技能会话级激活登记（进程内、无持久化）。
 *
 * 职责与边界：
 * - **两层技能注入的登记面**：短目录（skill-catalog.buildSkillCatalog）恒在 system
 *   prompt；技能正文只在 LLM 经 `skill_activate` 工具显式激活后，由组装方
 *   （assembleSystemPrompt 的调用方）按本登记表拼入。正文不随目录下发，控上下文预算。
 * - **纯内存**：`Map<sessionId, Set<name>>`，进程重启即清空（激活是会话内语义，
 *   持久化无必要）；跨会话天然隔离。
 * - **上限**：每会话最多 `MAX_ACTIVATED_SKILLS_PER_SESSION`（3）个——技能正文块
 *   （单块 ≤8KB、总量 ≤24KB，见 skill-catalog）叠加需有界；达上限后的新激活被拒，
 *   已激活技能的重复激活幂等成功（不占新名额）。
 * - **依赖循环检测从简**：激活集是名字集合、无激活链语义，循环不可能形成，
 *   以「上限 + 幂等」收口即可（不做图检测）。
 */

/** 每会话已激活技能数上限 */
export const MAX_ACTIVATED_SKILLS_PER_SESSION = 3;

/** 单次激活的结果（工具层据此归一为 {ok,...} / {ok:false,error}） */
export interface SkillActivationOutcome {
  /** true = 已激活（含幂等重复激活）；false = 被拒（未登记由调用方先行判定，此处仅上限拒绝） */
  ok: boolean;
  /** 拒绝原因（ok=false 时出现；当前仅 'limit_reached'） */
  error?: 'limit_reached';
  /** 激活后该会话的技能名清单（插入序；幂等重激活返回既有清单） */
  activated: string[];
}

/**
 * 会话级技能激活登记表（进程内单例语义；可多实例，实例间无共享）。
 *
 * 用法：`const reg = new SkillActivationSession(); reg.activate('sess-1', 'doc-review');`
 */
export class SkillActivationSession {
  private readonly sessions = new Map<string, Set<string>>();
  /** 已激活技能正文缓存：sessionId → (name → 激活时刻的正文快照) */
  private readonly bodies = new Map<string, Map<string, string>>();

  /**
   * 为会话激活一个技能（幂等：已激活直接成功，不占新名额）。
   * 未达上限 → 记录并 ok；已达上限且为新名字 → ok:false（error 'limit_reached'）。
   */
  activate(sessionId: string, name: string, content?: string){
    const set = this.sessions.get(sessionId) ?? new Set<string>();
    if (set.has(name)) {
      return { ok: true, activated: [...set] };
    }
    if (set.size >= MAX_ACTIVATED_SKILLS_PER_SESSION) {
      return { ok: false, error: 'limit_reached', activated: [...set] };
    }
    set.add(name);
    this.sessions.set(sessionId, set);
    return { ok: true, activated: [...set] };
  }

  /** 会话已激活技能名清单（插入序；未激活过 → 空数组） */
  /** 激活成功后缓存正文（同 name 重复激活刷新快照；reset 时一并清理） */
  cacheBody(sessionId: string, name: string, content: string): void {
    let byName = this.bodies.get(sessionId);
    if (byName === undefined) {
      byName = new Map();
      this.bodies.set(sessionId, byName);
    }
    byName.set(name, content);
  }

  /** 已激活技能正文快照（组装 system prompt 用；仅含成功缓存正文的条目） */
  snapshot(sessionId: string): Array<{ name: string; content: string }> {
    const byName = this.bodies.get(sessionId);
    if (byName === undefined) return [];
    return [...byName.entries()].map(([name, content]) => ({ name, content }));
  }

  list(sessionId: string): string[] {
    const set = this.sessions.get(sessionId);
    return set === undefined ? [] : [...set];
  }

  /** 会话已激活技能数 */
  count(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0;
  }

  /**
   * 复位：缺省清空全部会话（测试/运维用）；给 sessionId 只清该会话。
   * 会话结束时的清理由调用方（session 生命周期钩子）负责，本类不订阅事件。
   */
  reset(sessionId?: string): void {
    if (sessionId === undefined) {
      this.sessions.clear();
      this.bodies.clear();
      return;
    }
    this.sessions.delete(sessionId);
    this.bodies.delete(sessionId);
  }
}

/** 进程内共享单例（skill_activate / skill_list_activated 工具与组装方缺省共用） */
let shared: SkillActivationSession | null = null;

/** 取进程内共享登记表（懒创建；多实例场景可自建并经工具 deps 注入覆盖） */
export function sharedSkillActivationSession(): SkillActivationSession {
  if (shared === null) {
    shared = new SkillActivationSession();
  }
  return shared;
}
