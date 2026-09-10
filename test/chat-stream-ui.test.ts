/**
 * Chat 前端流式消费 + 思考时间线 + Markdown 渲染 测试（extensions/webui ui-src）。
 *
 * 覆盖面（工作包：/chat 流式发送管线）：
 * A. chatStream.ts 纯函数层（仓库根 vitest 直接导入，零别名依赖）：
 *    - token 格式化（约 1.2k）与 usage 合计；
 *    - streamGen 代数防串台代数（begin/invalidate/isCurrent 单调性）；
 *    - SSE 帧解析（\n\n 切帧、data: 前缀、跳过空行/注释/非 data 行、跨 chunk 断行、CRLF、尾帧冲刷）；
 *    - 事件反序列化（合法/非法/未知事件）；
 *    - reducer 全周期（thinking 按 segmentIndex 累积、reply 累计草稿、工具步骤状态机、
 *      done/error 终态、可重放恒等、未知事件原样返回）；
 *    - streamSessionMessage 传输层（stub fetch + ReadableStream：事件顺序、请求形状、
 *      404 → ChatStreamHttpError、网络失败 → ChatStreamNetworkError、abort → AbortError）；
 *    - 防串台集成模式（会话切换 invalidate 后过期事件丢弃、新代不受污染）。
 * B. MarkdownMessage.tsx：行为（sanitizeUrl 白名单拒绝 javascript:/data:、sanitizeMarkdownText
 *    控制字符/截断）+ 源码契约（零 dangerouslySetInnerHTML、外链 target=_blank + rel noopener、
 *    urlTransform 接线、table 横向滚动包裹、code 语言标签外壳、工作区文件 chip）。
 * C. ThinkingPanel.tsx 源码契约：状态头「模型正在思考」动画点、思考分段灰字区（maxHeight +
 *    自动滚底）、步骤卡片状态机（running spinner / done ✓ / error ✗）、回复草稿 5 行渐隐 mask、
 *    历史消息「查看思考过程（N 段）」折叠时间线。
 * D. AgentChat.tsx 集成点：流式优先（streamSessionMessage + reducer 折叠 + done 正式入列）、
 *    降级回退旧 POST messages（404/网络错误且未见事件）、中途断线 REST 对账不重发、
 *    Stop（abort 断开即服务端取消）、会话切换 invalidate、token 标签（formatTokenCount）、
 *    ThinkingPanel 挂载、MarkdownMessage 接线、reasoningSegments 消费。
 * E. 新增源码文件无 console.*（与 webui.test.ts React 工程契约同款）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ChatStreamHttpError,
  ChatStreamNetworkError,
  applyChatStreamEvent,
  createInitialChatStreamSnapshot,
  createSseFeeder,
  createStreamGen,
  formatTokenCount,
  isAbortError,
  isChatStreamHttpError,
  isChatStreamNetworkError,
  parseChatStreamEvent,
  streamSessionMessage,
  usageTotalTokens,
  type ChatStreamEvent,
  type ChatStreamSnapshot,
} from '../extensions/webui/ui-src/src/pages/AgentChat/chatStream.js';
// 相对导入直取 .tsx 内的纯函数（react-markdown 在 ui-src/node_modules 下可解析）
import {
  MarkdownMessage,
  sanitizeMarkdownText,
  sanitizeUrl,
} from '../extensions/webui/ui-src/src/pages/AgentChat/MarkdownMessage.jsx';
import {
  previewKindOfName,
  workspaceFileRefFromUrl,
} from '../extensions/webui/ui-src/src/pages/AgentChat/filePreview.js';

// ---------------------------------------------------------------------------
// 公共路径
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENT_CHAT_DIR = path.join(
  REPO_ROOT,
  'extensions',
  'webui',
  'ui-src',
  'src',
  'pages',
  'AgentChat',
);

const read = (name: string): string => readFileSync(path.join(AGENT_CHAT_DIR, name), 'utf8');

/** reducer 折叠便捷：事件序列 → 最终快照 */
const fold = (events: ChatStreamEvent[]): ChatStreamSnapshot =>
  events.reduce(applyChatStreamEvent, createInitialChatStreamSnapshot());

/** 构造 SSE 响应（stub fetch 用；chunks 逐块入 stream，验证跨块解析；open=true 时不关闭流——abort 测试用） */
function sseResponse(chunks: string[], opts?: { open?: boolean }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (opts?.open !== true) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ############################################################################
// A1. token 格式化与 usage 合计（气泡旁「约 1.2k」标签的数据源）
// ############################################################################

describe('chatStream token 格式化（约 1.2k 格式）', () => {
  it('1. formatTokenCount：<1000 整数、≥1k 一位小数 k、≥1M 一位小数 M', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(12_345)).toBe('12.3k');
    expect(formatTokenCount(1_100_000)).toBe('1.1M');
    expect(formatTokenCount(2_000_000)).toBe('2M');
    expect(formatTokenCount(-5)).toBe('0'); // 负数钳 0
  });

  it('2. usageTotalTokens：totalTokens 优先，缺省 input+output 求和，空 usage → 0', () => {
    expect(usageTotalTokens({ inputTokens: 900, outputTokens: 334 })).toBe(1234);
    expect(usageTotalTokens({ inputTokens: 100, outputTokens: 200, totalTokens: 999 })).toBe(999);
    expect(usageTotalTokens(null)).toBe(0);
    expect(usageTotalTokens(undefined)).toBe(0);
  });
});

// ############################################################################
// A2. streamGen 代数防串台
// ############################################################################

describe('chatStream streamGen 代数防串台', () => {
  it('3. begin 单调递增；isCurrent 只认最新代；invalidate 使当前代过期', () => {
    const gen = createStreamGen();
    expect(gen.current()).toBe(0);
    const g1 = gen.begin();
    expect(g1).toBe(1);
    expect(gen.isCurrent(g1)).toBe(true);
    const g2 = gen.begin(); // 重发 → 旧代即刻过期
    expect(g2).toBe(2);
    expect(gen.isCurrent(g1)).toBe(false);
    expect(gen.isCurrent(g2)).toBe(true);
    gen.invalidate(); // 会话切换 → 全部在途代过期（invalidate 与 begin 同为代数推进）
    expect(gen.isCurrent(g2)).toBe(false);
    const g3 = gen.begin();
    expect(g3).toBe(4); // 1(第一次发送) → 2(重发) → 3(invalidate) → 4(新会话发送)
    expect(gen.isCurrent(g3)).toBe(true);
  });

  it('4. 防串台集成模式：会话切换 invalidate 后旧代事件被丢弃，新代不受污染', () => {
    const gen = createStreamGen();
    const g1 = gen.begin();
    const oldSnap = fold([{ type: 'reply', content: '旧会话草稿', estimatedTokens: null, draft: true }]);
    // 用户切走 → invalidate；旧代晚到的 done 不应再写状态
    gen.invalidate();
    const staleApplied = gen.isCurrent(g1)
      ? applyChatStreamEvent(oldSnap, { type: 'done', message: { id: 'm-old', content: '旧' }, usage: null, reasoningSegments: [] })
      : oldSnap;
    expect(staleApplied.replyDraft).toBe('旧会话草稿'); // 未被污染（事件被丢弃）
    expect(staleApplied.finalMessage).toBeNull();
    // 新会话开新代：事件正常折叠
    const g2 = gen.begin();
    expect(gen.isCurrent(g2)).toBe(true);
  });
});

// ############################################################################
// A3. SSE 帧解析
// ############################################################################

describe('chatStream SSE 帧解析（跨 chunk 断行安全）', () => {
  it('5. 完整帧解析：data: 前缀取 JSON；空行/注释行/event: 行跳过', () => {
    const payloads: string[] = [];
    const feeder = createSseFeeder((p) => payloads.push(p));
    feeder.feed(': keep-alive\nevent: thinking\ndata: {"a":1}\n\n');
    feeder.feed('data:{"b":2}\n\ndata:   \n\n'); // 无空格前缀合法；纯空白 data 行跳过
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('6. 跨 chunk 断行：帧被任意切块后仍完整解析（\n\n 拆在块边界）', () => {
    const payloads: string[] = [];
    const feeder = createSseFeeder((p) => payloads.push(p));
    feeder.feed('data: {"type":"thinki');
    feeder.feed('ng","round":1,"segmentIndex":0,"content":"早"}\n\ndata: {"type":"rep');
    feeder.feed('ly","content":"草稿"}\n\n');
    expect(payloads).toEqual([
      '{"type":"thinking","round":1,"segmentIndex":0,"content":"早"}',
      '{"type":"reply","content":"草稿"}',
    ]);
  });

  it('7. CRLF 行尾归一化 + end() 冲刷未收尾帧', () => {
    const payloads: string[] = [];
    const feeder = createSseFeeder((p) => payloads.push(p));
    feeder.feed('data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n');
    expect(payloads).toEqual(['{"n":1}', '{"n":2}']);
    feeder.feed('data: {"tail":true}'); // 服务端最后一帧未带 \n\n
    expect(payloads).toEqual(['{"n":1}', '{"n":2}']);
    feeder.end();
    expect(payloads).toEqual(['{"n":1}', '{"n":2}', '{"tail":true}']);
  });
});

// ############################################################################
// A4. 事件反序列化
// ############################################################################

describe('chatStream parseChatStreamEvent', () => {
  it('8. 合法事件收敛为强类型：thinking/reply/tool_start/tool_done/done/error', () => {
    expect(parseChatStreamEvent('{"type":"thinking","round":2,"segmentIndex":1,"content":"x"}')).toEqual({
      type: 'thinking',
      round: 2,
      segmentIndex: 1,
      content: 'x',
    });
    expect(parseChatStreamEvent('{"type":"reply","content":"d","estimatedTokens":42}')).toEqual({
      type: 'reply',
      content: 'd',
      estimatedTokens: 42,
      draft: true, // 缺省视为草稿
    });
    const start = parseChatStreamEvent(
      '{"type":"tool_start","step":{"id":"t1","tool":"workspace_read","label":"读取文件","status":"running","argsPreview":{"path":"a.md"},"startedAt":"2026-01-01T00:00:00Z"}}',
    );
    expect(start).toMatchObject({ type: 'tool_start', step: { id: 't1', status: 'running' } });
    expect(start !== null && start.type === 'tool_start' && start.step.argsPreview).toBe('{"path":"a.md"}'); // 对象入参 → JSON 字符串
    const done = parseChatStreamEvent(
      '{"type":"done","message":{"id":"m1","content":"答","toolCalls":[{"id":"c1","name":"t","arguments":"{}"}],"usage":{"inputTokens":10,"outputTokens":5},"reasoningSegments":["s"]},"usage":{"totalTokens":15},"reasoningSegments":["s"]}',
    );
    expect(done).toMatchObject({ type: 'done', message: { id: 'm1', role: 'assistant' } });
    expect(parseChatStreamEvent('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
  });

  it('9. 非法/未知事件 → null（单帧脏数据静默跳过不毒化整条流）', () => {
    expect(parseChatStreamEvent('not-json')).toBeNull();
    expect(parseChatStreamEvent('42')).toBeNull();
    expect(parseChatStreamEvent('null')).toBeNull();
    expect(parseChatStreamEvent('{"type":"mysterious"}')).toBeNull(); // 未知类型（前向兼容跳过）
    expect(parseChatStreamEvent('{"type":"tool_start"}')).toBeNull(); // 缺 step
    expect(parseChatStreamEvent('{"type":"tool_start","step":{"tool":"x"}}')).toBeNull(); // 缺 step.id
    expect(parseChatStreamEvent('{"type":"done"}')).toBeNull(); // 缺 message.id
  });
});

// ############################################################################
// A5. reducer 纯函数全周期
// ############################################################################

describe('chatStream applyChatStreamEvent reducer 全周期', () => {
  it('10. thinking 按 segmentIndex 累积成段；相位推进且不被 replying 回切', () => {
    const snap = fold([
      { type: 'thinking', round: 1, segmentIndex: 0, content: '先想' },
      { type: 'thinking', round: 1, segmentIndex: 0, content: '一下' },
      { type: 'thinking', round: 1, segmentIndex: 1, content: '再想' },
    ]);
    expect(snap.thinkingSegments).toEqual(['先想一下', '再想']);
    expect(snap.phase).toBe('thinking');
    expect(snap.round).toBe(1);
    // replying 后晚到的 thinking 不回切状态头（分段仍累积）
    const afterReply = applyChatStreamEvent(
      fold([{ type: 'reply', content: '草', estimatedTokens: null, draft: true }]),
      { type: 'thinking', round: 2, segmentIndex: 0, content: '补充' },
    );
    expect(afterReply.phase).toBe('replying');
    expect(afterReply.thinkingSegments).toEqual(['补充']);
  });

  it('11. reply：累计草稿整体替换 + estimatedTokens 更新；相位 replying', () => {
    const snap = fold([
      { type: 'reply', content: '第一版', estimatedTokens: 10, draft: true },
      { type: 'reply', content: '第一版第二版', estimatedTokens: 20, draft: true },
    ]);
    expect(snap.replyDraft).toBe('第一版第二版');
    expect(snap.estimatedTokens).toBe(20);
    expect(snap.phase).toBe('replying');
  });

  it('12. 工具步骤状态机：tool_start 追加 running → tool_done 按 id 收束 done/error；重复 start 幂等；未知 id 兜底追加', () => {
    let snap = fold([
      { type: 'tool_start', step: { id: 't1', tool: 'workspace_read', label: '读取文件', status: 'running', argsPreview: '{"path":"a"}' } },
      { type: 'tool_start', step: { id: 't2', tool: 'report_create', label: '生成报告', status: 'running' } },
    ]);
    expect(snap.toolSteps.map((s) => s.status)).toEqual(['running', 'running']);
    // 重复 tool_start（同 id）不产生重复卡片
    snap = applyChatStreamEvent(snap, { type: 'tool_start', step: { id: 't1', tool: 'workspace_read', label: '读取文件', status: 'running' } });
    expect(snap.toolSteps).toHaveLength(2);
    snap = applyChatStreamEvent(snap, { type: 'tool_done', step: { id: 't1', tool: 'workspace_read', label: '读取文件', status: 'done', resultPreview: 'a.md (12B)' } });
    snap = applyChatStreamEvent(snap, { type: 'tool_done', step: { id: 't2', tool: 'report_create', label: '生成报告', status: 'error', error: '模板缺失' } });
    expect(snap.toolSteps.map((s) => s.status)).toEqual(['done', 'error']);
    expect(snap.toolSteps[0]?.resultPreview).toBe('a.md (12B)');
    expect(snap.toolSteps[1]?.error).toBe('模板缺失');
    // 未见 start 的 tool_done（断线重放等）兜底追加
    snap = applyChatStreamEvent(snap, { type: 'tool_done', step: { id: 't3', tool: 'x', label: 'X', status: 'done' } });
    expect(snap.toolSteps).toHaveLength(3);
  });

  it('13. done/error 终态：finalMessage/finalUsage/finalReasoningSegments 捕获；error 记录消息', () => {
    const done = fold([
      { type: 'thinking', round: 1, segmentIndex: 0, content: '思路' },
      { type: 'done', message: { id: 'm1', content: '答案', usage: { inputTokens: 900, outputTokens: 334 } }, usage: null, reasoningSegments: [] },
    ]);
    expect(done.phase).toBe('done');
    expect(done.finalMessage?.id).toBe('m1');
    expect(done.finalUsage).toEqual({ inputTokens: 900, outputTokens: 334 }); // 事件级 usage 缺省回退 message.usage
    expect(done.finalReasoningSegments).toEqual(['思路']); // 事件级缺省回退流式累积
    expect(formatTokenCount(usageTotalTokens(done.finalUsage))).toBe('1.2k'); // 气泡标签数据链
    const err = fold([{ type: 'error', message: '上游超时' }]);
    expect(err.phase).toBe('error');
    expect(err.error).toBe('上游超时');
  });

  it('14. 纯函数可重放：同一事件序列从初始快照重放结果恒等；未知事件原样返回同一引用', () => {
    const events: ChatStreamEvent[] = [
      { type: 'thinking', round: 1, segmentIndex: 0, content: 'a' },
      { type: 'tool_start', step: { id: 't1', tool: 'x', label: 'X', status: 'running' } },
      { type: 'reply', content: 'd', estimatedTokens: 1, draft: true },
      { type: 'tool_done', step: { id: 't1', tool: 'x', label: 'X', status: 'done', resultPreview: 'r' } },
      { type: 'done', message: { id: 'm', content: 'd' }, usage: { totalTokens: 3 }, reasoningSegments: ['a'] },
    ];
    const replayA = fold(events);
    const replayB = fold(events);
    expect(replayA).toEqual(replayB);
    const before = fold(events);
    // @ts-expect-error 故意喂未知事件（前向兼容路径）
    const same = applyChatStreamEvent(before, { type: 'something-new' });
    expect(same).toBe(before);
  });
});

// ############################################################################
// A6. streamSessionMessage 传输层（stub fetch + ReadableStream）
// ############################################################################

describe('chatStream streamSessionMessage（fetch + getReader 解析）', () => {
  it('15. 事件按序消费（跨块边界）；请求形状：POST + SSE Accept + Bearer + {content}', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init: init ?? {} });
      return sseResponse([
        'data: {"type":"thinking","round":1,"segmentIndex":0,"content":"早"}\n\ndata: {"type":"thi',
        'nking","round":1,"segmentIndex":0,"content":"晚"}\n\n',
        'data: {"type":"reply","content":"草","draft":true}\n\n',
        'data: {"type":"done","message":{"id":"m1","content":"答"},"usage":{"totalTokens":99},"reasoningSegments":[]}\n\n',
      ]);
    });
    try {
      const events: ChatStreamEvent[] = [];
      await streamSessionMessage({
        token: 'tok-1',
        sessionId: 's-1',
        content: '你好',
        onEvent: (e) => events.push(e),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('/api/v1/agents/sessions/s-1/messages/stream');
      expect(calls[0]?.init.method).toBe('POST');
      const headers = calls[0]?.init.headers as Record<string, string>;
      expect(headers['accept']).toBe('text/event-stream');
      expect(headers['authorization']).toBe('Bearer tok-1');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ content: '你好' });
      expect(events.map((e) => e.type)).toEqual(['thinking', 'thinking', 'reply', 'done']);
      expect(events[1]?.type === 'thinking' && events[1].content).toBe('晚'); // 跨块增量正确接收
      expect(fold(events).thinkingSegments).toEqual(['早晚']); // 同段增量正确累积
      const last = events[3];
      expect(last !== null && last.type === 'done').toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('16. token 空串不带 authorization 头；404 → ChatStreamHttpError（降级信号）', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => new Response('{"code":"NOT_FOUND"}', { status: 404 }));
    try {
      const onErr = vi.fn();
      await expect(
        streamSessionMessage({ token: '', sessionId: 's', content: 'x', onEvent: () => undefined, onError: onErr }),
      ).rejects.toSatisfy((e: unknown) => isChatStreamHttpError(e) && (e as ChatStreamHttpError).status === 404);
      expect(onErr).toHaveBeenCalledTimes(1);
      // 空 token：请求头无 authorization（借同 stub 复验）
      const seen: Array<Record<string, string>> = [];
      vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit): Promise<Response> => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return new Response('{}', { status: 404 });
      });
      await streamSessionMessage({ token: '', sessionId: 's', content: 'x', onEvent: () => undefined }).catch(() => undefined);
      expect(seen[0]?.['authorization']).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('17. 网络失败 → ChatStreamNetworkError；abort → AbortError（Stop 断开即服务端取消，不降级）', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => Promise.reject(new TypeError('fetch failed')));
    try {
      await expect(
        streamSessionMessage({ token: 't', sessionId: 's', content: 'x', onEvent: () => undefined }),
      ).rejects.toSatisfy((e: unknown) => isChatStreamNetworkError(e));
    } finally {
      vi.unstubAllGlobals();
    }
    // abort：事件回调里同步 Stop（首事件后 signal 置位，读循环顶部检查抛 AbortError；流保持打开）
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      async (): Promise<Response> =>
        sseResponse(['data: {"type":"thinking","round":1,"segmentIndex":0,"content":"x"}\n\n'], { open: true }),
    );
    try {
      await expect(
        streamSessionMessage({
          token: 't',
          sessionId: 's',
          content: 'x',
          signal: controller.signal,
          onEvent: () => controller.abort(),
        }),
      ).rejects.toSatisfy((e: unknown) => isAbortError(e));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ############################################################################
// B. MarkdownMessage：行为 + 源码契约
// ############################################################################

describe('MarkdownMessage 渲染安全与自定义渲染契约', () => {
  it('18. sanitizeUrl 白名单：javascript:/data:/vbscript: 拒绝；http/https/mailto/相对路径/锚点放行', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('DATA:text/html,<script>x</script>')).toBeNull();
    expect(sanitizeUrl('vbscript:x')).toBeNull();
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
    expect(sanitizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeUrl('http://localhost/x')).not.toBeNull();
    expect(sanitizeUrl('mailto:a@b.c')).not.toBeNull();
    expect(sanitizeUrl('/api/v1/agents/sessions/s1/workspace/file?path=a.md')).not.toBeNull();
    expect(sanitizeUrl('#anchor')).not.toBeNull();
    expect(sanitizeUrl('./rel/path')).not.toBeNull();
    expect(sanitizeUrl('')).toBeNull();
  });

  it('19. sanitizeMarkdownText：控制字符剔除（\\n \\t 保留）+ 超长截断；零 dangerouslySetInnerHTML + 外链 rel 契约', () => {
    expect(sanitizeMarkdownText('a\u0000b\u0007c\nd\te')).toBe('abc\nd\te');
    const long = sanitizeMarkdownText('x'.repeat(300_000));
    expect(long.length).toBeLessThan(300_000);
    expect(long.endsWith('…（已截断）')).toBe(true);
    const src = read('MarkdownMessage.tsx');
    expect(src.includes('dangerouslySetInnerHTML')).toBe(false); // 安全红线：全文件零 innerHTML 注入面
    expect(src).toContain('rel="noopener noreferrer"'); // 外链 rel 契约
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rehype-raw'); // 注释声明不引入 raw HTML（raw HTML 不解析）
    expect(src).toContain('urlTransform'); // 链接/图片 URL 统一过 sanitizeUrl
    expect(src).toContain('data-slot="table-wrap"'); // table 横向滚动包裹
    expect(src).toContain('data-slot="code-lang"'); // code 块语言标签外壳
    expect(src).toContain('data-slot="workspace-file-chip"'); // 工作区文件引用 → chip
    expect(src).toContain('data-slot="workspace-file-preview"'); // chip 预览按钮
    expect(typeof MarkdownMessage).toBe('object'); // memo 组件（default + named 双导出）
  });

  it('20. workspaceFileRefFromUrl + previewKindOfName：文件 chip 预览分类（复用 WorkspacePanel 逻辑）', () => {
    const ref = workspaceFileRefFromUrl('/api/v1/agents/sessions/s9/workspace/file?path=reports%2Fa.html&token=t');
    expect(ref).toEqual({ sessionId: 's9', path: 'reports/a.html', name: 'a.html' });
    expect(workspaceFileRefFromUrl('https://example.com/x')).toBeNull();
    expect(previewKindOfName('a.png')).toBe('image');
    expect(previewKindOfName('b.HTML')).toBe('html');
    expect(previewKindOfName('c.md')).toBe('text');
    expect(previewKindOfName('Makefile')).toBe('text'); // 无扩展名按文本尝试
    expect(previewKindOfName('d.bin')).toBeNull(); // 未知二进制不预览
  });
});

// ############################################################################
// C/D. ThinkingPanel 与 AgentChat 集成点（源码契约）
// ############################################################################

describe('ThinkingPanel 源码契约（思考时间线 + 步骤卡片 + 草稿预览）', () => {
  it('21. 状态头/思考分段/草稿 mask/步骤状态机/历史折叠时间线齐备', () => {
    const src = read('ThinkingPanel.tsx');
    expect(src).toContain('模型正在思考'); // 状态头（流式期间）
    expect(src).toContain('animate-bounce'); // 动画点
    expect(src).toContain('data-slot="thinking-segments"'); // 思考分段灰字区
    expect(src).toContain('maxHeight'); // maxHeight 限制
    expect(src).toContain('scrollTop = el.scrollHeight'); // 自动滚底
    expect(src).toContain('maskImage'); // 回复草稿上下渐隐 mask
    expect(src).toContain('DRAFT_VISIBLE_LINES'); // 5 行高预览
    expect(src).toContain('data-slot="tool-step"'); // 步骤卡片
    expect(src).toContain("data-status={step.status}"); // 状态机外显（running/done/error）
    expect(src).toContain('animate-spin'); // running spinner
    expect(src).toContain('查看思考过程'); // 历史消息折叠条「查看思考过程（N 段）」
    expect(src).toContain('aria-expanded'); // 默认收起、可展开
    expect(src).toContain('data-slot="reasoning-list"'); // 展开后分段竖轴时间线
    expect(src).toContain('第 {i + 1} 段'); // 段号
    expect(src).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
  });

  it('22. AgentChat 集成：流式优先 + 降级回退 + Stop + token 标签 + 防串台 + ThinkingPanel/Markdown 接线', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'extensions', 'webui', 'ui-src', 'src', 'pages', 'AgentChat.tsx'), 'utf8');
    // 流式优先：streamSessionMessage + reducer 折叠 + done 正式入列
    expect(src).toContain('streamSessionMessage');
    expect(src).toContain('applyChatStreamEvent');
    expect(src).toContain("event.type === 'done'");
    expect(src).toContain('toAgentMessage(');
    expect(src).toContain('reasoningSegments'); // 助手消息思考分段消费
    // 降级：404/网络错误（未见事件）→ 回退旧 POST messages；中途断线 → REST 对账不重发
    expect(src).toContain('/messages`');
    expect(src).toContain('sawEvent');
    expect(src).toContain('reloadMessages(activeSessionId)');
    // Stop：abort 断开即服务端取消
    expect(src).toContain('abortRef');
    expect(src).toContain('isAbortError(streamErr)');
    expect(src).toContain('abortRef.current?.abort()');
    expect(src).toContain('new AbortController()');
    expect(src).toContain('aria-label="停止生成"');
    // 防串台：streamGen 代数 + 会话切换 invalidate
    expect(src).toContain('createStreamGen()');
    expect(src).toContain('streamGenRef.current.isCurrent(gen)');
    expect(src).toContain('streamGenRef.current.invalidate()');
    // token 标签（约 1.2k 格式）+ ThinkingPanel + MarkdownMessage 接线
    expect(src).toContain('formatTokenCount');
    expect(src).toContain('data-slot="usage-tag"');
    expect(src).toContain('<ThinkingPanel snapshot={stream} />');
    expect(src).toContain('MarkdownMessage');
    expect(src).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
  });

  it('23. chatStream.ts / filePreview.ts 源码零 console.*（React 工程契约同款，新增文件统一收口）', () => {
    for (const name of ['chatStream.ts', 'filePreview.ts', 'WorkspacePanel.tsx']) {
      const src = read(name);
      expect(src, `${name} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
    }
  });

  it('24. AbortError 判定覆盖 DOMException 与裸 {name} 形状（跨端 Stop 路径）', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(new ChatStreamNetworkError('x'))).toBe(false);
    expect(isChatStreamHttpError(new ChatStreamHttpError(404, 'x'))).toBe(true);
    expect(isChatStreamNetworkError(new ChatStreamNetworkError('x'))).toBe(true);
  });
});
