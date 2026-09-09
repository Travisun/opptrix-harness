/**
 * asr/types — 语音识别（Whisper via @huggingface/transformers）模块的共享类型。
 *
 * 模块组成：
 * - downloader：模型文件后台静默下载（HF 直连 → hf-mirror → ModelScope 镜像优选链）
 * - engine：transformers.js pipeline 懒加载单例 + 空闲卸载
 * - manager：状态机编排（disabled/not-downloaded/downloading/ready/error）+ transcribe 门面
 *
 * PCM 契约（重要）：本模块只接受 **16kHz 单声道 Float32 PCM**（transformers.js whisper
 * 的原生输入形状）。浏览器端 MediaRecorder 产出的 webm/opus 容器由前端在上传前用
 * WebAudio `decodeAudioData` 解码并 `AudioSampleRate` 重采样为 16kHz——内核**不依赖
 * ffmpeg**，不做任何音频容器解码或重采样。REST/桥接线格式见 `../api/asr.ts` 与
 * `createAsrBridge`（samplesBase64 = Float32 小端字节流的 base64 编码）。
 */

/** ASR 管理器状态机的全部状态 */
export type AsrState =
  | 'disabled' // HARNESS_ASR_ENABLED=false（或装配时 enabled:false）——功能整体关闭
  | 'not-downloaded' // 模型未缓存且无下载进行中
  | 'downloading' // 后台静默下载进行中（progress 0–100）
  | 'ready' // 模型文件已就绪（pipeline 可能尚未加载——懒加载）
  | 'error'; // 最近一次下载失败（error 携带原因；再次 ensure 可重试）

/** GET /api/v1/asr/status 与 asrStatus 桥的统一状态快照 */
export interface AsrStatus {
  /** 状态机当前状态 */
  state: AsrState;
  /** 下载进度（0–100 整数）；仅 state === 'downloading' 时存在 */
  progress?: number;
  /** 最近一次失败原因（面向开发者的英文信息）；仅 state === 'error' 时存在 */
  error?: string;
  /** 当前使用的模型 id（如 onnx-community/whisper-base） */
  modelId: string;
  /** ASR 是否可用（state === 'ready'）——调用方据此决定是否提示下载 */
  enabled: boolean;
}

/** 下载进度回调事件：source 为当前成功取数的镜像源标签，pct 为总体进度 0–100 */
export interface AsrProgressEvent {
  source: string;
  pct: number;
}

/** ensureModel 的结果：dir 为模型目录（FileCache 布局根），source 为命中来源 */
export interface AsrEnsureResult {
  /** 模型目录：`<modelDir>/<modelId>`（transformers.js cache_dir 的 FileCache 布局） */
  dir: string;
  /** 命中来源：'cache'（已缓存）或镜像链标签（'huggingface' | 'hf-mirror' | 'modelscope'） */
  source: string;
  /** true = 全部必需文件已缓存，未发生任何网络请求 */
  cached: boolean;
}

/** transcribe 选项（透传 whisper pipeline；language 为 ISO 639-1 或语言英文名） */
export interface AsrTranscribeOptions {
  /** 源语言提示（如 'zh' | 'en' | 'french'）；缺省自动检测（多语言模型） */
  language?: string;
}

/** transcribe 结果 */
export interface AsrTranscribeResult {
  /** 识别文本（已去除首尾空白；空音频可能为 ''） */
  text: string;
  /** 本次推理耗时（毫秒，进程内计时，不含模型加载时间——加载时间在首次调用时计入） */
  durationMs: number;
}
