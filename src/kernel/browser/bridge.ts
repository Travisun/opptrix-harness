/**
 * browser/bridge — 扩展线程经 worker→kernel RPC 访问浏览器引擎的 handler 表。
 *
 * 与 skills/mcp/plugins/memory/asr/extract 桥同构：本工厂只产出 `handlers[topic]` 表
 * （键 = KERNEL_TOPICS.browserStatus / browserInstall / browserScreenshot），由集成方
 * （core-services）并入容器 'ext.bridges'，ExtensionManager 透传给桥。权限不在此自查
 * manifest——依赖注入的 requirePermission(extId, topic, permission) 闭包做裁决，三个
 * topic 都以 'browser' 权限收口（fail-closed：调用方非扩展端点、或未声明权限一律抛错）。
 *
 * 线格式：
 * - browser.status     {} → BrowserStatus（installed/running/installing/lastError）
 * - browser.install    {} → BrowserInstallResult（幂等；触发后台安装，不等完成）
 * - browser.screenshot { file } → { file, mime, base64 }（uuid 形状校验防穿越）
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';

import type {
  BrowserInstallResult,
  BrowserScreenshotFile,
  BrowserStatus,
} from './types.js';

/** 桥 handler 表形状（与 KernelBridgeHandlers 结构一致，但不依赖其类型避免环） */
export type BrowserBridgeHandler = (payload: unknown, from: string) => Promise<unknown>;
export type BrowserBridgeHandlers = Record<string, BrowserBridgeHandler>;

/** 扩展访问浏览器引擎所需的 manifest 权限名（白名单已登记，见 extensions/manifest.ts） */
export const BROWSER_PERMISSION = 'browser';

/** 引擎的桥窄面（BrowserEngine 结构兼容；测试可用替身） */
export interface BrowserBridgeService {
  status(): Promise<BrowserStatus>;
  install(): Promise<BrowserInstallResult>;
  readScreenshot(file: string): BrowserScreenshotFile;
}

/** createBrowserBridge 依赖集合 */
export interface BrowserBridgeDeps {
  service: BrowserBridgeService;
  /** 权限闸（集成方注入 kernel-handlers 同款闭包）：不通过即抛 FORBIDDEN */
  requirePermission: (extId: string, topic: string, permission: string) => void;
}

/** browser.screenshot 线格式 */
const screenshotPayloadSchema = z.object({ file: z.string().min(1).max(256) });

/** 端点 → 裸扩展 id（与 kernel-handlers 同规则）；'kernel'/空 → null */
function extIdFrom(from: string): string | null {
  if (from === 'kernel' || from === '') return null;
  return from.startsWith('ext:') ? from.slice('ext:'.length) : from;
}

/** 非扩展端点闸（RPC_PERMISSION_DENIED 同款语义） */
function requireExtCaller(from: string, topic: string): string {
  const extId = extIdFrom(from);
  if (extId === null || extId === '') {
    throw err('RPC_PERMISSION_DENIED', {
      message: `kernel service "${topic}" is only callable by extension endpoints (got "${from}")`,
      detail: { topic, from },
    });
  }
  return extId;
}

/** 装配浏览器扩展桥 handler 表（见模块头注释） */
export function createBrowserBridge(deps: BrowserBridgeDeps): BrowserBridgeHandlers {
  const gated = (topic: string, handler: (extId: string, payload: unknown) => Promise<unknown>): BrowserBridgeHandler => {
    return async (payload, from) => {
      const extId = requireExtCaller(from, topic);
      deps.requirePermission(extId, topic, BROWSER_PERMISSION);
      return await handler(extId, payload);
    };
  };

  return {
    [KERNEL_TOPICS.browserStatus]: gated(KERNEL_TOPICS.browserStatus, async () => deps.service.status()),
    [KERNEL_TOPICS.browserInstall]: gated(KERNEL_TOPICS.browserInstall, async () => deps.service.install()),
    [KERNEL_TOPICS.browserScreenshot]: gated(KERNEL_TOPICS.browserScreenshot, async (_extId, payload) => {
      const parsed = screenshotPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('BAD_REQUEST', { message: 'browser.screenshot requires payload { file: string }' });
      }
      return deps.service.readScreenshot(parsed.data.file);
    }),
  };
}
