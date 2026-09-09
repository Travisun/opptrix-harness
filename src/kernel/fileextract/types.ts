/**
 * fileextract types — 文件内容提取引擎的公共契约（内核服务 / REST / 桥 / MCP 工具共用）。
 *
 * 设计要点：
 * - 引擎对内容问题（损坏 / 不支持 / OCR 未就绪）**不抛错**，一律以 warnings + 空文本的
 *   ExtractResult 表达（needsOcr 标记弱文本层），调用方可安全地把结果直接给 LLM；
 * - 只有入参错误（缺 buffer/fileId、文件不存在、无权限）才抛 HarnessError；
 * - `ocr` 模式：'auto'（弱文本 PDF / 图片自动升级 OCR，缺省）| 'never'（禁用）| 'always'（强制尝试）。
 */

/** 提取引擎标识（result.engine；ocr 表示最终文本来自或升级自 OCR） */
export type ExtractEngineId = 'text' | 'pdf' | 'office' | 'ocr';

/** 按页切片（page 缺省 = 单页文档；长页软切后同页多 chunk） */
export interface ExtractChunk {
  page?: number;
  text: string;
}

/** 提取结果（REST / 桥 / MCP 工具的统一返回形状） */
export interface ExtractResult {
  /** 小写扩展名（含点，如 '.txt'；未知为 ''） */
  fileExt: string;
  /** 最终采用内容的引擎 */
  engine: ExtractEngineId;
  /** 页数（PDF 页 / 幻灯片 / Excel sheet；纯文本恒 1；未知缺省） */
  pages?: number;
  /** 提取文本（各页以 '\n\n' 连接；REST/桥层再按上限截断） */
  text: string;
  /** text 的字符数 */
  charCount: number;
  /** 按页切片（引擎可提供；纯文本单 chunk） */
  chunks?: ExtractChunk[];
  /** 最终文本是否来自 OCR */
  ocrUsed: boolean;
  /** 非致命告警（降级 / 截断 / OCR 未就绪等；面向调用方与日志） */
  warnings: string[];
  /** 提取耗时（毫秒） */
  durationMs: number;
  /**
   * 弱文本层标记：文本层字数过低（如扫描件 PDF）建议 OCR；
   * OCR 已尝试且失败 / 未就绪时同样置 true（配合 warnings）。
   */
  needsOcr?: boolean;
}

/** OCR 模式（service.extract 的 opts.ocr） */
export type ExtractOcrMode = 'auto' | 'never' | 'always';

/** 提取选项 */
export interface ExtractOptions {
  /** OCR 升级策略，缺省 'auto' */
  ocr?: ExtractOcrMode;
  /** 深度提取（强制 OCR 升级尝试，等价 ocr:'always' 的语义开关） */
  deep?: boolean;
}

/** 直接携带内容的提取入参 */
export interface ExtractFileInput {
  /** 文件内容（Buffer） */
  data: Buffer;
  /** 文件名（扩展名 / MIME 的路由依据） */
  name?: string;
  /** MIME 类型（扩展名缺失时的路由依据） */
  mime?: string;
}

/** 提取入参：内容或已上传 fileId 二选一 */
export type ExtractInput = ExtractFileInput | { fileId: string };

/** 任务线程池入参（JSON 序列化安全：buffer 以 base64 传递） */
export interface ExtractTaskArgs {
  dataBase64: string;
  name?: string;
  mime?: string;
  ocr?: ExtractOcrMode;
  deep?: boolean;
}

/**
 * 任务池窄接口：service.extract 优先把提取派发到 CPU 线程池执行。
 * 集成方把 TaskManager/TaskWorkerPool 适配成该形状（任务名 'file-extract'，
 * worker 侧经 createExtractTaskHandler 注册执行器）；派发失败由服务回退主线程并加警告。
 */
export interface ExtractTaskPool {
  run(jobId: string, args: ExtractTaskArgs): Promise<ExtractResult>;
}

/** OCR 模型状态（GET /api/v1/extract/status 与 KERNEL_TOPICS.extractStatus 的负载） */
export interface OcrModelStatus {
  /** downloaded | downloading | not-downloaded | error */
  state: 'downloaded' | 'downloading' | 'not-downloaded' | 'error';
  /** 下载进度 0..100（仅 downloading） */
  percent?: number;
  /** 模型目录（<dataDir>/models/ocr 或 HARNESS_OCR_MODEL_DIR 覆盖） */
  modelDir: string;
  /** 缺失的模型文件名（state=not-downloaded/error 时非空） */
  missingFiles: string[];
  /** 失败原因（state=error） */
  error?: string;
  /** 是否允许在提取时自动下载模型（HARNESS_OCR_AUTO_DOWNLOAD，缺省 false） */
  autoDownload: boolean;
}

/** 提取任务名（任务池 worker 侧注册 createExtractTaskHandler 产物时的约定名） */
export const EXTRACT_TASK_NAME = 'file-extract';

/** REST/桥返回文本的默认截断上限（字节）：8MB */
export const EXTRACT_TEXT_MAX_BYTES = 8 * 1024 * 1024;

/** 桥（KERNEL_TOPICS.extractFile）返回文本的截断上限（字节）：32KB */
export const BRIDGE_TEXT_MAX_BYTES = 32 * 1024;
