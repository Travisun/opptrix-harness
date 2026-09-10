/**
 * ext-browser 单测 — 浏览器自动化（内核引擎 + 扩展壳 + 工具目录 + 扩展桥）。
 *
 * CI 环境不下载浏览器（~150MB 重依赖，默认不自动下载）：全部引擎用例经注入的
 * Playwright 替身覆盖（launch/goto/screenshot 等可编程桩）；真浏览器冒烟用
 * it.skipIf 钉住——本机无 chromium（playwright-core executablePath 不存在）时
 * 自动跳过，绝不因浏览器缺失而失败。
 */
import { execPath } from 'node:process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserEngine } from '../src/kernel/browser/engine.js';
import type {
  BrowserEngineDeps,
  PlaywrightModuleLike,
  PlaywrightPageLike,
} from '../src/kernel/browser/engine.js';
import { createBrowserBridge } from '../src/kernel/browser/bridge.js';
import {
  BrowserBusyError,
  BrowserNotInstalledError,
  BrowserScreenshotNameError,
  BrowserUrlRejectedError,
} from '../src/kernel/browser/types.js';
import { createBrowserTools, type BrowserToolsDeps } from '../src/kernel/mcp/system-tools.js';
import { validateManifest, validatePermissions } from '../src/kernel/extensions/manifest.js';
import { HarnessError } from '../src/kernel/errors/index.js';

// ---------------------------------------------------------------------------
// Playwright 替身（结构对齐 engine.ts 的 PlaywrightModuleLike 视图）
// ---------------------------------------------------------------------------

/** 替身的操作轨迹与可编程面 */
interface FakeRig {
  module: PlaywrightModuleLike;
  /** chromium.executablePath() 的存在性（installed 判定的开关） */
  executableExists: { value: boolean };
  browsers: FakeBrowser[];
  gotos: string[];
  clicks: string[];
  fills: Array<{ selector: string; text: string }>;
  presses: string[];
  screenshots: Array<{ path: string; fullPage: boolean }>;
  /** goto 延迟（毫秒）：mutex 串行/并发峰值断言用 */
  gotoDelayMs: number;
  /** goto 并发计数（引擎 mutex 语义下峰值必须恒为 1） */
  gotoActive: { current: number; peak: number };
  /** ariaSnapshot 的返回文本（用例可改写） */
  snapshotText: string;
  /** goto 注入的失败序列（先进先出；崩溃类错误由引擎重启重试一次） */
  gotoFailures: Error[];
}

class FakePage implements PlaywrightPageLike {
  closed = false;
  constructor(private readonly rig: FakeRig) {}
  async goto(url: string): Promise<{ status(): number } | null> {
    this.rig.gotos.push(url);
    const failure = this.rig.gotoFailures.shift();
    if (failure !== undefined) throw failure;
    this.rig.gotoActive.current += 1;
    this.rig.gotoActive.peak = Math.max(this.rig.gotoActive.peak, this.rig.gotoActive.current);
    try {
      if (this.rig.gotoDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.rig.gotoDelayMs));
    } finally {
      this.rig.gotoActive.current -= 1;
    }
    return { status: () => 200 };
  }
  async title(): Promise<string> {
    return `title-of-${this.rig.gotos.length}`;
  }
  url(): string {
    return this.rig.gotos[this.rig.gotos.length - 1] ?? 'about:blank';
  }
  locator(selector: string) {
    const rig = this.rig;
    return {
      async click(): Promise<void> {
        rig.clicks.push(selector);
      },
      async fill(text: string): Promise<void> {
        rig.fills.push({ selector, text });
      },
      async ariaSnapshot(): Promise<string> {
        return rig.snapshotText;
      },
    };
  }
  keyboard = {
    press: async (key: string): Promise<void> => {
      this.rig.presses.push(key);
    },
  };
  async screenshot(opts: { fullPage?: boolean; path: string; type: 'png' }): Promise<void> {
    this.rig.screenshots.push({ path: opts.path, fullPage: opts.fullPage === true });
    // 与真引擎同语义：真写文件（截图读取用例依赖）
    writeFileSync(opts.path, Buffer.from('fake-png-bytes'), 'utf8');
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser implements PlaywrightBrowserLike2 {
  connected = true;
  readonly closeSpy = vi.fn(async (): Promise<void> => {
    this.connected = false;
  });
  readonly page: FakePage;
  constructor(rig: FakeRig) {
    this.page = new FakePage(rig);
  }
  async newPage(): Promise<PlaywrightPageLike> {
    return this.page;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async close(): Promise<void> {
    this.connected = false;
    await this.closeSpy();
  }
  on(_event: 'disconnected', _cb: () => void): void {
    // 替身不模拟断连事件
  }
}

/** engine.ts 未导出 BrowserLike 视图类型，这里局部等价声明（结构兼容即可） */
interface PlaywrightBrowserLike2 {
  newPage(): Promise<PlaywrightPageLike>;
  isConnected(): boolean;
  close(): Promise<void>;
  on(event: 'disconnected', cb: () => void): void;
}

function makeFakePlaywright(): FakeRig {
  const rig: FakeRig = {
    module: null as unknown as PlaywrightModuleLike,
    executableExists: { value: true },
    browsers: [],
    gotos: [],
    clicks: [],
    fills: [],
    presses: [],
    screenshots: [],
    gotoDelayMs: 0,
    gotoActive: { current: 0, peak: 0 },
    snapshotText: '- text "hello"',
    gotoFailures: [],
  };
  rig.module = {
    chromium: {
      launch: async () => {
        const browser = new FakeBrowser(rig);
        rig.browsers.push(browser);
        return browser;
      },
      executablePath: () => '/fake/chromium-path',
    },
  };
  return rig;
}

function makeEngine(
  rig: FakeRig,
  overrides?: { idleCloseMs?: number; queueLimit?: number; dataDir?: string },
): { engine: BrowserEngine; dataDir: string } {
  const dataDir = overrides?.dataDir ?? mkdtempSync(join(tmpdir(), 'browser-engine-'));
  tempDirs.push(dataDir);
  const deps: BrowserEngineDeps = {
    dataDir,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    idleCloseMs: overrides?.idleCloseMs,
    queueLimit: overrides?.queueLimit,
    loadPlaywright: async () => rig.module,
    existsSync: () => rig.executableExists.value,
  };
  return { engine: new BrowserEngine(deps), dataDir };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 引擎（BrowserEngine）— 全部经替身驱动，无需真实浏览器
// ---------------------------------------------------------------------------

describe('BrowserEngine', () => {
  it('浏览器未安装：status 标记 installed:false，navigate 收敛 browser_not_installed 结构化错误（含 hint），且不尝试 launch', async () => {
    const rig = makeFakePlaywright();
    rig.executableExists.value = false;
    const { engine } = makeEngine(rig);
    expect(await engine.status()).toEqual({ installed: false, running: false, installing: false, lastError: null });
    const err = await engine.navigate('https://example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserNotInstalledError);
    expect((err as BrowserNotInstalledError).code).toBe('browser_not_installed');
    expect(String((err as BrowserNotInstalledError).hint)).toMatch(/install/i);
    expect((await engine.status()).lastError).toContain('chromium is not installed');
    expect(rig.browsers).toHaveLength(0);
  });

  it('URL 校验：file:// 与非 http(s) 协议、非法语法一律拒绝，且不触碰浏览器', async () => {
    const rig = makeFakePlaywright();
    const { engine } = makeEngine(rig);
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'not-a-url']) {
      const err = await engine.navigate(url).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BrowserUrlRejectedError);
      expect(String((err as Error).message)).toMatch(/http/i);
    }
    expect(rig.gotos).toHaveLength(0);
    expect(rig.browsers).toHaveLength(0);
  });

  it('navigate 成功返回 { title, url, status }；单例浏览器跨调用复用（仅 launch 一次）', async () => {
    const rig = makeFakePlaywright();
    const { engine } = makeEngine(rig);
    const first = await engine.navigate('https://example.com/a');
    const second = await engine.navigate('https://example.com/b');
    expect(first).toMatchObject({ url: 'https://example.com/a', status: 200 });
    expect(second.title).toBe('title-of-2');
    expect(rig.browsers).toHaveLength(1);
    expect((await engine.status()).running).toBe(true);
  });

  it('mutex：并发操作串行通过单实例（goto 峰值并发 1）；队列超限直接 BUSY', async () => {
    const rig = makeFakePlaywright();
    rig.gotoDelayMs = 25;
    const { engine } = makeEngine(rig, { queueLimit: 8 });
    const [r1, r2] = await Promise.all([
      engine.navigate('https://example.com/1'),
      engine.navigate('https://example.com/2'),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(rig.gotoActive.peak).toBe(1); // 第二个调用等待第一个完成
    expect(rig.browsers).toHaveLength(1); // 单实例

    // 队列深度 1：在途 1 期间的新调用 → BUSY（等待者过多直接拒绝）
    const busyRig = makeFakePlaywright();
    busyRig.gotoDelayMs = 50;
    const busy = makeEngine(busyRig, { queueLimit: 1 });
    const slow = busy.engine.navigate('https://example.com/slow');
    const err = await busy.engine.navigate('https://example.com/next').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserBusyError);
    expect((err as BrowserBusyError).code).toBe('browser_busy');
    await slow;
  });

  it('崩溃恢复：崩溃类失败自动重启一次并重试成功；非崩溃错误不重启', async () => {
    const rig = makeFakePlaywright();
    rig.gotoFailures.push(new Error('Target page, context or browser has been closed'));
    const { engine } = makeEngine(rig);
    const result = await engine.navigate('https://example.com/after-crash');
    expect(result.status).toBe(200);
    expect(rig.browsers).toHaveLength(2); // 崩溃前 1 + 重启 1
    expect(rig.gotos).toEqual(['https://example.com/after-crash', 'https://example.com/after-crash']);

    rig.gotoFailures.push(new Error('net::ERR_NAME_NOT_RESOLVED at x'));
    await expect(engine.navigate('https://broken.invalid/x')).rejects.toThrow(/NAME_NOT_RESOLVED/);
    expect(rig.browsers).toHaveLength(2); // 非崩溃错误不触发重启
  });

  it('空闲回收：阈值到期自动关浏览器；再次调用冷启动新实例', async () => {
    const rig = makeFakePlaywright();
    const { engine } = makeEngine(rig, { idleCloseMs: 40 });
    await engine.navigate('https://example.com/idle');
    expect(rig.browsers).toHaveLength(1);
    await vi.waitFor(
      () => {
        expect(rig.browsers[0]?.closeSpy).toHaveBeenCalled();
      },
      { timeout: 2_000, interval: 10 },
    );
    expect((await engine.status()).running).toBe(false);
    await engine.navigate('https://example.com/warm');
    expect(rig.browsers).toHaveLength(2);
  });

  it('snapshot：aria 快照文本 ≤50KB 截断（truncated 标记）', async () => {
    const rig = makeFakePlaywright();
    rig.snapshotText = 'x'.repeat(60 * 1024);
    const { engine } = makeEngine(rig);
    const result = await engine.snapshot();
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.snapshot, 'utf8')).toBeLessThanOrEqual(50 * 1024);
    rig.snapshotText = '- text "small"';
    const small = await engine.snapshot();
    expect(small).toEqual({ snapshot: '- text "small"', truncated: false });
  });

  it('click / type / press_key 转发到 page 定位器与键盘；screenshot 落数据目录并回 { path, file, url }', async () => {
    const rig = makeFakePlaywright();
    const { engine, dataDir } = makeEngine(rig);
    await engine.click({ selector: '#btn' });
    await engine.type({ selector: '#name', text: 'hello' });
    await engine.pressKey({ key: 'Enter' });
    expect(rig.clicks).toEqual(['#btn']);
    expect(rig.fills).toEqual([{ selector: '#name', text: 'hello' }]);
    expect(rig.presses).toEqual(['Enter']);

    const shot = await engine.screenshot({ fullPage: true });
    expect(shot.url).toBe(`/ext/browser/screenshots/${shot.file}`);
    expect(shot.file).toMatch(/^[0-9a-f-]{36}\.png$/i);
    expect(shot.path.startsWith(join(dataDir, 'browser', 'screenshots'))).toBe(true);
    expect(existsSync(shot.path)).toBe(true);
    expect(rig.screenshots).toEqual([{ path: shot.path, fullPage: true }]);
  });

  it('readScreenshot：uuid 形状校验防穿越；存在返回 base64；不存在 404（HARNESS-3004）', async () => {
    const rig = makeFakePlaywright();
    const { engine } = makeEngine(rig);
    for (const bad of ['../secret.png', 'abc.png', 'a/b.png', '../../etc/passwd', '', `${'0'.repeat(36)}.png`]) {
      expect(() => engine.readScreenshot(bad)).toThrow(BrowserScreenshotNameError);
    }
    const missing = '00000000-0000-4000-8000-000000000000.png';
    const err = await Promise.resolve()
      .then(() => engine.readScreenshot(missing))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe('HARNESS-3004');

    const shot = await engine.screenshot({});
    const read = engine.readScreenshot(shot.file);
    expect(read).toMatchObject({ file: shot.file, mime: 'image/png' });
    expect(Buffer.from(read.base64, 'base64').toString('utf8')).toBe('fake-png-bytes');
  });

  it('install：幂等触发后台安装 + 状态流转（started → installing → done/failed）+ 标记文件', async () => {
    const rig = makeFakePlaywright();
    rig.executableExists.value = false;
    const dataDir = mkdtempSync(join(tmpdir(), 'browser-install-'));
    tempDirs.push(dataDir);
    let exitHook: ((code: number | null, tail: string) => void) | null = null;
    const installer = {
      pid: 4321,
      on: (_event: string, cb: (code: number | null, tail: string) => void) => {
        exitHook = cb;
      },
      kill: vi.fn(),
    };
    const spawnInstaller = vi.fn((onExit: (code: number | null, tail: string) => void) => {
      installer.on('exit', onExit);
      return installer;
    });
    const engine = new BrowserEngine({
      dataDir,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      loadPlaywright: async () => rig.module,
      spawnInstaller,
      existsSync: () => rig.executableExists.value,
    });

    // 第一次触发：started=true；重复调用幂等（installing）
    expect(await engine.install()).toEqual({ started: true });
    expect(await engine.install()).toEqual({ started: false, installing: true });
    expect(spawnInstaller).toHaveBeenCalledTimes(1);
    expect((await engine.status()).installing).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, 'browser', 'install.json'), 'utf8'))).toMatchObject({ pid: 4321 });

    // 失败：lastError 记录 + installing 复位；再次调用可重新触发
    exitHook?.(1, 'download boom');
    await vi.waitFor(async () => {
      expect((await engine.status()).installing).toBe(false);
    });
    expect((await engine.status()).lastError).toContain('download boom');
    expect(await engine.install()).toEqual({ started: true });

    // 成功：installed 翻转后 install 幂等短路
    exitHook?.(0, '');
    rig.executableExists.value = true;
    expect(await engine.install()).toEqual({ started: false, installed: true });
    const marker = JSON.parse(readFileSync(join(dataDir, 'browser', 'install.json'), 'utf8')) as { ok?: boolean };
    expect(marker.ok).toBe(true);
  });

  it('stop 后不再冷启动（内核关停语义）', async () => {
    const rig = makeFakePlaywright();
    const { engine } = makeEngine(rig);
    await engine.navigate('https://example.com/x');
    await engine.stop();
    await expect(engine.navigate('https://example.com/y')).rejects.toThrow();
    expect(rig.gotos).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 扩展桥（browser.* topics）— 'browser' 权限收口
// ---------------------------------------------------------------------------

describe('createBrowserBridge', () => {
  function makeBridge() {
    const requirePermission = vi.fn();
    const service = {
      status: vi.fn(async () => ({ installed: false, running: false, installing: false, lastError: null })),
      install: vi.fn(async () => ({ started: true })),
      readScreenshot: vi.fn(() => ({ file: 'f.png', mime: 'image/png' as const, base64: 'Zm9v' })),
    };
    const bridge = createBrowserBridge({ service, requirePermission });
    return { bridge, requirePermission, service };
  }

  it('browser.status / browser.install：扩展端点放行并做权限闸（manifest 需声明 browser）', async () => {
    const { bridge, requirePermission, service } = makeBridge();
    const status = await bridge['browser.status']!({}, 'ext:browser');
    expect(status).toMatchObject({ installed: false });
    expect(requirePermission).toHaveBeenCalledWith('browser', 'browser.status', 'browser');
    await bridge['browser.install']!({}, 'ext:browser');
    expect(requirePermission).toHaveBeenCalledWith('browser', 'browser.install', 'browser');
    expect(service.install).toHaveBeenCalledTimes(1);
  });

  it('browser.screenshot：payload 校验 + 穿越类文件名错误原样穿透（引擎侧 uuid 复核）', async () => {
    const requirePermission = vi.fn();
    const service = {
      status: vi.fn(async () => ({ installed: false, running: false, installing: false, lastError: null })),
      install: vi.fn(async () => ({ started: true })),
      readScreenshot: vi.fn((file: string) => {
        // 引擎的 uuid 形状复核（桥把原始 file 原样转发给引擎）
        if (!/^[0-9a-f-]{36}\.png$/i.test(file)) throw new BrowserScreenshotNameError(file);
        return { file, mime: 'image/png' as const, base64: 'Zm9v' };
      }),
    };
    const bridge = createBrowserBridge({ service, requirePermission });

    const missingPayload = await bridge['browser.screenshot']!({}, 'ext:browser').catch((e: unknown) => e);
    expect((missingPayload as HarnessError).code).toBe('HARNESS-1008');
    const traversal = await bridge['browser.screenshot']!({ file: '../x.png' }, 'ext:browser').catch((e: unknown) => e);
    expect(traversal).toBeInstanceOf(BrowserScreenshotNameError);

    const ok = (await bridge['browser.screenshot']!({ file: '00000000-0000-4000-8000-000000000000.png' }, 'ext:browser')) as {
      file: string;
    };
    expect(ok.file).toBe('00000000-0000-4000-8000-000000000000.png');
    expect(service.readScreenshot).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000.png');
  });

  it('非扩展端点拒绝（RPC_PERMISSION_DENIED）；权限闸抛错原样穿透（fail-closed）', async () => {
    const { bridge, requirePermission } = makeBridge();
    const denied = await bridge['browser.status']!({}, 'kernel').catch((e: unknown) => e);
    expect((denied as HarnessError).code).toBe('HARNESS-2003');
    requirePermission.mockImplementation(() => {
      throw new Error('FORBIDDEN');
    });
    await expect(bridge['browser.status']!({}, 'ext:other')).rejects.toThrow('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// LLM 工具目录（browser_* 域）
// ---------------------------------------------------------------------------

/** SystemToolContext 最小桩（browser_* 工具依赖经 getDeps 注入，不消费内核容器） */
const fakeCtx = {
  kernel: { container: { has: () => false, resolve: () => undefined } },
  updater: {},
  cronHistory: async () => [],
} as unknown as Parameters<ReturnType<typeof createBrowserTools>[number]['execute']>[1];

describe('createBrowserTools', () => {
  it('目录形状：8 个工具、域前缀命名、中文描述与 inputSchema 齐备', () => {
    const tools = createBrowserTools(() => ({ engine: undefined }));
    expect(tools.map((t) => t.name)).toEqual([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_screenshot',
      'browser_close',
      'browser_status',
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(4);
      expect(tool.inputSchema).toBeTypeOf('object');
    }
  });

  it('引擎未装配 → HARNESS-9001 结果对象（裸装配不硬失败）', async () => {
    const [navigate] = createBrowserTools(() => ({ engine: undefined }));
    const result = await navigate!.execute({ url: 'https://example.com' }, fakeCtx);
    expect(result).toMatchObject({ ok: false, error: { code: 'HARNESS-9001' } });
  });

  it('browser_not_installed 结构化错误：{ ok:false, error:{ code, message, hint } }（需求形状）', async () => {
    const deps: () => BrowserToolsDeps = () => ({
      engine: {
        navigate: async () => {
          throw new BrowserNotInstalledError('run POST /ext/browser/install');
        },
      } as unknown as NonNullable<BrowserToolsDeps['engine']>,
    });
    const [navigate] = createBrowserTools(deps);
    const result = await navigate!.execute({ url: 'https://example.com' }, fakeCtx);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'browser_not_installed', hint: 'run POST /ext/browser/install' },
    });
  });

  it('URL 校验错误在工具层同样结构化（browser_url_rejected）', async () => {
    const deps: () => BrowserToolsDeps = () => ({
      engine: {
        navigate: async (url: string) => {
          throw new BrowserUrlRejectedError(url, 'protocol "file:" is not allowed');
        },
      } as unknown as NonNullable<BrowserToolsDeps['engine']>,
    });
    const [navigate] = createBrowserTools(deps);
    const result = await navigate!.execute({ url: 'file:///etc/passwd' }, fakeCtx);
    expect(result).toMatchObject({ ok: false, error: { code: 'browser_url_rejected' } });
  });

  it('工具成功路径转发引擎（navigate/screenshot/status）', async () => {
    const engine = {
      navigate: async (url: string) => ({ title: 't', url, status: 200 }),
      snapshot: async () => ({ snapshot: '- text', truncated: false }),
      click: async () => true,
      type: async () => true,
      pressKey: async () => true,
      screenshot: async () => ({ path: '/d/x.png', file: 'x.png', url: '/ext/browser/screenshots/x.png' }),
      close: async () => undefined,
      status: async () => ({ installed: true, running: true, installing: false, lastError: null }),
    };
    const tools = createBrowserTools(() => ({ engine: engine as unknown as NonNullable<BrowserToolsDeps['engine']> }));
    expect(await tools[0]!.execute({ url: 'https://example.com' }, fakeCtx)).toMatchObject({ ok: true, title: 't', status: 200 });
    expect(await tools[1]!.execute({}, fakeCtx)).toMatchObject({ ok: true, snapshot: '- text' });
    expect(await tools[5]!.execute({}, fakeCtx)).toMatchObject({ ok: true, url: '/ext/browser/screenshots/x.png' });
    expect(await tools[6]!.execute({}, fakeCtx)).toMatchObject({ ok: true, done: true });
    expect(await tools[7]!.execute({}, fakeCtx)).toMatchObject({ ok: true, installed: true });
  });
});

// ---------------------------------------------------------------------------
// 扩展壳（extensions/browser）— vm 沙箱桩法（与 ext-samples 同款）
// ---------------------------------------------------------------------------

type SetupFn = (h: Record<string, unknown>) => void | Promise<void>;
type RouteHandler = (req: { params?: Record<string, string>; body?: unknown }) => Promise<{
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}>;

async function loadBrowserShell(h: Record<string, unknown>): Promise<void> {
  const slot: { setup?: SetupFn } = {};
  const defineExtension = (input: unknown): unknown => {
    const candidate = typeof input === 'function' ? { setup: input } : input;
    slot.setup = (candidate as { setup?: SetupFn }).setup;
    return candidate;
  };
  const file = fileURLToPath(new URL('../extensions/browser/index.js', import.meta.url));
  vm.runInContext(readFileSync(file, 'utf8'), vm.createContext({ defineExtension }), { filename: file });
  if (slot.setup === undefined) throw new Error('browser extension did not call defineExtension');
  await slot.setup(h);
}

function makeShellHarness(browserStub: Record<string, unknown>) {
  const routes = new Map<string, RouteHandler>();
  const h = {
    route: (method: string, path: string, handler: RouteHandler) => {
      routes.set(`${method} ${path}`, handler);
    },
    browser: browserStub,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { routes, h: h as unknown as Record<string, unknown> };
}

describe('extensions/browser 壳', () => {
  it('manifest：校验通过、id=browser、builtin、权限在白名单（browser 已登记）', () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL('../extensions/browser/manifest.json', import.meta.url)), 'utf8'),
    ) as unknown;
    const manifest = validateManifest(raw);
    expect(manifest.id).toBe('browser');
    expect(manifest.builtin).toBe(true);
    expect(() => validatePermissions(manifest)).not.toThrow();
    expect(manifest.permissions).toContain('browser');
  });

  it('激活期注册三条路由（status/install/screenshots），挂载前缀即 /ext/browser', async () => {
    const { routes, h } = makeShellHarness({});
    await loadBrowserShell(h);
    expect([...routes.keys()].sort()).toEqual(['GET /api/status', 'GET /screenshots/:file', 'POST /install']);
  });

  it('GET /api/status：转发 h.browser.status 并回 { extension, installed, running, installing, lastError }', async () => {
    const { routes, h } = makeShellHarness({
      status: async () => ({ installed: false, running: false, installing: true, lastError: null }),
    });
    await loadBrowserShell(h);
    const res = await routes.get('GET /api/status')!({});
    expect(res).toEqual({
      status: 200,
      body: { extension: 'browser', installed: false, running: false, installing: true, lastError: null },
    });
  });

  it('POST /install：转发引擎（幂等语义由引擎保证）；内核错误收敛为结构化错误体', async () => {
    const { routes, h } = makeShellHarness({ install: async () => ({ started: true }) });
    await loadBrowserShell(h);
    expect(await routes.get('POST /install')!({})).toEqual({ status: 200, body: { started: true } });

    const failing = makeShellHarness({
      install: async () => {
        throw Object.assign(new Error('installer missing'), { code: 'INTERNAL' });
      },
    });
    await loadBrowserShell(failing.h);
    const errRes = await failing.routes.get('POST /install')!({});
    expect(errRes.status).toBe(500);
    expect(errRes.body).toMatchObject({ error: 'INTERNAL' });
  });

  it('GET /screenshots/:file：uuid 校验防穿越 + base64 → PNG 二进制体', async () => {
    // 纯 JS base64 解码正确性：'fake-png-bytes' 的 base64 回写必须逐字节一致
    const base64 = Buffer.from('fake-png-bytes', 'utf8').toString('base64');
    const { routes, h } = makeShellHarness({
      readScreenshot: async (file: string) => ({ file, mime: 'image/png', base64 }),
    });
    await loadBrowserShell(h);
    const handler = routes.get('GET /screenshots/:file')!;

    for (const bad of ['..%2Fsecret.png', 'abc.png', 'x.png.png']) {
      const res = await handler({ params: { file: bad } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'browser_screenshot_name_invalid' });
    }

    const res = await handler({ params: { file: '00000000-0000-4000-8000-000000000000.png' } });
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'image/png' });
    expect(Buffer.from(String(res.body), 'latin1').toString('utf8')).toBe('fake-png-bytes');

    // 引擎 404（HARNESS-3004）→ 路由 404
    const missing = makeShellHarness({
      readScreenshot: () => {
        throw Object.assign(new Error('screenshot "x" does not exist'), { code: 'HARNESS-3004' });
      },
    });
    await loadBrowserShell(missing.h);
    const notFound = await missing.routes
      .get('GET /screenshots/:file')!({ params: { file: '00000000-0000-4000-8000-000000000000.png' } });
    expect(notFound.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 真浏览器冒烟（本机已装 chromium 才跑；CI 无浏览器自动跳过）
// ---------------------------------------------------------------------------

/** 本机 chromium 是否可用（playwright-core executablePath 存在性） */
async function realChromiumAvailable(): Promise<boolean> {
  try {
    const pw = (await import('playwright-core')) as unknown as PlaywrightModuleLike;
    return existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}

const chromiumReady = await realChromiumAvailable();

describe.skipIf(!chromiumReady)('真浏览器冒烟（chromium 已安装）', () => {
  it('navigate 本地 http 服务 → title/status 正确 + file:// 拒绝 + 截图落盘 + close 释放', { timeout: 60_000 }, async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>smoke-ok</title></head><body><h1 id="h">hi</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const dataDir = mkdtempSync(join(tmpdir(), 'browser-smoke-'));
    tempDirs.push(dataDir);
    try {
      const engine = new BrowserEngine({
        dataDir,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
        loadPlaywright: async () => (await import('playwright-core')) as unknown as PlaywrightModuleLike,
        existsSync: (p) => existsSync(p),
      });
      expect((await engine.status()).installed).toBe(true);
      const nav = await engine.navigate(`http://127.0.0.1:${port}/`);
      expect(nav).toMatchObject({ title: 'smoke-ok', status: 200 });
      // URL 校验在真引擎同样生效（file:// 拒绝）
      await expect(engine.navigate(`file://${execPath}`)).rejects.toThrow(BrowserUrlRejectedError);
      const snapshot = await engine.snapshot();
      expect(snapshot.snapshot).toContain('hi');
      const shot = await engine.screenshot({});
      expect(existsSync(shot.path)).toBe(true);
      await engine.close();
      expect((await engine.status()).running).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
