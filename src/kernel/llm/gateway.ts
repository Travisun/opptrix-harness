/**
 * LLM 网关：按模型路由到 provider（协议适配器），密钥经 secret 引用运行时解析。
 *
 * - 路由：`getProviders()` 中找 models 包含 input.model 的第一个 provider；
 *   无 → `LLM_MODEL_NOT_FOUND`（detail.model）。
 * - 密钥：`resolveSecret(cfg.apiKeySecretRef)` 为 null → `LLM_NOT_CONFIGURED`（detail.provider）；
 *   密钥仅传给 adapter，不落日志。
 * - stream !== true → `adapter.chat`（Promise 结果）；否则返回 `adapter.stream`（AsyncGenerator 直接透出）。
 * - **HA 自动回退（默认关闭）**：deps.haEnabled 缺省 undefined / 返回非 true / 自身抛错一律视为关闭；
 *   关闭时保持单 provider 语义（主路由失败原样抛，现状不变）。开启时主路由失败
 *   （LLM_PROVIDER_ERROR / LLM_MODEL_NOT_FOUND / LLM_NOT_CONFIGURED）→ 按 providers 配置顺序
 *   自「当前模型所在 provider 的下一个」起逐个尝试（模型未命中任何 provider 则自第一个起）：
 *   每个 provider 取其 models[0] 缺省模型 + 该 provider 的密钥/协议适配器；LLM 域失败记入尝试链
 *   （LLM_PARAM_REJECTED 属调用方参数错误，不参与回退、原样抛）继续下一个；全部失败 →
 *   `LLM_PROVIDER_ERROR`（detail.attempts: LlmHaAttempt[]，按尝试顺序）。每次回退尝试经
 *   logger.warn 记录。流式路径的 provider 侧错误发生在生成器迭代期、无法无缝中途切换——
 *   仅同步可探测的路由级失败（模型未命中 / secret 缺失）参与回退；生成器一经返回即不再回退。
 */
import { err, HarnessError, type ErrorCodeName } from '../errors/index.js';
import { anthropicMessagesAdapter } from './adapters/anthropic-messages.js';
import { openaiChatAdapter } from './adapters/openai-chat.js';
import { openaiResponsesAdapter } from './adapters/openai-responses.js';
import type {
  LlmAdapter,
  LlmChatInput,
  LlmChatResult,
  LlmGatewayDeps,
  LlmHaAttempt,
  LlmProtocol,
  LlmProviderConfig,
  LlmStreamEvent,
} from './types.js';

/** 依赖契约定义于 types.ts（与 LLM 领域类型同源）；此处转出保持既有 import 路径不变 */
export type { LlmGatewayDeps } from './types.js';

const ADAPTERS: Readonly<Record<LlmProtocol, LlmAdapter>> = {
  'openai-chat': openaiChatAdapter,
  'openai-responses': openaiResponsesAdapter,
  'anthropic-messages': anthropicMessagesAdapter,
};

/** 调用方参数错误不参与 HA 回退（allowlist 差异下重试无意义，原样上抛） */
const PARAM_REJECTED_CODE = err('LLM_PARAM_REJECTED').code;

/** 单 provider 尝试结局：成功（chat 结果或流生成器）/ 失败（尝试记录 + 原始错误供 HA 关闭时原样上抛） */
type AttemptOutcome =
  | { ok: true; result: LlmChatResult | AsyncGenerator<LlmStreamEvent> }
  | { ok: false; attempt: LlmHaAttempt; original: HarnessError };

/** 回退链结局：成功 / 全部失败（完整尝试链，按尝试顺序） */
type FailoverOutcome =
  | { ok: true; result: LlmChatResult | AsyncGenerator<LlmStreamEvent> }
  | { ok: false; attempts: LlmHaAttempt[] };

export class LlmGateway {
  constructor(private readonly deps: LlmGatewayDeps) {}

  /** 供应商配置目录（子代理/管理面的模型解析链用） */
  getProviders(): Promise<LlmProviderConfig[]> {
    return this.deps.getProviders();
  }

  /** 按模型路由执行一次对话；stream=true 时返回流事件迭代器（首个事件在首次 next 时产生） */
  async chat(input: LlmChatInput): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> {
    const providers = await this.deps.getProviders();
    const primaryIdx = providers.findIndex((p) => p.models.includes(input.model));

    // 主路由命中：单次尝试失败时，HA 开启才进入回退链；关闭 → 原始错误原样抛（现状）
    if (primaryIdx >= 0) {
      const cfg = providers[primaryIdx] as LlmProviderConfig;
      this.deps.logger.debug(
        { provider: cfg.name, protocol: cfg.protocol, model: input.model, stream: input.stream === true },
        'llm gateway: routed to provider',
      );
      const outcome = await this.attemptChat(cfg, input);
      if (outcome.ok) return outcome.result;
      if (!(await this.isHaEnabled())) throw outcome.original;
      const { attempt } = outcome;
      this.deps.logger.warn(
        { provider: attempt.provider, model: attempt.model, code: attempt.error.code },
        'llm gateway: primary provider failed; HA failover begins',
      );
      return this.finishChat(input, this.runFailover(providers, primaryIdx + 1, input, [attempt]));
    }

    // 主路由未命中：HA 开启 → 自第一个 provider 的缺省模型起回退；关闭 → 现状 LLM_MODEL_NOT_FOUND
    if (!(await this.isHaEnabled())) {
      throw err('LLM_MODEL_NOT_FOUND', { detail: { model: input.model } });
    }
    this.deps.logger.warn(
      { model: input.model },
      'llm gateway: model not found in any provider; HA failover begins from first provider',
    );
    return this.finishChat(input, this.runFailover(providers, 0, input, []));
  }

  /** 回退链收尾：成功透传结果；全部失败 → LLM_PROVIDER_ERROR（detail.attempts 按尝试顺序） */
  private async finishChat(
    input: LlmChatInput,
    chain: Promise<FailoverOutcome>,
  ): Promise<LlmChatResult | AsyncGenerator<LlmStreamEvent>> {
    const outcome = await chain;
    if (outcome.ok) return outcome.result;
    throw err('LLM_PROVIDER_ERROR', {
      message: `all llm providers failed after HA failover (${outcome.attempts.length} attempts)`,
      detail: { model: input.model, attempts: outcome.attempts },
    });
  }

  /** HA 开关探测：deps 未注入 / 返回非 true / 自身抛错 → 一律视为关闭（默认关闭） */
  private async isHaEnabled(): Promise<boolean> {
    if (this.deps.haEnabled === undefined) return false;
    try {
      return (await this.deps.haEnabled()) === true;
    } catch (cause) {
      this.deps.logger.warn({ err: cause }, 'llm gateway: haEnabled probe failed; HA treated as disabled');
      return false;
    }
  }

  /**
   * 按 providers 配置顺序自 startIdx 起逐个回退：每个 provider 取其 models[0] 缺省模型。
   * 单次尝试失败（LLM 域错误）→ 记入尝试链、logger.warn 后继续下一个；成功即返回。
   * attempts 由调用方带入（含主 provider 的失败记录），本方法追加回退尝试。
   */
  private async runFailover(
    providers: LlmProviderConfig[],
    startIdx: number,
    input: LlmChatInput,
    attempts: LlmHaAttempt[],
  ): Promise<FailoverOutcome> {
    for (let i = startIdx; i < providers.length; i++) {
      const cfg = providers[i] as LlmProviderConfig;
      const model = cfg.models[0] ?? '';
      if (model === '') {
        attempts.push({
          provider: cfg.name,
          model: '',
          error: this.errInfo('LLM_MODEL_NOT_FOUND', `provider ${cfg.name} declares no models`),
        });
        this.deps.logger.warn({ provider: cfg.name }, 'llm gateway: HA failover skipped — provider has no models');
        continue;
      }
      const outcome = await this.attemptChat(cfg, { ...input, model });
      if (outcome.ok) {
        this.deps.logger.warn(
          { provider: cfg.name, model, priorAttempts: attempts.length },
          'llm gateway: HA failover succeeded',
        );
        return { ok: true, result: outcome.result };
      }
      attempts.push(outcome.attempt);
      this.deps.logger.warn(
        { provider: outcome.attempt.provider, model: outcome.attempt.model, code: outcome.attempt.error.code },
        'llm gateway: HA failover attempt failed; trying next provider',
      );
    }
    return { ok: false, attempts };
  }

  /**
   * 对单个 provider 执行一次对话尝试（stream=true 时同步可探测的失败只有路由级：
   * secret 缺失/未知协议；生成器一经返回，其迭代期错误不再回退）。
   * 非流式：adapter 抛 LLM 域 HarnessError → 记为失败尝试；LLM_PARAM_REJECTED 与
   * 非 HarnessError（内部缺陷）原样上抛，不参与回退。
   */
  private async attemptChat(cfg: LlmProviderConfig, input: LlmChatInput): Promise<AttemptOutcome> {
    const apiKey = await this.deps.resolveSecret(cfg.apiKeySecretRef);
    if (apiKey === null) {
      const original = err('LLM_NOT_CONFIGURED', { detail: { provider: cfg.name } });
      return {
        ok: false,
        original,
        attempt: {
          provider: cfg.name,
          model: input.model,
          error: this.errInfo('LLM_NOT_CONFIGURED', `secret ${cfg.apiKeySecretRef} not resolvable for provider ${cfg.name}`),
        },
      };
    }
    const adapter: LlmAdapter | undefined = ADAPTERS[cfg.protocol];
    if (adapter === undefined) {
      // 配置脏数据（未知协议）：不属可回退失败，与非 HarnessError 同路原样抛（保持改动前失败面）
      throw new TypeError(`no llm adapter for protocol ${String(cfg.protocol)}`);
    }
    if (input.stream === true) {
      return { ok: true, result: adapter.stream(cfg, apiKey, input) };
    }
    try {
      return { ok: true, result: await adapter.chat(cfg, apiKey, input) };
    } catch (e) {
      if (!(e instanceof HarnessError) || e.code === PARAM_REJECTED_CODE) throw e;
      return {
        ok: false,
        original: e,
        attempt: { provider: cfg.name, model: input.model, error: { code: e.code, message: e.message } },
      };
    }
  }

  /** 错误码名 → { code, message }（message 由调用方给出；code 自错误注册表派生，禁止裸造） */
  private errInfo(codeName: ErrorCodeName, message: string): { code: string; message: string } {
    return { code: err(codeName).code, message };
  }
}
