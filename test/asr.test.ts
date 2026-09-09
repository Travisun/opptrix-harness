/**
 * asr 测试（不下载真实模型——downloader 走 mock fetchImpl，engine 走注入的 mock pipelineFactory）。
 *
 * - downloader：镜像链换源（源 1 失败 → 源 2 成功）、HTML 投毒检测换源（content-type 与
 *   首段字节两路）、原子写（失败无 .part 残留、流中断无半截文件）、缓存命中短路、
 *   进度回调、必需/可选文件失败语义、模型 id 校验与 env 镜像覆盖；
 * - engine：懒加载单例、language 透传、空闲卸载、加载失败可重试；
 * - manager：状态机（not-downloaded→downloading→ready / error）、disabled 门禁、
 *   transcribe 委托与参数校验、ensureReady 单飞去重、init autoDownload；
 * - PCM 线格式：base64 往返与形状/上限校验；
 * - 扩展桥：asrStatus/asrTranscribe 权限闸（kernel 端点拒绝、manifest 'asr' 权限）；
 * - REST：鉴权与角色门禁矩阵、status、ensure 202、transcribe 形状校验
 *   （缺 samplesBase64 → 400、sampleRate 非 16k → 400）与 octet-stream 直传。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerAsrRoutes } from '../src/api/asr.js';
import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import {
  buildDownloadSources,
  createModelDownloader,
  DEFAULT_ASR_MODEL_ID,
  looksLikeHtmlBody,
  OPTIONAL_MODEL_FILES,
  REQUIRED_MODEL_FILES,
  safeModelSegments,
} from '../src/kernel/asr/downloader.js';
import { createAsrEngine, type AsrPipelineFactory } from '../src/kernel/asr/engine.js';
import {
  ASR_PERMISSION,
  createAsrBridge,
  decodePcmBase64,
  encodePcmBase64,
  EXPECTED_SAMPLE_RATE,
  float32FromBuffer,
  MAX_PCM_SAMPLES,
} from '../src/kernel/asr/index.js';
import { AsrManager } from '../src/kernel/asr/manager.js';
import type { AsrEnsureResult, AsrProgressEvent, AsrStatus } from '../src/kernel/asr/types.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { err } from '../src/kernel/errors/HarnessError.js';
import { createHttpServer } from '../src/kernel/http/server.js';

const logger = pino({ level: 'silent' });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opptrix-asr-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fetch mock 基建
// ---------------------------------------------------------------------------

/** 单源行为规则：按 match 命中第一条；无命中 → 404 */
interface SourceRule {
  match: (url: string) => boolean;
  status?: number;
  contentType?: string;
  body?: Buffer;
  /** 连接层失败（DNS/拒连等） */
  failWith?: Error;
  /** 首块写完后流中断（模拟半截下载） */
  streamError?: boolean;
}

function makeFetch(rules: SourceRule[]): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const rule = rules.find((r) => r.match(url));
    if (!rule) return new Response(null, { status: 404 });
    if (rule.failWith) throw rule.failWith;
    if (rule.status !== undefined && rule.status !== 200) return new Response(null, { status: rule.status });
    const body = rule.body ?? Buffer.from('model-bytes');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        if (rule.streamError) {
          controller.error(new Error('connection reset mid-download'));
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': rule.contentType ?? 'application/octet-stream' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const MODEL_ID = DEFAULT_ASR_MODEL_ID;
const hfUrl = (file: string): string => `https://huggingface.co/${MODEL_ID}/resolve/main/${file}?download=true`;
const mirrorUrl = (file: string): string => `https://hf-mirror.com/${MODEL_ID}/resolve/main/${file}?download=true`;
const msUrl = (file: string): string => `https://modelscope.cn/models/${MODEL_ID}/resolve/master/${file}`;

const OK: Omit<SourceRule, 'match'> = { status: 200 };
const onHf = (extra: Omit<SourceRule, 'match'>): SourceRule => ({ match: (u) => u.startsWith('https://huggingface.co/'), ...extra });
const onMirror = (extra: Omit<SourceRule, 'match'>): SourceRule => ({ match: (u) => u.startsWith('https://hf-mirror.com/'), ...extra });
const onMs = (extra: Omit<SourceRule, 'match'>): SourceRule => ({ match: (u) => u.startsWith('https://modelscope.cn/'), ...extra });

/** 预置缓存：直接写出全部清单文件（isCached 短路） */
function seedCache(modelDir: string, modelId = MODEL_ID): string {
  const modelPath = join(modelDir, ...modelId.split('/'));
  mkdirSync(join(modelPath, 'onnx'), { recursive: true });
  for (const file of [...REQUIRED_MODEL_FILES, ...OPTIONAL_MODEL_FILES]) {
    writeFileSync(join(modelPath, file), 'seeded');
  }
  return modelPath;
}

// ---------------------------------------------------------------------------
// downloader — 镜像优选链
// ---------------------------------------------------------------------------

describe('asr downloader — 镜像优选链', () => {
  it('全链健康：全部文件从 HF 直连下载落盘（result: huggingface / cached=false）', async () => {
    const { fetchImpl, urls } = makeFetch([onHf(OK), onMirror(OK), onMs(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();

    expect(result.source).toBe('huggingface');
    expect(result.cached).toBe(false);
    expect(result.dir).toBe(join(dir, 'onnx-community', 'whisper-base'));
    // 每个文件（6 必需 + 6 可选）的首个请求都落在 HF 直连
    expect(urls.filter((u) => u.startsWith('https://huggingface.co/')).length).toBe(
      REQUIRED_MODEL_FILES.length + OPTIONAL_MODEL_FILES.length,
    );
    for (const file of REQUIRED_MODEL_FILES) {
      expect(readFileSync(join(result.dir, file), 'utf8')).toBe('model-bytes');
    }
    expect(downloader.isCached()).toBe(true);
  });

  it('源 1 失败 → 自动换源 2（hf-mirror）：文件来自镜像且内容完整', async () => {
    const { fetchImpl, urls } = makeFetch([onHf({ status: 503 }), onMirror(OK), onMs(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();

    expect(result.source).toBe('hf-mirror');
    expect(urls.filter((u) => u.startsWith('https://hf-mirror.com/')).length).toBe(
      REQUIRED_MODEL_FILES.length + OPTIONAL_MODEL_FILES.length,
    );
    expect(readFileSync(join(result.dir, REQUIRED_MODEL_FILES[0]!), 'utf8')).toBe('model-bytes');
  });

  it('HTML 投毒检测（content-type text/html）逐文件换源；三源全投毒 → 必需文件聚合报错', async () => {
    const poisoned: Omit<SourceRule, 'match'> = {
      status: 200,
      contentType: 'text/html',
      body: Buffer.from('<!DOCTYPE html><html><body>login page</body></html>'),
    };
    const { fetchImpl } = makeFetch([onHf(poisoned), onMirror(poisoned), onMs(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();
    expect(result.source).toBe('modelscope');

    const allPoisoned = createModelDownloader({
      modelDir: join(dir, 'second'),
      logger,
      fetchImpl: makeFetch([onHf(poisoned), onMirror(poisoned), onMs(poisoned)]).fetchImpl,
      env: {},
    });
    await expect(allPoisoned.ensureModel()).rejects.toThrow(/config\.json/);
    await expect(allPoisoned.ensureModel()).rejects.toThrow(/huggingface[\s\S]*hf-mirror[\s\S]*modelscope/);
  });

  it('首段字节投毒（content-type 正常但 body 以 <html 开头）→ 换源', async () => {
    const { fetchImpl } = makeFetch([
      onHf({ status: 200, body: Buffer.from('<html><body>not a model</body></html>') }),
      onMirror(OK),
      onMs({ status: 500 }),
    ]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();
    expect(result.source).toBe('hf-mirror');
  });

  it('原子写：流中断不留半截目标文件、无 .part 残留；其余文件照常完成', async () => {
    const { fetchImpl, urls } = makeFetch([onHf({ status: 200, streamError: true }), onMirror(OK), onMs(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();

    // 目录树内无 .part 残留
    const allFiles: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else allFiles.push(p);
      }
    };
    walk(dir);
    expect(allFiles.some((f) => f.endsWith('.part'))).toBe(false);
    // 每个文件都经历了 HF（中断）→ 镜像（成功），最终内容完整
    expect(urls.filter((u) => u.startsWith('https://huggingface.co/')).length).toBeGreaterThan(0);
    expect(readFileSync(join(result.dir, REQUIRED_MODEL_FILES[0]!), 'utf8')).toBe('model-bytes');
  });

  it('缓存命中短路：必需文件齐全时不发任何请求（cached=true / source=cache）', async () => {
    const modelPath = seedCache(dir);
    const { fetchImpl, urls } = makeFetch([onHf(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();
    expect(result).toEqual({ dir: modelPath, source: 'cache', cached: true });
    expect(urls).toHaveLength(0);
  });

  it('进度回调：逐文件上报 {source, pct}，pct 单调递增至 100，source 为实际命中源', async () => {
    const { fetchImpl } = makeFetch([onHf({ status: 500 }), onMirror(OK), onMs(OK)]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const events: AsrProgressEvent[] = [];
    await downloader.ensureModel((event) => events.push({ ...event }));

    expect(events.length).toBe(REQUIRED_MODEL_FILES.length + OPTIONAL_MODEL_FILES.length);
    expect(events[0]).toMatchObject({ source: 'hf-mirror' });
    expect(events.at(-1)!.pct).toBe(100);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.pct).toBeGreaterThanOrEqual(events[i - 1]!.pct);
    }
  });

  it('可选文件三源全败只记 warn 不失败；必需文件不受牵连照常落盘', async () => {
    const optionalMiss = (u: string): boolean => u.includes('normalizer.json') || u.includes('merges.txt');
    const { fetchImpl } = makeFetch([
      onHf({ status: 500 }),
      { match: optionalMiss, status: 500 },
      onMirror(OK),
      onMs({ status: 500 }),
    ]);
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl, env: {} });
    const result = await downloader.ensureModel();
    expect(result.cached).toBe(false);
    expect(existsSync(join(result.dir, 'normalizer.json'))).toBe(false);
    expect(existsSync(join(result.dir, 'merges.txt'))).toBe(false);
    expect(existsSync(join(result.dir, 'config.json'))).toBe(true);
    expect(existsSync(join(result.dir, REQUIRED_MODEL_FILES[5]!))).toBe(true);
  });

  it('模型 id 校验：路径穿越/非法形态 fail-fast；安全 id 正常拆段', () => {
    expect(() => safeModelSegments('../evil/repo')).toThrow(/<org>\/<name>/);
    expect(() => safeModelSegments('onnx-community')).toThrow(/<org>\/<name>/);
    expect(() => safeModelSegments('a/b/c')).toThrow(/<org>\/<name>/);
    expect(safeModelSegments('onnx-community/whisper-tiny')).toEqual(['onnx-community', 'whisper-tiny']);
    expect(() => createModelDownloader({ modelDir: dir, logger, env: { HARNESS_ASR_MODEL: '..%2Fevil' } })).toThrow();
  });

  it('env 覆盖：HARNESS_ASR_MODEL 换 tiny、HARNESS_HF_MIRROR/HARNESS_MODELSCOPE_BASE 换镜像 base', async () => {
    const { fetchImpl, urls } = makeFetch([
      { match: (u) => u.startsWith('https://huggingface.co/'), status: 500 },
      { match: (u) => u.startsWith('https://my-mirror.internal/'), status: 200 },
      { match: (u) => u.startsWith('https://ms.internal/'), status: 200 },
    ]);
    const downloader = createModelDownloader({
      modelDir: dir,
      logger,
      fetchImpl,
      env: {
        HARNESS_ASR_MODEL: 'onnx-community/whisper-tiny',
        HARNESS_HF_MIRROR: 'https://my-mirror.internal',
        HARNESS_MODELSCOPE_BASE: 'https://ms.internal',
      },
    });
    expect(downloader.modelId).toBe('onnx-community/whisper-tiny');
    const result = await downloader.ensureModel();
    expect(result.source).toBe('hf-mirror');
    expect(urls[0]).toBe(hfUrl('config.json').replace(MODEL_ID, 'onnx-community/whisper-tiny'));
    expect(urls.some((u) => u.startsWith('https://my-mirror.internal/'))).toBe(true);
    // 源顺序契约：HF 直连 → hf-mirror → ModelScope；ModelScope URL 形态 resolve/master
    expect(buildDownloadSources('config.json', MODEL_ID, {
      hfDirect: 'https://huggingface.co',
      hfMirror: 'https://hf-mirror.com',
      modelScope: 'https://modelscope.cn',
    }).map((s) => s.url)).toEqual([
      hfUrl('config.json'),
      mirrorUrl('config.json'),
      msUrl('config.json'),
    ]);
    expect(looksLikeHtmlBody(Buffer.from('  <!doctype html>'))).toBe(true);
    expect(looksLikeHtmlBody(Buffer.from('ONNX binary'))).toBe(false);
  });

  it('工厂缺省 env → 读 process.env（默认镜像链、默认模型 id）', () => {
    const downloader = createModelDownloader({ modelDir: dir, logger, fetchImpl: makeFetch([onHf(OK)]).fetchImpl });
    expect(downloader.modelId).toBe('onnx-community/whisper-base');
    expect(downloader.modelPath).toBe(join(dir, 'onnx-community', 'whisper-base'));
  });
});

// ---------------------------------------------------------------------------
// engine — 懒加载单例与空闲卸载
// ---------------------------------------------------------------------------

function makeFactory(text = '  hello world  '): {
  factory: AsrPipelineFactory;
  calls: Array<{ task: string; modelId: string; options: Record<string, unknown> }>;
  pipeline: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const calls: Array<{ task: string; modelId: string; options: Record<string, unknown> }> = [];
  const dispose = vi.fn(async () => {});
  const pipeline = vi.fn(async (_audio: Float32Array, _options?: { language?: string; task?: string }) => ({ text }));
  const factory = (vi.fn(async (
    task: 'automatic-speech-recognition',
    modelId: string,
    options: { dtype: 'q8'; cache_dir: string; local_files_only: true },
  ) => {
    calls.push({ task, modelId, options });
    return Object.assign(pipeline, { dispose });
  })) as unknown as AsrPipelineFactory;
  return { factory, calls, pipeline, dispose };
}

describe('asr engine — 懒加载单例与空闲卸载', () => {
  it('懒加载：首次 transcribe 才建 pipeline；连续调用复用单例；文本 trim + durationMs', async () => {
    const { factory, calls, pipeline } = makeFactory();
    const engine = createAsrEngine({ modelDir: dir, logger, pipelineFactory: factory, idleUnloadMs: 0 });
    expect(engine.isLoaded()).toBe(false);

    const r1 = await engine.transcribe(Float32Array.from([0.1, 0.2, 0.3]));
    expect(engine.isLoaded()).toBe(true);
    await engine.transcribe(Float32Array.from([0.4]));
    expect(calls).toHaveLength(1); // 单例：工厂只调用一次
    expect(calls[0]).toMatchObject({
      task: 'automatic-speech-recognition',
      modelId: DEFAULT_ASR_MODEL_ID,
      options: { dtype: 'q8', cache_dir: dir, local_files_only: true },
    });
    expect(r1.text).toBe('hello world');
    expect(r1.durationMs).toBeTypeOf('number');
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('language 透传：{ language: "zh" } → pipeline 收到 language + task: "transcribe"', async () => {
    const { factory, pipeline } = makeFactory();
    const engine = createAsrEngine({ modelDir: dir, logger, pipelineFactory: factory, idleUnloadMs: 0 });
    await engine.transcribe(Float32Array.from([0.1]), { language: 'zh' });
    expect(pipeline).toHaveBeenLastCalledWith(expect.any(Float32Array), { language: 'zh', task: 'transcribe' });
  });

  it('空 PCM 拒绝且不触发加载', async () => {
    const { factory } = makeFactory();
    const engine = createAsrEngine({ modelDir: dir, logger, pipelineFactory: factory, idleUnloadMs: 0 });
    await expect(engine.transcribe(new Float32Array(0))).rejects.toThrow(/non-empty/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('空闲卸载：idleUnloadMs 到期 dispose；下次调用自动重建（工厂第二次调用）', async () => {
    vi.useFakeTimers();
    try {
      const { factory, calls, dispose } = makeFactory();
      const engine = createAsrEngine({ modelDir: dir, logger, pipelineFactory: factory, idleUnloadMs: 1000 });
      await engine.transcribe(Float32Array.from([0.1]));
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(engine.isLoaded()).toBe(false);
      await engine.transcribe(Float32Array.from([0.2]));
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('加载失败可重试：工厂 reject → transcribe 上抛；恢复后再次调用成功', async () => {
    let fail = true;
    const factory = (vi.fn(async () => {
      if (fail) throw new Error('model files missing');
      return Object.assign(vi.fn(async () => ({ text: 'ok' })), { dispose: vi.fn(async () => {}) });
    })) as unknown as AsrPipelineFactory;
    const engine = createAsrEngine({ modelDir: dir, logger, pipelineFactory: factory, idleUnloadMs: 0 });

    await expect(engine.transcribe(Float32Array.from([0.1]))).rejects.toThrow('model files missing');
    expect(engine.isLoaded()).toBe(false);
    fail = false;
    const result = await engine.transcribe(Float32Array.from([0.2]));
    expect(result.text).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// manager — 状态机与转写门面
// ---------------------------------------------------------------------------

type DownloaderStub = {
  modelId: string;
  modelPath: string;
  isCached: ReturnType<typeof vi.fn>;
  ensureModel: ReturnType<typeof vi.fn>;
};

type EngineStub = {
  modelId: string;
  isLoaded: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
};

function makeDownloaderStub(overrides: {
  isCached?: () => boolean;
  ensureModel?: (onProgress?: (e: AsrProgressEvent) => void) => Promise<AsrEnsureResult>;
} = {}): DownloaderStub {
  return {
    modelId: DEFAULT_ASR_MODEL_ID,
    modelPath: join(dir, 'model'),
    isCached: vi.fn(overrides.isCached ?? (() => false)),
    ensureModel: vi.fn(
      overrides.ensureModel ?? (async () => ({ dir: join(dir, 'model'), source: 'hf-mirror', cached: false })),
    ),
  };
}

function makeEngineStub(): EngineStub {
  return {
    modelId: DEFAULT_ASR_MODEL_ID,
    isLoaded: vi.fn(() => false),
    load: vi.fn(async () => {}),
    transcribe: vi.fn(async (_pcm: Float32Array, _opts?: { language?: string }) => ({ text: 'stub text', durationMs: 7 })),
    unload: vi.fn(async () => {}),
  };
}

function makeManager(
  downloader: DownloaderStub,
  engine: EngineStub,
  opts: { enabled?: boolean; autoDownload?: boolean } = {},
): AsrManager {
  return new AsrManager({
    modelDir: dir,
    logger,
    downloader: downloader as never,
    engine: engine as never,
    ...opts,
  });
}

describe('asr manager — 状态机与转写门面', () => {
  it('状态机：not-downloaded → downloading（progress 扇出）→ ready；完成后进度清零', async () => {
    let resolveDownload!: (r: AsrEnsureResult) => void;
    const downloader = makeDownloaderStub({
      ensureModel: (onProgress) =>
        new Promise<AsrEnsureResult>((resolve) => {
          onProgress?.({ source: 'hf-mirror', pct: 42 });
          resolveDownload = resolve;
        }),
    });
    const engine = makeEngineStub();
    const manager = makeManager(downloader, engine);

    expect(manager.status()).toEqual({ state: 'not-downloaded', modelId: DEFAULT_ASR_MODEL_ID, enabled: true });

    const events: AsrProgressEvent[] = [];
    const pending = manager.ensureReady((e) => events.push(e));
    expect(manager.status()).toEqual({ state: 'downloading', progress: 42, modelId: DEFAULT_ASR_MODEL_ID, enabled: true });

    resolveDownload({ dir: downloader.modelPath, source: 'hf-mirror', cached: false });
    const result = await pending;
    expect(result.cached).toBe(false);
    expect(events).toEqual([{ source: 'hf-mirror', pct: 42 }]);
    expect(manager.status()).toMatchObject({ state: 'ready' });
    expect(manager.status().progress).toBeUndefined();
  });

  it('下载失败 → error 状态（error 可见）+ HARNESS-1003；源恢复后重试回 ready', async () => {
    const downloader = makeDownloaderStub({
      ensureModel: async () => {
        throw new Error('huggingface: HTTP 503; hf-mirror: HTTP 503; modelscope: HTTP 503');
      },
    });
    const manager = makeManager(downloader, makeEngineStub());

    await expect(manager.ensureReady()).rejects.toMatchObject({ code: 'HARNESS-1003' });
    const status = manager.status();
    expect(status.state).toBe('error');
    expect(status.error).toContain('modelscope');
    expect(status.progress).toBeUndefined();

    downloader.ensureModel.mockImplementation(async () => ({ dir: downloader.modelPath, source: 'modelscope', cached: false }));
    await manager.ensureReady();
    expect(manager.status().state).toBe('ready');
    expect(manager.status().error).toBeUndefined();
  });

  it('disabled：status 报 disabled；ensureReady/transcribe → HARNESS-1003；init 不触发下载', async () => {
    const downloader = makeDownloaderStub();
    const manager = makeManager(downloader, makeEngineStub(), { enabled: false });
    expect(manager.status()).toMatchObject({ state: 'disabled', enabled: false });
    await expect(manager.ensureReady()).rejects.toMatchObject({ code: 'HARNESS-1003' });
    await expect(manager.transcribe(Float32Array.from([0.1]))).rejects.toMatchObject({ code: 'HARNESS-1003' });
    manager.init();
    expect(downloader.ensureModel).not.toHaveBeenCalled();
  });

  it('transcribe：空/非 Float32Array PCM → HARNESS-1008；正常路径委托 engine（pcm/language 透传）', async () => {
    const downloader = makeDownloaderStub({ isCached: () => true });
    const engine = makeEngineStub();
    const manager = makeManager(downloader, engine);

    await expect(manager.transcribe(new Float32Array(0))).rejects.toMatchObject({ code: 'HARNESS-1008' });
    await expect(manager.transcribe([1, 2, 3] as unknown as Float32Array)).rejects.toMatchObject({ code: 'HARNESS-1008' });
    expect(downloader.ensureModel).not.toHaveBeenCalled();

    const result = await manager.transcribe(Float32Array.from([0.5, -0.5]), { language: 'en' });
    expect(result).toEqual({ text: 'stub text', durationMs: 7 });
    expect(engine.transcribe).toHaveBeenCalledTimes(1);
    const passed = engine.transcribe.mock.calls[0]?.[0] as Float32Array;
    expect(Array.from(passed)).toEqual([0.5, -0.5]);
    expect(engine.transcribe.mock.calls[0]?.[1]).toEqual({ language: 'en' });
  });

  it('ensureReady 单飞：并发调用共享一次下载；transcribe 在下载中等待', async () => {
    let resolveDownload!: (r: AsrEnsureResult) => void;
    const downloader = makeDownloaderStub({
      ensureModel: () =>
        new Promise<AsrEnsureResult>((resolve) => {
          resolveDownload = resolve;
        }),
    });
    const engine = makeEngineStub();
    const manager = makeManager(downloader, engine);

    const p1 = manager.ensureReady();
    const p2 = manager.ensureReady();
    const p3 = manager.transcribe(Float32Array.from([0.1]));
    expect(downloader.ensureModel).toHaveBeenCalledTimes(1);

    resolveDownload({ dir: downloader.modelPath, source: 'cache', cached: false });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(r2);
    expect(r3.text).toBe('stub text');
    expect(downloader.ensureModel).toHaveBeenCalledTimes(1);
  });

  it('init autoDownload：开启时 fire-and-forget 后台下载（失败落 error 不抛出）；关闭/已缓存不动', async () => {
    const downloader = makeDownloaderStub();
    const manager = makeManager(downloader, makeEngineStub(), { autoDownload: true });
    manager.init();
    expect(downloader.ensureModel).toHaveBeenCalledTimes(1);
    expect(manager.status().state).toBe('downloading');
    manager.init(); // 幂等：在飞期间不重复触发
    expect(downloader.ensureModel).toHaveBeenCalledTimes(1);

    const failing = makeManager(
      makeDownloaderStub({
        ensureModel: async () => {
          throw new Error('all mirrors down');
        },
      }),
      makeEngineStub(),
      { autoDownload: true },
    );
    expect(() => failing.init()).not.toThrow();
    await vi.waitFor(() => expect(failing.status().state).toBe('error'));

    const cached = makeManager(makeDownloaderStub({ isCached: () => true }), makeEngineStub(), { autoDownload: true });
    cached.init();
    expect(cached.status().state).toBe('ready');
    expect(cached.status().progress).toBeUndefined();
  });

  it('warmup：ensureReady + engine.load；unloadEngine 委托 engine.unload', async () => {
    const downloader = makeDownloaderStub({ isCached: () => true });
    const engine = makeEngineStub();
    const manager = makeManager(downloader, engine);
    const status: AsrStatus = await manager.warmup();
    expect(status.state).toBe('ready');
    expect(engine.load).toHaveBeenCalledTimes(1);
    await manager.unloadEngine();
    expect(engine.unload).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PCM 线格式
// ---------------------------------------------------------------------------

describe('asr PCM 线格式', () => {
  it('encode/decode 往返一致', () => {
    const pcm = Float32Array.from([0.25, -0.75, 1, 0]);
    expect(Array.from(decodePcmBase64(encodePcmBase64(pcm)))).toEqual([0.25, -0.75, 1, 0]);
    expect(EXPECTED_SAMPLE_RATE).toBe(16_000);
  });

  it('形状/上限校验：非 4 字节对齐、空字节、超采样上限均报错', () => {
    expect(() => float32FromBuffer(Buffer.from([1, 2, 3]))).toThrow(/multiple of 4/);
    expect(() => float32FromBuffer(Buffer.alloc(0))).toThrow(/multiple of 4/);
    expect(() => decodePcmBase64(Buffer.alloc(2).toString('base64'))).toThrow(/multiple of 4/);
    const tooLong = new Float32Array(MAX_PCM_SAMPLES + 1);
    const buffer = Buffer.alloc(tooLong.length * 4);
    for (let i = 0; i < tooLong.length; i += 1) buffer.writeFloatLE(0, i * 4);
    expect(() => float32FromBuffer(buffer)).toThrow(/sample limit/);
  });
});

// ---------------------------------------------------------------------------
// 扩展桥 — 权限闸与线格式
// ---------------------------------------------------------------------------

describe('asr 扩展桥 — asrStatus/asrTranscribe', () => {
  function makeBridge(allowed: boolean) {
    const manager = {
      status: vi.fn((): AsrStatus => ({ state: 'ready', modelId: DEFAULT_ASR_MODEL_ID, enabled: true })),
      transcribe: vi.fn(async (_pcm: Float32Array, _opts?: { language?: string }) => ({ text: '桥接文本', durationMs: 3 })),
    };
    const requirePermission = vi.fn((extId: string, topic: string, permission: string): void => {
      if (!allowed) {
        throw err('FORBIDDEN', {
          message: `kernel service "${topic}" requires the "${permission}" permission`,
          detail: { extId, permission },
        });
      }
    });
    const handlers = createAsrBridge({ manager: manager as never, requirePermission });
    return { handlers, manager, requirePermission };
  }

  it('asrStatus：kernel 端点 → HARNESS-2003；无 asr 权限 → HARNESS-1007；有权限 → 状态快照', async () => {
    const denied = makeBridge(false);
    await expect(denied.handlers[KERNEL_TOPICS.asrStatus]({}, 'kernel')).rejects.toMatchObject({ code: 'HARNESS-2003' });
    await expect(denied.handlers[KERNEL_TOPICS.asrStatus]({}, 'ext:e1')).rejects.toMatchObject({ code: 'HARNESS-1007' });
    expect(denied.requirePermission).toHaveBeenCalledWith('e1', KERNEL_TOPICS.asrStatus, ASR_PERMISSION);

    const allowed = makeBridge(true);
    await expect(allowed.handlers[KERNEL_TOPICS.asrStatus]({}, 'ext:e1')).resolves.toMatchObject({
      state: 'ready',
      modelId: DEFAULT_ASR_MODEL_ID,
    });
  });

  it('asrTranscribe：samplesBase64 解码为 Float32Array 透传（含 language）', async () => {
    const { handlers, manager } = makeBridge(true);
    const pcm = Float32Array.from([0.5, -0.25]);
    const payload = { samplesBase64: encodePcmBase64(pcm), sampleRate: 16000, language: 'zh' };
    await expect(handlers[KERNEL_TOPICS.asrTranscribe](payload, 'ext:e1')).resolves.toEqual({
      text: '桥接文本',
      durationMs: 3,
    });
    const passed = manager.transcribe.mock.calls[0]?.[0] as Float32Array;
    expect(Array.from(passed)).toEqual([0.5, -0.25]);
    expect(manager.transcribe).toHaveBeenLastCalledWith(expect.any(Float32Array), { language: 'zh' });
  });

  it('asrTranscribe：sampleRate 非 16k / 缺样本字段 / 坏 base64 形状 → HARNESS-1009', async () => {
    const { handlers } = makeBridge(true);
    await expect(
      handlers[KERNEL_TOPICS.asrTranscribe](
        { samplesBase64: encodePcmBase64(Float32Array.from([1])), sampleRate: 44100 },
        'ext:e1',
      ),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(handlers[KERNEL_TOPICS.asrTranscribe]({}, 'ext:e1')).rejects.toMatchObject({ code: 'HARNESS-1009' });
    await expect(
      handlers[KERNEL_TOPICS.asrTranscribe]({ samplesBase64: Buffer.from([1, 2]).toString('base64') }, 'ext:e1'),
    ).rejects.toMatchObject({ code: 'HARNESS-1009' });
  });
});

// ---------------------------------------------------------------------------
// REST — 鉴权/门禁/形状校验
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'token-admin';
const ROOT_TOKEN = 'token-root';
const NORMAL_TOKEN = 'token-normal';
const AUTH_ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const AUTH_ROOT = { authorization: `Bearer ${ROOT_TOKEN}` };
const AUTH_NORMAL = { authorization: `Bearer ${NORMAL_TOKEN}` };

const checker = async ({ token }: { token?: string }): Promise<{ role: string } & Record<string, unknown>> => {
  if (token === ADMIN_TOKEN) return { userId: 'admin-1', role: 'admin', scopes: [] };
  if (token === ROOT_TOKEN) return { userId: 'root', role: 'root', scopes: ['*'] };
  if (token === NORMAL_TOKEN) return { userId: 'user-1', role: 'normal', scopes: [] };
  throw err('UNAUTHORIZED', { detail: 'token rejected by all auth providers' });
};

function makeRestManagerStub(state: AsrStatus['state']): Record<string, ReturnType<typeof vi.fn>> {
  const status: AsrStatus =
    state === 'downloading'
      ? { state, progress: 55, modelId: DEFAULT_ASR_MODEL_ID, enabled: true }
      : state === 'error'
        ? { state, error: 'boom', modelId: DEFAULT_ASR_MODEL_ID, enabled: true }
        : { state, modelId: DEFAULT_ASR_MODEL_ID, enabled: state !== 'disabled' };
  return {
    status: vi.fn(() => ({ ...status })),
    ensureReady: vi.fn(async () => ({ dir: '/tmp/asr', source: 'hf-mirror', cached: false }) satisfies AsrEnsureResult),
    transcribe: vi.fn(async () => ({ text: 'rest transcription', durationMs: 11 })),
    warmup: vi.fn(async () => ({ ...status })),
    isEngineLoaded: vi.fn(() => true),
    unloadEngine: vi.fn(async () => {}),
    init: vi.fn(),
  };
}

describe('asr REST — 鉴权/门禁/形状', () => {
  let restDir: string;
  let app: FastifyInstance;
  let disabledApp: FastifyInstance;
  let stub: Record<string, ReturnType<typeof vi.fn>>;

  const buildApp = (manager: unknown): FastifyInstance => {
    const config = loadConfig({ NODE_ENV: 'test', HARNESS_LOG_LEVEL: 'error', HARNESS_DATA_DIR: restDir });
    const { app: built } = createHttpServer({
      config,
      logger,
      isReady: () => true,
      state: () => 'ready',
      registerExtra: (a) => registerAsrRoutes(a, { checker, manager: manager as never }),
    });
    return built;
  };

  beforeAll(() => {
    restDir = mkdtempSync(join(tmpdir(), 'opptrix-asr-rest-'));
    stub = makeRestManagerStub('ready');
    app = buildApp(stub);
    disabledApp = buildApp(makeRestManagerStub('disabled'));
  });

  afterAll(async () => {
    await app.close();
    await disabledApp.close();
    rmSync(restDir, { recursive: true, force: true });
  });

  it('无 token → 401 HARNESS-1006（三个路由一致）', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/v1/asr/status', undefined],
      ['POST', '/api/v1/asr/ensure', {}],
      ['POST', '/api/v1/asr/transcribe', {}],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().code, url).toBe('HARNESS-1006');
    }
  });

  it('status：任意已认证身份可读（normal 200）+ 状态原样透传', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/asr/status', headers: AUTH_NORMAL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'ready', modelId: DEFAULT_ASR_MODEL_ID, enabled: true });
    expect(stub.status).toHaveBeenCalled();
  });

  it('ensure：normal → 403 HARNESS-1007；admin/root → 202 + 状态快照', async () => {
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers: AUTH_NORMAL });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('HARNESS-1007');

    const admin = await app.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers: AUTH_ADMIN });
    expect(admin.statusCode).toBe(202);
    expect(admin.json()).toMatchObject({ state: 'ready', modelId: DEFAULT_ASR_MODEL_ID });
    expect(stub.ensureReady).toHaveBeenCalled();

    const root = await app.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers: AUTH_ROOT });
    expect(root.statusCode).toBe(202);
  });

  it('ensure：disabled → 503 HARNESS-1003（且不触发下载）', async () => {
    const res = await disabledApp.inject({ method: 'POST', url: '/api/v1/asr/ensure', headers: AUTH_ADMIN });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('HARNESS-1003');
  });

  it('transcribe：缺 samplesBase64 → 400；sampleRate 非 16k → 400；合法请求 → { text, durationMs }', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: { sampleRate: 16000 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('HARNESS-1009');

    const badRate = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: { samplesBase64: encodePcmBase64(Float32Array.from([0.1])), sampleRate: 44100 },
    });
    expect(badRate.statusCode).toBe(400);
    expect(badRate.json().code).toBe('HARNESS-1009');
    expect(badRate.json().message).toContain('16kHz');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_NORMAL, 'content-type': 'application/json' },
      payload: { samplesBase64: encodePcmBase64(Float32Array.from([0.1, 0.2])), language: 'zh' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ text: 'rest transcription', durationMs: 11 });
    const [pcm, opts] = stub.transcribe.mock.calls.at(-1) as unknown as [Float32Array, { language?: string }];
    expect(pcm).toHaveLength(2);
    expect(pcm[0]).toBeCloseTo(0.1, 5);
    expect(pcm[1]).toBeCloseTo(0.2, 5);
    expect(opts).toEqual({ language: 'zh' });
  });

  it('transcribe：octet-stream 直传 float32 裸字节（query sampleRate/language）', async () => {
    const buffer = Buffer.alloc(12);
    [0.125, -0.125, 0.5].forEach((v, i) => buffer.writeFloatLE(v, i * 4));
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/asr/transcribe?sampleRate=${EXPECTED_SAMPLE_RATE}&language=en`,
      headers: { ...AUTH_ADMIN, 'content-type': 'application/octet-stream' },
      payload: buffer,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ text: 'rest transcription', durationMs: 11 });
    const [pcm, opts] = stub.transcribe.mock.calls.at(-1) as unknown as [Float32Array, { language?: string } | undefined];
    expect(Array.from(pcm)).toEqual([0.125, -0.125, 0.5]);
    expect(opts).toEqual({ language: 'en' });
  });

  it('transcribe：非对齐 octet-stream body → 400；sampleRate=8000 → 400（提示重采样）', async () => {
    const misaligned = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(misaligned.statusCode).toBe(400);
    expect(misaligned.json().code).toBe('HARNESS-1009');

    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(0.5, 0);
    const badRate = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe?sampleRate=8000',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/octet-stream' },
      payload: buffer,
    });
    expect(badRate.statusCode).toBe(400);
    expect(badRate.json().message).toContain('resample');
  });

  it('transcribe：空 octet-stream body → 400；非法 JSON body → 400 HARNESS-1009', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);

    const invalidJson = await app.inject({
      method: 'POST',
      url: '/api/v1/asr/transcribe',
      headers: { ...AUTH_ADMIN, 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json().code).toBe('HARNESS-1009');
  });
});
