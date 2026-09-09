/**
 * Skills/batchImport — 拖拽批量导入的异步编排壳（浏览器专用，根 vitest 不直测）。
 *
 * 纯逻辑（分类 / frontmatter / 首段 / id 去重 / LLM 输出解析）在 ./dragdrop，
 * 本模块只做 IO：
 * - 文本类（.md/.markdown/.txt）：File.text() 直读；
 * - 二进制（.pdf/.docx 等）：POST /api/v1/extract（multipart file）提取文本——
 *   端点未接线（404 / 503）或提取失败 → 该文件带 error 进失败清单（降级提示）；
 * - LLM 元信息（可选增强）：GET /api/v1/llm/models 取第一可用模型 →
 *   POST /api/v1/llm/chat 生成 { name, description } JSON——模型不可用或生成
 *   解析失败一律返回 null，调用方降级「文件名 + 首段」，不阻塞批量流程。
 *
 * 全部请求走 silent（错误由失败清单逐行呈现，不经 api 层全局 toast）。
 */
import { api } from '@/lib/api';
import { errText, isApiError } from '@/pages/_shared';
import { classifyDroppedFile, parseLlmMetaJson, type DroppedFileInput, type LlmDraftMeta } from './dragdrop';

/** POST /api/v1/extract 应答（内核 fileextract 契约：{ fileExt, text, charCount, ocrUsed, warnings }） */
export interface ExtractResult {
  fileExt: string;
  text: string;
  charCount: number;
  ocrUsed: boolean;
  warnings: string[];
}

/** POST /api/v1/llm/chat 应答的最小视图（内核 LlmChatResult.text） */
interface LlmChatResultView {
  text?: string;
}

/** extract 端点未接线的降级提示（404 / 503 时进失败清单） */
export const EXTRACT_ENDPOINT_UNAVAILABLE =
  '文本提取端点未接线（POST /api/v1/extract 不可用），该文件暂无法导入';

/** LLM 生成 name/description 时送给模型的正文采样长度 */
const LLM_SAMPLE_CHARS = 4000;

/** 读取拖入文件列表 → 草稿输入（逐文件互不阻塞；单文件失败不拖垮整批） */
export async function readDroppedFiles(files: readonly File[]): Promise<DroppedFileInput[]> {
  return Promise.all(files.map((file) => readDroppedFile(file)));
}

async function readDroppedFile(file: File): Promise<DroppedFileInput> {
  const kind = classifyDroppedFile(file.name);
  if (kind === 'unsupported') return { fileName: file.name, kind };
  if (kind === 'markdown' || kind === 'text') {
    try {
      return { fileName: file.name, kind, text: await file.text() };
    } catch (e) {
      return { fileName: file.name, kind, error: `文件读取失败：${errText(e)}` };
    }
  }
  // 二进制 → POST /api/v1/extract（multipart，浏览器自动补 boundary）
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await api.post<ExtractResult>('/api/v1/extract', form, { silent: true });
    return { fileName: file.name, kind, text: typeof res?.text === 'string' ? res.text : '' };
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 503 || e.status === 501)) {
      return { fileName: file.name, kind, error: EXTRACT_ENDPOINT_UNAVAILABLE };
    }
    return { fileName: file.name, kind, error: `文本提取失败：${errText(e)}` };
  }
}

/**
 * 取第一可用模型（GET /api/v1/llm/models 聚合视图按 provider 顺序取首个非空
 * 模型）；端点不可用 / 无任何模型 → null（跳过 LLM，全部走「文件名 + 首段」降级）。
 */
export async function resolveFirstLlmModel(): Promise<string | null> {
  try {
    const aggregates = await api.get<Array<{ provider: string; models: string[] }>>('/api/v1/llm/models', {
      silent: true,
    });
    for (const agg of aggregates ?? []) {
      const model = (agg?.models ?? []).find((m) => typeof m === 'string' && m.trim() !== '');
      if (model !== undefined) return model.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * LLM 生成技能 name/description（POST /api/v1/llm/chat，非流式）：提示词要求
 * 只输出 JSON；任何失败（网络 / 无模型 / 输出不可解析）→ null 降级，不抛错。
 */
export async function generateDraftMeta(fileName: string, text: string, model: string): Promise<LlmDraftMeta | null> {
  const sample = text.length > LLM_SAMPLE_CHARS ? `${text.slice(0, LLM_SAMPLE_CHARS)}…` : text;
  const prompt = [
    `你是技能库整理助手。下面是一份文档「${fileName}」的内容节选。`,
    '请为它生成一个可导入 Agent Skills 技能库的元信息：',
    '- name：简短的技能展示名（≤20 字，中文或英文）',
    '- description：一句话描述技能用途（≤100 字）',
    '只输出一个 JSON 对象，格式：{"name": "...", "description": "..."}，不要输出其他内容。',
    '',
    sample,
  ].join('\n');
  try {
    const res = await api.post<LlmChatResultView>(
      '/api/v1/llm/chat',
      { model, messages: [{ role: 'user', content: prompt }] },
      { silent: true },
    );
    const raw = typeof res?.text === 'string' ? res.text : '';
    return parseLlmMetaJson(raw);
  } catch {
    return null;
  }
}
