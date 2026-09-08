/**
 * sandbox REST API 集成测试（真实 fastify 注入 + stub manager）。
 *
 * - 覆盖：无 token 401、normal 角色 403、manager 未启用 409 SANDBOX_DISABLED（错误透传）、
 *   工作区 CRUD（创建 201 / 列表 / 删除 + 404）、exec 透传（cmd/timeoutMs/isolated/workdir/env）
 *   与结果 JSON、文件写读列（query path 解码、缺 path 400、非法 body 400）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerSandboxRoutes } from '../src/api/sandbox.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';
import type { SandboxManager } from '../src/kernel/sandbox/manager.js';
import type { SandboxExecResult, WorkspaceInfo } from '../src/kernel/sandbox/types.js';

const logger = pino({ level: 'silent' });

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';

const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

/** 统一认证入口（与 authProxy.createAuthChecker 语义一致的测试替身） */
const checker = async ({ token }: { token?: string }): Promise<{ role: string } & Record<string, unknown>> => {
  if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: ['sandbox'] };
  if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
  if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
  throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
};

const WS: WorkspaceInfo = {
  id: 'ws-1',
  containerId: 'cid-1',
  image: 'test-sandbox:latest',
  status: 'running',
  homeDir: '/data/sandbox/ws-1',
  createdAt: 1000,
  lastActiveAt: 2000,
};
const EXEC_RESULT: SandboxExecResult = { exitCode: 0, stdout: 'hello\n', stderr: '', timedOut: false, durationMs: 12 };

/** stub manager：逐方法 vi.fn 记录调用；enabled=false 时方法体抛 SANDBOX_DISABLED（同真 manager 语义） */
function makeStub(enabled: boolean) {
  const guard = (): void => {
    if (!enabled) throw err('SANDBOX_DISABLED');
  };
  return {
    enabled: vi.fn(() => enabled),
    list: vi.fn(() => {
      guard();
      return [WS];
    }),
    createWorkspace: vi.fn(async (input: { id?: string; image?: string }) => {
      guard();
      return { ...WS, id: input.id ?? 'uuid-generated', image: input.image ?? WS.image };
    }),
    removeWorkspace: vi.fn(async () => {
      guard();
      return true;
    }),
    exec: vi.fn(async () => {
      guard();
      return { ...EXEC_RESULT };
    }),
    writeFile: vi.fn(async () => {
      guard();
    }),
    readFile: vi.fn(async () => {
      guard();
      return 'aGk=';
    }),
    listFiles: vi.fn(async () => {
      guard();
      return [{ name: 'a.txt', size: 3, dir: false }];
    }),
  };
}

type Stub = ReturnType<typeof makeStub>;

let dir: string;
let app: FastifyInstance;
let stub: Stub;
let disabledApp: FastifyInstance;
let disabledStub: Stub;

/** 组装被测服务器（真实 createHttpServer → HarnessError 全局映射按 status 下发） */
function buildApp(manager: SandboxManager): FastifyInstance {
  const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: dir });
  const { app: built } = createHttpServer({
    config,
    logger,
    isReady: () => true,
    state: () => 'ready',
    registerExtra: (a) => {
      registerSandboxRoutes(a, { checker, manager });
    },
  });
  return built;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-sandbox-api-'));
  stub = makeStub(true);
  app = buildApp(stub as unknown as SandboxManager);
  disabledStub = makeStub(false);
  disabledApp = buildApp(disabledStub as unknown as SandboxManager);
});

afterAll(async () => {
  await app.close();
  await disabledApp.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 鉴权与角色门禁
// ---------------------------------------------------------------------------

describe('sandbox api — 鉴权与角色门禁', () => {
  it.each([
    { method: 'GET', url: '/api/v1/sandbox/workspaces' },
    { method: 'POST', url: '/api/v1/sandbox/workspaces', payload: { id: 'ws-x' } },
    { method: 'DELETE', url: '/api/v1/sandbox/workspaces/ws-1' },
    { method: 'POST', url: '/api/v1/sandbox/workspaces/ws-1/exec', payload: { cmd: ['ls'] } },
    { method: 'PUT', url: '/api/v1/sandbox/workspaces/ws-1/files?path=a.txt', payload: { contentBase64: 'aGk=' } },
    { method: 'GET', url: '/api/v1/sandbox/workspaces/ws-1/files?path=a.txt' },
  ] as const)('$method $url 无 token → 401 HARNESS-1006', async (route) => {
    const res = await app.inject({ method: route.method, url: route.url, payload: 'payload' in route ? route.payload : undefined });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('HARNESS-1006');
  });

  it('normal 角色 → 403 HARNESS-1007（读与写一致收口 admin/root）', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/sandbox/workspaces', headers: AUTH_NORMAL });
    expect(list.statusCode).toBe(403);
    expect(list.json().code).toBe('HARNESS-1007');
    expect(list.json().message).toContain('admin or root');

    const exec = await app.inject({
      method: 'POST',
      url: '/api/v1/sandbox/workspaces/ws-1/exec',
      headers: AUTH_NORMAL,
      payload: { cmd: ['ls'] },
    });
    expect(exec.statusCode).toBe(403);
  });

  it('admin/root 均可访问（root 创建 → 201）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sandbox/workspaces',
      headers: AUTH_ROOT,
      payload: { id: 'ws-root', image: 'alpine:3.20' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: 'ws-root', image: 'alpine:3.20', status: 'running' });
    expect(stub.createWorkspace).toHaveBeenCalledWith({ id: 'ws-root', image: 'alpine:3.20' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/sandbox/workspaces', headers: AUTH_ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([WS]);
    expect(stub.list).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 未启用 → 409 SANDBOX_DISABLED（错误透传）
// ---------------------------------------------------------------------------

describe('sandbox api — 未启用 409 透传', () => {
  it.each([
    { method: 'GET', url: '/api/v1/sandbox/workspaces' },
    { method: 'POST', url: '/api/v1/sandbox/workspaces', payload: {} },
    { method: 'DELETE', url: '/api/v1/sandbox/workspaces/ws-1' },
    { method: 'POST', url: '/api/v1/sandbox/workspaces/ws-1/exec', payload: { cmd: ['ls'] } },
    { method: 'PUT', url: '/api/v1/sandbox/workspaces/ws-1/files?path=a.txt', payload: { contentBase64: 'aGk=' } },
    { method: 'GET', url: '/api/v1/sandbox/workspaces/ws-1/files?path=a.txt' },
    { method: 'GET', url: '/api/v1/sandbox/workspaces/ws-1/files?list=1' },
  ] as const)('$method $url 未启用 → 409 HARNESS-6001', async (route) => {
    const res = await disabledApp.inject({
      method: route.method,
      url: route.url,
      headers: AUTH_ADMIN,
      payload: 'payload' in route ? route.payload : undefined,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('HARNESS-6001');
  });
});

// ---------------------------------------------------------------------------
// CRUD + exec + 文件透传
// ---------------------------------------------------------------------------

describe('sandbox api — 工作区 CRUD / exec / 文件', () => {
  it('POST 校验：id 穿越形态 / 未知字段体 → 400 HARNESS-1009；缺 body 亦可创建（全缺省）', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/sandbox/workspaces',
      headers: AUTH_ADMIN,
      payload: { id: '../evil' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('HARNESS-1009');

    const ok = await app.inject({ method: 'POST', url: '/api/v1/sandbox/workspaces', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().id).toBe('uuid-generated');
    expect(stub.createWorkspace).toHaveBeenLastCalledWith({});
  });

  it('DELETE 已知 → { deleted: true }；未知（manager false）→ 404 HARNESS-6004', async () => {
    const ok = await app.inject({ method: 'DELETE', url: '/api/v1/sandbox/workspaces/ws-1', headers: AUTH_ADMIN });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ deleted: true });
    expect(stub.removeWorkspace).toHaveBeenCalledWith('ws-1', {});

    stub.removeWorkspace.mockResolvedValueOnce(false);
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/sandbox/workspaces/ghost', headers: AUTH_ADMIN });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('HARNESS-6004');
  });

  it('POST exec：body 字段透传（cmd/timeoutMs/workdir/env/isolated）+ 结果 JSON 原样返回', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sandbox/workspaces/ws-1/exec',
      headers: AUTH_ADMIN,
      payload: { cmd: ['echo', 'hi'], timeoutMs: 5000, workdir: '/tmp', env: { FOO: 'bar' }, isolated: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(EXEC_RESULT);
    expect(stub.exec).toHaveBeenCalledWith('ws-1', ['echo', 'hi'], {
      timeoutMs: 5000,
      workdir: '/tmp',
      env: { FOO: 'bar' },
      isolated: true,
    });
  });

  it('POST exec 校验：空 cmd / cmd 非字符串数组 → 400 HARNESS-1009', async () => {
    for (const payload of [{ cmd: [] }, { cmd: ['ls', 1] }, {}]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/sandbox/workspaces/ws-1/exec',
        headers: AUTH_ADMIN,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('HARNESS-1009');
    }
  });

  it('PUT files：query.path 解码后透传（含子目录），contentBase64 透传 → { ok: true, path }', async () => {
    const url = `/api/v1/sandbox/workspaces/ws-1/files?path=${encodeURIComponent('sub/a.txt')}`;
    const res = await app.inject({
      method: 'PUT',
      url,
      headers: AUTH_ADMIN,
      payload: { contentBase64: 'aGk=' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, path: 'sub/a.txt' });
    expect(stub.writeFile).toHaveBeenCalledWith('ws-1', 'sub/a.txt', 'aGk=');
  });

  it('GET files：读 → { path, contentBase64 }；?list=1 → 列表；缺 path → 400；缺 body（PUT）→ 400', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/sandbox/workspaces/ws-1/files?path=${encodeURIComponent('a b.txt')}`,
      headers: AUTH_ADMIN,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ path: 'a b.txt', contentBase64: 'aGk=' });
    expect(stub.readFile).toHaveBeenCalledWith('ws-1', 'a b.txt');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/sandbox/workspaces/ws-1/files?list=1',
      headers: AUTH_ADMIN,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([{ name: 'a.txt', size: 3, dir: false }]);
    expect(stub.listFiles).toHaveBeenCalledWith('ws-1', '.'); // list 缺 path 默认家目录根

    const noPath = await app.inject({ method: 'GET', url: '/api/v1/sandbox/workspaces/ws-1/files', headers: AUTH_ADMIN });
    expect(noPath.statusCode).toBe(400);
    expect(noPath.json().code).toBe('HARNESS-1009');

    const noBody = await app.inject({
      method: 'PUT',
      url: '/api/v1/sandbox/workspaces/ws-1/files?path=a.txt',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(noBody.statusCode).toBe(400);
    expect(noBody.json().code).toBe('HARNESS-1009');
  });
});
