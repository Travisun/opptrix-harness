/**
 * flow — 传入 Webhook（FlowTrigger）子系统桶出口。
 *
 * 外部系统（Stripe 风格签名回调）POST /hooks/flow/:slug → FlowManager.handleInbound
 * （签名校验 → 事件落库 → log/notify/llm 分派 → SSE `flow:{endpointId}` 推送）。
 * REST 面见 src/api/flows.ts；装配见 src/kernel/providers/core-services.ts。
 */
export { FlowManager, renderTemplate, slugifyBase } from './manager.js';
export { FlowEndpointStore } from './store.js';
export {
  FLOW_EVENT_STATUSES,
  FLOW_TYPES,
} from './types.js';
export type {
  FlowEndpointCreateInput,
  FlowEndpointPatchInput,
  FlowEndpointRecord,
  FlowEndpointStoreLike,
  FlowEventRecord,
  FlowEventStatus,
  FlowHeaders,
  FlowInboundResult,
  FlowLlmGatewayLike,
  FlowManagerDeps,
  FlowNotifierLike,
  FlowPublishFn,
  FlowType,
} from './types.js';
