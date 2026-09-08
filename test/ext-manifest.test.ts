import { describe, expect, it } from 'vitest';

import {
  EMPTY_CONTRIBUTIONS,
  validateContributions,
  type ExtensionContributions,
  type RouteContribution,
} from '../src/kernel/extensions/contributions.js';
import {
  checkApiCompat,
  extIdFromDir,
  manifestSchema,
  SUPPORTED_API_VERSIONS,
  validateManifest,
  validatePermissions,
  type ExtensionManifest,
} from '../src/kernel/extensions/manifest.js';
import { HarnessError } from '../src/kernel/errors/index.js';

/** 合法 manifest 基样例 */
function validManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: 'hello-world',
    api: 1,
    version: '1.2.3',
    main: 'index.js',
    permissions: ['http', 'storage'],
    provides: ['hello-world.greet'],
    requires: [],
    requiresOptional: [],
    routes: true,
    uninstall: 'keep',
    builtin: false,
    ...overrides,
  };
}

/** 合法贡献点基样例 */
function validContributions(): unknown {
  return {
    routes: [
      { method: 'GET', path: '/greet', auth: 'public', timeoutMs: 3000 },
      { method: 'POST', path: '/echo', auth: 'user', scope: 'echo:write' },
    ],
    crons: [{ name: 'tick', expr: '*/5 * * * *', overlap: 'skip', misfire: 'runOnce' }],
    events: [{ pattern: 'chat.message.created', priority: 10 }],
    hooks: [{ name: 'chat:beforeSend', priority: 0 }],
    services: [{ name: 'hello-world.greet', methods: ['greet', 'ping'] }],
  };
}

describe('validateManifest', () => {
  it('合法 manifest 原样通过并保留显式字段', () => {
    const m = validateManifest(JSON.parse(JSON.stringify(validManifest())));
    expect(m).toEqual(validManifest());
  });

  it('默认值落地：main=index.js、permissions/provides/requires/requiresOptional=[]、routes=true、uninstall=keep、builtin=false', () => {
    const m = validateManifest({ id: 'a', api: 1, version: '0.0.1' });
    expect(m.main).toBe('index.js');
    expect(m.permissions).toEqual([]);
    expect(m.provides).toEqual([]);
    expect(m.requires).toEqual([]);
    expect(m.requiresOptional).toEqual([]);
    expect(m.routes).toBe(true);
    expect(m.uninstall).toBe('keep');
    expect(m.builtin).toBe(false);
    expect(m.ui).toBeUndefined();
  });

  it('ui 贡献的嵌套默认值：pages/widgets/renderers 空数组', () => {
    const m = validateManifest({ id: 'a', api: 1, version: '0.0.1', ui: { menu: { label: 'Hi' } } });
    expect(m.ui).toEqual({ menu: { label: 'Hi' }, pages: [], widgets: [], renderers: [] });
  });

  it('非法 id 拒绝（大写/非法首字符/空格），合法 id（小写开头 + ._-）通过', () => {
    for (const id of ['Hello', 'hello world', '-abc', '.abc', 'abc!', '', 'ab/cd']) {
      const thrown = (() => {
        try {
          validateManifest({ id, api: 1, version: '1.0.0' });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(thrown, `id=${id}`).toBeInstanceOf(HarnessError);
      expect((thrown as HarnessError).code).toBe('HARNESS-3001');
    }
    expect(validateManifest({ id: 'a', api: 1, version: '1.0.0' }).id).toBe('a');
    expect(validateManifest({ id: 'a1-b.c_d', api: 1, version: '1.0.0' }).id).toBe('a1-b.c_d');
  });

  it('semver 错误拒绝：两段/纯文本/空串；带 v 前缀按 semver 规则放行', () => {
    for (const version of ['1.2', 'abc', '', '1.2.3.4']) {
      expect(() => validateManifest({ id: 'a', api: 1, version }), `version=${version}`).toThrowError(
        HarnessError,
      );
    }
    expect(validateManifest({ id: 'a', api: 1, version: '1.2.3' }).version).toBe('1.2.3');
    expect(validateManifest({ id: 'a', api: 1, version: 'v1.2.3' }).version).toBe('v1.2.3');
  });

  it('EXT_MANIFEST_INVALID 的 detail 携带 zod issues（可定位字段）', () => {
    try {
      validateManifest({ id: 'BAD', api: 1, version: 'nope' });
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he).toBeInstanceOf(HarnessError);
      expect(he.code).toBe('HARNESS-3001');
      expect(he.status).toBe(400);
      const issues = he.detail as { path: (string | number)[]; code?: string }[];
      expect(Array.isArray(issues)).toBe(true);
      const paths = issues.map((i) => i.path.join('.'));
      expect(paths).toContain('id');
      expect(paths).toContain('version');
    }
  });

  it('manifestSchema：api 非整数（1.5）在 schema 层拒绝', () => {
    expect(manifestSchema.safeParse({ id: 'a', api: 1.5, version: '1.0.0' }).success).toBe(false);
  });
});

describe('checkApiCompat', () => {
  it('SUPPORTED_API_VERSIONS 当前为 [1]；api=1 通过', () => {
    expect(SUPPORTED_API_VERSIONS).toEqual([1]);
    expect(() => checkApiCompat(validManifest({ api: 1 }))).not.toThrow();
  });

  it('api 不在支持列表（2 / 0 / -1）→ EXT_API_INCOMPATIBLE（HARNESS-3011 / 409）', () => {
    for (const api of [2, 0, -1]) {
      try {
        checkApiCompat(validManifest({ api }));
        expect.unreachable(`api=${api}`);
      } catch (e) {
        const he = e as HarnessError;
        expect(he).toBeInstanceOf(HarnessError);
        expect(he.code).toBe('HARNESS-3011');
        expect(he.status).toBe(409);
        expect(he.detail).toEqual({ manifestApi: api, supported: [1] });
      }
    }
  });
});

describe('validatePermissions', () => {
  it('全部白名单权限逐个通过（含 net:out 泛授权与 net:out:<domain>）', () => {
    const whitelist = [
      'http', 'events', 'hooks', 'cron', 'notify:send', 'notify:driver',
      'chat:write', 'chat:bridge', 'files:read', 'files:write', 'tasks',
      'sandbox', 'llm', 'storage', 'db', 'ui', 'net:out',
      // 跨扩展 RPC（P0-5）：全量与定向两种形状均在白名单
      'rpc:call', 'rpc:call:doc-demo', 'rpc:call:webui',
    ];
    expect(() => validatePermissions(validManifest({ permissions: whitelist }))).not.toThrow();
    expect(() => validatePermissions(validManifest({ permissions: ['net:out:api.example.com'] }))).not.toThrow();
    expect(() => validatePermissions(validManifest({ permissions: ['net:out:localhost'] }))).not.toThrow();
    expect(() => validatePermissions(validManifest({ permissions: [] }))).not.toThrow();
  });

  it('rpc:call 形状把关：rpc:call 与合法 rpc:call:<id> 通过；空/大写/非法字符 id 拒绝', () => {
    // 合法：<id> 段 ^[a-z0-9][a-z0-9._-]*$（与 manifest id 同规则）
    for (const ok of ['rpc:call', 'rpc:call:a', 'rpc:call:doc-demo', 'rpc:call:web.ui_x-1']) {
      expect(() => validatePermissions(validManifest({ permissions: [ok] })), ok).not.toThrow();
    }
    // 非法：目标段为空 / 首字符非法 / 含大写或其它符号
    for (const bad of ['rpc:call:', 'rpc:call:-x', 'rpc:call:.x', 'rpc:call:Doc', 'rpc:call:a/b', 'rpc:call:a b']) {
      expect(() => validatePermissions(validManifest({ permissions: [bad] })), bad).toThrowError(HarnessError);
    }
  });

  it('未知权限 → EXT_MANIFEST_INVALID，detail 列出全部未知项（一次说清）', () => {
    try {
      validatePermissions(validManifest({ permissions: ['http', 'fs:root', 'sudo', 'net:out'] }));
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he).toBeInstanceOf(HarnessError);
      expect(he.code).toBe('HARNESS-3001');
      const issue = (he.detail as { issues: { unknownPermissions: string[] }[] }).issues[0];
      expect(issue.unknownPermissions).toEqual(['fs:root', 'sudo']);
    }
  });

  it('net:out 变体形状把关：空域名/下划线/通配/尾点拒绝，合法域名通过', () => {
    for (const bad of ['net:out:', 'net:out:bad_domain', 'net:out:*', 'net:out:*.example.com', 'net:out:a..b', 'net:out:x.']) {
      expect(() => validatePermissions(validManifest({ permissions: [bad] })), bad).toThrowError(HarnessError);
    }
    for (const good of ['net:out:a', 'net:out:api.example.com', 'net:out:MY-API.Example.COM']) {
      expect(() => validatePermissions(validManifest({ permissions: [good] })), good).not.toThrow();
    }
  });
});

describe('extIdFromDir', () => {
  it('取目录名作为扩展 id，容忍结尾斜杠', () => {
    expect(extIdFromDir('/data/opptrix/extensions/hello-world')).toBe('hello-world');
    expect(extIdFromDir('/data/opptrix/extensions/hello-world/')).toBe('hello-world');
    expect(extIdFromDir('extensions/auth')).toBe('auth');
    expect(extIdFromDir('hello-world')).toBe('hello-world');
  });
});

describe('validateContributions', () => {
  it('合法贡献点全量通过并保留字段', () => {
    const c = validateContributions(validContributions(), 100);
    expect(c.routes).toHaveLength(2);
    expect(c.routes[0]).toEqual({ method: 'GET', path: '/greet', auth: 'public', timeoutMs: 3000 });
    expect(c.crons[0]?.name).toBe('tick');
    expect(c.events[0]?.pattern).toBe('chat.message.created');
    expect(c.hooks[0]?.name).toBe('chat:beforeSend');
    expect(c.services[0]).toEqual({ name: 'hello-world.greet', methods: ['greet', 'ping'] });
  });

  it('空对象/缺省键 → 各贡献点默认空数组（含 ui 空段）', () => {
    expect(validateContributions({}, 10)).toEqual({
      routes: [], crons: [], events: [], hooks: [], services: [],
      ui: { menu: [], pages: [], widgets: [], renderers: [] },
    });
  });

  it('ui 段透传：worker 线格式（menu 数组 + pages）经校验保留，形状非法 → EXT_MANIFEST_INVALID', () => {
    const parsed = validateContributions(
      { ui: { menu: [{ label: 'Console' }], pages: [{ path: '/', title: 'T', entry: 'index.html' }] } },
      10,
    );
    expect(parsed.ui).toEqual({
      menu: [{ label: 'Console' }],
      pages: [{ path: '/', title: 'T', entry: 'index.html' }],
      widgets: [],
      renderers: [],
    });
    // menu 非数组（worker 线格式恒数组）→ 形状非法
    expect(() =>
      validateContributions({ ui: { menu: { label: 'X' } } } as unknown, 10),
    ).toThrowError(HarnessError);
  });

  it('路由数超上限 → EXT_ROUTE_LIMIT（HARNESS-3007 / 400）', () => {
    const routes = Array.from({ length: 6 }, (_, i) => ({ method: 'GET' as const, path: `/r${i}` }));
    try {
      validateContributions({ routes }, 5);
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he).toBeInstanceOf(HarnessError);
      expect(he.code).toBe('HARNESS-3007');
      expect(he.status).toBe(400);
      expect(he.detail).toEqual({ routes: 6, maxRoutes: 5 });
    }
    // 恰好等于上限放行
    expect(() => validateContributions({ routes }, 6)).not.toThrow();
  });

  it('同扩展内重复 method+path → EXT_ROUTE_CONFLICT（HARNESS-3008），不同 method 不算冲突', () => {
    try {
      validateContributions(
        { routes: [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/a' }] },
        10,
      );
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he.code).toBe('HARNESS-3008');
      expect(he.detail).toEqual({
        method: 'GET', path: '/a', duplicateOf: { method: 'GET', path: '/a' },
      });
    }
    expect(() =>
      validateContributions({ routes: [{ method: 'GET', path: '/a' }, { method: 'POST', path: '/a' }] }, 10),
    ).not.toThrow();
  });

  it('归一化后判定冲突：折叠重复斜杠、去结尾斜杠（根路径除外）', () => {
    expect(() =>
      validateContributions({ routes: [{ method: 'GET', path: '/a/b' }, { method: 'GET', path: '//a/b//' }] }, 10),
    ).toThrowError(HarnessError);
    expect(() =>
      validateContributions({ routes: [{ method: 'GET', path: '/' }, { method: 'GET', path: '//' }] }, 10),
    ).toThrowError(HarnessError);
  });

  it("路径不以 '/' 开头 → 拒绝（EXT_MANIFEST_INVALID，issue 指向具体路由）", () => {
    try {
      validateContributions({ routes: [{ method: 'GET', path: 'greet' }] }, 10);
      expect.unreachable();
    } catch (e) {
      const he = e as HarnessError;
      expect(he.code).toBe('HARNESS-3001');
      const issues = he.detail as { path: (string | number)[]; message: string }[];
      expect(issues.some((i) => i.path.join('.') === 'routes.0.path' && i.message.includes('"/"'))).toBe(true);
    }
  });

  it('形状损坏拒绝：未知 method、非法 auth/overlap/misfire、timeoutMs 非正整数、name 空串', () => {
    const cases: unknown[] = [
      { routes: [{ method: 'GETX', path: '/a' }] },
      { routes: [{ method: 'GET', path: '/a', auth: 'root' }] },
      { routes: [{ method: 'GET', path: '/a', timeoutMs: -1 }] },
      { crons: [{ name: '', expr: '* * * * *' }] },
      { crons: [{ name: 't', expr: '* * * * *', overlap: 'cancel' }] },
      { crons: [{ name: 't', expr: '* * * * *', misfire: 'spam' }] },
      { events: [{ pattern: '' }] },
      { hooks: [{ name: 'h', priority: 1.5 }] },
      { services: [{ name: 'svc', methods: ['ok', ''] }] },
      'not-an-object',
    ];
    for (const bad of cases) {
      expect(() => validateContributions(bad, 10), JSON.stringify(bad)).toThrowError(HarnessError);
    }
  });

  it('首个冲突即报（报出重复对与原路由），上限检查先于冲突检查', () => {
    // 超限 + 冲突同时存在时，路由上限优先
    const routes = [
      { method: 'GET' as const, path: '/a' },
      { method: 'GET' as const, path: '/a' },
      { method: 'GET' as const, path: '/b' },
    ];
    expect(() => validateContributions({ routes }, 2)).toThrowError(/route limit/i);
  });
});

describe('EMPTY_CONTRIBUTIONS', () => {
  it('五类贡献点 + ui 段均为空数组，且实例被冻结（防共享实例被误改）', () => {
    const c: ExtensionContributions = EMPTY_CONTRIBUTIONS;
    expect(c).toEqual({
      routes: [], crons: [], events: [], hooks: [], services: [],
      ui: { menu: [], pages: [], widgets: [], renderers: [] },
    });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.routes)).toBe(true);
    expect(Object.isFrozen(c.ui)).toBe(true);
    expect(() => (c.routes as RouteContribution[]).push({ method: 'GET', path: '/x' })).toThrowError();
  });
});
