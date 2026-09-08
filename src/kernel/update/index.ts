/**
 * update — 内核升级模块出口（slots 状态层 + Updater 升级器）。
 * 使用方统一 `import { Updater, settlePendingUpdate, readSlots, ... } from '.../update/index.js'`。
 */
export {
  readSlots,
  writeSlots,
  commitNewSlot,
  markUpdateSettled,
  resolveBootSlot,
  slotDir,
  slotsPath,
} from './slots.js';
export type { SlotName, SlotsState, SlotsCfg, BootResolution } from './slots.js';

export { Updater, settlePendingUpdate } from './updater.js';
export type {
  UpdateFeed,
  UpdaterDeps,
  UpdaterNotifier,
  UpdateCheckResult,
  UpdateApplyResult,
  UpdateFailStage,
  UpdateHistoryEntry,
} from './updater.js';
