/**
 * runtime-profile 内核测试（全部注入 os/env，机器无关——任何核数/内存的宿主机上结果一致）。
 *
 * - 三档画像对照：1 核（全下限收敛）/ 2 核 / 4 核 / 16 核 → 各默认值与 ARCHITECTURE.md
 *   「并发模型」小节的对照表一致；
 * - clamp 边界：64 核封顶（taskWorkers→16、maxConcurrent→64、perParent→16）、
 *   cpus 0/负数注入 → ≥1 下限、8 核恰在 ×8 上界；
 * - 小机保护：内存 <2GB → taskWorkers/并发减半（下限 1），恰 2GB 不减半；
 * - env 覆盖：UV_THREADPOOL_SIZE > NODE_OPTIONS(--uv-threadpool-size) > 建议值；非法值忽略；
 * - config 接线：taskWorkers 缺省 = 画像值，HARNESS_TASK_WORKERS 显式设置仍最高优先，
 *   非法 env 仍 fail-fast；
 * - manager 接线：DEFAULT_MAX_CONCURRENT = 画像值，SubagentManager 缺省即画像值，
 *   显式传入仍优先。
 */
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MAX_CONCURRENT, SubagentManager } from '../src/kernel/agents/manager.js';
import type { SubagentRecord, SubagentStoreLike } from '../src/kernel/agents/types.js';
import { loadConfig } from '../src/kernel/config/index.js';
import { HarnessError } from '../src/kernel/errors/index.js';
import { detectRuntimeProfile } from '../src/kernel/runtime-profile.js';

const GB = 1024 ** 3;
const logger = pino({ level: 'silent' });

/** 极小内存（512MB）+ 指定核数的 os 注入：小机保护必然触发 */
const withMem = (cpus: number, totalMemBytes: number) => ({ cpus, totalMemBytes });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('detectRuntimeProfile — 核数三档画像对照', () => {
  it('1 核：全部收敛到下限（单核自动收敛）', () => {
    const p = detectRuntimeProfile({}, withMem(1, 8 * GB));
    expect(p).toEqual({
      cpus: 1,
      memTotalGB: 8,
      taskWorkers: 1,
      subagentMaxConcurrent: 8, // clamp(1*8, 8, 64) 下限兜底
      subagentMaxPerParent: 4, // clamp(1*2, 4, 16) 下限兜底
      uvThreadpoolSize: 1, // clamp(4, 4, 1) 上限收紧到核数
    });
  });

  it('2 核：等待型并发 ×8 放大，perParent 恰在下界', () => {
    const p = detectRuntimeProfile({}, withMem(2, 8 * GB));
    expect(p.taskWorkers).toBe(2);
    expect(p.subagentMaxConcurrent).toBe(16);
    expect(p.subagentMaxPerParent).toBe(4); // 2*2=4 恰在 clamp 下界
    expect(p.uvThreadpoolSize).toBe(2);
  });

  it('4 核：uvThreadpool 达到建议基线 4', () => {
    const p = detectRuntimeProfile({}, withMem(4, 8 * GB));
    expect(p.taskWorkers).toBe(4);
    expect(p.subagentMaxConcurrent).toBe(32);
    expect(p.subagentMaxPerParent).toBe(8);
    expect(p.uvThreadpoolSize).toBe(4);
  });

  it('16 核：等待型并发封顶 64，perParent 封顶 16', () => {
    const p = detectRuntimeProfile({}, withMem(16, 8 * GB));
    expect(p.taskWorkers).toBe(16);
    expect(p.subagentMaxConcurrent).toBe(64); // 16*8=128 → 封顶 64
    expect(p.subagentMaxPerParent).toBe(16); // 16*2=32 → 封顶 16
    expect(p.uvThreadpoolSize).toBe(4);
  });
});

describe('detectRuntimeProfile — clamp 边界', () => {
  it('64 核：taskWorkers 封顶 16（对齐 HARNESS_TASK_WORKERS env 区间），并发封顶', () => {
    const p = detectRuntimeProfile({}, withMem(64, 8 * GB));
    expect(p.cpus).toBe(64);
    expect(p.taskWorkers).toBe(16);
    expect(p.subagentMaxConcurrent).toBe(64);
    expect(p.subagentMaxPerParent).toBe(16);
    expect(p.uvThreadpoolSize).toBe(4);
  });

  it('8 核：maxConcurrent 恰在 ×8 上界（64，不封顶触发）', () => {
    const p = detectRuntimeProfile({}, withMem(8, 8 * GB));
    expect(p.subagentMaxConcurrent).toBe(64);
    expect(p.subagentMaxPerParent).toBe(16); // 8*2=16 恰在上界
  });

  it('cpus 0 / 负数 / 非整数注入 → ≥1 下限（容器异常环境防御）', () => {
    for (const cpus of [0, -3, 1.5]) {
      const p = detectRuntimeProfile({}, withMem(cpus, 8 * GB));
      expect(p.cpus, `cpus=${cpus}`).toBe(1);
      expect(p.taskWorkers).toBe(1);
      expect(p.subagentMaxConcurrent).toBe(8);
      expect(p.subagentMaxPerParent).toBe(4);
      expect(p.uvThreadpoolSize).toBe(1);
    }
  });
});

describe('detectRuntimeProfile — 小机内存保护（<2GB 减半）', () => {
  it('4 核 1.5GB：taskWorkers/并发全部减半，uv 建议值不动', () => {
    const p = detectRuntimeProfile({}, withMem(4, 1.5 * GB));
    expect(p.memTotalGB).toBe(1.5);
    expect(p.taskWorkers).toBe(2); // 4 → 2
    expect(p.subagentMaxConcurrent).toBe(16); // 32 → 16
    expect(p.subagentMaxPerParent).toBe(4); // 8 → 4
    expect(p.uvThreadpoolSize).toBe(4); // 建议（回读值）不减半
  });

  it('恰 2GB 不减半；2GB−1 字节减半（严格小于阈值）', () => {
    const exact = detectRuntimeProfile({}, withMem(4, 2 * GB));
    expect(exact.taskWorkers).toBe(4);
    expect(exact.subagentMaxConcurrent).toBe(32);
    const under = detectRuntimeProfile({}, withMem(4, 2 * GB - 1));
    expect(under.taskWorkers).toBe(2);
    expect(under.subagentMaxConcurrent).toBe(16);
  });

  it('1 核 1GB：减半不穿透下限（taskWorkers 不为 0）', () => {
    const p = detectRuntimeProfile({}, withMem(1, 1 * GB));
    expect(p.taskWorkers).toBe(1);
    expect(p.subagentMaxConcurrent).toBe(4); // 8 → 4
    expect(p.subagentMaxPerParent).toBe(2); // 4 → 2
  });
});

describe('detectRuntimeProfile — env 覆盖（uvThreadpoolSize）', () => {
  it('UV_THREADPOOL_SIZE 显式设置 → 如实回读（clamp 1..1024），且优先于 NODE_OPTIONS', () => {
    const p = detectRuntimeProfile(
      { UV_THREADPOOL_SIZE: '16', nodeOptions: '--uv-threadpool-size=32' },
      withMem(4, 8 * GB),
    );
    expect(p.uvThreadpoolSize).toBe(16);
    const capped = detectRuntimeProfile({ UV_THREADPOOL_SIZE: '9999' }, withMem(4, 8 * GB));
    expect(capped.uvThreadpoolSize).toBe(1024); // libuv 硬上限
  });

  it('NODE_OPTIONS 的 --uv-threadpool-size（= 与空格两种形态）→ 覆盖建议值', () => {
    expect(detectRuntimeProfile({ nodeOptions: '--uv-threadpool-size=32' }, withMem(4, 8 * GB)).uvThreadpoolSize).toBe(32);
    expect(detectRuntimeProfile({ nodeOptions: '--max-old-space-size=4096 --uv-threadpool-size 24' }, withMem(4, 8 * GB)).uvThreadpoolSize).toBe(24);
    // NODE_OPTIONS 无该标志 → 回落建议值
    expect(detectRuntimeProfile({ nodeOptions: '--max-old-space-size=4096' }, withMem(4, 8 * GB)).uvThreadpoolSize).toBe(4);
  });

  it('非法覆盖值（0/负数/小数/非数字/空串）→ 忽略，回落建议值', () => {
    for (const bad of ['0', '-2', '12.5', 'abc', '']) {
      const p = detectRuntimeProfile({ UV_THREADPOOL_SIZE: bad }, withMem(4, 8 * GB));
      expect(p.uvThreadpoolSize, `UV_THREADPOOL_SIZE="${bad}"`).toBe(4);
    }
  });

  it('无参调用读真实 process.env（stub UV_THREADPOOL_SIZE=9 → 9）', () => {
    vi.stubEnv('UV_THREADPOOL_SIZE', '9');
    const p = detectRuntimeProfile(undefined, withMem(4, 8 * GB));
    expect(p.uvThreadpoolSize).toBe(9);
  });
});

describe('config 接线：taskWorkers 缺省 = 画像值，env 仍最高优先', () => {
  it('空 env → loadConfig().taskWorkers === detectRuntimeProfile().taskWorkers', () => {
    expect(loadConfig({}).taskWorkers).toBe(detectRuntimeProfile().taskWorkers);
  });

  it('HARNESS_TASK_WORKERS 显式设置 → 覆盖画像缺省（最高优先）', () => {
    expect(loadConfig({ HARNESS_TASK_WORKERS: '2' }).taskWorkers).toBe(2);
  });

  it('HARNESS_TASK_WORKERS 非法值仍 fail-fast（VALIDATION_FAILED）', () => {
    try {
      loadConfig({ HARNESS_TASK_WORKERS: '0' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      expect((e as HarnessError).code).toBe('HARNESS-1009');
      expect((e as HarnessError).message).toContain('HARNESS_TASK_WORKERS');
    }
  });
});

describe('manager 接线：缺省并发 = 画像值', () => {
  /** 最小 store 替身（manager 缺省值路径不会触库） */
  const storeStub: SubagentStoreLike = {
    create: async (_rec: SubagentRecord) => undefined,
    get: async () => null,
    list: async () => [],
    update: async () => undefined,
  };

  it('DEFAULT_MAX_CONCURRENT === 画像 subagentMaxConcurrent（常量名保持不变）', () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(detectRuntimeProfile().subagentMaxConcurrent);
  });

  it('SubagentManager 未显式传 maxConcurrent → 缺省即画像值', () => {
    const manager = new SubagentManager({
      store: storeStub,
      runner: async () => undefined,
      logger,
    });
    expect(manager.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(manager.maxConcurrent).toBeGreaterThanOrEqual(8); // clamp 下限兜底不因画像而破
  });

  it('显式传入 maxConcurrent 仍优先于画像缺省', () => {
    const manager = new SubagentManager({
      store: storeStub,
      runner: async () => undefined,
      logger,
      maxConcurrent: 3,
    });
    expect(manager.maxConcurrent).toBe(3);
  });
});
