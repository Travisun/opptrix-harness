/**
 * Counters（src/kernel/system/info.ts）单测。
 *
 * 覆盖点：唯一 key 上限 10000 的保护语义——
 * 超限后新 key 的 inc 被忽略、已有 key 照常累加、process.emitWarning 只发一次。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Counters } from '../src/kernel/system/info.js';

describe('Counters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('常规语义：同 key 累加、无 tags/空 tags 退化、tags 顺序不影响 key', () => {
    const counters = new Counters();
    counters.inc('http.requests');
    counters.inc('http.requests');
    counters.inc('http.requests', {});
    counters.inc('http.requests', { route: '/health', code: '200' });
    counters.inc('http.requests', { code: '200', route: '/health' });
    const snap = counters.snapshot();
    expect(snap['http.requests']).toBe(3);
    expect(snap['http.requests{code=200,route=/health}']).toBe(2);
  });

  it('唯一 key 上限 10000：超限新 key 忽略、已有 key 累加、emitWarning 仅一次', () => {
    const counters = new Counters();
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    for (let i = 0; i < 10_000; i++) {
      counters.inc('k', { i: String(i) });
    }
    expect(Object.keys(counters.snapshot())).toHaveLength(10_000);
    expect(warnSpy).not.toHaveBeenCalled(); // 未超限不警告

    // 第 10001 个唯一 key：忽略 + 一次性警告
    counters.inc('k', { i: 'overflow' });
    expect(Object.keys(counters.snapshot())).toHaveLength(10_000);
    expect(counters.snapshot()['k{i=overflow}']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('10000');

    // 已有 key 照常累加；再次遇到新 key 不重复警告
    counters.inc('k', { i: '0' });
    counters.inc('k', { i: 'brand-new' });
    expect(counters.snapshot()['k{i=0}']).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
