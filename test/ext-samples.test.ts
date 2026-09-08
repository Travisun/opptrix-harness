/**
 * ext-samples 单测 — echo-bot / doc-demo 两个示例扩展。
 *
 * 与 auth 扩展测试同款 vm 沙箱桩法：不 spawn 线程、不 import 内核——
 * vm.createContext 注入 defineExtension 捕获（与 worker.ts 注入语义一致：
 * 函数入参包装为 { setup }），扩展源码在沙箱内执行后拿到 setup；
 * h 为内存桩：h.route / h.on 捕获进 Map，h.chat.send / h.notify.send /
 * h.call / h.files.read 全部 vi.fn，直接驱动 handler 断言行为。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 沙箱装载与 h 桩
// ---------------------------------------------------------------------------

/** 扩展 setup 签名（h 以内存桩承载，宽松键型） */
type SetupFn = (h: Record<string, unknown>) => void | Promise<void>;

/** RouteContext 最小桩（本组扩展只消费 body） */
interface ReqStub {
  body: unknown;
}

/** ChatMessagePayload 最小桩形状（对齐 src/kernel/channels/types.ts） */
interface MsgStub {
  channelSlug?: string;
  senderType?: 'user' | 'ext' | 'webhook';
  content?: unknown;
}

/** FileRecord 最小桩形状 */
interface FileStub {
  id?: string;
  mime?: string;
}

type RouteHandler = (req: ReqStub) => Promise<unknown>;
type EventHandler = (payload: unknown) => Promise<void>;

interface HarnessRig {
  h: Record<string, unknown>;
  routes: Map<string, RouteHandler>;
  events: Map<string, EventHandler>;
  chatSend: ReturnType<typeof vi.fn>;
  notifySend: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  filesRead: ReturnType<typeof vi.fn>;
}

/** 在 vm context 内执行扩展源码，捕获 defineExtension(setup) 的 setup */
function loadSetup(extPath: string): SetupFn {
  const slot: { setup?: SetupFn } = {};
  // 与 worker.ts 的注入语义一致：函数入参包装为 { setup }，对象入参取 .setup
  const defineExtension = (input: unknown): unknown => {
    const candidate = typeof input === 'function' ? { setup: input } : input;
    const setup = (candidate as { setup?: unknown } | null)?.setup;
    if (typeof setup !== 'function') throw new TypeError('defineExtension(setup): setup must be a function');
    slot.setup = setup as SetupFn;
    return candidate;
  };
  const file = fileURLToPath(new URL(extPath, import.meta.url));
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext({ defineExtension }), { filename: file });
  if (slot.setup === undefined) throw new Error(`extension ${extPath} did not call defineExtension`);
  return slot.setup;
}

/** 内存 h 桩：注册类捕获进 Map，运行类全部 vi.fn */
function makeHarness(): HarnessRig {
  const routes = new Map<string, RouteHandler>();
  const events = new Map<string, EventHandler>();
  const chatSend = vi.fn(async (_input: unknown) => undefined);
  const notifySend = vi.fn(async (_input: unknown) => ({ id: 'n1', deliveries: [] }));
  const call = vi.fn(async (_target: string, _method: string, _args?: unknown) => null);
  const filesRead = vi.fn(async (_id: string) => '');
  const h: Record<string, unknown> = {
    route: (method: string, path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    },
    on: (event: string, handler: EventHandler) => {
      events.set(event, handler);
      return () => undefined;
    },
    expose: vi.fn(), // doc-demo 激活期暴露 parse 服务（本组用例不消费其注册表）
    chat: { send: chatSend },
    notify: { send: notifySend },
    call,
    files: { read: filesRead },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { h, routes, events, chatSend, notifySend, call, filesRead };
}

/** 装载并激活扩展（执行 setup 完成注册） */
async function activate(extPath: string): Promise<HarnessRig> {
  const rig = makeHarness();
  await loadSetup(extPath)(rig.h);
  return rig;
}

// ---------------------------------------------------------------------------
// echo-bot
// ---------------------------------------------------------------------------

describe('echo-bot', () => {
  const EXT = '../extensions/echo-bot/index.js';

  /** 构造一条用户消息桩（ChatMessagePayload 子集） */
  function userMsg(overrides: Partial<MsgStub> = {}): MsgStub {
    return { channelSlug: 'general', senderType: 'user', content: { type: 'text', text: 'hello' }, ...overrides };
  }

  it('注册了 chat.message.created 订阅', async () => {
    const rig = await activate(EXT);
    expect(typeof rig.events.get('chat.message.created')).toBe('function');
  });

  it('senderType=ext 或空载荷时不回复（防回声循环）', async () => {
    const rig = await activate(EXT);
    const onMessage = rig.events.get('chat.message.created')!;
    await onMessage(userMsg({ senderType: 'ext' }));
    await onMessage(null);
    expect(rig.chatSend).not.toHaveBeenCalled();
  });

  it('普通文本消息回显到原频道：echo: <text>', async () => {
    const rig = await activate(EXT);
    await rig.events.get('chat.message.created')!(userMsg({ content: { type: 'text', text: 'hi there' } }));
    expect(rig.chatSend).toHaveBeenCalledTimes(1);
    expect(rig.chatSend).toHaveBeenCalledWith({
      slug: 'general',
      content: { type: 'text', text: 'echo: hi there' },
    });
  });

  it('超长回显截断到 500 字符（含 "echo: " 前缀）', async () => {
    const rig = await activate(EXT);
    await rig.events.get('chat.message.created')!(userMsg({ content: { type: 'text', text: 'x'.repeat(600) } }));
    const sent = rig.chatSend.mock.calls[0]?.[0] as { slug: string; content: { type: string; text: string } };
    expect(sent.content.text).toHaveLength(500);
    expect(sent.content.text).toBe(`echo: ${'x'.repeat(494)}`);
  });

  it('content 非 text（card）回显 JSON 摘要；content 为 null 回显 "null"', async () => {
    const rig = await activate(EXT);
    const onMessage = rig.events.get('chat.message.created')!;
    const card = { type: 'card', card: { kind: 'x' } };
    await onMessage(userMsg({ content: card }));
    const sent = rig.chatSend.mock.calls[0]?.[0] as { content: { text: string } };
    expect(sent.content.text.startsWith('echo: ')).toBe(true);
    expect(JSON.parse(sent.content.text.slice('echo: '.length))).toEqual(card);

    await onMessage(userMsg({ content: null }));
    const sent2 = rig.chatSend.mock.calls[1]?.[0] as { content: { text: string } };
    expect(sent2.content.text).toBe('echo: null');
  });

  it('webhook 消息同样回显（仅 senderType=ext 跳过）', async () => {
    const rig = await activate(EXT);
    await rig.events.get('chat.message.created')!(
      userMsg({ senderType: 'webhook', content: { type: 'text', text: 'w' } }),
    );
    expect(rig.chatSend).toHaveBeenCalledWith({
      slug: 'general',
      content: { type: 'text', text: 'echo: w' },
    });
  });
});

// ---------------------------------------------------------------------------
// doc-demo
// ---------------------------------------------------------------------------

describe('doc-demo', () => {
  const EXT = '../extensions/doc-demo/index.js';
  // 宿主侧 Buffer 仅用于构造测试用 base64 输入（扩展沙箱内无 Buffer）
  const TEXT = 'hello world\nsecond line\n';
  const TEXT_B64 = Buffer.from(TEXT, 'utf8').toString('base64');

  /** 取已注册的 /parse 处理器（未注册时显式失败） */
  function parseHandler(rig: HarnessRig): RouteHandler {
    const handler = rig.routes.get('POST /parse');
    expect(handler).toBeTypeOf('function');
    return handler!;
  }

  it('注册了 POST /parse 路由', async () => {
    const rig = await activate(EXT);
    expect(rig.routes.has('POST /parse')).toBe(true);
  });

  it('缺 fileId → 400 HARNESS-1009 形状（body 缺失/空值同样拒绝），且不读文件', async () => {
    const rig = await activate(EXT);
    const handler = parseHandler(rig);
    for (const body of [undefined, {}, { fileId: '' }, { fileId: null }]) {
      const res = (await handler({ body })) as { status: number; body: { code: string; message: string } };
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'HARNESS-1009', message: 'fileId required' });
    }
    expect(rig.filesRead).not.toHaveBeenCalled();
  });

  it('有 fileId → files.read 被调 + 行/词/字符统计正确（固定 base64 输入）', async () => {
    const rig = await activate(EXT);
    rig.filesRead.mockResolvedValueOnce(TEXT_B64);
    const res = (await parseHandler(rig)({ body: { fileId: 'f1' } })) as {
      status: number;
      body: { fileId: string; lines: number; words: number; chars: number };
    };
    expect(rig.filesRead).toHaveBeenCalledWith('f1');
    expect(res).toEqual({ status: 200, body: { fileId: 'f1', lines: 2, words: 4, chars: 24 } });
  });

  it('解析完成后发送 success 通知（标题/正文/级别）', async () => {
    const rig = await activate(EXT);
    rig.filesRead.mockResolvedValueOnce(TEXT_B64);
    await parseHandler(rig)({ body: { fileId: 'f1' } });
    expect(rig.notifySend).toHaveBeenCalledTimes(1);
    expect(rig.notifySend).toHaveBeenCalledWith({ title: '文档解析完成', body: 'f1: 4 词', level: 'success' });
  });

  it('纯 JS base64 解码 + 多行/空行统计："a\\n\\nb" → 3 行 2 词 4 字符', async () => {
    const rig = await activate(EXT);
    rig.filesRead.mockResolvedValueOnce(Buffer.from('a\n\nb', 'utf8').toString('base64'));
    const res = (await parseHandler(rig)({ body: { fileId: 'f2' } })) as {
      body: { fileId: string; lines: number; words: number; chars: number };
    };
    expect(res.body).toEqual({ fileId: 'f2', lines: 3, words: 2, chars: 4 });
  });

  it('file.uploaded：非 text/plain（或空载荷）直接跳过，不触发解析', async () => {
    const rig = await activate(EXT);
    const onUploaded = rig.events.get('file.uploaded')!;
    await onUploaded({ id: 'f1', mime: 'image/png' } satisfies FileStub);
    await onUploaded(null);
    expect(rig.call).not.toHaveBeenCalled();
    expect(rig.chatSend).not.toHaveBeenCalled();
  });

  it('file.uploaded：text/plain 且解析成功 → general 频道收到 doc-parse 卡片', async () => {
    const rig = await activate(EXT);
    rig.call.mockResolvedValueOnce({ fileId: 'f9', lines: 2, words: 4, chars: 24 });
    await rig.events.get('file.uploaded')!({ id: 'f9', mime: 'text/plain' } satisfies FileStub);
    expect(rig.call).toHaveBeenCalledWith('doc-demo', 'parse.run', { fileId: 'f9' });
    expect(rig.chatSend).toHaveBeenCalledTimes(1);
    const sent = rig.chatSend.mock.calls[0]?.[0] as {
      slug: string;
      content: { type: string; card: Record<string, unknown> };
    };
    expect(sent.slug).toBe('general');
    expect(sent.content.type).toBe('card');
    expect(sent.content.card).toEqual({ kind: 'doc-parse', fileId: 'f9', lines: 2, words: 4, chars: 24 });
  });

  it('file.uploaded：解析失败不发送；发送失败（general 不存在）静默不崩溃', async () => {
    const rig = await activate(EXT);
    const onUploaded = rig.events.get('file.uploaded')!;

    // call 拒绝（如服务不可用）→ 不发送
    rig.call.mockRejectedValueOnce(new Error('rpc down'));
    await expect(onUploaded({ id: 'f1', mime: 'text/plain' } satisfies FileStub)).resolves.toBeUndefined();
    expect(rig.chatSend).not.toHaveBeenCalled();

    // call 成功但 general 频道不存在（chat.send 拒绝）→ 静默吞掉
    rig.call.mockResolvedValueOnce({ fileId: 'f2', lines: 1, words: 1, chars: 1 });
    rig.chatSend.mockRejectedValueOnce(new Error('channel not found'));
    await expect(onUploaded({ id: 'f2', mime: 'text/plain' } satisfies FileStub)).resolves.toBeUndefined();
    expect(rig.chatSend).toHaveBeenCalledTimes(1); // 发起过，但错误未穿透
  });
});

// ---------------------------------------------------------------------------
// manifest 校验（硬编码白名单，不 import 内核）
// ---------------------------------------------------------------------------

describe('manifest 校验', () => {
  // 对齐 src/kernel/extensions/manifest.ts 的 PERMISSION_WHITELIST（net:out:<domain> 形状不涉及）
  const WHITELIST: readonly string[] = [
    'http',
    'events',
    'hooks',
    'cron',
    'notify:send',
    'notify:driver',
    'chat:write',
    'chat:bridge',
    'files:read',
    'files:write',
    'tasks',
    'sandbox',
    'llm',
    'storage',
    'db',
    'ui',
    'net:out',
  ];

  function readManifest(extPath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(fileURLToPath(new URL(extPath, import.meta.url)), 'utf8')) as Record<string, unknown>;
  }

  it('echo-bot：JSON 合法、id/api 正确、permissions 全在白名单内', () => {
    const m = readManifest('../extensions/echo-bot/manifest.json') as {
      id: string;
      api: number;
      main: string;
      permissions: string[];
    };
    expect(m.id).toBe('echo-bot');
    expect(m.api).toBe(1);
    expect(m.main).toBe('index.js');
    expect(m.permissions).toEqual(['events', 'chat:write']);
    for (const p of m.permissions) expect(WHITELIST).toContain(p);
  });

  it('doc-demo：JSON 合法、id/api 正确、permissions 全在白名单内、ui 入口文件存在', () => {
    const m = readManifest('../extensions/doc-demo/manifest.json') as {
      id: string;
      api: number;
      main: string;
      permissions: string[];
      ui?: { pages?: { path: string; title: string; entry: string }[] };
    };
    expect(m.id).toBe('doc-demo');
    expect(m.api).toBe(1);
    expect(m.main).toBe('index.js');
    expect(m.permissions).toEqual(['http', 'events', 'chat:write', 'files:read', 'notify:send']);
    for (const p of m.permissions) expect(WHITELIST).toContain(p);
    // ui.pages 声明的入口文件相对扩展目录真实存在
    const entry = m.ui?.pages?.[0]?.entry;
    expect(entry).toBe('ui/index.html');
    expect(existsSync(fileURLToPath(new URL(`../extensions/doc-demo/${entry}`, import.meta.url)))).toBe(true);
  });
});
