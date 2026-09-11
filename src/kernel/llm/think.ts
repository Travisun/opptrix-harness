/**
 * think — `<think>...</think>` 思考块剥离（Qwen 系兼容网关把思考链写进正文而非独立字段）。
 *
 * 两条路径：
 * - **非流式**：`extractThinkContent(text)` 一次性剥离全部完整块与末尾未闭合块
 *   （截断输出时 Qwen 常漏闭合标签），剥离段拼接为 reasoning，剩余为正文；
 * - **流式**：`createThinkStripper()` 增量状态机——逐 delta 判断 think 开/闭，
 *   **跨 delta 边界安全**（`<think>`/`</think>` 标签被拆在多个 delta 时正确缓冲匹配，
 *   误判零容忍：仅当缓冲不再是标签前缀时才放行正文）。流结束 `flush()` 收尾残余缓冲。
 *
 * 剥离出的思考链进入 reasoning（LlmChatResult.reasoning / reasoning_delta 事件），
 * 绝不混入 text；与 `reasoning_content` 字段路径并存时字段优先（显式约定 > 正文启发式）。
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** 提取结果：text 为剥离后的正文，reasoning 为剥离出的思考链（无则空串） */
export interface ThinkExtraction {
  text: string;
  reasoning: string;
}

/** 找出 buf 尾部仍是 tag 前缀的最长后缀长度（跨 delta 边界缓冲的依据） */
function trailingTagPrefixLength(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let keep = max; keep > 0; keep--) {
    if (tag.startsWith(buf.slice(buf.length - keep))) return keep;
  }
  return 0;
}

/**
 * 流式剥离状态机（见模块头注释）。push 返回本次增量产出的 {text, reasoning}；
 * flush 收尾：缓冲残余按当前状态归入 text 或 reasoning。
 */
export interface ThinkStreamStripper {
  push(delta: string): ThinkExtraction;
  flush(): ThinkExtraction;
}

export function createThinkStripper(): ThinkStreamStripper {
  let inThink = false;
  let buf = '';

  const run = (chunk: string, sink: ThinkExtraction): void => {
    for (const ch of chunk) {
      buf += ch;
      const tag = inThink ? THINK_CLOSE : THINK_OPEN;
      if (buf === tag) {
        // 开/闭标签完整命中：切换状态，缓冲清空
        inThink = !inThink;
        buf = '';
        continue;
      }
      if (tag.startsWith(buf)) continue; // 仍可能是标签前缀：继续缓冲
      // 确定不是标签：放行"安全前缀"，仅保留尾部潜在前缀继续缓冲
      const keep = trailingTagPrefixLength(buf, tag);
      const safe = buf.slice(0, buf.length - keep);
      if (inThink) sink.reasoning += safe;
      else sink.text += safe;
      buf = buf.slice(buf.length - keep);
    }
  };

  return {
    push(delta) {
      const out: ThinkExtraction = { text: '', reasoning: '' };
      run(delta, out);
      return out;
    },
    flush() {
      const out: ThinkExtraction = { text: '', reasoning: '' };
      if (buf !== '') {
        if (inThink) out.reasoning += buf;
        else out.text += buf;
        buf = '';
      }
      return out;
    },
  };
}

/**
 * 非流式一次性剥离：完整 `<think>...</think>` 块 + 末尾未闭合 `<think>...`（EOF 截断）
 * 全部归入 reasoning（多块内容按出现序连续拼接）；紧随被剥离块的换行/空白一并吃掉
 * （`<think>…</think>\n\n答案` → 正文 `答案`，前缀稳定利于 provider 缓存）。
 */
export function extractThinkContent(text: string): ThinkExtraction {
  const stripper = createThinkStripper();
  const pushed = stripper.push(text);
  const flushed = stripper.flush();
  const reasoning = [pushed.reasoning, flushed.reasoning].filter((s) => s !== '').join('');
  let outText = [pushed.text, flushed.text].filter((s) => s !== '').join('');
  if (reasoning !== '') outText = outText.replace(/^\s+/, '');
  return { text: outText, reasoning };
}
