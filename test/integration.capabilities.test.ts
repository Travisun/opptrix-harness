/**
 * 三域能力接线 E2E（真实 Kernel + 真实 createHttpServer + 真库 + 临时 dataDir）。
 *
 * 覆盖 memory（记忆系统）/ asr（语音识别）/ fileextract（文件提取）接入运行内核后的
 * 完整链路：
 * - REST：POST /api/v1/extract（multipart 直提 + fileId 引用 + 落库）、/api/v1/memory*
 *   （add/search/list/forget/settings 门禁与持久化）、/api/v1/asr/*（status/ensure，
 *   模型经本地 mock HF 源真实下载——不触外网）、/api/v1/tasks/dispatch（'file-extract'
 *   内置任务名走线程池管线）；
 * - 扩展桥（容器 'ext.bridges' → kernel-handlers extraBridges 懒合并）：memory.* / asr.* /
 *   extract.* 的权限闸（manifest 'memory' / 'asr' / 'files:read'）与正向调用；
 * - 全旅程串联：上传 → 提取 → 记忆入库 → 检索命中 → 遗忘。
 *
 * root 令牌从 kernel.container.resolve('auth.identity') 取（HARNESS_PERSIST_ROOT_TOKEN='0'）；
 * HTTP 交互经 fastify.inject；桥交互直接调容器 'ext.bridges' handler 表（与 worker→kernel
 * 网关的分发同源——createKernelHandlers 的 extraBridges Proxy 即查该表）。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { CONTAINER_KEYS, Kernel } from '../src/kernel/Kernel.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { MEMORY_SETTINGS_KEY } from '../src/kernel/memory/index.js';
import { SYSTEM_TOOLS_CONTAINER_KEY } from '../src/kernel/mcp/system-tools.js';
import type { HarnessError } from '../src/kernel/errors/index.js';

// ---------------------------------------------------------------------------
// 环境：真实 Kernel（临时 dataDir、端口 0 = 系统分配、静音日志、单工作线程）
// ---------------------------------------------------------------------------

let dataDir = '';
let kernel: Kernel;
let app: FastifyInstance;
let rootToken = '';
let base = '';
let mockHf: Server = undefined as unknown as Server;
let mockHfUrl = '';
const savedEnv: Record<string, string | undefined> = {};

const auth = { authorization: '' }; // beforeAll 中填充

/** ASR 必需模型文件（与 downloader REQUIRED_MODEL_FILES 同清单；内容任意非 HTML 字节） */
const MOCK_ASR_MODEL_FILES: Record<string, string> = {
  'config.json': '{"model_type":"whisper"}',
  'preprocessor_config.json': '{}',
  'tokenizer.json': '{}',
  'tokenizer_config.json': '{}',
  'onnx/encoder_model_quantized.onnx': 'mock-encoder-bytes',
  'onnx/decoder_model_merged_quantized.onnx': 'mock-decoder-bytes',
};

beforeAll(async () => {
  // 本地 mock HF 源：ASR 模型下载器经 HARNESS_HF_DIRECT 指向它，确保 ensure→ready
  // 全链路真实执行（镜像链/原子写/FileCache 布局）而无需外网
  mockHf = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const prefix = '/onnx-community/whisper-base/resolve/main/';
    if (url.pathname.startsWith(prefix)) {
      const rel = url.pathname.slice(prefix.length);
      const body = MOCK_ASR_MODEL_FILES[rel];
      if (body !== undefined) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => mockHf.listen(0, '127.0.0.1', resolve));
  const addr = mockHf.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  mockHfUrl = `http://127.0.0.1:${port}`;

  // 线程池/装配读 process.env（worker 共享进程环境）；先保存，afterAll 还原
  for (const key of [
    'HARNESS_ASR_AUTO_DOWNLOAD',
    'HARNESS_ASR_ENABLED',
    'HARNESS_HF_DIRECT',
    'HARNESS_HF_MIRROR',
    'HARNESS_MODELSCOPE_BASE',
    'HARNESS_OCR_AUTO_DOWNLOAD',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env['HARNESS_ASR_AUTO_DOWNLOAD'] = '0'; // 关 boot 期自动下载：status 从 not-downloaded 起步
  delete process.env['HARNESS_ASR_ENABLED'];
  // 镜像链三源全部指向本地 mock：必需文件首源命中，可选文件 404 快速跳过——
  // 任何真实外网主机（可能被防火墙黑洞挂起）都不触碰
  process.env['HARNESS_HF_DIRECT'] = mockHfUrl;
  process.env['HARNESS_HF_MIRROR'] = mockHfUrl;
  process.env['HARNESS_MODELSCOPE_BASE'] = mockHfUrl;
  delete process.env['HARNESS_OCR_AUTO_DOWNLOAD'];

  dataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-caps-e2e-'));
  // 脚手架一个声明了 files:read/memory/asr 权限的扩展（仅发现、不启用）：
  // 桥权限闸按 manifest 裁决，正向用例经它验证"已声明 → 放行"
  const extDir = path.join(dataDir, 'extensions', 'caps-demo');
  await mkdir(extDir, { recursive: true });
  await writeFile(
    path.join(extDir, 'manifest.json'),
    JSON.stringify({
      id: 'caps-demo',
      api: 1,
      version: '1.0.0',
      main: 'index.js',
      displayName: 'Caps Demo',
      permissions: ['files:read', 'memory', 'asr'],
    }),
    'utf8',
  );
  await writeFile(path.join(extDir, 'index.js'), 'module.exports = {};\n', 'utf8');

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

  rootToken = kernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
  auth.authorization = `Bearer ${rootToken}`;
  app = kernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;

  const httpAddr = app.server.address();
  const httpPort = typeof httpAddr === 'object' && httpAddr !== null ? httpAddr.port : 0;
  base = `http://127.0.0.1:${httpPort}`;
});

afterAll(async () => {
  await kernel?.shutdown('e2e-afterall'); // 幂等：测试内已 shutdown 时直接返回
  await new Promise<void>((resolve) => mockHf?.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dataDir !== '') await rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 轮询直到 pred 成立或超时（毫秒） */
async function waitFor(what: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 手工构造 multipart/form-data 请求体（field 名固定 'file'，与 @fastify/multipart 对齐） */
function multipartBody(filename: string, mime: string, content: Buffer): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----opptrixcapse2eboundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), content, Buffer.from(tail, 'utf8')]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** 容器 'ext.bridges' 桥表（createKernelHandlers extraBridges 的懒解析源，同源分发） */
function bridges(): Record<string, (payload: unknown, from: string) => Promise<unknown>> {
  return kernel.container.resolve(CONTAINER_KEYS.extBridges);
}

/** 捕获桥调用抛出的 HarnessError（供错误码断言） */
async function bridgeError(fn: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await fn();
  } catch (e) {
    return e as HarnessError;
  }
  throw new Error('expected bridge call to throw');
}

// ---------------------------------------------------------------------------
// 装配冒烟 + 文件提取
// ---------------------------------------------------------------------------

describe('三域能力接线 E2E', () => {
  it('boot 后三域服务登记进容器（memory.manager / asr.manager / fileextract.service），extract status 暴露 OCR 模型状态', async () => {
    for (const key of [CONTAINER_KEYS.memoryManager, CONTAINER_KEYS.asrManager, CONTAINER_KEYS.fileExtract]) {
      expect(kernel.container.has(key)).toBe(true);
      expect(kernel.container.resolve(key)).toBeDefined();
    }
    const res = await app.inject({ method: 'GET', url: '/api/v1/extract/status', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; modelDir: string; autoDownload: boolean; missingFiles: string[] };
    expect(body.state).toBe('not-downloaded');
    expect(body.autoDownload).toBe(false);
    expect(body.modelDir).toBe(path.join(dataDir, 'models', 'ocr'));
    expect(body.missingFiles.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/extract（multipart .txt 直提）→ 200 text 正确（engine=text）', async () => {
    const content = '# 会议纪要\n\nOpptrix Harness 的提取管线工作正常。';
    const { payload, headers } = multipartBody('meeting.txt', 'text/plain', Buffer.from(content, 'utf8'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/extract', headers: { ...auth, ...headers }, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fileExt: string; engine: string; text: string; charCount: number; truncated: boolean; ocrUsed: boolean };
    expect(body.fileExt).toBe('.txt');
    expect(body.engine).toBe('text');
    expect(body.text).toContain('提取管线工作正常');
    expect(body.charCount).toBe(body.text.length);
    expect(body.truncated).toBe(false);
    expect(body.ocrUsed).toBe(false);
  });

  it('files 上传 → POST /api/v1/extract/file/:id 提取落库（file_extracts）→ service.getStored 可读回', async () => {
    // 1) files REST 上传
    const content = 'hello from files api — this line must survive extraction.';
    const { payload, headers } = multipartBody('note.txt', 'text/plain', Buffer.from(content, 'utf8'));
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...auth, ...headers }, payload });
    expect(upload.statusCode).toBe(201);
    const file = upload.json() as { id: string; origName: string };
    expect(file.origName).toBe('note.txt');

    // 2) 按 fileId 提取并持久化
    const res = await app.inject({ method: 'POST', url: `/api/v1/extract/file/${file.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { fileId: string; text: string; stored: boolean; engine: string };
    expect(body.fileId).toBe(file.id);
    expect(body.stored).toBe(true);
    expect(body.text).toContain('must survive extraction');

    // 3) 落库读回（files REST 无提取结果关联读取端点——LLM files_read 关联走内核
    //    service.getStored/file_extracts 表，这里直接对服务断言落库事实）
    const stored = await kernel.container
      .resolve<{ getStored(id: string): Promise<{ text: string } | null> }>(CONTAINER_KEYS.fileExtract)
      .getStored(file.id);
    expect(stored).not.toBeNull();
    expect(stored?.text).toContain('must survive extraction');

    // 4) query fileId 引用路径（POST /api/v1/extract?fileId=）
    const byRef = await app.inject({ method: 'POST', url: `/api/v1/extract?fileId=${file.id}`, headers: auth });
    expect(byRef.statusCode).toBe(200);
    expect((byRef.json() as { text: string }).text).toContain('must survive extraction');
  });

  // -------------------------------------------------------------------------
  // memory — 记忆系统 REST
  // -------------------------------------------------------------------------

  it('memory REST：POST 201 → 精确去重 deduped=true → search 命中 → list → DELETE → 再删 404', async () => {
    const content = '用户部署在 Kubernetes 1.30 集群';
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/memory',
      headers: auth,
      payload: { content, kind: 'fact', tags: ['k8s'] },
    });
    expect(created.statusCode).toBe(201);
    const { record, deduped } = created.json() as { record: { id: string; content: string; source: string }; deduped: boolean };
    expect(deduped).toBe(false);
    expect(record.content).toBe(content);
    expect(record.source).toBe('manual');

    // 精确重写 → 去重命中，不重复插入
    const again = await app.inject({ method: 'POST', url: '/api/v1/memory', headers: auth, payload: { content } });
    expect(again.statusCode).toBe(201);
    expect((again.json() as { deduped: boolean }).deduped).toBe(true);

    // FTS 检索命中 + 命中回写
    const search = await app.inject({ method: 'GET', url: '/api/v1/memory/search?q=Kubernetes', headers: auth });
    expect(search.statusCode).toBe(200);
    const searchBody = search.json() as { items: Array<{ id: string; content: string }>; enabled: boolean };
    expect(searchBody.enabled).toBe(true);
    expect(searchBody.items.some((m) => m.id === record.id)).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/memory', headers: auth });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/memory/${record.id}`, headers: auth });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, removed: true });
    const delAgain = await app.inject({ method: 'DELETE', url: `/api/v1/memory/${record.id}`, headers: auth });
    expect(delAgain.statusCode).toBe(404);
  });

  it('memory.settings GET/PUT 持久化：PUT 落 settings 表 + 联动 manager 容量；enabled=false 时 search 被门禁', async () => {
    const settings = kernel.container.resolve<{ get<T>(key: string, fallback?: T): Promise<T | undefined> }>(
      CONTAINER_KEYS.settings,
    );

    const get0 = await app.inject({ method: 'GET', url: '/api/v1/memory/settings', headers: auth });
    expect(get0.statusCode).toBe(200);
    expect(get0.json()).toEqual({ enabled: true, maxMemories: 10_000, autoExtract: true });

    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/memory/settings',
      headers: auth,
      payload: { enabled: false, maxMemories: 555, autoExtract: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ enabled: false, maxMemories: 555, autoExtract: false });

    // 持久化（settings 'memory.settings'）+ manager 容量联动
    expect(await settings.get<unknown>(MEMORY_SETTINGS_KEY)).toEqual({ enabled: false, maxMemories: 555, autoExtract: false });
    const manager = kernel.container.resolve<{ capacity: number }>(CONTAINER_KEYS.memoryManager);
    expect(manager.capacity).toBe(555);

    // enabled=false → REST 门禁（search 返回空 + disabled 标记；manager 直连不受影响）
    const gated = await app.inject({ method: 'GET', url: '/api/v1/memory/search?q=anything', headers: auth });
    expect(gated.statusCode).toBe(200);
    expect(gated.json()).toEqual({ items: [], query: 'anything', enabled: false, disabled: true });

    // 还原：重新开启（后续用例依赖可用状态）
    const restore = await app.inject({
      method: 'PUT',
      url: '/api/v1/memory/settings',
      headers: auth,
      payload: { enabled: true, maxMemories: 10_000, autoExtract: true },
    });
    expect(restore.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // asr — 语音识别 REST（模型经本地 mock HF 源真实下载）
  // -------------------------------------------------------------------------

  it('asr REST：GET status → not-downloaded；POST ensure → 202；后台下载完成后 status → ready', async () => {
    const status0 = await app.inject({ method: 'GET', url: '/api/v1/asr/status', headers: auth });
    expect(status0.statusCode).toBe(200);
    const snap0 = status0.json() as { state: string; enabled: boolean; modelId: string };
    expect(snap0.state).toBe('not-downloaded');
    expect(snap0.enabled).toBe(true);
    expect(snap0.modelId).toBe('onnx-community/whisper-base');

    const ensure = await app.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers: auth });
    expect(ensure.statusCode).toBe(202);
    const snap1 = ensure.json() as { state: string };
    expect(['downloading', 'ready']).toContain(snap1.state);

    await waitFor('asr model ready', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/asr/status', headers: auth });
      return (res.json() as { state: string }).state === 'ready';
    }, 20_000);
    const status2 = await app.inject({ method: 'GET', url: '/api/v1/asr/status', headers: auth });
    expect((status2.json() as { state: string }).state).toBe('ready');
  }, 30_000);

  // -------------------------------------------------------------------------
  // 扩展桥（kernel-handlers extraBridges 懒合并表；'ext:caps-demo' 已声明三权限）
  // -------------------------------------------------------------------------

  it('extract 桥：无 files:read 的扩展调 extractFile → FORBIDDEN；已声明扩展正向提取；kernel 端点拒入', async () => {
    // 先准备一个已上传文件
    const { payload, headers } = multipartBody('bridge.txt', 'text/plain', Buffer.from('bridge extraction works', 'utf8'));
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...auth, ...headers }, payload });
    const file = upload.json() as { id: string };

    // 未声明 'files:read' 的扩展（未发现的 extId → manifest 权限为空）→ FORBIDDEN（HARNESS-1007）
    const denied = await bridgeError(() => bridges()['extract.file']({ fileId: file.id }, 'ext:ghost-ext'));
    expect(denied.code).toBe('HARNESS-1007');
    expect(denied.message).toContain('files:read');

    // 非扩展端点（kernel）→ RPC_PERMISSION_DENIED（HARNESS-2003）
    const kernelCall = await bridgeError(() => bridges()['extract.file']({ fileId: file.id }, 'kernel'));
    expect(kernelCall.code).toBe('HARNESS-2003');

    // 已声明扩展：正向提取（返回 ≤32KB 文本 + 落库元数据）
    const ok = (await bridges()['extract.file']({ fileId: file.id }, 'ext:caps-demo')) as {
      fileId: string;
      engine: string;
      charCount: number;
      truncated: boolean;
      text: string;
    };
    expect(ok.fileId).toBe(file.id);
    expect(ok.engine).toBe('text');
    expect(ok.text).toContain('bridge extraction works');
    expect(ok.truncated).toBe(false);

    // extract.status 桥（同 'files:read' 权限收口）
    const status = (await bridges()['extract.status']({}, 'ext:caps-demo')) as { state: string };
    expect(['not-downloaded', 'downloading', 'downloaded', 'error']).toContain(status.state);
  });

  it('memory 桥：已声明 memory 权限的扩展 add/search/list/forget 全链路可用；未声明的扩展 FORBIDDEN', async () => {
    const denied = await bridgeError(() => bridges()['memory.add']({ content: 'ghost write' }, 'ext:ghost-ext'));
    expect(denied.code).toBe('HARNESS-1007');
    expect(denied.message).toContain('memory');

    const added = (await bridges()['memory.add'](
      { content: '扩展写入的记忆：Opptrix 文档站用 Mintlify 构建', kind: 'fact', tags: ['docs'] },
      'ext:caps-demo',
    )) as { record: { id: string; source: string }; deduped: boolean };
    expect(added.deduped).toBe(false);
    expect(added.record.source).toBe('extension');

    const found = (await bridges()['memory.search']({ query: 'Mintlify' }, 'ext:caps-demo')) as {
      items: Array<{ id: string }>;
    };
    expect(found.items.some((m) => m.id === added.record.id)).toBe(true);

    const listed = (await bridges()['memory.list']({ limit: 100 }, 'ext:caps-demo')) as { items: Array<{ id: string }> };
    expect(listed.items.some((m) => m.id === added.record.id)).toBe(true);

    const forgotten = (await bridges()['memory.forget']({ id: added.record.id }, 'ext:caps-demo')) as { removed: boolean };
    expect(forgotten.removed).toBe(true);
  });

  it('asr 桥：已声明 asr 权限的扩展可读状态；未声明的扩展 FORBIDDEN', async () => {
    const denied = await bridgeError(() => bridges()['asr.status']({}, 'ext:ghost-ext'));
    expect(denied.code).toBe('HARNESS-1007');
    expect(denied.message).toContain('asr');

    // REST ensure 的后台下载（含可选文件跳过）可能仍在收尾：等 ready 再断言
    await waitFor('asr ready for bridge', async () => {
      const status = (await bridges()['asr.status']({}, 'ext:caps-demo')) as { state: string };
      return status.state === 'ready';
    }, 30_000);
    const status = (await bridges()['asr.status']({}, 'ext:caps-demo')) as { state: string; enabled: boolean };
    expect(status.state).toBe('ready');
    expect(status.enabled).toBe(true);
  }, 40_000);

  it('tasks dispatch：REST 放行内置 file-extract 任务名并走 TaskManager→线程池管线到终态', async () => {
    const args = {
      dataBase64: Buffer.from('task pipeline extract', 'utf8').toString('base64'),
      name: 'pipeline.txt',
      mime: 'text/plain',
    };
    const dispatch = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: auth,
      payload: { name: 'file-extract', args },
    });
    expect(dispatch.statusCode).toBe(201);
    const record = dispatch.json() as { id: string; name: string; status: string };
    expect(record.name).toBe('file-extract');

    // 终态轮询：编译态（dist）worker 内提取执行器可用 → done；
    // 源码态（vitest/tsx 原生类型剥离无法解析包内 .js 说明符）→ failed 回退主线程（装配约定）。
    // 两者都证明 dispatch → pool → worker → 回调落库管线贯通。
    let terminal: { status: string; error: string | null; result: unknown } | null = null;
    await waitFor('file-extract task terminal', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/tasks/${record.id}`, headers: auth });
      const body = res.json() as { status: string; error: string | null; result: unknown };
      if (body.status === 'done' || body.status === 'failed') {
        terminal = body;
        return true;
      }
      return false;
    }, 30_000);
    expect(['done', 'failed']).toContain(terminal?.status);

    // 未知任务名依旧 400（门禁文案保持 task type not registered）
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/dispatch',
      headers: auth,
      payload: { name: 'no-such-task' },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('task type not registered');
  });

  it('system MCP 工具 files_extract（/mcp 目录注入）：按 fileId 提取 → ok:true + text（与 REST 同一 service）', async () => {
    // 上传一个文件
    const { payload, headers } = multipartBody('tool.txt', 'text/plain', Buffer.from('extracted via system mcp tool', 'utf8'));
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...auth, ...headers }, payload });
    const file = upload.json() as { id: string };

    // SystemToolRuntime 已在 /mcp 接线时登记进容器（SYSTEM_TOOLS_CONTAINER_KEY）
    const runtime = kernel.container.resolve<{ call(name: string, args: unknown): Promise<Record<string, unknown>> }>(
      SYSTEM_TOOLS_CONTAINER_KEY,
    );
    const result = await runtime.call('files_extract', { fileId: file.id });
    expect(result['ok']).toBe(true);
    expect(result['fileId']).toBe(file.id);
    expect(result['engine']).toBe('text');
    expect(String(result['text'])).toContain('extracted via system mcp tool');

    // 未知 fileId → 结果对象（工具不抛）
    const missing = await runtime.call('files_extract', { fileId: 'nonexistent-file' });
    expect(missing['ok']).toBe(false);
  });

  it('全旅程串联：上传 txt → 提取 → 摘要写入记忆 → search 命中 → 遗忘', async () => {
    // 1) 上传
    const report = ['季度报告（Q3）', 'Opptrix Harness 完成三域能力接线：记忆、语音识别、文件提取。'].join('\n');
    const { payload, headers } = multipartBody('report.txt', 'text/plain', Buffer.from(report, 'utf8'));
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...auth, ...headers }, payload });
    expect(upload.statusCode).toBe(201);
    const file = upload.json() as { id: string };

    // 2) 提取（落库）
    const extract = await app.inject({ method: 'POST', url: `/api/v1/extract/file/${file.id}`, headers: auth });
    expect(extract.statusCode).toBe(200);
    const extracted = extract.json() as { text: string };
    expect(extracted.text).toContain('三域能力接线');

    // 3) 摘要写入记忆（REST）
    const summary = 'Q3 季度报告：Opptrix Harness 完成记忆/语音识别/文件提取三域能力接线';
    const added = await app.inject({ method: 'POST', url: '/api/v1/memory', headers: auth, payload: { content: summary, kind: 'event' } });
    expect(added.statusCode).toBe(201);
    const memoryId = (added.json() as { record: { id: string } }).record.id;

    // 4) 检索命中
    const search = await app.inject({ method: 'GET', url: `/api/v1/memory/search?q=${encodeURIComponent('三域能力接线')}`, headers: auth });
    expect(search.statusCode).toBe(200);
    expect(((search.json() as { items: Array<{ id: string }> }).items.some((m) => m.id === memoryId))).toBe(true);

    // 5) 遗忘收尾
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/memory/${memoryId}`, headers: auth });
    expect(del.statusCode).toBe(200);
    const stats = await app.inject({ method: 'GET', url: '/api/v1/memory/stats', headers: auth });
    expect(stats.statusCode).toBe(200);
    const statsBody = stats.json() as { count: number; byKind: Record<string, number> };
    expect(statsBody.count).toBe(statsBody.byKind['event'] ?? 0);
  });
});

// ---------------------------------------------------------------------------
// asr disabled 形态：HARNESS_ASR_ENABLED=false → status disabled（独立内核，轻量验证）
// ---------------------------------------------------------------------------

describe('三域能力接线 E2E — asr disabled', () => {
  it('HARNESS_ASR_ENABLED=false 时 GET /api/v1/asr/status → disabled，ensure → 503', async () => {
    const disabledDataDir = await mkdtemp(path.join(tmpdir(), 'opptrix-caps-e2e-asr-off-'));
    const prev = process.env['HARNESS_ASR_ENABLED'];
    process.env['HARNESS_ASR_ENABLED'] = 'false';
    let disabledKernel: Kernel | undefined;
    try {
      disabledKernel = new Kernel({
        config: {
          ...loadConfig({
            NODE_ENV: 'test',
            HARNESS_LOG_LEVEL: 'error',
            HARNESS_TASK_WORKERS: '1',
            HARNESS_DATA_DIR: disabledDataDir,
            HARNESS_PERSIST_ROOT_TOKEN: '0',
          }),
          port: 0,
        },
      });
      await disabledKernel.boot();
      const token = disabledKernel.container.resolve<{ token: string }>(CONTAINER_KEYS.authIdentity).token;
      const disabledApp = disabledKernel.container.resolve<{ app: FastifyInstance }>(CONTAINER_KEYS.http).app;
      const headers = { authorization: `Bearer ${token}` };

      const status = await disabledApp.inject({ method: 'GET', url: '/api/v1/asr/status', headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({
        state: 'disabled',
        modelId: 'onnx-community/whisper-base',
        enabled: false,
      });

      const ensure = await disabledApp.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers });
      expect(ensure.statusCode).toBe(503);
    } finally {
      process.env['HARNESS_ASR_ENABLED'] = prev;
      await disabledKernel?.shutdown('e2e-disabled-asr');
      await rm(disabledDataDir, { recursive: true, force: true });
    }
  });
});
