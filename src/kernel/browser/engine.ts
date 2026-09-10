/**
 * browser/engine — 浏览器自动化内核引擎（Playwright 跑在内核主线程，方案 B）。
 *
 * 为什么在内核而不在扩展沙箱：扩展运行于 worker_threads + vm.Context，受限 require
 * 只放行扩展目录内相对 .js（SEC-1/SEC-2），Playwright（npm 包 + child_process + node:fs）
 * 在沙箱内不可加载——探针证据见 extensions/browser/README.md。本引擎为 doc-extract
 * 同款「内核能力层」：扩展壳（extensions/browser）只做路由转发。
 *
 * 运行语义（工作包需求逐条落地）：
 * - **单例浏览器**：同一时间至多一个 Browser + 一个 Page；全部操作经 promise 链
 *   mutex 串行化，等待队列深度超过 BROWSER_QUEUE_LIMIT 直接 BrowserBusyError
 *   （第二个调用「等待」为主、极端积压「报 BUSY」兜底）；
 * - **空闲回收**：BROWSER_IDLE_CLOSE_MS（默认 10 分钟）无调用自动关浏览器，
 *   下轮工具调用再冷启动；
 * - **崩溃恢复**：操作前检查存活（isConnected / isClosed），操作失败且错误形似
 *   「浏览器/页面已关闭或崩溃」时自动重启一次并重试一次（仅一次，防 crash loop）；
 * - **URL 校验**：仅 http/https；file:// 与其余协议一律 BrowserUrlRejectedError；
 * - **导航超时**：BROWSER_NAV_TIMEOUT_MS（30s）；
 * - **浏览器二进制默认不下载**：chromium 缺失时统一抛 BrowserNotInstalledError，
 *   由工具层/扩展壳映射为 `{ error: 'browser_not_installed', hint }` 结构化错误；
 *   POST /ext/browser/install 经 install() 后台触发 `playwright-core cli install chromium`
 *   （幂等：已装 / 已在装均不重复触发；状态内存 + <dataDir>/browser/install.json 标记）。
 *
 * 可注入面（测试替身）：loadPlaywright / spawnInstaller / existsSync 均可替换，
 * 测试无需真实浏览器即可覆盖全部分支。
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync as fsExistsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { err } from '../errors/index.js';

import {
  BROWSER_IDLE_CLOSE_MS,
  BROWSER_NAV_TIMEOUT_MS,
  BROWSER_QUEUE_LIMIT,
  BROWSER_SNAPSHOT_MAX_BYTES,
  SCREENSHOT_FILE_PATTERN,
  BrowserBusyError,
  BrowserNotInstalledError,
  BrowserScreenshotNameError,
  BrowserUrlRejectedError,
  type BrowserInstallResult,
  type BrowserNavigateResult,
  type BrowserScreenshotFile,
  type BrowserScreenshotResult,
  type BrowserStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Playwright 结构视图（只声明引擎实际用到的面；测试替身按此形状桩）
// ---------------------------------------------------------------------------

export interface PlaywrightResponseLike {
  status(): number;
}

export interface PlaywrightLocatorLike {
  click(opts?: { timeout?: number }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

export interface PlaywrightPageLike {
  goto(url: string, opts?: { timeout?: number; waitUntil?: 'load' }): Promise<PlaywrightResponseLike | null>;
  title(): Promise<string>;
  url(): string;
  locator(selector: string): PlaywrightLocatorLike;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts: { fullPage?: boolean; path: string; type: 'png' }): Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface PlaywrightBrowserLike {
  newPage(): Promise<PlaywrightPageLike>;
  isConnected(): boolean;
  close(): Promise<void>;
  on(event: 'disconnected', cb: () => void): void;
}

export interface PlaywrightModuleLike {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowserLike>;
    executablePath(): string;
  };
}

/** 引擎 logger 结构面（内核 pino 子集） */
export interface BrowserLogger {
  info(o: unknown, msg: string): void;
  warn(o: unknown, msg: string): void;
  error(o: unknown, msg: string): void;
  debug(o: unknown, msg: string): void;
}

/** 后台安装任务句柄（测试替身可自行实现） */
export interface InstallerProcessLike {
  readonly pid?: number;
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill?(): void;
}

export interface BrowserEngineDeps {
  /** 数据目录（截图落 <dataDir>/browser/screenshots，安装标记落 <dataDir>/browser/install.json） */
  dataDir: string;
  logger: BrowserLogger;
  /** 截图目录（缺省 <dataDir>/browser/screenshots） */
  screenshotsDir?: string;
  /** 空闲自动关浏览器阈值（毫秒；缺省 10 分钟） */
  idleCloseMs?: number;
  /** 页面导航超时（毫秒；缺省 30s） */
  navTimeoutMs?: number;
  /** mutex 等待队列深度上限（缺省 16） */
  queueLimit?: number;
  /** Playwright 模块加载器（缺省动态 import('playwright-core')；测试注入替身） */
  loadPlaywright?: () => Promise<PlaywrightModuleLike>;
  /** 后台安装器（缺省 spawn node <playwright-core>/cli.js install chromium；测试注入替身） */
  spawnInstaller?: (onExit: (code: number | null, stderrTail: string) => void) => InstallerProcessLike;
  /** 可执行文件存在性检查（缺省 fs.existsSync；测试注入） */
  existsSync?: (path: string) => boolean;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 按 UTF-8 字节口径截断字符串（多字节字符不劈半） */
function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  let sliced = text.slice(0, maxBytes);
  while (sliced.length > 0 && Buffer.byteLength(sliced, 'utf8') > maxBytes) {
    sliced = sliced.slice(0, -1);
  }
  return { text: sliced, truncated: true };
}

/** 错误是否形似「浏览器/页面已关闭或崩溃」（崩溃恢复的触发判定） */
function looksLikeBrowserCrash(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /closed|crashed|target page|browser has been|browser context|disconnected/i.test(message);
}

// ---------------------------------------------------------------------------
// BrowserEngine
// ---------------------------------------------------------------------------

export class BrowserEngine {
  readonly #deps: BrowserEngineDeps;
  readonly #screenshotsDir: string;
  readonly #idleCloseMs: number;
  readonly #navTimeoutMs: number;
  readonly #queueLimit: number;
  readonly #installMarkerPath: string;
  /** 存在性检查（deps 注入优先，缺省 fs.existsSync） */
  readonly #existsSync: (path: string) => boolean;

  /** Playwright 模块缓存（首次成功加载后复用；加载失败不缓存） */
  #playwright: PlaywrightModuleLike | null = null;
  /** 单例浏览器与页面 */
  #browser: PlaywrightBrowserLike | null = null;
  #page: PlaywrightPageLike | null = null;
  /** mutex：操作串行链 + 在途计数（含排队） */
  #chain: Promise<unknown> = Promise.resolve();
  #pending = 0;
  /** 空闲回收定时器 */
  #idleTimer: NodeJS.Timeout | null = null;
  /** 后台安装态（内存权威；标记文件只作可观测/重启后排查） */
  #installing = false;
  #installer: InstallerProcessLike | null = null;
  #lastError: string | null = null;
  /** stop() 后不再启动浏览器（内核关停语义） */
  #stopped = false;

  constructor(deps: BrowserEngineDeps) {
    this.#deps = deps;
    this.#screenshotsDir = deps.screenshotsDir ?? join(deps.dataDir, 'browser', 'screenshots');
    this.#idleCloseMs = deps.idleCloseMs ?? BROWSER_IDLE_CLOSE_MS;
    this.#navTimeoutMs = deps.navTimeoutMs ?? BROWSER_NAV_TIMEOUT_MS;
    this.#queueLimit = deps.queueLimit ?? BROWSER_QUEUE_LIMIT;
    this.#installMarkerPath = join(deps.dataDir, 'browser', 'install.json');
    this.#existsSync = deps.existsSync ?? fsExistsSync;
  }

  // ------------------------------------------------------------------ 状态查询

  /**
   * 运行态快照：{ installed, running, installing, lastError }。
   * installed = playwright-core 可加载且 chromium 可执行文件存在；不缓存失败。
   */
  async status(): Promise<BrowserStatus> {
    return {
      installed: await this.#resolveInstalled(),
      running: this.#isAlive(),
      installing: this.#installing,
      lastError: this.#lastError,
    };
  }

  // ------------------------------------------------------------------ 安装

  /**
   * 后台安装 chromium（幂等）：
   * - 已安装 → { started:false, installed:true }；
   * - 安装进行中 → { started:false, installing:true }；
   * - 否则 spawn 后台安装（立即返回 { started:true }，不等完成），
   *   起止写 <dataDir>/browser/install.json 标记；失败记 lastError。
   */
  async install(): Promise<BrowserInstallResult> {
    if (await this.#resolveInstalled()) return { started: false, installed: true };
    if (this.#installing) return { started: false, installing: true };

    const startedAt = Date.now();
    this.#writeInstallMarker({ startedAt });
    this.#installing = true;
    const finish = (ok: boolean, detail: string): void => {
      this.#installing = false;
      this.#installer = null;
      this.#writeInstallMarker({ startedAt, finishedAt: Date.now(), ok, detail });
      if (ok) {
        this.#lastError = null;
        this.#deps.logger.info({ durationMs: Date.now() - startedAt }, 'browser engine: chromium install finished');
      } else {
        this.#lastError = `chromium install failed: ${detail}`;
        this.#deps.logger.error({ detail }, 'browser engine: chromium install failed');
      }
    };
    try {
      this.#installer = this.#spawnInstallerImpl((code, stderrTail) => {
        finish(code === 0, code === 0 ? 'ok' : `exit code ${code}${stderrTail !== '' ? `: ${stderrTail}` : ''}`);
      });
      // 起始标记补 pid（重启后排查孤儿安装进程用）
      this.#writeInstallMarker({ startedAt, pid: this.#installer.pid ?? null });
      this.#deps.logger.info({ pid: this.#installer.pid ?? null }, 'browser engine: chromium install started in background');
      return { started: true };
    } catch (cause) {
      finish(false, cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  /** 缺省安装器：node <playwright-core>/cli.js install chromium（stderr 尾部回收作失败详情） */
  #spawnInstallerImpl(onExit: (code: number | null, stderrTail: string) => void): InstallerProcessLike {
    const spawn = this.#deps.spawnInstaller;
    if (spawn !== undefined) return spawn(onExit);
    let cliPath: string;
    try {
      const require = createRequire(import.meta.url);
      const pkgJson = require.resolve('playwright-core/package.json');
      cliPath = join(dirname(pkgJson), 'cli.js');
      if (!fsExistsSync(cliPath)) throw new Error(`cli not found at ${cliPath}`);
    } catch (cause) {
      throw new Error(
        `playwright-core CLI is not resolvable (${cause instanceof Error ? cause.message : String(cause)}); ` +
          'install playwright-core next to the kernel first',
      );
    }
    let stderrTail = '';
    const child: ChildProcess = nodeSpawn(process.execPath, [cliPath, 'install', 'chromium'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-400);
    });
    child.on('exit', (code) => onExit(code, stderrTail.trim()));
    return child;
  }

  #writeInstallMarker(payload: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.#installMarkerPath), { recursive: true });
      writeFileSync(this.#installMarkerPath, JSON.stringify(payload), 'utf8');
    } catch (cause) {
      this.#deps.logger.warn(
        { err: cause instanceof Error ? cause.message : String(cause) },
        'browser engine: install marker write failed',
      );
    }
  }

  // ------------------------------------------------------------------ 页面操作（公开 API，全部走 mutex）

  /** 导航：URL 校验 → goto（30s 超时）→ { title, url, status } */
  async navigate(url: string): Promise<BrowserNavigateResult> {
    const target = this.#assertHttpUrl(url);
    return await this.#enqueue(async (page) => {
      const response = await page.goto(target.href, { timeout: this.#navTimeoutMs, waitUntil: 'load' });
      const title = await page.title();
      return { title, url: page.url(), status: response?.status() ?? 0 };
    });
  }

  /** 可访问性 aria 快照文本（≤50KB 截断） */
  async snapshot(): Promise<{ snapshot: string; truncated: boolean }> {
    return await this.#enqueue(async (page) => {
      let text: string;
      try {
        text = await page.locator('html').ariaSnapshot();
      } catch {
        // 老版本 playwright 无 Locator.ariaSnapshot → 退化 accessibility 快照（JSON 文本）
        const ax = await (
          page as unknown as { accessibility?: { snapshot(): Promise<unknown> } }
        ).accessibility?.snapshot();
        text = JSON.stringify(ax ?? {});
      }
      const out = truncateUtf8(text, BROWSER_SNAPSHOT_MAX_BYTES);
      return { snapshot: out.text, truncated: out.truncated };
    });
  }

  /** 点击元素 */
  async click(input: { selector: string }): Promise<true> {
    const selector = this.#assertSelector(input.selector);
    await this.#enqueue(async (page) => {
      await page.locator(selector).click({ timeout: this.#navTimeoutMs });
    });
    return true;
  }

  /** 向元素输入文本（fill 语义：先清空再输入） */
  async type(input: { selector: string; text: string }): Promise<true> {
    const selector = this.#assertSelector(input.selector);
    await this.#enqueue(async (page) => {
      await page.locator(selector).fill(input.text, { timeout: this.#navTimeoutMs });
    });
    return true;
  }

  /** 按键（page.keyboard.press） */
  async pressKey(input: { key: string }): Promise<true> {
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key === '' || key.length > 64) {
      throw err('BAD_REQUEST', { message: 'browser_press_key: "key" must be a non-empty string (max 64 chars)' });
    }
    await this.#enqueue(async (page) => {
      await page.keyboard.press(key);
    });
    return true;
  }

  /** 截图落数据目录 → { path, file, url }（url 即扩展路由 GET /ext/browser/screenshots/:file） */
  async screenshot(input: { fullPage?: boolean }): Promise<BrowserScreenshotResult> {
    const file = `${randomUUID()}.png`;
    const path = join(this.#screenshotsDir, file);
    await this.#enqueue(async (page) => {
      mkdirSync(this.#screenshotsDir, { recursive: true });
      await page.screenshot({ fullPage: input.fullPage === true, path, type: 'png' });
    });
    return { path, file, url: `/ext/browser/screenshots/${file}` };
  }

  /** 读取截图文件（base64；uuid 形状校验防穿越）——扩展壳 screenshots 路由的取数通道 */
  readScreenshot(file: string): BrowserScreenshotFile {
    if (typeof file !== 'string' || !SCREENSHOT_FILE_PATTERN.test(file)) {
      throw new BrowserScreenshotNameError(String(file));
    }
    const path = join(this.#screenshotsDir, file);
    // 截图是引擎自持数据：直接用 fs 存在性（注入的 existsSync 只管 chromium 可执行文件）
    if (!fsExistsSync(path)) {
      throw err('EXT_NOT_FOUND', { message: `screenshot "${file}" does not exist`, detail: { file } });
    }
    return { file, mime: 'image/png', base64: readFileSync(path).toString('base64') };
  }

  /** 关闭浏览器释放资源（幂等；空闲回收与显式关闭共用） */
  async close(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#teardown();
    });
  }

  /** 内核关停：关浏览器 + 终止后台安装子进程；之后不再冷启动 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#clearIdleTimer();
    try {
      this.#installer?.kill?.();
    } catch {
      // 安装进程已退出：忽略
    }
    await this.#teardown();
  }

  // ------------------------------------------------------------------ mutex 与生命周期

  /**
   * mutex 入队：全部页面操作串行通过单一 promise 链（同一时间仅一个浏览器实例被
   * 操作/创建）。队列深度超限 → BrowserBusyError。op 收到确保存活的 page。
   * 崩溃恢复：op 失败且形似浏览器崩溃 → 重启一次并重试一次（仅一次）。
   */
  async #enqueue<T>(op: (page: PlaywrightPageLike) => Promise<T>): Promise<T> {
    if (this.#pending >= this.#queueLimit) throw new BrowserBusyError(this.#queueLimit);
    this.#pending += 1;
    const run = async (): Promise<T> => {
      if (this.#stopped) throw err('KERNEL_SHUTTING_DOWN', { message: 'browser engine is stopped' });
      const page = await this.#ensurePage();
      try {
        return await op(page);
      } catch (cause) {
        if (!looksLikeBrowserCrash(cause)) throw cause;
        // 崩溃恢复：重启一次并重试一次
        this.#deps.logger.warn(
          { err: cause instanceof Error ? cause.message : String(cause) },
          'browser engine: browser crashed, restarting once',
        );
        this.#setLastError(cause);
        await this.#teardown();
        const fresh = await this.#ensurePage();
        return await op(fresh);
      }
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined); // 链不断：单个 op 失败不阻塞后续
    try {
      return await next;
    } catch (cause) {
      this.#setLastError(cause);
      throw cause;
    } finally {
      this.#pending -= 1;
      this.#armIdleTimer();
    }
  }

  /** 确保存活的单例 page：缺失/已死则（重）启动一次 */
  async #ensurePage(): Promise<PlaywrightPageLike> {
    if (this.#isAlive()) return this.#page as PlaywrightPageLike;
    await this.#teardown(); // 清理残骸（幂等）
    const pw = await this.#loadPlaywright();
    if (!this.#existsSync(this.#executablePath(pw))) {
      throw new BrowserNotInstalledError();
    }
    const browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage();
    this.#browser = browser;
    this.#page = page;
    this.#deps.logger.info({ headless: true }, 'browser engine: chromium launched (headless singleton)');
    return page;
  }

  /** 存活判定：browser 已连且 page 未关 */
  #isAlive(): boolean {
    return (
      this.#browser !== null &&
      this.#page !== null &&
      this.#browser.isConnected() &&
      !this.#page.isClosed()
    );
  }

  /**
   * chromium 可执行文件存在性判定（playwright-core 可加载为前提；模块缺失/解析失败
   * 一律 false——「未安装」语义）。结果不缓存失败，安装完成后立即可见。
   */
  async #resolveInstalled(): Promise<boolean> {
    try {
      const pw = await this.#loadPlaywright();
      return this.#existsSync(this.#executablePath(pw));
    } catch {
      return false;
    }
  }

  #executablePath(pw: PlaywrightModuleLike): string {
    try {
      return pw.chromium.executablePath();
    } catch {
      return '';
    }
  }

  async #loadPlaywright(): Promise<PlaywrightModuleLike> {
    if (this.#playwright !== null) return this.#playwright;
    const loader = this.#deps.loadPlaywright;
    try {
      const mod = loader !== undefined
        ? await loader()
        : ((await import('playwright-core')) as unknown as PlaywrightModuleLike);
      this.#playwright = mod;
      return mod;
    } catch (cause) {
      // 模块缺失按「浏览器未安装」收敛（playwright-core 是常规依赖，正常安装必在）
      throw new BrowserNotInstalledError(
        `playwright-core module failed to load: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** 关闭 page + browser（幂等；失败静默——残骸由下次 ensurePage 再清） */
  async #teardown(): Promise<void> {
    const page = this.#page;
    const browser = this.#browser;
    this.#page = null;
    this.#browser = null;
    for (const [label, closer] of [['page', page], ['browser', browser]] as const) {
      if (closer === null) continue;
      try {
        await closer.close();
      } catch (cause) {
        this.#deps.logger.debug(
          { err: cause instanceof Error ? cause.message : String(cause) },
          `browser engine: ${label} close warned`,
        );
      }
    }
  }

  // ------------------------------------------------------------------ 空闲回收

  /** 每次操作完成后重置空闲定时器：阈值到期且无在途操作 → 关浏览器（下轮调用再冷启动） */
  #armIdleTimer(): void {
    this.#clearIdleTimer();
    if (this.#stopped || !this.#isAlive()) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#pending > 0 || !this.#isAlive()) return;
      void this.#teardown().then(() => {
        this.#deps.logger.info({ idleMs: this.#idleCloseMs }, 'browser engine: idle browser closed');
      });
    }, this.#idleCloseMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  // ------------------------------------------------------------------ 入参校验

  /** URL 白名单：仅 http/https（file:// 与其余协议、语法非法一律拒绝） */
  #assertHttpUrl(raw: string): URL {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new BrowserUrlRejectedError(String(raw), 'url is required');
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.trim());
    } catch {
      throw new BrowserUrlRejectedError(raw, 'invalid url syntax');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserUrlRejectedError(raw, `protocol "${parsed.protocol}" is not allowed`);
    }
    return parsed;
  }

  #assertSelector(selector: string): string {
    if (typeof selector !== 'string' || selector.trim() === '' || selector.length > 2048) {
      throw err('BAD_REQUEST', { message: 'selector must be a non-empty string (max 2048 chars)' });
    }
    return selector;
  }

  #setLastError(cause: unknown): void {
    this.#lastError = cause instanceof Error ? cause.message : String(cause);
  }
}
