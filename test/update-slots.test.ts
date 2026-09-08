/**
 * A/B slot 状态管理（src/kernel/update/slots.ts）单测。
 *
 * 覆盖点（对应任务规格 ≥12 用例）：
 * - 路径布局：slotsPath / slotDir
 * - 初始态：文件缺失 → slot-a/slot-b 初始值，且不落盘
 * - 读写往返：writeSlots → readSlots 深等值；原子性（.tmp 不残留、嵌套目录创建、0600 权限）
 * - commitNewSlot：current/previous 交换、updateInFlight 标记、版本随 commit 更新、
 *   更新窗口冲突（UPDATE_IN_PROGRESS 409）与同 slot 提交拒绝
 * - markUpdateSettled：ok / 回滚两态（含显式 version 覆盖）
 * - 损坏文件：非法 JSON 与形状不符 → INTERNAL（HARNESS-9003，'slots.json corrupted'）
 *   且产生 slots.json.bad 备份（保留坏内容原文）
 * - resolveBootSlot 五分支：current 可用 / current 缺用 previous / 双缺用任一
 *  （slots.json 缺失或损坏时）/ 全缺 degraded / 损坏 json 不抛错并降级
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import {
  commitNewSlot,
  markUpdateSettled,
  readSlots,
  resolveBootSlot,
  slotDir,
  slotsPath,
  writeSlots,
  type SlotsState,
} from '../src/kernel/update/slots.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'harness-slots-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  // 兜底：清理 mkdtemp 残留（正常情况下 afterEach 已清理）
  void rm(path.join(tmpdir(), 'harness-slots-'), { recursive: true, force: true });
});

/** 构造一个完整合法的 SlotsState（覆盖全部字段的显式基线） */
function makeState(overrides: Partial<SlotsState> = {}): SlotsState {
  const now = Date.now();
  return {
    current: 'slot-a',
    previous: 'slot-b',
    version: '1.0.0',
    previousVersion: null,
    updatedAt: now,
    updatedAtIso: new Date(now).toISOString(),
    updateInFlight: false,
    ...overrides,
  };
}

/** 落一个空的 dist/main.js 占位（只测存在性，不真正执行） */
async function seedMainJs(slot: 'slot-a' | 'slot-b'): Promise<string> {
  const file = path.join(slotDir({ dataDir }, slot), 'dist', 'main.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '// stub main\n', 'utf8');
  return file;
}

/** 断言抛出 INTERNAL（HARNESS-9003）并返回该错误 */
async function expectInternal(p: Promise<unknown>): Promise<HarnessError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-9003');
    expect(he.status).toBe(500);
    return he;
  }
  throw new Error('expected an INTERNAL throw, but nothing was thrown');
}

/** 断言抛出 UPDATE_IN_PROGRESS（HARNESS-8004, 409） */
async function expectUpdateInProgress(p: Promise<unknown>): Promise<HarnessError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-8004');
    expect(he.status).toBe(409);
    return he;
  }
  throw new Error('expected an UPDATE_IN_PROGRESS throw, but nothing was thrown');
}

describe('slots 路径布局', () => {
  it('slotsPath = <dataDir>/releases/slots.json，slotDir = <dataDir>/releases/<slot>', () => {
    expect(slotsPath({ dataDir })).toBe(path.join(dataDir, 'releases', 'slots.json'));
    expect(slotDir({ dataDir }, 'slot-a')).toBe(path.join(dataDir, 'releases', 'slot-a'));
    expect(slotDir({ dataDir }, 'slot-b')).toBe(path.join(dataDir, 'releases', 'slot-b'));
  });
});

describe('readSlots 初始态', () => {
  it('文件缺失 → 初始 {current:slot-a, previous:slot-b, version:null, updateInFlight:false}，且不落盘', async () => {
    const before = Date.now();
    const state = await readSlots({ dataDir });

    expect(state.current).toBe('slot-a');
    expect(state.previous).toBe('slot-b');
    expect(state.version).toBeNull();
    expect(state.previousVersion).toBeNull();
    expect(state.updateInFlight).toBe(false);
    expect(state.updatedAt).toBeGreaterThanOrEqual(before);
    expect(state.updatedAtIso).toBe(new Date(state.updatedAt).toISOString());

    // 初始态是纯读语义：不创建 slots.json
    await expect(stat(slotsPath({ dataDir }))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('writeSlots 原子写', () => {
  it('读写往返：writeSlots → readSlots 深等值（全字段）', async () => {
    const state = makeState({
      current: 'slot-b',
      previous: 'slot-a',
      version: '2.3.1',
      previousVersion: '2.3.0',
      updateInFlight: true,
    });
    await writeSlots({ dataDir }, state);
    await expect(readSlots({ dataDir })).resolves.toEqual(state);
  });

  it('原子性：写入成功后无 slots.json.tmp 残留；嵌套目录自动创建', async () => {
    // dataDir 下无 releases/，writeSlots 需递归创建
    await writeSlots({ dataDir }, makeState({ version: '9.9.9' }));

    const file = slotsPath({ dataDir });
    await expect(stat(file)).resolves.toBeTruthy();
    await expect(stat(`${file}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('文件权限 0600', async () => {
    await writeSlots({ dataDir }, makeState());
    const st = await stat(slotsPath({ dataDir }));
    // 提取权限位（st.mode 低 9 位）
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe('commitNewSlot', () => {
  it('交换：current←newSlot、previous←旧 current、version←新版本、previousVersion←旧版本、updateInFlight=true', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0', updateInFlight: false }));
    const before = Date.now();

    const next = await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' });

    expect(next.current).toBe('slot-b');
    expect(next.previous).toBe('slot-a');
    expect(next.version).toBe('2.0.0');
    expect(next.previousVersion).toBe('1.0.0');
    expect(next.updateInFlight).toBe(true);
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
    expect(next.updatedAtIso).toBe(new Date(next.updatedAt).toISOString());

    // 持久化生效
    await expect(readSlots({ dataDir })).resolves.toEqual(next);
  });

  it('更新窗口未结算时抛 UPDATE_IN_PROGRESS（HARNESS-8004, 409），状态不被修改', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0', updateInFlight: true }));

    await expectUpdateInProgress(commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' }));

    const state = await readSlots({ dataDir });
    expect(state.current).toBe('slot-a');
    expect(state.version).toBe('1.0.0');
    expect(state.updateInFlight).toBe(true);
  });

  it('newSlot 等于 current 时抛 UPDATE_IN_PROGRESS，状态不被修改', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0', updateInFlight: false }));

    await expectUpdateInProgress(commitNewSlot({ dataDir }, { newSlot: 'slot-a', version: '2.0.0' }));

    const state = await readSlots({ dataDir });
    expect(state.current).toBe('slot-a');
    expect(state.previous).toBe('slot-b');
    expect(state.version).toBe('1.0.0');
    expect(state.updateInFlight).toBe(false);
  });
});

describe('markUpdateSettled', () => {
  it('ok=true：updateInFlight=false、version 保持 commit 版本、current/previous 不动', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0' }));
    await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' });

    const settled = await markUpdateSettled({ dataDir }, { ok: true });

    expect(settled.current).toBe('slot-b');
    expect(settled.previous).toBe('slot-a');
    expect(settled.version).toBe('2.0.0');
    expect(settled.previousVersion).toBe('1.0.0');
    expect(settled.updateInFlight).toBe(false);
  });

  it('ok=true 且显式 version：version 被覆盖为显式值', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0' }));
    await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' });

    const settled = await markUpdateSettled({ dataDir }, { ok: true, version: '2.0.1' });

    expect(settled.version).toBe('2.0.1');
    expect(settled.updateInFlight).toBe(false);
  });

  it('ok=false 回滚：current/previous 互换、version=回滚后 current 的版本（原 previousVersion）', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0' }));
    await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' });

    const rolled = await markUpdateSettled({ dataDir }, { ok: false });

    expect(rolled.current).toBe('slot-a');
    expect(rolled.previous).toBe('slot-b');
    expect(rolled.version).toBe('1.0.0');
    expect(rolled.previousVersion).toBe('2.0.0'); // 被放弃的版本留在 previous 上
    expect(rolled.updateInFlight).toBe(false);
  });

  it('ok=false 且显式 version：version 取显式值，updateInFlight 清除', async () => {
    await writeSlots({ dataDir }, makeState({ version: '1.0.0' }));
    await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '2.0.0' });

    const rolled = await markUpdateSettled({ dataDir }, { ok: false, version: '1.0.5' });

    expect(rolled.current).toBe('slot-a');
    expect(rolled.version).toBe('1.0.5');
    expect(rolled.updateInFlight).toBe(false);
  });
});

describe('readSlots 损坏检测', () => {
  it('非法 JSON → INTERNAL（HARNESS-9003, "slots.json corrupted"）且坏文件备份为 slots.json.bad', async () => {
    const bad = '{not valid json!!';
    await mkdir(path.dirname(slotsPath({ dataDir })), { recursive: true });
    await writeFile(slotsPath({ dataDir }), bad, 'utf8');

    const he = await expectInternal(readSlots({ dataDir }));
    expect(he.message).toBe('slots.json corrupted');

    // 坏文件被移走并保留原文于 .bad
    await expect(stat(slotsPath({ dataDir }))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${slotsPath({ dataDir })}.bad`, 'utf8')).resolves.toBe(bad);

    // 备份后回到初始态（可恢复）
    const state = await readSlots({ dataDir });
    expect(state.current).toBe('slot-a');
  });

  it('形状不符的合法 JSON → 同样按损坏处理（INTERNAL + .bad 备份）', async () => {
    const bad = JSON.stringify({ hello: 'world', current: 42 });
    await mkdir(path.dirname(slotsPath({ dataDir })), { recursive: true });
    await writeFile(slotsPath({ dataDir }), bad, 'utf8');

    const he = await expectInternal(readSlots({ dataDir }));
    expect(he.message).toBe('slots.json corrupted');
    await expect(readFile(`${slotsPath({ dataDir })}.bad`, 'utf8')).resolves.toBe(bad);
  });
});

describe('resolveBootSlot 五分支', () => {
  it('分支1：current 的 dist/main.js 存在 → 用 current（version 为 current 版本）', async () => {
    await seedMainJs('slot-a');
    await writeSlots({ dataDir }, makeState({ current: 'slot-a', previous: 'slot-b', version: '1.0.0' }));

    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-a',
      version: '1.0.0',
      degraded: false,
    });
  });

  it('分支2：current 缺 dist/main.js、previous 有 → 用 previous（version 为 previousVersion）', async () => {
    await seedMainJs('slot-b');
    await writeSlots(
      { dataDir },
      makeState({
        current: 'slot-a',
        previous: 'slot-b',
        version: '2.0.0',
        previousVersion: '1.0.0',
        updateInFlight: true,
      }),
    );

    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-b',
      version: '1.0.0',
      degraded: false,
    });
  });

  it('分支3：slots.json 缺失但任一 slot 含 dist/main.js → 用该 slot（a→b 固定序），version=null', async () => {
    await seedMainJs('slot-b'); // 只有 slot-b 可运行，slots.json 不存在

    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-b',
      version: null,
      degraded: false,
    });
  });

  it('分支3（损坏 json）：slots.json 损坏不抛错，降级为文件存在性探测', async () => {
    await mkdir(path.dirname(slotsPath({ dataDir })), { recursive: true });
    await writeFile(slotsPath({ dataDir }), '###corrupted###', 'utf8');
    await seedMainJs('slot-a');

    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-a',
      version: null,
      degraded: false,
    });
  });

  it('分支4：current/previous 均缺 dist/main.js（且无其他可用 slot）→ degraded=true、slot=slot-a、version=null', async () => {
    await writeSlots({ dataDir }, makeState({ current: 'slot-a', previous: 'slot-b', version: '1.0.0' }));

    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-a',
      version: null,
      degraded: true,
    });
  });

  it('分支4（全空）：无 slots.json、无任何 release → degraded=true', async () => {
    await expect(resolveBootSlot({ dataDir })).resolves.toEqual({
      slot: 'slot-a',
      version: null,
      degraded: true,
    });
  });
});

describe('版本随 commit/settled 演进（端到端）', () => {
  it('初始 → commit → settle(ok) 全程版本与 slot 演进正确', async () => {
    // 初始（从未更新）
    expect((await readSlots({ dataDir })).version).toBeNull();

    // 第一次 commit：slot-a → slot-b @ 1.0.0
    const committed = await commitNewSlot({ dataDir }, { newSlot: 'slot-b', version: '1.0.0' });
    expect(committed.version).toBe('1.0.0');
    expect(committed.previousVersion).toBeNull();
    expect(committed.updateInFlight).toBe(true);

    // 健康确认
    const settled = await markUpdateSettled({ dataDir }, { ok: true });
    expect(settled.version).toBe('1.0.0');
    expect(settled.updateInFlight).toBe(false);

    // 第二次 commit：slot-b → slot-a @ 2.0.0，随后回滚 → 回到 slot-b @ 1.0.0
    await commitNewSlot({ dataDir }, { newSlot: 'slot-a', version: '2.0.0' });
    const rolled = await markUpdateSettled({ dataDir }, { ok: false });
    expect(rolled.current).toBe('slot-b');
    expect(rolled.version).toBe('1.0.0');
    expect(rolled.previousVersion).toBe('2.0.0');
    expect(rolled.updateInFlight).toBe(false);
  });
});
