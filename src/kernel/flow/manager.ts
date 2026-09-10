/**
 * FlowManager — 传入 Webhook（FlowTrigger）编排器。
 *
 * 端点生命周期：
 * - createEndpoint：slug 自动生成（name slugify + 4 位随机后缀防撞，唯一约束兜底）；
 *   HMAC 密钥自动生成（32 字节 hex）存 secrets 层（键 `flow.<id>.secret`，表内只留
 *   secret_ref 引用），**明文仅在创建/轮换响应返回一次**，之后永不复现；
 * - updateEndpoint / listEndpoints / getEndpoint / deleteEndpoint（级联删 events +
 *   secrets 清理）；rotateSecret 换钥（旧签名立即失效）。
 *
 * 入站管线 handleInbound(slug, rawBody, headers, sourceIp)：
 * 1. slug 查端点（不存在 → 404 EXT_NOT_FOUND；disabled → 403 FLOW_DISABLED）；
 * 2. 签名校验：端点有 secret_ref 时校验 `x-harness-signature: sha256=<hex hmac(rawBody, secret)>`
 *    （timingSafeEqual 时序安全比较；无密钥端点跳过；密钥不可解 fail-closed 视同失败 → 401）；
 * 3. 事件落库（status='received'，payload 只留 SHA-256 摘要）→ SSE `flow:{endpointId}` 推送；
 * 4. 按 flow_type 分派：
 *    - 'log'：仅记录 → result={logged:true} → processed；
 *    - 'notify'：flowConfig.notification {title,body?,level?,data?} 模板（支持 {{payload}} /
 *      {{字段路径}} 占位符，按 payload 字段替换）→ notifications.send → result={notificationId}；
 *    - 'llm'：llmPrompt 渲染 payload 后 gateway.chat 单轮 → result={text,usage}；
 *    - 分派异常 → status='failed' + error（不抛出，入站响应恒 200）；
 * 5. 返回 { eventId, status }。
 *
 * 依赖注入（deps.gateway / deps.notifications 为调用期懒解析 getter）：对应 flow_type
 * 的依赖缺失时创建该类型端点报 VALIDATION_FAILED（fail-fast，不留永远失败的端点）。
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { Logger } from 'pino';
import { z } from 'zod';

import { err } from '../errors/index.js';
import { FlowEndpointStore } from './store.js';
import {
  FLOW_TYPES,
  type FlowEndpointCreateInput,
  type FlowEndpointPatchInput,
  type FlowEndpointRecord,
  type FlowEventRecord,
  type FlowHeaders,
  type FlowInboundResult,
  type FlowLlmGatewayLike,
  type FlowManagerDeps,
  type FlowType,
} from './types.js';

/** 签名头名（Stripe 风格 scheme=value 形：`sha256=<hex>`） */
const SIGNATURE_HEADER = 'x-harness-signature';

/** HMAC 密钥字节数（32 字节 → 64 hex 字符） */
const SECRET_BYTES = 32;

/** slug 前缀最大长度（name slugify 后截断，防超长 URL） */
const SLUG_BASE_MAX = 48;

/** slug 撞名重试上限（4 位随机后缀空间 65536，8 次仍撞视为病态） */
const SLUG_MAX_ATTEMPTS = 8;

/** 事件列表缺省条数上限 */
const DEFAULT_EVENT_LIMIT = 50;

/** notify 型 flowConfig 结构（zod 与 REST/manager 校验共用） */
const notifyConfigSchema = z.object({
  notification: z.object({
    title: z.string().min(1).max(512),
    body: z.string().max(16_000).optional(),
    level: z.enum(['info', 'success', 'warn', 'error']).optional(),
    data: z.unknown().optional(),
  }),
});

/** llm 型 flowConfig 结构（model 可空 = 网关按 provider 目录解析缺省模型） */
const llmConfigSchema = z.object({
  model: z.string().min(1).max(256).optional(),
});

/** 名称校验（manager 防御性复核；REST 层另有同款 zod） */
const nameSchema = z.string().min(1).max(128);

/** 结构化对象判定 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 名称 → url-safe slug 基底（小写、非 [a-z0-9] 折叠为 '-'、去首尾 '-'、截断；空回退 'flow'） */
export function slugifyBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX);
  return base === '' ? 'flow' : base;
}

/** 按点分路径取 payload 字段值（'data.amount' → payload.data.amount；不可达返回 undefined） */
function resolvePayloadPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split('.')) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * 模板渲染：{{payload}}（或空占位符）注入整包 JSON；{{field.path}} 注入字段值
 * （字符串原样、标量 String()、对象/数组 JSON 串；缺失/不可达替换为空串）。
 */
export function renderTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([\w.$-]*)\s*\}\}/g, (_match, path: string) => {
    if (path === '' || path === 'payload') return JSON.stringify(payload ?? null);
    const value = resolvePayloadPath(payload, path);
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** 深度模板渲染：对象/数组内的字符串值逐个渲染（notify 的 data 字段用） */
function renderDeep(value: unknown, payload: unknown): unknown {
  if (typeof value === 'string') return renderTemplate(value, payload);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, payload));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = renderDeep(val, payload);
    return out;
  }
  return value;
}

/** 原始 body → payload：JSON 解析失败/非 JSON 体回退 { raw: <utf8 文本> }（空体 = {}） */
function parsePayload(rawBody: Buffer): unknown {
  const text = rawBody.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

/** 十六进制串时序安全比较（长度不等直接 false——长度本身不泄露密钥信息） */
function timingSafeHexEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 端点未找到（EXT_NOT_FOUND 语义贴切 → 404 HARNESS-3004，与 subagents/chat 同款） */
function endpointNotFound(idOrSlug: string): ReturnType<typeof err> {
  return err('EXT_NOT_FOUND', { message: `flow endpoint "${idOrSlug}" not found`, detail: { ref: idOrSlug } });
}

/** FlowManager：传入 Webhook 端点与入站事件编排（见模块头注释的管线契约） */
export class FlowManager {
  private readonly store: FlowEndpointStore;
  private readonly secrets: FlowManagerDeps['secrets'];
  private readonly logger: Logger;

  constructor(private readonly deps: FlowManagerDeps) {
    this.store = new FlowEndpointStore(deps.db);
    this.secrets = deps.secrets;
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // 端点生命周期
  // -------------------------------------------------------------------------

  /**
   * 创建端点：slug 自动生成（slugify + 4 位随机后缀）；HMAC 密钥自动生成并存 secrets 层。
   * @returns 端点记录 + **一次性明文 secret**（仅本响应返回；之后只能 rotateSecret 换钥）
   * @throws HarnessError（VALIDATION_FAILED）flow_type 非法 / llm 缺提示词或网关缺失 /
   *   notify 缺通知管理器或 flowConfig.notification 非法
   */
  async createEndpoint(input: FlowEndpointCreateInput): Promise<FlowEndpointRecord & { secret: string }> {
    const flowType = this.#assertFlowType(input.flowType);
    const name = nameSchema.safeParse(input.name);
    if (!name.success) {
      throw err('VALIDATION_FAILED', { detail: name.error.issues });
    }
    const flowConfig = this.#assertFlowConfig(flowType, input.flowConfig);
    if (flowType === 'llm') {
      this.#assertLlmPrompt(input.llmPrompt);
      this.#assertGatewayAvailable();
    }
    if (flowType === 'notify') this.#assertNotificationsAvailable();

    const id = randomUUID();
    const secretRef = `flow.${id}.secret`;
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    await this.secrets.set(secretRef, secret); // 密钥本体只进 secrets 层（AES-256-GCM 加密落盘）
    const now = Date.now();
    const record: FlowEndpointRecord = {
      id,
      name: name.data,
      slug: await this.#generateSlug(name.data),
      secretRef,
      enabled: true,
      flowType,
      flowConfig,
      llmPrompt: flowType === 'llm' ? (input.llmPrompt as string) : null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(record);
    this.logger.info({ endpointId: id, slug: record.slug, flowType }, 'flow: endpoint created');
    return { ...record, secret };
  }

  /** 端点列表（不含任何密钥材料——记录层只有 secret_ref 引用） */
  listEndpoints(): Promise<FlowEndpointRecord[]> {
    return this.store.list();
  }

  /** 按 ID 读取端点；不存在返回 null */
  getEndpoint(id: string): Promise<FlowEndpointRecord | null> {
    return this.store.get(id);
  }

  /**
   * 部分更新端点。flow_type 相关结构与依赖在「合并后的最终形态」上复核
   * （如切到 llm 必须已有提示词 + 网关可用；notify 必须有合法 flowConfig.notification）。
   * @returns 更新后的记录；端点不存在返回 null
   */
  async updateEndpoint(id: string, patch: FlowEndpointPatchInput): Promise<FlowEndpointRecord | null> {
    const current = await this.store.get(id);
    if (current === null) return null;

    const nextFlowType = this.#assertFlowType(patch.flowType ?? current.flowType);
    if (patch.name !== undefined) {
      const name = nameSchema.safeParse(patch.name);
      if (!name.success) throw err('VALIDATION_FAILED', { detail: name.error.issues });
    }
    if (patch.llmPrompt !== undefined && patch.llmPrompt !== null) {
      this.#assertLlmPrompt(patch.llmPrompt);
    }
    const nextFlowConfig =
      patch.flowConfig !== undefined ? patch.flowConfig : (current.flowConfig ?? undefined);
    const nextLlmPrompt =
      patch.llmPrompt !== undefined ? patch.llmPrompt : (current.llmPrompt ?? undefined);
    if (nextFlowType === 'llm') {
      this.#assertLlmPrompt(nextLlmPrompt === null ? undefined : nextLlmPrompt);
      this.#assertGatewayAvailable();
    }
    if (nextFlowType === 'notify') {
      this.#assertFlowConfig('notify', nextFlowConfig);
      this.#assertNotificationsAvailable();
    }

    await this.store.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.flowType !== undefined ? { flowType: patch.flowType } : {}),
      ...(patch.flowConfig !== undefined ? { flowConfig: patch.flowConfig } : {}),
      ...(patch.llmPrompt !== undefined ? { llmPrompt: patch.llmPrompt } : {}),
      updatedAt: Date.now(),
    });
    return this.store.get(id);
  }

  /**
   * 删除端点：级联删全部事件 + secrets 清理（密钥本体一并抹除）。
   * @returns 是否确有端点被删除
   */
  async deleteEndpoint(id: string): Promise<boolean> {
    const current = await this.store.get(id);
    if (current === null) return false;
    await this.store.deleteEventsByEndpoint(id);
    if (current.secretRef !== null) {
      await this.secrets.delete(current.secretRef).catch((cause: unknown) => {
        // 密钥清理失败不阻断删除（secrets 层单点故障不应留下删不掉的端点），只记日志
        this.logger.warn({ err: cause, endpointId: id }, 'flow: secret cleanup during delete failed');
      });
    }
    await this.store.delete(id);
    this.logger.info({ endpointId: id, slug: current.slug }, 'flow: endpoint deleted');
    return true;
  }

  /**
   * 轮换 HMAC 密钥：新密钥覆盖 secrets 层同一引用（旧签名立即失效）。
   * @returns **一次性明文 secret**（仅本响应返回）
   */
  async rotateSecret(id: string): Promise<{ secret: string }> {
    const current = await this.store.get(id);
    if (current === null) throw endpointNotFound(id);
    const secretRef = current.secretRef ?? `flow.${id}.secret`;
    const secret = randomBytes(SECRET_BYTES).toString('hex');
    await this.secrets.set(secretRef, secret);
    if (current.secretRef === null) {
      // 历史无密钥端点：轮换即补齐引用（此后入站开始强制校验签名）
      await this.store.update(id, { secretRef, updatedAt: Date.now() });
    }
    this.logger.info({ endpointId: id }, 'flow: endpoint secret rotated');
    return { secret };
  }

  // -------------------------------------------------------------------------
  // 入站管线
  // -------------------------------------------------------------------------

  /**
   * 入站事件处理（公开路由 /hooks/flow/:slug 的直接委托方；见模块头注释的管线契约）。
   * 任何分派失败都不抛出——事件标 failed 后正常返回（HTTP 侧恒 200，重试语义交发送方）。
   * @throws HarnessError（EXT_NOT_FOUND / FLOW_DISABLED / UNAUTHORIZED）仅路由级失败：
   *   端点不存在（404）/ 已禁用（403）/ 签名校验失败（401）
   */
  async handleInbound(
    slug: string,
    rawBody: Buffer,
    headers: FlowHeaders,
    sourceIp?: string,
  ): Promise<FlowInboundResult> {
    // 1. slug 查端点
    const endpoint = await this.store.getBySlug(slug);
    if (endpoint === null) throw endpointNotFound(slug);
    if (!endpoint.enabled) {
      throw err('FLOW_DISABLED', { detail: { slug } });
    }
    // 2. 签名校验（无密钥端点跳过；密钥不可解 fail-closed）
    await this.#verifySignature(endpoint, rawBody, headers);

    // 3. 事件落库（received；payload 只留摘要，原始全文不落库）
    const eventId = randomUUID();
    const digest = createHash('sha256').update(rawBody).digest('hex');
    const payload = parsePayload(rawBody);
    await this.store.insertEvent({
      id: eventId,
      endpointId: endpoint.id,
      status: 'received',
      payloadDigest: digest,
      sourceIp: sourceIp ?? null,
      error: null,
      result: null,
      createdAt: Date.now(),
    });
    this.#publish(endpoint.id, 'flow.received', {
      eventId,
      endpointId: endpoint.id,
      slug: endpoint.slug,
      status: 'received',
    });

    // 4. flow_type 分派（失败标 failed + error，不外溢）
    let status: 'processed' | 'failed';
    try {
      const result = await this.#dispatch(endpoint, payload);
      status = 'processed';
      await this.store.updateEventStatus(eventId, { status, result });
      this.#publish(endpoint.id, 'flow.processed', { eventId, endpointId: endpoint.id, status, result });
    } catch (cause) {
      status = 'failed';
      const error = cause instanceof Error ? cause.message : String(cause);
      await this.store.updateEventStatus(eventId, { status, error, result: null });
      this.#publish(endpoint.id, 'flow.failed', { eventId, endpointId: endpoint.id, status, error });
      this.logger.warn({ err: cause, endpointId: endpoint.id, eventId }, 'flow: inbound dispatch failed');
    }
    return { eventId, status };
  }

  /**
   * 事件列表（审计读取；天然脱敏——表里只有 payload 摘要，无原始全文可泄）。
   * @param opts.limit 条数上限（1..200，缺省 50）
   * @param opts.before 游标（UTC epoch ms）：只返回 created_at < before 的事件
   */
  listEvents(
    endpointId: string,
    opts?: { limit?: number; before?: number },
  ): Promise<FlowEventRecord[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(opts?.limit ?? DEFAULT_EVENT_LIMIT)));
    return this.store.listEvents(endpointId, {
      limit,
      ...(opts?.before !== undefined ? { before: opts.before } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // 内部：校验 / 签名 / 分派
  // -------------------------------------------------------------------------

  /** flow_type 合法性（非法 → VALIDATION_FAILED） */
  #assertFlowType(flowType: string): FlowType {
    const hit = (FLOW_TYPES as readonly string[]).includes(flowType) ? flowType as FlowType : undefined;
    if (hit === undefined) {
      throw err('VALIDATION_FAILED', {
        message: `flowType must be one of ${FLOW_TYPES.join(' | ')} (got "${flowType}")`,
        detail: { flowType },
      });
    }
    return hit;
  }

  /** flow_type 相关 flowConfig 结构校验（notify 必填 notification.title；llm 可选 model；log 透传） */
  #assertFlowConfig(flowType: FlowType, flowConfig: unknown): unknown {
    if (flowType === 'notify') {
      const parsed = notifyConfigSchema.safeParse(flowConfig ?? null);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'notify endpoint requires flowConfig.notification { title, body?, level?, data? }',
          detail: parsed.error.issues,
        });
      }
      return flowConfig;
    }
    if (flowType === 'llm') {
      const parsed = llmConfigSchema.safeParse(flowConfig ?? {});
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: 'llm endpoint flowConfig must be { model?: string }',
          detail: parsed.error.issues,
        });
      }
      return flowConfig ?? null;
    }
    return flowConfig ?? null; // log 型不约束结构
  }

  /** llm 型提示词必填 */
  #assertLlmPrompt(llmPrompt: string | undefined): void {
    if (typeof llmPrompt !== 'string' || llmPrompt.trim() === '') {
      throw err('VALIDATION_FAILED', {
        message: 'llm endpoint requires llmPrompt (supports {{payload}} / {{field.path}} placeholders)',
        detail: { flowType: 'llm' },
      });
    }
  }

  /** llm 网关可用性（缺失 → VALIDATION_FAILED；lazy getter 允许 boot 后替换/注入替身） */
  #assertGatewayAvailable(): void {
    if (this.deps.gateway?.() === undefined) {
      throw err('VALIDATION_FAILED', {
        message: 'flowType "llm" requires the llm gateway, which is not available in this deployment',
        detail: { flowType: 'llm', dependency: 'gateway' },
      });
    }
  }

  /** 通知管理器可用性（缺失 → VALIDATION_FAILED） */
  #assertNotificationsAvailable(): void {
    if (this.deps.notifications?.() === undefined) {
      throw err('VALIDATION_FAILED', {
        message: 'flowType "notify" requires the notification manager, which is not available in this deployment',
        detail: { flowType: 'notify', dependency: 'notifications' },
      });
    }
  }

  /** 签名校验：有 secret_ref 时强制 `sha256=<hex hmac(rawBody, secret)>`；无密钥跳过 */
  async #verifySignature(endpoint: FlowEndpointRecord, rawBody: Buffer, headers: FlowHeaders): Promise<void> {
    if (endpoint.secretRef === null) return; // 无密钥端点：跳过校验（token/slug 即唯一凭据）
    const secret = await this.secrets.get(endpoint.secretRef);
    const headerRaw = headers[SIGNATURE_HEADER];
    const provided = (Array.isArray(headerRaw) ? headerRaw[0] : headerRaw)?.trim() ?? '';
    const expected =
      secret !== null ? createHmac('sha256', secret).update(rawBody).digest('hex') : '';
    // fail-closed：secret_ref 存在但密钥不可解（被删/解密失败）视同校验失败
    const scheme = 'sha256=';
    const ok =
      secret !== null && provided.startsWith(scheme) && timingSafeHexEqual(expected, provided.slice(scheme.length).trim());
    if (!ok) {
      // 密钥/签名不入 detail（401 响应与日志都不回显任何材料）
      throw err('UNAUTHORIZED', { message: 'flow webhook signature verification failed' });
    }
  }

  /** flow_type 分派：log 记录 / notify 发通知 / llm 单轮提示词（返回值写入事件 result） */
  async #dispatch(endpoint: FlowEndpointRecord, payload: unknown): Promise<unknown> {
    switch (endpoint.flowType) {
      case 'log':
        return { logged: true };
      case 'notify':
        return await this.#dispatchNotify(endpoint, payload);
      case 'llm':
        return await this.#dispatchLlm(endpoint, payload);
    }
  }

  /** notify 分派：模板渲染 → notifications.send → { notificationId } */
  async #dispatchNotify(endpoint: FlowEndpointRecord, payload: unknown): Promise<unknown> {
    const notifications = this.deps.notifications?.();
    if (notifications === undefined) {
      throw err('SERVICE_UNAVAILABLE', {
        message: 'notification manager is not available (flow endpoint "notify" cannot dispatch)',
      });
    }
    const parsed = notifyConfigSchema.safeParse(endpoint.flowConfig ?? null);
    if (!parsed.success) {
      // 创建时已校验；脏数据（库外改动）兜底为 failed 事件
      throw err('VALIDATION_FAILED', { detail: parsed.error.issues });
    }
    const n = parsed.data.notification;
    const record = await notifications.send({
      title: renderTemplate(n.title, payload),
      ...(n.body !== undefined ? { body: renderTemplate(n.body, payload) } : {}),
      ...(n.level !== undefined ? { level: n.level } : {}),
      ...(n.data !== undefined ? { data: renderDeep(n.data, payload) } : {}),
    });
    return { notificationId: record.id };
  }

  /** llm 分派：提示词渲染（{{payload}} 注入 JSON）→ gateway.chat 单轮 → { text, usage } */
  async #dispatchLlm(endpoint: FlowEndpointRecord, payload: unknown): Promise<unknown> {
    const gateway = this.deps.gateway?.();
    if (gateway === undefined) {
      throw err('SERVICE_UNAVAILABLE', {
        message: 'llm gateway is not available (flow endpoint "llm" cannot dispatch)',
      });
    }
    const prompt = endpoint.llmPrompt ?? '';
    const model = await this.#resolveModel(endpoint, gateway);
    const outcome = await gateway.chat({
      model,
      messages: [{ role: 'user', content: renderTemplate(prompt, payload) }],
      stream: false,
    });
    return {
      text: outcome.text ?? '',
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    };
  }

  /** 模型解析：flowConfig.model 优先；否则第一可用 provider 的缺省模型；都没有 → LLM_NOT_CONFIGURED */
  async #resolveModel(endpoint: FlowEndpointRecord, gateway: FlowLlmGatewayLike): Promise<string> {
    const configured = isRecord(endpoint.flowConfig) ? endpoint.flowConfig['model'] : undefined;
    if (typeof configured === 'string' && configured !== '') return configured;
    try {
      const providers = await gateway.getProviders?.();
      const model = providers?.find((p) => Array.isArray(p.models) && p.models.length > 0)?.models[0];
      if (typeof model === 'string' && model !== '') return model;
    } catch (cause) {
      this.logger.warn({ err: cause, endpointId: endpoint.id }, 'flow: llm provider lookup failed');
    }
    throw err('LLM_NOT_CONFIGURED', {
      message: 'no llm model resolvable for flow endpoint (set flowConfig.model or configure an llm provider)',
      detail: { endpointId: endpoint.id },
    });
  }

  /** slug 生成：slugify 基底 + 4 位随机后缀；撞名重试（唯一约束最终兜底） */
  async #generateSlug(name: string): Promise<string> {
    const base = slugifyBase(name);
    for (let i = 0; i < SLUG_MAX_ATTEMPTS; i++) {
      const candidate = `${base}-${randomBytes(2).toString('hex')}`;
      if ((await this.store.getBySlug(candidate)) === null) return candidate;
    }
    throw err('INTERNAL', { message: 'flow slug generation failed after repeated collisions' });
  }

  /** SSE 广播门面（fire-and-forget；publish 缺省时不做任何事） */
  #publish(endpointId: string, event: string, data: unknown): void {
    try {
      this.deps.publish?.(`flow:${endpointId}`, event, data);
    } catch (cause) {
      this.logger.warn({ err: cause, endpointId, event }, 'flow: sse publish failed');
    }
  }
}
