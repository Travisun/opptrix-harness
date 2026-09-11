/**
 * 文本内嵌工具调用标记恢复层（markup recovery，纯函数、零项目内依赖）。
 *
 * 背景：LongCat/Qwen 系兼容网关偶发不返回原生 `tool_calls`，而是把工具调用以文本
 * 标记写进 `message.content`，如：
 *   <longcat_tool_call>{"name":"workspace_read","arguments":{"path":"a.md"}}</longcat_tool_call>
 * 也见过 `<tool_call>`、`<|tool_call|>` 等变体（闭标签相应有 `</…>`、`<|/…|>`、`</|…|>`）。
 *
 * 识别策略：开标签 `<|?(?:[a-z0-9_]+_)?tool_call|?…>` + **同族**闭标签（按 kind 匹配：
 * 标签名去掉竖线与闭合斜杠后的归一化名）。标签体内为 JSON 对象
 * `{"name": …, "arguments": {…}}`；解析失败/缺 name/非对象 → 该块视为普通正文**原样保留**
 * （正文可能碰巧包含该字符串，绝不吞文本）。只解析「开+闭」完整块：残缺块（无闭标签）
 * 同样原样保留，避免误伤未生成完的正文。
 */

/** 恢复出的单个工具调用（kind = 标记族归一化名，诊断元数据；接入方映射为 LlmResultToolCall 时剔除） */
export interface RecoveredToolCall {
  id: string;
  name: string;
  argsJson: string;
  /** 标记族归一化名（标签名去掉竖线/闭合斜杠，如 `longcat_tool_call` / `tool_call`） */
  kind: string;
}

/** 文本标记恢复结果：toolCalls 按出现序；cleanedText = 剥离已成功解析块后的正文 */
export interface ToolMarkupRecovery {
  toolCalls: RecoveredToolCall[];
  cleanedText: string;
}

/**
 * 开标签：`<longcat_tool_call>` / `<tool_call>` / `<|tool_call|>`，允许尾缀属性（`\s…>`）。
 * 前缀可选且必须以 `_` 结尾（`longcat_`）；竖线为 `<|tool_call|>` 族的两侧装饰。
 */
const OPEN_TAG_RE = /<\|?(?:[a-z0-9_]+_)?tool_call\|?(?:\s[^>]*)?>/gi;

/** 闭标签：`</longcat_tool_call>` / `</tool_call>` / `<|/tool_call|>` / `</|tool_call|>` */
const CLOSE_TAG_RE = /<\|?\/\|?(?:[a-z0-9_]+_)?tool_call\|?>/gi;

/** 快速探测用（非 global，无 lastIndex 状态）：开或闭标签任一命中即含标记 */
const ANY_TAG_RE = /<\|?\/?\|?(?:[a-z0-9_]+_)?tool_call\|?(?:\s[^>]*)?>/i;

/** 标签文本 → 标记族归一化名（去 `<``>``|``/` 与属性，只留 name 核心并小写） */
function kindOf(tag: string): string {
  const m = /<\|?\/?\|?((?:[a-z0-9_]+_)?tool_call)/i.exec(tag);
  return (m?.[1] ?? '').toLowerCase();
}

/** call_ + 8 位随机 hex（globalThis.crypto，Node ≥19 全局可用；不引模块保持零依赖） */
function makeCallId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `call_${hex}`;
}

/**
 * 标签体 → 调用（不可解析返回 null）：
 * `{"name":"…","arguments":{…}}`；arguments 缺省/null → `{}`；name 缺失/非字符串/空白 → null；
 * JSON 破损或非对象（含数组/标量）→ null（调用方保留原文）。
 */
function parseCallBody(raw: string): { name: string; argsJson: string } | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const rec = obj as { name?: unknown; arguments?: unknown };
  if (typeof rec.name !== 'string' || rec.name.trim() === '') return null;
  const args = rec.arguments === undefined || rec.arguments === null ? {} : rec.arguments;
  return { name: rec.name.trim(), argsJson: JSON.stringify(args) ?? '{}' };
}

/** 清洗已剥离块后的正文：折叠行尾空白与 3+ 连续换行，收敛首尾空白行 */
function tidyCleaned(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}

/** 快速探测：正文是否可能含工具调用标记（宽松前缀检查；权威判定以 recover 为准） */
export function hasToolMarkup(text: string): boolean {
  if (!text) return false;
  return ANY_TAG_RE.test(text);
}

/**
 * 从正文恢复文本内嵌工具调用：
 * - 逐个开标签扫描，找**同 kind** 的最近闭标签构成完整块；标签体解析成功才回收；
 * - 已成功解析的块自正文剥离（紧邻换行一并吸收 + 首尾空白行折叠）；未解析块（JSON 破损/
 *   缺 name/残缺无闭）原样保留，不吞正文；
 * - 多块按出现序全部提取；id 为 `call_${8hex}` 随机生成。
 * 无任何可恢复调用时原样返回（toolCalls 空、cleanedText === 原文）。
 */
export function recoverToolCallsFromText(text: string): ToolMarkupRecovery {
  if (!hasToolMarkup(text)) return { toolCalls: [], cleanedText: text };

  const toolCalls: RecoveredToolCall[] = [];
  const spans: Array<[number, number]> = [];

  OPEN_TAG_RE.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = OPEN_TAG_RE.exec(text)) !== null) {
    const kind = kindOf(open[0]);
    const bodyStart = open.index + open[0].length;
    // 自开标签之后找第一个同族闭标签（跨族闭标签跳过；无闭 = 残缺块，原样保留）
    CLOSE_TAG_RE.lastIndex = bodyStart;
    let close: RegExpExecArray | null;
    let matched: RegExpExecArray | null = null;
    while ((close = CLOSE_TAG_RE.exec(text)) !== null) {
      if (kindOf(close[0]) === kind) {
        matched = close;
        break;
      }
    }
    if (matched === null) {
      OPEN_TAG_RE.lastIndex = bodyStart;
      continue;
    }
    const blockEnd = matched.index + matched[0].length;
    const parsed = parseCallBody(text.slice(bodyStart, matched.index));
    if (parsed !== null) {
      toolCalls.push({ id: makeCallId(), name: parsed.name, argsJson: parsed.argsJson, kind });
      spans.push([open.index, blockEnd]);
    }
    // 已处理完整块（含解析失败保留的）：扫描越过其闭标签，不再重扫块内正文
    OPEN_TAG_RE.lastIndex = blockEnd;
  }

  if (toolCalls.length === 0) return { toolCalls: [], cleanedText: text };

  let cleaned = '';
  let cursor = 0;
  for (const [start0, end0] of spans) {
    // 块紧邻的换行一并吸收（前有换行优先吸收块后一个，其次吸收块前一个），
    // 避免「正文\n块\n正文」剥离后残留空行
    let start = start0;
    let end = end0;
    if (text[end] === '\n') end += 1;
    else if (start > 0 && text[start - 1] === '\n') start -= 1;
    cleaned += text.slice(cursor, start);
    cursor = end;
  }
  cleaned += text.slice(cursor);

  return { toolCalls, cleanedText: tidyCleaned(cleaned) };
}
