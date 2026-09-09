/**
 * fileextract 桥 — 扩展线程经 worker→kernel RPC 访问文件内容提取的 handler 表。
 *
 * 与 skills/mcp/plugins 桥同构（参照 kernel-handlers 的 requirePermission 收口模式）：
 * 本工厂只产出 `handlers[topic]` 表（键 = KERNEL_TOPICS.extractFile / extractStatus），
 * 由集成方并入 ExtensionManager.deps.bridgeHandlers。权限不在此自查 manifest——依赖注入的
 * `requirePermission(extId, topic, permission)` 闭包做裁决，本模块保证两个 topic 都以
 * 'files:read' 权限收口（fail-closed：调用方非扩展端点、或未声明权限，一律抛错）。
 *
 * 线格式：
 * - `extract.file`    { fileId, ocr?, deep? } → { fileId, engine, ocrUsed, pages?, charCount,
 *   truncated, text(≤32KB) }（结果同时落 file_extracts，供 LLM files_read 关联读取）
 * - `extract.status`  {} → OcrModelStatus（downloaded / downloading(pct) / not-downloaded / error）
 */
import { z } from 'zod';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err } from '../errors/index.js';
import type { OcrModelStatus } from './types.js';
import { BRIDGE_TEXT_MAX_BYTES } from './types.js';

/** 扩展访问文件提取所需 manifest 权限（与 h.files.read 同一权限） */
export const FILE_EXTRACT_PERMISSION = 'files:read';

/** 桥 handler 的统一形状（与 KernelBridgeHandlers 兼容，但不依赖其类型避免环） */
export type FileExtractBridgeHandler = (payload: unknown, from: string) => Promise<unknown>;
export type FileExtractBridgeHandlers = Record<string, FileExtractBridgeHandler>;

/** 桥依赖的 service 窄面（FileExtractService 结构兼容；测试可用替身） */
export interface FileExtractBridgeService {
  extractFile(
    fileId: string,
    opts?: { ocr?: 'auto' | 'never' | 'always'; deep?: boolean },
  ): Promise<{
    fileId: string;
    engine: string;
    ocrUsed: boolean;
    pages?: number;
    charCount: number;
    text: string;
    warnings: string[];
    needsOcr?: boolean;
    durationMs: number;
  }>;
  status(): OcrModelStatus;
}

/** createFileExtractBridge 依赖集合 */
export interface FileExtractBridgeDeps {
  /** 文件提取服务（kernel FileExtractService） */
  service: FileExtractBridgeService;
  /** 权限闸（集成方注入 kernel-handlers 同款闭包）：不通过即抛 FORBIDDEN */
  requirePermission: (extId: string, topic: string, permission: string) => void;
}

/** extract.file 线格式 */
const extractFileSchema = z.object({
  fileId: z.string().min(1).max(128),
  ocr: z.enum(['auto', 'never', 'always']).optional(),
  deep: z.boolean().optional(),
});

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

/**
 * 装配文件提取桥 handler 表（见模块头注释的线格式契约）。
 *
 * @param deps.service 文件提取服务（extractFile / status 窄面）
 * @param deps.requirePermission 权限闭包（集成方传 kernel-handlers 的校验实现；
 *   两个 topic 都以 FILE_EXTRACT_PERMISSION='files:read' 收口）
 */
export function createFileExtractBridge(deps: FileExtractBridgeDeps): FileExtractBridgeHandlers {
  /** 统一闸：扩展端点 + 'files:read' 权限 */
  const gate = (from: string, topic: string): string => {
    const extId = requireExtCaller(from, topic);
    deps.requirePermission(extId, topic, FILE_EXTRACT_PERMISSION);
    return extId;
  };

  return {
    [KERNEL_TOPICS.extractFile]: async (payload, from) => {
      const topic = KERNEL_TOPICS.extractFile;
      gate(from, topic);
      const parsed = extractFileSchema.safeParse(payload);
      if (!parsed.success) {
        throw err('VALIDATION_FAILED', {
          message: `kernel service "${topic}" requires payload { fileId: string, ocr?: 'auto'|'never'|'always', deep?: boolean }`,
          detail: parsed.error.issues,
        });
      }
      const result = await deps.service.extractFile(parsed.data.fileId, {
        ...(parsed.data.ocr !== undefined ? { ocr: parsed.data.ocr } : {}),
        ...(parsed.data.deep !== undefined ? { deep: parsed.data.deep } : {}),
      });
      const truncated = Buffer.byteLength(result.text, 'utf8') > BRIDGE_TEXT_MAX_BYTES;
      return {
        fileId: result.fileId,
        engine: result.engine,
        ocrUsed: result.ocrUsed,
        ...(result.pages !== undefined ? { pages: result.pages } : {}),
        charCount: result.charCount,
        needsOcr: result.needsOcr ?? false,
        warnings: result.warnings,
        truncated,
        text: truncated ? result.text.slice(0, BRIDGE_TEXT_MAX_BYTES) : result.text,
      };
    },

    [KERNEL_TOPICS.extractStatus]: async (_payload, from) => {
      gate(from, KERNEL_TOPICS.extractStatus);
      return deps.service.status();
    },
  };
}
