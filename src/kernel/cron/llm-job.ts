/**
 * cron — LLM 提示词自动化任务执行器（payload.kind === 'llm'）。
 *
 * 任务形态（cron payload 的约定形状，REST 层负责写入校验，见 api/cron.ts）：
 * `{ kind: 'llm', prompt: string, model?: string, notify?: boolean, channelSlug?: string }`
 * —— payload 本身仍是自由 JSON（CronJobRecord.payload 不改 schema），本模块只消费约定字段。
 *
 * 执行语义：
 * - 模型解析：payload.model 指定 → 尝试该模型；失败（模型不存在 / 供应商错误）→
 *   **回退第一可用 provider 的缺省模型**（getProviders() 顺序首个含模型者，取 models[0]）
 *   重试一次；仍失败 → ok:false。未指定 model → 直接用第一可用缺省模型单次尝试
 *   （它本身就是回退终点，无二次回退）；无任何可用 provider → ok:false。
 * - 调 gateway.chat({ model, messages: [{ role: 'user', content: prompt }] })，非流式
 *   （不传 stream，gateway 侧走 adapter.chat 返回 Promise 结果）。
 * - 结果摘要 = 返回 text 的前 {@link LLM_JOB_SUMMARY_MAX_CHARS} 字符（结果形状异常时兜底 ''）。
 * - 结果通知：notify !== false 时 send({ title: `自动化「${jobName}」完成`, body: 摘要,
 *   level: ok ? 'success' : 'error' })；send 失败仅 warn，不影响 run 结果。
 *
 * 错误约定：run() **不抛**——所有失败（prompt 非法 / 模型全部失败 / 内部异常）都收敛为
 * `{ ok: false, summary: <原因> }` 并（在未关闭通知时）发 level 'error' 通知；调用方
 * （core-services 的 cron 触发监听）无需 try/catch 也能安全 await。
 */
import type { Logger } from 'pino';

/** 提示词字节上限（UTF-8；与 REST 层 payload 校验一致） */
export const LLM_JOB_PROMPT_MAX_BYTES = 8 * 1024;

/** 结果摘要的最大字符数（超出截断） */
export const LLM_JOB_SUMMARY_MAX_CHARS = 500;

/** LLM 网关最小结构视图（内核 LlmGateway.chat 天然满足；unknown 出参由本模块防御性取 text） */
export interface LlmJobGateway {
  chat(input: { model: string; messages: Array<{ role: 'user'; content: string }> }): Promise<unknown>;
}

/** 供应商清单读取器（返回按优先级排序的 provider → models 视图） */
export type LlmJobProvidersReader = () => Promise<Array<{ name: string; models: string[] }>>;

/** 通知中心最小结构视图（内核 NotificationManager.send 天然满足） */
export interface LlmJobNotifier {
  send(input: { title: string; body?: string; level?: string }): Promise<unknown>;
}

/** createLlmJobRunner 依赖集合 */
export interface LlmJobRunnerDeps {
  /** LLM 网关（模型路由 + provider 协议适配） */
  gateway: LlmJobGateway;
  /** 供应商清单（回退时取第一可用 provider 的缺省模型） */
  getProviders: LlmJobProvidersReader;
  /** 通知中心（结果投递；失败不抛） */
  notify: LlmJobNotifier;
  logger: Logger;
}

/** run() 的任务负载（来自 cron payload 的约定字段；运行时再做防御性归一化） */
export interface LlmJobPayload {
  /** 提示词（必填；空/非字符串 → ok:false） */
  prompt: string;
  /** 指定模型（缺省 = 第一可用 provider 的缺省模型） */
  model?: string;
  /** 结果通知开关（缺省 true） */
  notify?: boolean;
}

/** run() 的触发元信息 */
export interface LlmJobMeta {
  /** 任务名（通知标题用） */
  jobName: string;
}

/** run() 结果：ok = 是否拿到 LLM 回复；summary = 结果摘要（失败时为失败原因） */
export interface LlmJobRunResult {
  ok: boolean;
  summary: string;
}

/** chat 结果的防御性 text 读取：形状异常（非对象 / text 非字符串）→ '' */
function textOf(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'text' in result) {
    const text = (result as { text?: unknown })['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}

/** 未知异常 → 可读消息 */
function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** createLlmJobRunner 的产物：run(payload, meta)（不抛错，约定见模块头注释） */
export interface LlmJobRunner {
  run(payload: LlmJobPayload, meta: LlmJobMeta): Promise<LlmJobRunResult>;
}

/**
 * 创建 LLM 提示词自动化执行器。返回的 run() 不抛错（约定见模块头注释），
 * 调用方可直接 await 并以返回值的 ok 分流。
 */
export function createLlmJobRunner(deps: LlmJobRunnerDeps): LlmJobRunner {
  /** 第一可用 provider 的缺省模型（顺序首个含非空 models 数组者）；无 → null */
  const firstAvailableModel = async (): Promise<string | null> => {
    let providers: Array<{ name: string; models: string[] }>;
    try {
      providers = await deps.getProviders();
    } catch (e) {
      deps.logger.warn({ err: e }, 'cron llm-job: getProviders failed (treated as no provider)');
      return null;
    }
    if (!Array.isArray(providers)) return null;
    for (const provider of providers) {
      if (provider !== null && typeof provider === 'object' && Array.isArray(provider.models)) {
        const model = provider.models.find((m) => typeof m === 'string' && m !== '');
        if (model !== undefined) return model;
      }
    }
    return null;
  };

  /** 单次对话（非流式）；失败原样上抛给 run 的尝试编排 */
  const chatOnce = async (model: string, prompt: string): Promise<unknown> =>
    deps.gateway.chat({ model, messages: [{ role: 'user', content: prompt }] });

  /**
   * 结果通知（失败不抛）：notify 关闭时不投递；send 抛错仅 warn。
   * level：成功 'success' / 失败 'error'；标题固定「自动化「<jobName>」完成」。
   */
  const sendResultNotice = async (ok: boolean, body: string, jobName: string, notifyEnabled: boolean): Promise<void> => {
    if (!notifyEnabled) return;
    try {
      await deps.notify.send({ title: `自动化「${jobName}」完成`, body, level: ok ? 'success' : 'error' });
    } catch (e) {
      deps.logger.warn({ err: e, jobName }, 'cron llm-job: result notification delivery failed (ignored)');
    }
  };

  const run = async (payload: LlmJobPayload, meta: LlmJobMeta): Promise<LlmJobRunResult> => {
    // ---- 负载归一化（REST 之外的入口——扩展桥 / 手工建库——不做结构保证，这里统一兜底）----
    const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
    const notifyEnabled = payload?.notify !== false;
    const jobName = typeof meta?.jobName === 'string' && meta.jobName !== '' ? meta.jobName : '(unnamed)';

    if (prompt.trim() === '') {
      const summary = '执行失败：缺少可执行的提示词（payload.prompt 必须是非空字符串）';
      await sendResultNotice(false, summary, jobName, notifyEnabled);
      return { ok: false, summary };
    }

    const requested = typeof payload?.model === 'string' && payload.model.trim() !== '' ? payload.model.trim() : null;

    // ---- 模型解析与对话：指定模型 → 失败回退第一可用缺省模型重试一次；未指定 → 缺省模型单次 ----
    let text = '';
    if (requested !== null) {
      try {
        text = textOf(await chatOnce(requested, prompt));
        deps.logger.info({ jobName, model: requested }, 'cron llm-job: chat ok (requested model)');
      } catch (e) {
        const requestedErr = messageOf(e);
        deps.logger.warn(
          { err: e, jobName, model: requested },
          'cron llm-job: requested model failed, falling back to first available default',
        );
        const fallback = await firstAvailableModel();
        if (fallback === null) {
          const summary = `执行失败：模型 "${requested}" 不可用且没有可回退的 LLM 供应商 — ${requestedErr}`;
          await sendResultNotice(false, summary, jobName, notifyEnabled);
          return { ok: false, summary };
        }
        try {
          text = textOf(await chatOnce(fallback, prompt));
          deps.logger.info({ jobName, model: fallback, requested }, 'cron llm-job: chat ok (fallback model)');
        } catch (fallbackErr) {
          const summary =
            `执行失败：指定模型与回退模型均失败 — ` +
            `model "${requested}": ${requestedErr}; ` +
            `fallback "${fallback}": ${messageOf(fallbackErr)}`;
          await sendResultNotice(false, summary, jobName, notifyEnabled);
          return { ok: false, summary };
        }
      }
    } else {
      const fallback = await firstAvailableModel();
      if (fallback === null) {
        const summary = '执行失败：未指定模型且没有可用的 LLM 供应商（请先在设置中配置 provider）';
        await sendResultNotice(false, summary, jobName, notifyEnabled);
        return { ok: false, summary };
      }
      try {
        text = textOf(await chatOnce(fallback, prompt));
        deps.logger.info({ jobName, model: fallback }, 'cron llm-job: chat ok (default first-available model)');
      } catch (e) {
        const summary = `执行失败：默认模型 "${fallback}" 调用失败 — ${messageOf(e)}`;
        await sendResultNotice(false, summary, jobName, notifyEnabled);
        return { ok: false, summary };
      }
    }

    // ---- 结果摘要 + 通知 ----
    const summary = text.slice(0, LLM_JOB_SUMMARY_MAX_CHARS);
    await sendResultNotice(true, summary, jobName, notifyEnabled);
    return { ok: true, summary };
  };

  return { run };
}
