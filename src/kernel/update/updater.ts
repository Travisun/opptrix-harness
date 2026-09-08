/**
 * updater — A/B slot 双槽升级器（下载 → 校验 → 解压 → 预检 → 原子提交）。
 *
 * 全链路（apply）：
 * 0. 实例内并发闸：进行中再次 apply → `UPDATE_IN_PROGRESS`；
 * 1. 目标缺省时取 `check().available`；无可用更新 → `UPDATE_CHECK_FAILED`；
 * 2. 升级前自动备份（createBackup，失败仅记日志不阻断）；
 * 3. 流式下载到 `<dataDir>/releases/incoming.tar.gz`；
 * 4. sha256 流式校验，不匹配 → 清理 + `{ ok:false, stage:'verify' }` + notifier warn；
 * 5. tar-stream 解压到**非活动 slot**（仅接受包内 `dist/**` 与 `node_modules/**`，
 *    拒绝绝对路径 / `..` 穿越 / symlink 成员）；
 * 6. 预检自检：子进程 `<slotDir>/dist/main.js`（独立端口与临时数据目录）轮询
 *    `GET /readyz`，超时或退出即失败 → 清理 + `{ ok:false, stage:'preflight' }` + notifier error；
 * 7. 原子提交 `commitNewSlot` 并把发布记录追加到 `<dataDir>/releases/history.json`；
 * 8. `markUpdateSettled` 延迟到重启后：内核 boot 时调用本模块导出的
 *    {@link settlePendingUpdate}（能启动即自检通过）→ settled + 成功通知。
 *
 * 本模块不 import NotificationManager：notifier 以回调注入（依赖倒置，见 UpdaterDeps）。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import semver from 'semver';
import { extract } from 'tar-stream';
import type { ExtractEvents, Header as TarHeader } from 'tar-stream';
import { z } from 'zod';
import type { Knex } from 'knex';
import type { Logger } from 'pino';

import { createBackup } from '../storage/backup.js';
import { err, HarnessError } from '../errors/index.js';
import {
  commitNewSlot,
  markUpdateSettled,
  readSlots,
  slotDir,
  type SlotName,
} from './slots.js';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** 升级 feed 中的单个发布项 */
export interface UpdateFeed {
  channel: 'stable' | 'beta';
  version: string;
  url: string;
  /** 发布包（tar.gz）的 sha256 hex 摘要 */
  sha256: string;
  notes?: string;
}

/** check() 结果（网络/feed 失败不抛错，以 feedOk=false + error 表达） */
export interface UpdateCheckResult {
  /** 当前活动 slot 的版本（首装无记录时为 null） */
  currentVersion: string | null;
  /** 可用更新（已是最新 / feed 无该频道分支时为 null） */
  available: UpdateFeed | null;
  /** feed 是否成功拉取并解析 */
  feedOk: boolean;
  /** feedOk=false 时的原因说明 */
  error?: string;
}

/** apply() 失败所处的阶段 */
export type UpdateFailStage = 'download' | 'verify' | 'extract' | 'preflight';

/** apply() 结果 */
export type UpdateApplyResult =
  | { ok: true; slot: SlotName; version: string }
  | { ok: false; stage: UpdateFailStage; error: string };

/** history.json 单条发布记录 */
export interface UpdateHistoryEntry {
  version: string;
  /** UTC epoch ms */
  appliedAt: number;
  ok: boolean;
}

/** 结果通知回调契约（由集成方注入，通常为 NotificationManager.send 的绑定） */
export interface UpdaterNotifier {
  send(input: { title: string; body: string; level?: string }): Promise<unknown>;
}

/** Updater 依赖集合 */
export interface UpdaterDeps {
  config: {
    dataDir: string;
    updateFeed: string;
    updateChannel: 'stable' | 'beta';
    updateToken: string;
  };
  /** 升级前备份用主库 */
  db: Knex;
  logger: Logger;
  /** 可选：结果通知 */
  notifier?: UpdaterNotifier;
  /** 提交成功后触发内核优雅重启（bootstrap 拉起新 slot） */
  requestRestart: () => void | Promise<void>;
  /** 测试注入的 fetch（feed 拉取与发布包下载）；预检轮询固定用原生 fetch */
  fetchFn?: typeof fetch;
  /** 预检自检超时，默认 30_000ms */
  preflightTimeoutMs?: number;
  /** 预检子进程端口，默认 3987 */
  preflightPort?: number;
}

// ---------------------------------------------------------------------------
// 常量与 zod 契约
// ---------------------------------------------------------------------------

const RELEASES_DIRNAME = 'releases';
const INCOMING_FILENAME = 'incoming.tar.gz';
const HISTORY_FILENAME = 'history.json';
const PREFLIGHT_DATA_DIRNAME = '.preflight-data';

/** 预检就绪轮询间隔 */
const PREFLIGHT_POLL_INTERVAL_MS = 300;
/** feed 拉取超时 */
const FEED_TIMEOUT_MS = 10_000;
/** 预检 kill 后等待子进程退出的兜底时限 */
const CHILD_EXIT_WAIT_MS = 5_000;

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;
const DEFAULT_PREFLIGHT_PORT = 3987;

/** feed 单频道发布项 */
const feedEntrySchema = z.object({
  channel: z.enum(['stable', 'beta']),
  version: z.string().min(1),
  url: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be a 64-char hex digest'),
  notes: z.string().optional(),
});

/** feed 文档：按频道分支（stable / beta），分支可缺省 */
const feedDocSchema = z.object({
  stable: feedEntrySchema.optional(),
  beta: feedEntrySchema.optional(),
});

/** history.json 文档（同 slots 的 JSON 读写助手风格：zod 校验、缺失视为空） */
const historyFileSchema = z.array(
  z.object({
    version: z.string(),
    appliedAt: z.number(),
    ok: z.boolean(),
  }),
);

// ---------------------------------------------------------------------------
// JSON 读写助手（history.json；风格对齐 slots）
// ---------------------------------------------------------------------------

/** 读取发布历史；文件缺失或目录未建返回 []（ENOENT 视为空，其余错误抛 INTERNAL） */
async function readHistoryFile(releasesDir: string): Promise<UpdateHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(releasesDir, HISTORY_FILENAME), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw HarnessError.wrap(e, 'INTERNAL');
  }
  const parsed = historyFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw err('INTERNAL', {
      message: `updater: ${HISTORY_FILENAME} is corrupt — delete or repair it at ${path.join(releasesDir, HISTORY_FILENAME)}`,
      detail: parsed.error.issues,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * 追加一条发布记录（读-改-写；调用方保证 releasesDir 已存在）。
 * REL-5：tmp + rename 原子写——进程在写入中途崩溃不再留下半截 history.json
 * （损坏的 JSON 会让后续 history()/append 全部失败）。
 */
async function appendHistoryFile(
  releasesDir: string,
  entry: UpdateHistoryEntry,
): Promise<void> {
  const list = await readHistoryFile(releasesDir);
  list.push(entry);
  const finalPath = path.join(releasesDir, HISTORY_FILENAME);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  await rename(tmpPath, finalPath);
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 取另一块 slot */
function otherSlot(active: SlotName): SlotName {
  return active === 'slot-a' ? 'slot-b' : 'slot-a';
}

/**
 * 版本比较：两者均为合法 semver 时用 gt（更新且更新才可用），
 * 否则退化为字符串不等式（不等于当前版本即视为可用）。
 */
function isNewerVersion(candidate: string, current: string | null): boolean {
  if (current === null || current === '') return true;
  if (semver.valid(candidate) !== null && semver.valid(current) !== null) {
    return semver.gt(candidate, current);
  }
  return candidate !== current;
}

/** sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待子进程退出（SIGTERM 起步，超时 SIGKILL 兜底） */
async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, CHILD_EXIT_WAIT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 安全通知：notifier 故障绝不影响升级主流程 */
async function notifySafe(
  notifier: UpdaterNotifier | undefined,
  logger: Logger,
  input: { title: string; body: string; level: 'info' | 'success' | 'warn' | 'error' },
): Promise<void> {
  if (notifier === undefined) return;
  try {
    await notifier.send(input);
  } catch (e) {
    logger.warn({ err: e }, 'updater: notifier.send failed (ignored)');
  }
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

/**
 * A/B 双槽升级器。用法：内核持有单例，`check()` 供查询，
 * `apply()` 串行执行完整升级并触发 `requestRestart()`。
 */
export class Updater {
  private readonly deps: UpdaterDeps;
  /** 实例内并发闸 */
  private inFlight = false;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
  }

  private get releasesDir(): string {
    return path.join(this.deps.config.dataDir, RELEASES_DIRNAME);
  }

  /**
   * 检查更新：拉取 feed（配置了 updateToken 时带 `Authorization: Bearer`）→
   * 取配置频道分支 → 与 slots.version 比较。任何失败都不抛错：
   * feed 未配置 / 网络失败 / 响应非法 → `feedOk:false` + `error`。
   */
  async check(): Promise<UpdateCheckResult> {
    const { config, fetchFn = fetch, logger } = this.deps;

    const state = await readSlots(config);
    const currentVersion = state.version;

    if (config.updateFeed === '') {
      return {
        currentVersion,
        available: null,
        feedOk: false,
        error: 'update feed is not configured (set HARNESS_UPDATE_FEED)',
      };
    }

    let doc: z.infer<typeof feedDocSchema>;
    try {
      const headers: Record<string, string> =
        config.updateToken !== '' ? { authorization: `Bearer ${config.updateToken}` } : {};
      const res = await fetchFn(config.updateFeed, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          currentVersion,
          available: null,
          feedOk: false,
          error: `update feed responded with HTTP ${res.status}`,
        };
      }
      const parsed = feedDocSchema.safeParse(await res.json());
      if (!parsed.success) {
        return {
          currentVersion,
          available: null,
          feedOk: false,
          error: `update feed document is invalid: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      doc = parsed.data;
    } catch (e) {
      logger.warn({ err: e }, 'updater: update feed fetch failed');
      return {
        currentVersion,
        available: null,
        feedOk: false,
        error: `update feed fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const branch = doc[config.updateChannel];
    if (branch === undefined) {
      // feed 可达但该频道无发布：feedOk=true、无可用更新
      return { currentVersion, available: null, feedOk: true };
    }
    if (!isNewerVersion(branch.version, currentVersion)) {
      // 已是该版本（或更新）：无可用更新
      return { currentVersion, available: null, feedOk: true };
    }
    return { currentVersion, available: branch, feedOk: true };
  }

  /**
   * 执行完整升级链路。见模块头注释。
   *
   * @param target 显式目标（字段可部分给出，缺省字段回退到 check().available）
   * @returns 成功给新 slot 与版本；失败给阶段与原因（checksum/preflight 失败另发通知）
   * @throws HarnessError `UPDATE_IN_PROGRESS`（并发）、`UPDATE_CHECK_FAILED`（无可用目标）
   */
  async apply(
    target?: { version?: string; url?: string; sha256?: string },
  ): Promise<UpdateApplyResult> {
    if (this.inFlight) {
      throw err('UPDATE_IN_PROGRESS', { detail: 'another apply() is already running in this process' });
    }
    this.inFlight = true;
    try {
      return await this.applyLocked(target);
    } finally {
      this.inFlight = false;
    }
  }

  /** apply 主体（持锁执行） */
  private async applyLocked(
    target?: { version?: string; url?: string; sha256?: string },
  ): Promise<UpdateApplyResult> {
    const { config, db, logger, notifier, fetchFn = fetch } = this.deps;
    const incomingPath = path.join(this.releasesDir, INCOMING_FILENAME);

    // 1) 解析目标：显式 target 字段覆盖 feed 分支；跨进程在途升级同样拒绝
    const slots = await readSlots(config);
    if (slots.updateInFlight) {
      throw err('UPDATE_IN_PROGRESS', {
        detail: 'a previously applied update is pending restart/settle',
      });
    }
    const base = (await this.check()).available;
    const entry: UpdateFeed = {
      ...(base ?? {
        channel: config.updateChannel,
        version: '',
        url: '',
        sha256: '',
      }),
      ...(target?.version !== undefined ? { version: target.version } : {}),
      ...(target?.url !== undefined ? { url: target.url } : {}),
      ...(target?.sha256 !== undefined ? { sha256: target.sha256 } : {}),
    };
    if (entry.version === '' || entry.url === '' || entry.sha256 === '') {
      throw err('UPDATE_CHECK_FAILED', {
        message: 'no update available: feed has no newer release for the configured channel and target is incomplete',
        detail: { channel: config.updateChannel, target: target ?? null },
      });
    }

    const newSlot = otherSlot(slots.current);
    const destSlotDir = slotDir(config, newSlot);

    // 2) 升级前自动备份：失败不阻断
    try {
      const backup = await createBackup(config, db);
      logger.info({ path: backup.path, sizeBytes: backup.sizeBytes }, 'updater: pre-update backup created');
    } catch (e) {
      logger.warn({ err: e }, 'updater: pre-update backup failed (continuing)');
    }

    try {
      // 3) 下载（流式落盘）
      await mkdir(this.releasesDir, { recursive: true });
      try {
        const res = await fetchFn(entry.url, { method: 'GET', redirect: 'follow' });
        if (!res.ok || res.body === null) {
          return {
            ok: false,
            stage: 'download',
            error: `release download failed: HTTP ${res.status} from ${entry.url}`,
          };
        }
        await pipeline(
          Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>),
          createWriteStream(incomingPath),
        );
      } catch (e) {
        return {
          ok: false,
          stage: 'download',
          error: `release download failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // 4) sha256 流式校验
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(incomingPath)) hash.update(chunk as Buffer);
      const actual = hash.digest('hex');
      if (actual !== entry.sha256.toLowerCase()) {
        await rm(incomingPath, { force: true });
        await notifySafe(notifier, logger, {
          title: 'Update rejected: checksum mismatch',
          body: `Release ${entry.version} sha256 mismatch (expected ${entry.sha256}, got ${actual}). Download was discarded.`,
          level: 'warn',
        });
        return {
          ok: false,
          stage: 'verify',
          error: `sha256 mismatch: expected ${entry.sha256}, got ${actual}`,
        };
      }

      // 5) 解压到非活动 slot（路径安全校验在 extractEntry 内）
      await rm(destSlotDir, { recursive: true, force: true });
      try {
        await this.extractRelease(incomingPath, destSlotDir);
      } catch (e) {
        return {
          ok: false,
          stage: 'extract',
          error: `release extraction failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // 6) 预检自检
      const preflight = await this.preflight(destSlotDir);
      await killChild(preflight.child).catch(() => {});
      await rm(path.join(this.releasesDir, PREFLIGHT_DATA_DIRNAME), { recursive: true, force: true }).catch(
        () => {},
      );
      if (!preflight.ok) {
        await rm(incomingPath, { force: true }).catch(() => {});
        await notifySafe(notifier, logger, {
          title: 'Update failed: preflight self-check',
          body: `Release ${entry.version} failed preflight (${preflight.error}). Nothing was committed.`,
          level: 'error',
        });
        return { ok: false, stage: 'preflight', error: preflight.error };
      }

      // 7) 原子提交 + 发布历史
      // REL-5：history 追加失败仅 warn——无论如何随后必须 requestRestart()（新 slot
      // 已 commit，升级已不可逆；让 history 写失败阻塞重启会把内核卡在「在途升级」态）
      await commitNewSlot(config, { newSlot, version: entry.version });
      try {
        await appendHistoryFile(this.releasesDir, {
          version: entry.version,
          appliedAt: Date.now(),
          ok: true,
        });
      } catch (e) {
        logger.warn({ err: e, slot: newSlot, version: entry.version }, 'updater: release history append failed (restart continues)');
      }
      await rm(incomingPath, { force: true }).catch(() => {});
      logger.info({ slot: newSlot, version: entry.version }, 'updater: new slot committed, requesting restart');

      // 8) 触发优雅重启（markUpdateSettled 由新进程 settlePendingUpdate 完成）
      await this.deps.requestRestart();
      return { ok: true, slot: newSlot, version: entry.version };
    } finally {
      // 半成品归档一律不留（成功路径上已在各分支清理；此处兜底异常路径）
      await rm(incomingPath, { force: true }).catch(() => {});
    }
  }

  /**
   * 解压发布包到 slot 目录。仅接受包内 `dist/**` 与 `node_modules/**`；
   * 拒绝绝对路径、`..` 穿越、NUL 与 symlink 等特殊成员（违例即整体失败）。
   */
  private async extractRelease(tarPath: string, destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true });
    const extractor = extract();
    const done = pipeline(createReadStream(tarPath), createGunzip(), extractor);

    extractor.on('entry', (header, stream, next) => {
      void this.extractEntry(header, stream, destDir)
        .then(() => next())
        .catch((e: unknown) => extractor.destroy(e instanceof Error ? e : new Error(String(e))));
    });

    await done;
  }

  /** 处理单个 tar 成员：安全校验 → 落位 / 跳过（跳过成员同样排空数据） */
  private async extractEntry(
    header: TarHeader,
    stream: ExtractEvents['entry'][1],
    destDir: string,
  ): Promise<void> {
    /** 排空被跳过成员的数据，保持解包管线推进 */
    const drain = async (): Promise<void> => {
      for await (const _chunk of stream) {
        /* discard */
      }
    };

    // 路径规范化与安全校验：拒绝绝对路径、穿越、NUL、Windows 盘符
    const name = header.name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    if (
      name === '' ||
      name.includes('\0') ||
      name.startsWith('/') ||
      /^[a-zA-Z]:/.test(name) ||
      name.split('/').includes('..')
    ) {
      throw err('INTERNAL', {
        message: `release archive contains an unsafe path entry: "${header.name}" — the release package appears tampered; refusing to extract it`,
        detail: { entry: header.name },
      });
    }
    const [topLevel] = name.split('/');
    if (topLevel !== 'dist' && topLevel !== 'node_modules') {
      await drain(); // 非发布内容（如 README）：跳过
      return;
    }
    if (header.type === 'directory') {
      await mkdir(path.join(destDir, name), { recursive: true });
      await drain();
      return;
    }
    if (header.type !== 'file') {
      await drain(); // symlink/hardlink 等一律不落盘（防逃逸）
      return;
    }

    const target = path.join(destDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await pipeline(Readable.from(stream), createWriteStream(target));
  }

  /**
   * 预检自检：以独立端口 + 临时空数据目录拉起 `<slotDir>/dist/main.js`，
   * 轮询 `GET /readyz`。返回 ok 与失败原因（子进程对象一并返回，调用方负责 kill）。
   */
  private async preflight(destSlotDir: string): Promise<{ ok: boolean; error: string; child: ChildProcess }> {
    const { config, logger } = this.deps;
    const timeoutMs = this.deps.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    const port = this.deps.preflightPort ?? DEFAULT_PREFLIGHT_PORT;
    const preflightDataDir = path.join(this.releasesDir, PREFLIGHT_DATA_DIRNAME);

    const child = spawn(process.execPath, [path.join(destSlotDir, 'dist', 'main.js')], {
      env: {
        ...process.env,
        HARNESS_DATA_DIR: preflightDataDir,
        HARNESS_PORT: String(port),
        HARNESS_LOG_LEVEL: 'error',
        HARNESS_SANDBOX_ENABLED: '0',
        HARNESS_PERSIST_ROOT_TOKEN: '0',
      },
      stdio: 'ignore',
    });

    // 临时数据目录：预检独享、先清空（子进程首写失败即暴露）
    await rm(preflightDataDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(preflightDataDir, { recursive: true }).catch(() => {});

    // spawn 失败（如 ENOENT）经 'error' 事件异步送达；用对象承载以便跨回调读取
    const spawnFailure: { err: Error | null } = { err: null };
    child.once('error', (e) => {
      spawnFailure.err = e;
    });

    const deadline = Date.now() + timeoutMs;
    let lastError = 'preflight timed out';
    while (Date.now() < deadline) {
      if (spawnFailure.err !== null) {
        lastError = `failed to spawn preflight process: ${spawnFailure.err.message}`;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        lastError = `preflight process exited prematurely (exitCode=${String(child.exitCode)}, signal=${String(child.signalCode)})`;
        break;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          logger.info({ port, slot: path.basename(destSlotDir) }, 'updater: preflight self-check passed');
          return { ok: true, error: '', child };
        }
        lastError = `preflight /readyz responded HTTP ${res.status}`;
      } catch {
        // 未就绪：继续轮询直至超时
      }
      await sleep(PREFLIGHT_POLL_INTERVAL_MS);
    }

    logger.warn({ slot: path.basename(destSlotDir), reason: lastError }, 'updater: preflight self-check failed');
    return { ok: false, error: lastError, child };
  }

  /** 发布历史（`<dataDir>/releases/history.json`；无记录返回 []） */
  async history(): Promise<UpdateHistoryEntry[]> {
    return readHistoryFile(this.releasesDir);
  }
}

// ---------------------------------------------------------------------------
// 重启后的 settle（由 Kernel boot 调用）
// ---------------------------------------------------------------------------

/**
 * 内核 boot 时的在途升级收尾：若 slots.updateInFlight（上一进程刚 commit 完
 * 并触发重启），能执行到这里即证明新 slot 可启动 → `markUpdateSettled({ ok:true })`
 * + 成功通知。正常态（无在途升级）为 no-op。
 *
 * 本函数吞掉全部异常（仅记日志），绝不阻塞 boot。
 */
export async function settlePendingUpdate(deps: {
  config: { dataDir: string };
  logger: Logger;
  notifier?: UpdaterNotifier;
}): Promise<void> {
  const { config, logger, notifier } = deps;
  try {
    const state = await readSlots(config);
    if (!state.updateInFlight) return;
    const version = state.version ?? 'unknown';
    await markUpdateSettled(config, { ok: true, version });
    logger.info({ version }, 'updater: pending update settled after restart');
    await notifySafe(notifier, logger, {
      title: 'Update applied successfully',
      body: `Version ${version} is now active after restart.`,
      level: 'success',
    });
  } catch (e) {
    logger.error({ err: e }, 'updater: settlePendingUpdate failed (boot continues)');
  }
}
