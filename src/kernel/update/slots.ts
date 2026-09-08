/**
 * A/B slot 状态管理（UPDATE 域 8xxx 的持久化状态层）。
 *
 * - 状态文件：`<dataDir>/releases/slots.json`，记录 current/previous slot、
 *   各自版本与 updateInFlight（更新窗口标记）。
 * - 布局约定：每个 slot 是 `<dataDir>/releases/<slot>` 目录，其可运行入口固定为
 *   `<slotDir>/dist/main.js`（由发布流程写入；bootstrap.mjs 与 Updater 共享该约定）。
 * - 写入一律「临时文件 + rename」原子落盘（0600），保证进程任意时刻崩溃都不会留下半写状态。
 * - 读取约定（与 bootstrap.mjs 内联实现保持语义一致，bootstrap 因纯 JS 运行时约束
 *   不能 import 本 TS 模块，故内联最小副本——修改此处语义时必须同步修改 bootstrap.mjs）：
 *   缺失 → 返回初始态（slot-a 为主、无版本）；损坏 → 备份为 slots.json.bad 后抛 INTERNAL。
 */
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { err } from '../errors/index.js';

/** slot 名称（固定两个：slot-a / slot-b） */
export type SlotName = 'slot-a' | 'slot-b';

/** slots.json 持久化状态（权威 Schema；bootstrap.mjs 内联实现与此保持一致） */
export interface SlotsState {
  /** 当前（尝试）运行的 slot */
  current: SlotName;
  /** 上一个 slot（回滚目标） */
  previous: SlotName;
  /** current slot 的版本；从未更新过为 null */
  version: string | null;
  /** previous slot 的版本 */
  previousVersion: string | null;
  /** 最近一次状态变更（UTC epoch ms） */
  updatedAt: number;
  /** 最近一次状态变更（UTC ISO8601） */
  updatedAtIso: string;
  /** 更新窗口标记：commit 后置 true，settle（成功确认或回滚）后置 false */
  updateInFlight: boolean;
}

/** slots 模块配置（只依赖 dataDir，便于独立于完整 Kernel 配置使用与测试） */
export interface SlotsCfg {
  /** 数据根目录（对应 HARNESS_DATA_DIR） */
  dataDir: string;
}

/** resolveBootSlot 结果：bootstrap 据此决定启动哪个入口、是否进入 degraded（无可运行发布） */
export interface BootResolution {
  /** 选中的 slot */
  slot: SlotName;
  /** 选中 slot 的版本（无可解析状态时为 null） */
  version: string | null;
  /** true = 所有 slot 都没有可运行的 dist/main.js，调用方（bootstrap）自行决定退出 */
  degraded: boolean;
}

/** slots.json 绝对路径：<dataDir>/releases/slots.json */
export function slotsPath(cfg: SlotsCfg): string {
  return path.join(cfg.dataDir, 'releases', 'slots.json');
}

/** slot 目录绝对路径：<dataDir>/releases/<slot> */
export function slotDir(cfg: SlotsCfg, slot: SlotName): string {
  return path.join(cfg.dataDir, 'releases', slot);
}

/** slot 可运行入口约定路径（dist/main.js） */
function slotMainJs(cfg: SlotsCfg, slot: SlotName): string {
  return path.join(slotDir(cfg, slot), 'dist', 'main.js');
}

/** 初始状态：从未更新过（slot-a 为主、slot-b 为回滚目标、无版本、无更新窗口） */
function initialSlotsState(): SlotsState {
  const now = Date.now();
  return {
    current: 'slot-a',
    previous: 'slot-b',
    version: null,
    previousVersion: null,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
    updateInFlight: false,
  };
}

const SLOT_NAMES: readonly SlotName[] = ['slot-a', 'slot-b'];

/** 损坏检测的最小形状校验（字段存在且类型正确；值本身按写入方信任） */
function isSlotsStateLike(v: unknown): v is SlotsState {
  if (v === null || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    SLOT_NAMES.includes(s['current'] as SlotName) &&
    SLOT_NAMES.includes(s['previous'] as SlotName) &&
    (s['version'] === null || typeof s['version'] === 'string') &&
    (s['previousVersion'] === null || typeof s['previousVersion'] === 'string') &&
    typeof s['updatedAt'] === 'number' &&
    typeof s['updatedAtIso'] === 'string' &&
    typeof s['updateInFlight'] === 'boolean'
  );
}

/**
 * 读取 slots 状态。
 *
 * - 文件缺失 → 返回初始态（不落盘；首次 writeSlots 时才创建文件）。
 * - 文件损坏（非法 JSON 或形状不符）→ 尽力把坏文件备份为 `slots.json.bad`
 *   （覆盖旧备份；备份失败不掩盖原始错误）→ 抛 INTERNAL（message: 'slots.json corrupted'）。
 * - 其他 IO 错误 → 规整为 INTERNAL 抛出。
 */
export async function readSlots(cfg: SlotsCfg): Promise<SlotsState> {
  const file = slotsPath(cfg);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return initialSlotsState();
    throw err('INTERNAL', { message: `failed to read ${file}`, cause: e });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    await backupCorruptedFile(cfg);
    throw err('INTERNAL', { message: 'slots.json corrupted', cause: e, detail: { file } });
  }
  if (!isSlotsStateLike(parsed)) {
    await backupCorruptedFile(cfg);
    throw err('INTERNAL', { message: 'slots.json corrupted', detail: { file, reason: 'shape invalid' } });
  }
  return parsed;
}

/** 尽力把损坏的 slots.json 备份为 slots.json.bad（覆盖旧备份；失败静默，不掩盖原始错误） */
async function backupCorruptedFile(cfg: SlotsCfg): Promise<void> {
  try {
    await rename(slotsPath(cfg), `${slotsPath(cfg)}.bad`);
  } catch {
    /* best-effort */
  }
}

/**
 * 原子写入 slots 状态：先写 `slots.json.tmp`（0600）再 rename 覆盖，
 * 崩溃任意时刻都不会留下半写的 slots.json（最多残留待覆盖的 .tmp）。
 * 目录不存在时递归创建。
 */
export async function writeSlots(cfg: SlotsCfg, next: SlotsState): Promise<void> {
  const file = slotsPath(cfg);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const payload = `${JSON.stringify(next, null, 2)}\n`;
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

/** 变更时间戳（UTC epoch ms + ISO8601 一起更新，保证两字段一致） */
function stamped(next: Omit<SlotsState, 'updatedAt' | 'updatedAtIso'>): SlotsState {
  const now = Date.now();
  return { ...next, updatedAt: now, updatedAtIso: new Date(now).toISOString() };
}

/**
 * 提交新 slot（由内核 Updater 在新 release 就绪后调用）：
 * current ← newSlot，previous ← 旧 current，version ← opts.version，
 * previousVersion ← 旧 version，updateInFlight=true（进入更新窗口）。
 *
 * 抛 UPDATE_IN_PROGRESS（409）：
 * - 已有更新窗口未结算（updateInFlight=true）；
 * - 或 newSlot 等于 current（无处可换，调用方 bug / 无事可做）。
 */
export async function commitNewSlot(
  cfg: SlotsCfg,
  opts: { newSlot: SlotName; version: string },
): Promise<SlotsState> {
  const cur = await readSlots(cfg);
  if (cur.updateInFlight) {
    throw err('UPDATE_IN_PROGRESS', { detail: { current: cur.current, updateInFlight: true } });
  }
  if (opts.newSlot === cur.current) {
    throw err('UPDATE_IN_PROGRESS', {
      message: 'commitNewSlot: target slot equals current slot; nothing to commit',
      detail: { current: cur.current, newSlot: opts.newSlot },
    });
  }
  const next = stamped({
    current: opts.newSlot,
    previous: cur.current,
    version: opts.version,
    previousVersion: cur.version,
    updateInFlight: true,
  });
  await writeSlots(cfg, next);
  return next;
}

/**
 * 结算更新窗口（由内核 Updater 在新 slot 健康确认或回滚后调用）。
 *
 * - ok=true：确认新 slot 健康 → updateInFlight=false；version 取 opts.version
 *   （未提供则保持 commit 时写入的版本）；current/previous 不动。
 * - ok=false：回滚 → current 与 previous 互换、updateInFlight=false；
 *   version = 回滚后 current 的版本（opts.version 优先，否则取原 previousVersion），
 *   previousVersion = 原 version（即被放弃的版本，仍留在 previous 上）。
 */
export async function markUpdateSettled(
  cfg: SlotsCfg,
  opts: { version?: string; ok: boolean },
): Promise<SlotsState> {
  const cur = await readSlots(cfg);
  let next: SlotsState;
  if (opts.ok) {
    next = stamped({
      current: cur.current,
      previous: cur.previous,
      version: opts.version ?? cur.version,
      previousVersion: cur.previousVersion,
      updateInFlight: false,
    });
  } else {
    next = stamped({
      current: cur.previous,
      previous: cur.current,
      version: opts.version ?? cur.previousVersion,
      previousVersion: cur.version,
      updateInFlight: false,
    });
  }
  await writeSlots(cfg, next);
  return next;
}

/**
 * 解析本次启动应使用的 slot（bootstrap.mjs 的内联实现与此逻辑保持一致）。
 *
 * 降级顺序：
 * 1. current 的 dist/main.js 存在 → 用 current；
 * 2. 不存在 → previous 的存在 → 用 previous；
 * 3. 仍无（含 slots.json 缺失/损坏的情况）→ 任一含 dist/main.js 的 slot（固定 a→b 扫描）；
 * 4. 全无 → degraded=true 且 slot='slot-a'（bootstrap 据此退出，交由部署层处理）。
 *
 * slots.json 损坏不抛错：引导路径必须可用，此时退化为纯文件存在性探测。
 */
export async function resolveBootSlot(cfg: SlotsCfg): Promise<BootResolution> {
  let state: SlotsState | null = null;
  try {
    state = await readSlots(cfg);
  } catch {
    state = null; // 损坏 → 退化为纯探测（见下）
  }

  const mainJsExists = async (slot: SlotName): Promise<boolean> => {
    try {
      await access(slotMainJs(cfg, slot));
      return true;
    } catch {
      return false;
    }
  };
  const versionOf = (slot: SlotName): string | null =>
    state === null ? null : slot === state.current ? state.version : state.previousVersion;

  if (state !== null) {
    if (await mainJsExists(state.current)) {
      return { slot: state.current, version: state.version, degraded: false };
    }
    if (await mainJsExists(state.previous)) {
      return { slot: state.previous, version: state.previousVersion, degraded: false };
    }
  }
  for (const slot of SLOT_NAMES) {
    if (await mainJsExists(slot)) {
      return { slot, version: versionOf(slot), degraded: false };
    }
  }
  return { slot: 'slot-a', version: null, degraded: true };
}
