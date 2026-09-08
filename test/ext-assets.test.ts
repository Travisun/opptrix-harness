import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HarnessError } from '../src/kernel/errors/HarnessError.js';
import { registerExtAssets } from '../src/kernel/extensions/assets.js';

// ---------------------------------------------------------------------------
// 临时资产目录：tmpRoot/{demo,other}/... + tmpRoot/secret.txt（穿越目标）
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'opptrix-ext-assets-'));
writeFileSync(join(tmpRoot, 'secret.txt'), 'top-secret-outside-ui-root');

mkdirSync(join(tmpRoot, 'demo', 'sub'), { recursive: true });
writeFileSync(join(tmpRoot, 'demo', 'index.html'), '<h1>demo-ui</h1>');
writeFileSync(join(tmpRoot, 'demo', 'style.css'), 'body { color: #0f1115; }');
writeFileSync(join(tmpRoot, 'demo', 'sub', 'app.js'), 'console.log("demo");');

mkdirSync(join(tmpRoot, 'other'), { recursive: true });
writeFileSync(join(tmpRoot, 'other', 'other.html'), '<p>other-ui</p>');

let app: FastifyInstance;

beforeAll(() => {
  app = Fastify({ logger: false });
  registerExtAssets(app, [
    { extId: 'demo', uiRoot: join(tmpRoot, 'demo') },
    { extId: 'other', uiRoot: join(tmpRoot, 'other') },
  ]);
});

afterAll(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('registerExtAssets（@fastify/static 多实例）', () => {
  it('1. GET /ext/demo/ui/index.html → 200 且内容一致', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/demo/ui/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<h1>demo-ui</h1>');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('2. GET /ext/demo/ui/style.css → 200，content-type 为 text/css', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/demo/ui/style.css' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('body { color: #0f1115; }');
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('3. 未注册 extId 的 /ext/{id}/ui/* → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/ghost/ui/index.html' });
    expect(res.statusCode).toBe(404);
  });

  it('4. 目录穿越（编码 ..）→ 403 或 404（@fastify/static root 防护）', async () => {
    const encoded = await app.inject({ method: 'GET', url: '/ext/demo/ui/..%2Fsecret.txt' });
    expect([403, 404]).toContain(encoded.statusCode);

    const dotted = await app.inject({ method: 'GET', url: '/ext/demo/ui/%2e%2e/secret.txt' });
    expect([403, 404]).toContain(dotted.statusCode);
    expect(dotted.body).not.toContain('top-secret-outside-ui-root');
  });

  it('5. index.html 目录根回退：/ext/demo/ui/ → 200 index.html 内容（/admin 302 落点语义）', async () => {
    const withSlash = await app.inject({ method: 'GET', url: '/ext/demo/ui/' });
    // index: 'index.html'——目录根回退 index.html（mount:'ui' 的 /admin 302 落点
    // 即 /ext/{id}/ui/ 前缀根，必须可达）；无 index.html 的目录照常 404
    expect(withSlash.statusCode).toBe(200);
    expect(withSlash.body).toBe('<h1>demo-ui</h1>');

    const withoutSlash = await app.inject({ method: 'GET', url: '/ext/demo/ui' });
    expect(withoutSlash.statusCode).toBe(404); // 无尾斜杠不匹配前缀路由
  });

  it('6. 子目录资产可达：/ext/demo/ui/sub/app.js → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/demo/ui/sub/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("demo");');
  });

  it('7. 多扩展并存（decorateReply:false 多实例）：other 扩展同样可服务', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/other/ui/other.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<p>other-ui</p>');
  });

  it('8. 不设长缓存头：cache-control 无 immutable / 长 max-age（长缓存交给反代）', async () => {
    const res = await app.inject({ method: 'GET', url: '/ext/demo/ui/index.html' });
    const cacheControl = String(res.headers['cache-control'] ?? '');
    expect(cacheControl).not.toContain('immutable');
    expect(cacheControl).not.toContain('max-age=31536000');
  });

  it('9. 入参校验：非法 extId → EXT_MANIFEST_INVALID；extId 重复 → EXT_ROUTE_CONFLICT', () => {
    const bad = Fastify({ logger: false });
    expect(() =>
      registerExtAssets(bad, [{ extId: 'a/b', uiRoot: join(tmpRoot, 'demo') }]),
    ).toThrowError(HarnessError);
    expect(() =>
      registerExtAssets(bad, [
        { extId: 'x', uiRoot: join(tmpRoot, 'demo') },
        { extId: 'x', uiRoot: join(tmpRoot, 'other') },
      ]),
    ).toThrowError(HarnessError);
  });
});
