import { defineConfig } from 'vitest/config';

/**
 * vitest 配置。
 *
 * coverage（ENGINEERING.md：内核整体行覆盖率 ≥ 80%）：
 * - provider v8（@vitest/coverage-v8，与 vitest 主版本一致）
 * - 统计范围限定 src/kernel（extensions/、tools/ 由各自工作包自行保障）
 * - thresholds.lines 80：不达标 CI 直接失败（禁止用 exclude 排除文件糊弄达标；
 *   个别难覆盖分支如实保持低分并由回炉任务补测）
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/kernel/**/*.ts'],
      thresholds: {
        lines: 80,
      },
    },
  },
});
