/**
 * webui 内置扩展测试（React + Tailwind + shadcn/ui 重写后的契约面）。
 *
 * 四层覆盖：
 * A. manifest 与扩展入口（单元）：validateManifest/validatePermissions（import 内核）；
 *    index.js 经 vm 注入 defineExtension 加载并捕获 h.page/h.menu 贡献。
 *    —— 管理台从 Vue3 重写为 React 后此契约面不变。
 * B. 构建产物与部署面（静态）：ui/index.html（React #app 挂载点（React root 挂载点） + 防闪烁脚本）与
 *    引用资产齐全；React 工程契约（依赖无 Vue、源码无 .vue、无 console.*）；
 *    主题 Token 体系（styles.css 亮暗两套变量 + theme.tsx 运行期覆盖链）；
 *    路由注册完整性（router.tsx 含 /login + 11 条主导航 + HashRouter）；
 *    基础设施契约（api.ts 凭据/401、sse.ts 游标重连/replay-gap）；
 *    vite/Dockerfile/.gitignore 契约；产物经内核 registerExtAssets 可静态服务。
 * C. 真实 Kernel E2E（真实 createHttpServer + 真实 worker 线程 + 临时 dataDir）：
 *    builtin 自动启用（与 auth 同款）→ manifest/聚合端点 → /admin 与 UI 资产路由断言。
 *
 * ★ 内核接线状态（与上版一致，行为未回归）：
 *   1. mount:'ui' → /admin 接管：GET /admin → 302 → /ext/webui/ui/。
 *   2. 扩展 UI 静态资产：registerExtAssets 延迟到 extManager.start() 之后在 app 上补挂，
 *      /ext/webui/ui/** 可静态服务。
 *   3. h.page/h.menu 贡献聚合：GET /api/v1/ui 含 webui 条目。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// worker 入口解析在工厂调用期读 env：boot 之前设置（与 integration.extensions.test.ts 同款）
process.env['HARNESS_WORKER_MODE'] = 'dev';

import { registerExtAssets } from '../src/kernel/extensions/assets.js';
import { validateManifest, validatePermissions } from '../src/kernel/extensions/manifest.js';
import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';

// ---------------------------------------------------------------------------
// 公共路径
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT_DIR = path.join(REPO_ROOT, 'extensions', 'webui');
const UI_DIR = path.join(EXT_DIR, 'ui');
const UI_SRC_DIR = path.join(EXT_DIR, 'ui-src');
const UI_SRC = path.join(UI_SRC_DIR, 'src');

const manifestRaw: unknown = JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

// ############################################################################
// A. manifest 与扩展入口（Vue → React 重写后契约不变）
// ############################################################################

describe('webui manifest 与扩展入口', () => {
  it('1. manifest.json 通过内核 validateManifest + validatePermissions；builtin/mount 正确', () => {
    const manifest = validateManifest(manifestRaw); // 非法形状/版本 → EXT_MANIFEST_INVALID
    expect(manifest.id).toBe('webui');
    expect(manifest.api).toBe(1);
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.main).toBe('index.js');
    expect(manifest.displayName).toBe('Web Console');
    expect(manifest.builtin).toBe(true);
    expect(manifest.mount).toBe('ui');
    expect(manifest.permissions).toEqual(['http', 'ui', 'storage']);
    validatePermissions(manifest); // 白名单外权限 → EXT_MANIFEST_INVALID
  });

  it('2. manifest.ui 声明根页面（静态资产挂载与 /api/v1/extensions/webui 的数据源）', () => {
    const manifest = validateManifest(manifestRaw);
    expect(manifest.ui).toBeDefined();
    expect(manifest.ui?.menu).toEqual({ label: 'Console' });
    expect(manifest.ui?.pages).toEqual([{ path: '/', title: 'Console', entry: 'index.html' }]);
  });

  it('3. index.js 经 vm 注入 defineExtension 可加载；setup 捕获 h.page("/") + h.menu 贡献', async () => {
    const source = readFileSync(path.join(EXT_DIR, 'index.js'), 'utf8');
    let captured: ((h: unknown, ctx?: unknown) => void | Promise<void>) | undefined;
    const context = vm.createContext({
      // 沙箱注入的全局函数（worker.ts installDefineExtensionGlobal 同款记录式语义）
      defineExtension: (fn: unknown) => {
        captured = fn as typeof captured;
      },
    });
    new vm.Script(source, { filename: path.join(EXT_DIR, 'index.js') }).runInContext(context);
    expect(typeof captured).toBe('function');

    // 记录式 fake harness：只实现 index.js 会触达的注册类 API
    const pages: Array<{ path: string; title: string; entry: string }> = [];
    const menus: Array<{ label: string; icon?: string }> = [];
    const fakeH = {
      page: (p: string, def: { title: string; entry: string }) => pages.push({ path: p, ...def }),
      menu: (label: string, icon?: string) => menus.push(icon === undefined ? { label } : { label, icon }),
    };
    await captured?.(fakeH);
    expect(pages).toEqual([{ path: '/', title: 'Console', entry: 'index.html' }]);
    expect(menus).toEqual([{ label: 'Console' }]);
  });
});

// ############################################################################
// B. 构建产物与部署面
// ############################################################################

/** 从 index.html 抽取 ./ 相对引用（script src / link href） */
function referencedAssets(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
    const ref = m[1];
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

describe('webui 构建产物与部署面（React 产物）', () => {
  it('4. ui/index.html 存在：React #app 挂载点（React root 挂载点） + 主题防闪烁脚本 + ./ 相对引用产物齐全', () => {
    const htmlPath = path.join(UI_DIR, 'index.html');
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, 'utf8');
    // React 挂载点（main.tsx: getElementById('root')）
    expect(html).toContain('<div id="app">');
    // 防闪烁脚本：首帧前按 localStorage('ui.mode') 落 .dark 类（与 lib/theme.tsx 同策略）
    expect(html).toContain("localStorage.getItem('ui.mode')");
    expect(html).toContain("classList.toggle('dark'");
    const refs = referencedAssets(html);
    expect(refs.length).toBeGreaterThanOrEqual(2); // 至少 1 js + 1 css
    expect(refs.some((r) => r.endsWith('.js'))).toBe(true);
    expect(refs.some((r) => r.endsWith('.css'))).toBe(true);
    for (const ref of refs) {
      const assetPath = path.join(UI_DIR, ref);
      expect(existsSync(assetPath), `missing asset: ${ref}`).toBe(true);
      expect(statSync(assetPath).size).toBeGreaterThan(0);
    }
  });

  it('5. vite.config：base 为相对路径、outDir 指向 ../ui（产物出 extensions/webui/ui）', () => {
    const cfg = readFileSync(path.join(UI_SRC_DIR, 'vite.config.ts'), 'utf8');
    expect(cfg).toContain("base: './'");
    expect(cfg).toContain("outDir: '../ui'");
    // 产物目录确有内容（空目录视为未构建）
    const entries = readdirSync(UI_DIR);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('6. React 工程契约：依赖无 Vue、源码无 .vue 残留、源码无 console.*', () => {
    // 依赖面：React 三件套在列，Vue 全家清零（dependencies/devDependencies 双检查）
    const pkg = JSON.parse(readFileSync(path.join(UI_SRC_DIR, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(pkg.dependencies?.['react']).toBeDefined();
    expect(pkg.dependencies?.['react-dom']).toBeDefined();
    expect(pkg.dependencies?.['react-router-dom']).toBeDefined();
    for (const name of Object.keys(allDeps)) {
      expect(name.startsWith('vue') || name.includes('/vue') || name.startsWith('@vue'), `residual dep: ${name}`).toBe(false);
    }
    // 源码面：无 .vue 文件、无 Vue 导入、无 console.*
    const vueFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.vue')) vueFiles.push(p);
      }
    };
    walk(UI_SRC);
    expect(vueFiles).toEqual([]);
    const sourceFiles = ['main.tsx', 'router.tsx', 'lib/api.ts', 'lib/sse.ts', 'lib/theme.tsx', 'styles.css'];
    for (const f of sourceFiles) {
      const src = readFileSync(path.join(UI_SRC, f), 'utf8');
      expect(src.includes('from \'vue'), `${f} imports vue`).toBe(false);
      expect(src, `${f} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
    }
  });

  it('7. 主题 Token 体系：styles.css 含亮暗两套变量全集；theme.tsx 运行期覆盖链完整', () => {
    const css = readFileSync(path.join(UI_SRC, 'styles.css'), 'utf8');
    // :root 亮色段与 .dark 暗色段各自携带 shadcn 核心变量
    const rootStart = css.indexOf(':root {');
    const darkStart = css.indexOf('.dark {');
    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(darkStart).toBeGreaterThan(rootStart);
    const rootBlock = css.slice(rootStart, darkStart);
    const darkBlock = css.slice(darkStart);
    const REQUIRED_VARS = ['--background:', '--foreground:', '--primary:', '--muted:', '--accent:', '--destructive:', '--border:', '--input:', '--ring:', '--radius:'];
    for (const v of REQUIRED_VARS) {
      expect(rootBlock.includes(v), `:root missing ${v}`).toBe(true);
      expect(darkBlock.includes(v), `.dark missing ${v}`).toBe(true);
    }
    // class 策略（Tailwind v4 @custom-variant dark）+ 变量 → 工具类桥接
    expect(css).toContain('@custom-variant dark');
    expect(css).toContain('@theme inline');
    expect(css).toContain('--color-background: var(--background);');

    // 运行期覆盖链：ThemeProvider 经 setProperty 应用（mode → preset → radius/density → custom）
    const theme = readFileSync(path.join(UI_SRC, 'lib', 'theme.tsx'), 'utf8');
    expect(theme).toContain("setProperty");
    expect(theme).toContain("'ui.mode'");
    expect(theme).toContain("'ui.tokens'");
    expect(theme).toContain('resetToDefaults');
    expect(theme).toContain("'system'");
    // 强调色预设 ≥6 组（default/zinc/violet/blue/emerald/amber/rose）
    const presetIds = [...theme.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(presetIds).size).toBeGreaterThanOrEqual(6);
    // 圆角档位 5 档
    for (const step of ['0rem', '0.25rem', '0.5rem', '0.75rem', '1rem']) {
      expect(theme).toContain(`'${step}'`);
    }
    // 密度两档
    expect(theme).toContain("'comfortable'");
    expect(theme).toContain("'compact'");
  });

  it('8. 路由注册完整性：router.tsx 含 HashRouter + /login + 全部 11 条主导航 + /onboarding + 兜底', () => {
    const router = readFileSync(path.join(UI_SRC, 'router.tsx'), 'utf8');
    expect(router).toContain('HashRouter');
    const routes = [
      '/login',
      '/',
      '/extensions',
      '/cron',
      '/notifications',
      '/files-tasks',
      '/sandbox',
      '/users',
      '/api-keys',
      '/logs',
      '/settings',
      '/update',
      // ★ W2 onboarding 向导包追加：/onboarding 公开路由（首次初始化向导，不入主导航）
      '/onboarding',
    ];
    for (const r of routes) {
      expect(router, `route missing: ${r}`).toContain(`path="${r}"`);
    }
    // 兜底重定向（未知 hash → 仪表盘），与认证守卫
    expect(router).toContain('path="*"');
    expect(router).toContain('RequireAuth');
    // ★ W2 onboarding 向导包追加：启动探测网关（needsOnboarding=true 且无 token → 强制 /onboarding）
    expect(router).toContain('OnboardingGate');
    expect(router).toContain('/api/v1/auth/onboarding/status');
    // 与导航单一数据源对账：NAV_GROUPS 恰好覆盖同一组路径（不含 /login，★亦不含引导专用 /onboarding）
    const nav = readFileSync(path.join(UI_SRC, 'lib', 'nav.tsx'), 'utf8');
    for (const r of routes.filter((r) => r !== '/login' && r !== '/onboarding')) {
      expect(nav, `nav missing: ${r}`).toContain(`path: '${r}'`);
    }
  });

  it('9. 基础设施契约：api.ts 凭据/401 跳转；sse.ts 游标重连与 replay-gap 对账', () => {
    const api = readFileSync(path.join(UI_SRC, 'lib', 'api.ts'), 'utf8');
    expect(api).toContain("'ui.token'");
    expect(api).toContain("res.status === 401");
    expect(api).toContain("'#/login'");

    const sse = readFileSync(path.join(UI_SRC, 'lib', 'sse.ts'), 'utf8');
    // 断线自动重连带 lastEventId 游标（内核 hub 支持 Last-Event-ID 重放）
    expect(sse).toContain('lastEventId');
    // replay-gap → 回调清空本地缓存由调用方 REST 对账；: replay 注释帧由 EventSource 天然静默
    expect(sse).toContain('replay-gap');
    expect(sse).toContain('/api/v1/stream');
    expect(sse).toContain('topics');
  });

  it('10. Dockerfile 含 ui 构建阶段，runtime 携带 webui manifest/入口与 ui 产物', () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, 'docker', 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/FROM node:24-alpine AS ui-build/);
    expect(dockerfile).toContain('COPY --from=ui-build /app/extensions/webui/ui ./extensions/webui/ui');
    // 扩展发现依赖 manifest + main；runtime 必须一并携带，否则产物成孤儿
    expect(dockerfile).toContain('extensions/webui/index.js');
    expect(dockerfile).toContain('extensions/webui/manifest.json');
  });

  it('11. .gitignore：忽略 ui-src/node_modules，白名单跟踪 extensions/webui/ui 产物', () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('extensions/webui/ui-src/node_modules/');
    expect(gitignore).toContain('extensions/*/ui/');
    expect(gitignore).toContain('!extensions/webui/ui/');
  });

  it('12. 产物经内核 registerExtAssets 可静态服务：index.html 200（非应急页）+ 引用资产 200', async () => {
    const app = Fastify({ logger: false });
    registerExtAssets(app, [{ extId: 'webui', uiRoot: UI_DIR }]);
    try {
      const html = await app.inject({ method: 'GET', url: '/ext/webui/ui/index.html' });
      expect(html.statusCode).toBe(200);
      expect(html.headers['content-type']).toContain('text/html');
      expect(html.body).toContain('<div id="app">');
      // 非内核应急页（server.ts FALLBACK_PAGE 的标记文案不得出现在控制台产物里）
      expect(html.body).not.toContain('webui 扩展未启用');

      for (const ref of referencedAssets(html.body)) {
        const asset = await app.inject({ method: 'GET', url: `/ext/webui/ui/${ref.slice('./'.length)}` });
        expect(asset.statusCode, `asset ${ref} should be servable`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});

// ############################################################################
// C. 真实内核 E2E
// ############################################################################

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let auth = { authorization: '' };

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-webui-e2e-'));
  kernel = new Kernel({
    config: {
      ...loadConfig({
        NODE_ENV: 'test',
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_TASK_WORKERS: '1',
        HARNESS_DATA_DIR: dataDir,
        HARNESS_PERSIST_ROOT_TOKEN: '0',
      }),
      port: 0,
    },
  });
  await kernel.boot();
  const rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  auth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
});

afterAll(async () => {
  await kernel?.shutdown('webui-e2e-afterall');
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

describe('webui 真实内核 E2E（builtin 自动启用 + /admin 与 UI 资产现状）', () => {
  it('13. webui 随 boot 自动启用（builtin 同 auth 款）：清单 enabled:true / builtin:true / mount ui', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions', headers: auth });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; enabled: boolean; builtin: boolean; mount: string | null }>;
    const webui = list.find((s) => s.id === 'webui');
    expect(webui).toBeDefined();
    expect(webui?.enabled).toBe(true); // builtin 默认启用（manager.start() insertRow 语义）
    expect(webui?.builtin).toBe(true);
    expect(webui?.mount).toBe('ui');
  });

  it('14. GET /api/v1/extensions/webui → manifest.ui.pages 携带根页面声明', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/extensions/webui', headers: auth });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as {
      manifest?: { ui?: { pages?: Array<{ path: string; title: string; entry: string }> } };
    };
    expect(detail.manifest?.ui?.pages).toEqual([{ path: '/', title: 'Console', entry: 'index.html' }]);
  });

  it('15. GET /api/v1/ui → 200 含 webui 贡献条目（h.page/h.menu 随 host.load 回报并入册）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ui', headers: auth });
    expect(res.statusCode).toBe(200);
    // 内核补线（load 回执 ui → validateContributions 保留 ui 段 → UiRegistry）后：
    expect(res.json()).toEqual([
      expect.objectContaining({
        extId: 'webui',
        menu: { label: 'Console' },
        pages: [{ path: '/', title: 'Console', entry: 'index.html' }],
        widgets: [],
        renderers: [],
      }),
    ]);
  });

  it('16. GET /ext/webui/ui/index.html → 200（资产挂载已延迟到 manager.start() 后补挂）', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/webui/ui/index.html' });
    // Kernel 的 registerExtAssets 现于 extManager.start() 之后直接在 app 上补挂，
    // builtin webui 的 ui/ 产物随 boot 即静态可服务：
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="app">');
  });

  it('17. GET /admin → 302 重定向到 /ext/webui/ui/（mount:"ui" 接管），跟随后 200 管理台', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    // AGENTS.md 内置扩展白名单 webui → /admin：内核已接线（请求期查 enabled + mount==='ui'），
    // 命中即 302 到扩展静态资产前缀根（index.html 回退）：
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ext/webui/ui/');
    const followed = await app.inject({ method: 'GET', url: '/ext/webui/ui/' });
    expect(followed.statusCode).toBe(200);
    expect(followed.body).toContain('<div id="app">');
  });

  it('18. 核心内置扩展保护（HARNESS-1007 core-builtin）：webui disable/uninstall → 403，webui 保持 enabled', async () => {
    // webui 是 builtin:true 的核心扩展：不可停用（停用 = 管理台消失，恢复只能进数据目录改库）
    const off = await app.inject({ method: 'POST', url: '/api/v1/extensions/webui/disable', headers: auth });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: 'HARNESS-1007', detail: { reason: 'core-builtin' } });
    const afterOff = await app.inject({ method: 'GET', url: '/api/v1/extensions/webui', headers: auth });
    expect(afterOff.statusCode).toBe(200);
    expect((afterOff.json() as { enabled: boolean }).enabled).toBe(true);

    // 卸载同受保护
    const gone = await app.inject({ method: 'POST', url: '/api/v1/extensions/webui/uninstall', headers: auth });
    expect(gone.statusCode).toBe(403);
    expect(gone.json()).toMatchObject({ code: 'HARNESS-1007', detail: { reason: 'core-builtin' } });

    // enable 幂等无害（已启用的核心扩展重复 enable 仍 200）
    const on = await app.inject({ method: 'POST', url: '/api/v1/extensions/webui/enable', headers: auth });
    expect(on.statusCode).toBe(200);
    const afterOn = await app.inject({ method: 'GET', url: '/api/v1/extensions/webui', headers: auth });
    expect((afterOn.json() as { enabled: boolean }).enabled).toBe(true);
  });

  it('19. GET / → 内核应急页保持不变（webui 不越权改写内核根路由）', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('webui 扩展未启用');
  });
});
