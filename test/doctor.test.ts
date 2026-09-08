/**
 * doctor 环境体检单测。
 *
 * 环境相关检查（磁盘/内存）只断言结构完整与判定逻辑存在，
 * 不对具体 ok 值做硬断言（CI 磁盘/内存水位不可控）。
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/kernel/config/index.js';
import type { HarnessConfig } from '../src/kernel/config/index.js';
import { runDoctor } from '../src/kernel/system/doctor.js';

function makeConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      HARNESS_LOG_LEVEL: 'error',
    }),
    ...overrides,
  };
}

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'opptrix-doctor-'));
}

const ALL_CHECK_IDS = ['dataDir', 'diskSpace', 'timezone', 'nodeVersion', 'memory'];

describe('runDoctor', () => {
  it('可写的临时 dataDir：dataDir 检查通过，探针文件被清理', async () => {
    const tmp = await makeTmpDir();
    try {
      const report = await runDoctor(makeConfig({ dataDir: tmp }));

      const dataDir = report.checks.find((c) => c.id === 'dataDir');
      expect(dataDir?.ok).toBe(true);
      expect(dataDir?.detail).toContain('writable');

      // 探针文件写完即删，不残留
      const leftovers = (await fsp.readdir(tmp)).filter((e) => e.startsWith('.doctor-probe'));
      expect(leftovers).toEqual([]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('返回结构完整：五项检查 id 稳定，每项都有 id/ok/detail', async () => {
    const tmp = await makeTmpDir();
    try {
      const report = await runDoctor(makeConfig({ dataDir: tmp }));

      expect(report.checks.map((c) => c.id)).toEqual(ALL_CHECK_IDS);
      for (const check of report.checks) {
        expect(typeof check.id).toBe('string');
        expect(typeof check.ok).toBe('boolean');
        expect(typeof check.detail).toBe('string');
        expect(check.detail.length).toBeGreaterThan(0);
      }

      // 确定性判定：合法时区与满足版本的 Node 必须通过
      expect(report.checks.find((c) => c.id === 'timezone')?.ok).toBe(true);
      expect(report.checks.find((c) => c.id === 'nodeVersion')?.ok).toBe(true);

      // 磁盘/内存：只要求结构完整（ok 值依赖宿主环境，不做硬断言）
      const disk = report.checks.find((c) => c.id === 'diskSpace');
      const memory = report.checks.find((c) => c.id === 'memory');
      expect(disk).toBeDefined();
      expect(memory).toBeDefined();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('不可写的 dataDir（父路径是文件）：检查失败，整体 ok=false，detail 可操作', async () => {
    const tmp = await makeTmpDir();
    try {
      const blocker = path.join(tmp, 'not-a-dir');
      await fsp.writeFile(blocker, 'x', 'utf8');

      const report = await runDoctor(makeConfig({ dataDir: path.join(blocker, 'child') }));

      const dataDir = report.checks.find((c) => c.id === 'dataDir');
      expect(dataDir?.ok).toBe(false);
      expect(dataDir?.detail).toContain('not writable');
      expect(report.ok).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('非法时区：timezone 检查失败，整体 ok=false', async () => {
    const tmp = await makeTmpDir();
    try {
      const report = await runDoctor(makeConfig({ dataDir: tmp, timezone: 'Not/AZone' }));

      const timezone = report.checks.find((c) => c.id === 'timezone');
      expect(timezone?.ok).toBe(false);
      expect(timezone?.detail).toContain('HARNESS_TIMEZONE');
      expect(report.ok).toBe(false);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
