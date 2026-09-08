/**
 * cron parser（src/kernel/cron/parser.ts）单测。
 *
 * 覆盖点：
 * - validateCron：合法 5 字段 / @别名 / 6 字段秒级；非法表达式与非法时区抛 BAD_REQUEST
 * - nextCronRun：方向正确（下一次≈+1min）、tz 换算正确（epoch 比较）、DST、单调推进、永不匹配返回 null
 */
import { describe, expect, it } from 'vitest';

import { HarnessError } from '../src/kernel/errors/index.js';
import { nextCronRun, validateCron } from '../src/kernel/cron/parser.js';

/** 断言同步调用抛 BAD_REQUEST（HARNESS-1008）并返回该错误 */
function expectBadRequestSync(fn: () => unknown): HarnessError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-1008');
    expect(he.status).toBe(400);
    return he;
  }
  throw new Error('expected a BAD_REQUEST throw, but nothing was thrown');
}

/** 断言异步调用抛 BAD_REQUEST（HARNESS-1008）并返回该错误 */
async function expectBadRequestAsync(fn: () => Promise<unknown>): Promise<HarnessError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    const he = e as HarnessError;
    expect(he.code).toBe('HARNESS-1008');
    expect(he.status).toBe(400);
    return he;
  }
  throw new Error('expected a BAD_REQUEST throw, but nothing was thrown');
}

describe('validateCron', () => {
  it('合法 5 字段表达式 + 合法 IANA 时区 → 返回 void 不抛', () => {
    expect(validateCron('* * * * *', 'UTC')).toBeUndefined();
    expect(validateCron('0 12 * * *', 'Asia/Shanghai')).toBeUndefined();
    expect(validateCron('*/5 * * * *', 'America/New_York')).toBeUndefined();
    expect(validateCron('30 4 1,15 * 1-5', 'Europe/Berlin')).toBeUndefined();
  });

  it('@别名（@hourly/@daily/@weekly/@monthly/@yearly）原生支持', () => {
    for (const alias of ['@hourly', '@daily', '@weekly', '@monthly', '@yearly'] as const) {
      expect(() => validateCron(alias, 'UTC')).not.toThrow();
    }
  });

  it('croner 原生 6 字段秒级语法同样支持', () => {
    expect(validateCron('*/10 * * * * *', 'UTC')).toBeUndefined();
  });

  it('非法表达式抛 BAD_REQUEST，detail 携带 { expr, tz, cause }', () => {
    for (const expr of ['not a cron', '99 99 99 99 99', '', '* * *', '0 0 * * *@daily']) {
      const he = expectBadRequestSync(() => validateCron(expr, 'UTC'));
      expect(he.detail).toMatchObject({ expr, tz: 'UTC' });
      expect(typeof (he.detail as { cause: string }).cause).toBe('string');
    }
  });

  it('非法时区抛 BAD_REQUEST（Intl 验证，合法表达式也不放行）', () => {
    for (const tz of ['Not/AZone', '', 'Asia/FakeCity', 'GMT+8', 123 as unknown as string]) {
      const he = expectBadRequestSync(() => validateCron('* * * * *', tz));
      expect((he.detail as { tz: string }).tz).toBe(tz);
    }
  });
});

describe('nextCronRun', () => {
  it("'* * * * *' 下一次 ≈ +1min 且方向正确（对齐到下一个分钟边界）", () => {
    const from = new Date('2026-09-07T10:30:15.000Z');
    const next = nextCronRun('* * * * *', 'UTC', from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-09-07T10:31:00.000Z');
    // from 恰在分钟边界上时，返回严格更晚的下一个边界（不重复触发同一分钟）
    const atBoundary = nextCronRun('* * * * *', 'UTC', new Date('2026-09-07T10:31:00.000Z'));
    expect(atBoundary!.toISOString()).toBe('2026-09-07T10:32:00.000Z');
  });

  it("'0 12 * * *' Asia/Shanghai 与 UTC 的绝对时刻换算正确（epoch 比较）", () => {
    const from = new Date('2026-09-07T10:30:15.000Z');
    const utcNext = nextCronRun('0 12 * * *', 'UTC', from)!;
    const shNext = nextCronRun('0 12 * * *', 'Asia/Shanghai', from)!;
    // UTC：当天 12:00Z；Shanghai：钟面 12:00+08 = 04:00Z（已过当天 12 点则顺延次日）
    expect(utcNext.getTime()).toBe(Date.UTC(2026, 8, 7, 12, 0, 0));
    expect(shNext.getTime()).toBe(Date.UTC(2026, 8, 8, 4, 0, 0));
    // 同一钟面 12 点：UTC 版本在当天，Shanghai 版本（UTC+8）顺延到次日本地 12 点
    expect(shNext.getTime() - utcNext.getTime()).toBe(16 * 3_600_000);
  });

  it("'0 12 * * *' America/New_York 正确处理 DST（冬令 17:00Z / 夏令 16:00Z）", () => {
    const winter = nextCronRun('0 12 * * *', 'America/New_York', new Date('2026-01-15T00:00:00.000Z'))!;
    const summer = nextCronRun('0 12 * * *', 'America/New_York', new Date('2026-07-01T00:00:00.000Z'))!;
    expect(winter.toISOString()).toBe('2026-01-15T17:00:00.000Z'); // EST = UTC-5
    expect(summer.toISOString()).toBe('2026-07-01T16:00:00.000Z'); // EDT = UTC-4
  });

  it('单调推进：以返回值为 from 连续计算，结果严格递增', () => {
    let cursor = new Date('2026-09-07T10:30:15.000Z');
    let prev = cursor.getTime();
    for (let i = 0; i < 3; i++) {
      const next = nextCronRun('*/15 * * * *', 'UTC', cursor)!;
      expect(next.getTime()).toBeGreaterThan(prev);
      prev = next.getTime();
      cursor = next;
    }
    // 3 步后精确落在 */15 分钟边界（10:45 → 11:00 → 11:15）
    expect(cursor.toISOString()).toBe('2026-09-07T11:15:00.000Z');
  });

  it('@daily/@weekly/@monthly/@yearly 的 nextCronRun 语义正确', () => {
    const from = new Date('2026-02-01T00:00:00.000Z'); // 周日
    expect(nextCronRun('@hourly', 'UTC', from)!.toISOString()).toBe('2026-02-01T01:00:00.000Z');
    expect(nextCronRun('@daily', 'UTC', from)!.toISOString()).toBe('2026-02-02T00:00:00.000Z');
    expect(nextCronRun('@weekly', 'UTC', from)!.toISOString()).toBe('2026-02-08T00:00:00.000Z');
    expect(nextCronRun('@monthly', 'UTC', from)!.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(nextCronRun('@yearly', 'UTC', from)!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('省略 from 时基于当前时间，返回未来时刻', () => {
    const before = Date.now();
    const next = nextCronRun('0 12 * * *', 'UTC')!;
    expect(next.getTime()).toBeGreaterThan(before);
    // 今天或明天的 12:00Z，距现在不超过 25h
    expect(next.getTime() - before).toBeLessThanOrEqual(25 * 60 * 60_000 + 60_000);
  });

  it('永不匹配的表达式返回 null（如 2 月 31 日）', () => {
    expect(nextCronRun('0 0 31 2 *', 'UTC', new Date('2026-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('非法表达式 / 非法时区在 nextCronRun 同样抛 BAD_REQUEST', async () => {
    await expectBadRequestAsync(() => Promise.resolve(nextCronRun('garbage', 'UTC')));
    await expectBadRequestAsync(() => Promise.resolve(nextCronRun('* * * * *', 'No/Such/Zone')));
  });
});
