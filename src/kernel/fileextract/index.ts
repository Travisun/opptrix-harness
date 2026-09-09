/**
 * fileextract — 文件内容提取引擎出口（内核服务 / REST / 桥 / MCP 工具的统一装配面）。
 */
export * from './types.js';
export { FileExtractService, createExtractTaskHandler, runExtraction, detectExtractKind } from './service.js';
export type {
  FileExtractServiceDeps,
  ExtractRuntime,
  ExtractTaskHandlerDeps,
  ExtractKind,
} from './service.js';
export {
  OCR_MODEL_FILES,
  ensureOcrModelsDownloaded,
  getOcrDownloadState,
  missingOcrModelFiles,
  ocrModelDir,
  sourcesForRemote,
} from './model-downloader.js';
export {
  isOcrAvailable,
  isOcrModelReady,
  getOcrModelStatus,
  closeOcrEngine,
  releaseOcrInstance,
  resolveOcrIdleMs,
  DEFAULT_OCR_IDLE_MS,
  OCR_TIMEOUT_MS,
} from './engines/ocr.js';
export {
  setOcrFactoryForTests,
  hasOcrSingletonForTests,
  getOcrLastUsedAtForTests,
} from './engines/ocr.js';
export { resetOcrDownloadStateForTests } from './model-downloader.js';
export { createFileExtractBridge, FILE_EXTRACT_PERMISSION } from './bridge.js';
export type { FileExtractBridgeDeps, FileExtractBridgeHandlers } from './bridge.js';
