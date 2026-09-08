/**
 * cron parser — croner 的内核封装（纯函数，无副作用、无全局调度注册）。
 *
 * 职责：
 * - `validateCron`：校验 cron 表达式 + IANA 时区，非法抛 `BAD_REQUEST`（detail 携带 expr/tz/cause）。
 * - `nextCronRun`：计算下一次触发时刻（epoch Date），无下一次（如 `0 0 31 2 *`）返回 null。
 *
 * 表达式支持 croner 原生语法：5/6/7 字段以及 `@hourly` / `@daily` / `@weekly` /
 * `@monthly` / `@yearly` 等别名（Package-First：不自研解析，见 docs/dependencies.md）。
 *
 * 时区必须是合法 IANA 名称（经 `Intl.DateTimeFormat` 验证）。时间一律以 UTC epoch 表示。
 */
import { Cron } from 'croner';

import { err } from '../errors/index.js';

/**
 * 校验 tz 为合法 IANA 时区。
 * croner 对非法 timezone 是惰性报错（构造不抛、nextRun 才抛），
 * 因此这里显式用 Intl 前置校验，保证错误在入口处（BAD_REQUEST）暴露。
 */
function assertIanaTimezone(tz: string, expr: string): void {
  try {
    // 仅构造 formatter 即可完成时区验证，不产生格式化开销
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw err('BAD_REQUEST', {
      detail: { expr, tz, cause: `invalid IANA timezone: ${JSON.stringify(tz)}` },
    });
  }
}

/** 将任意异常规整为 BAD_REQUEST（detail 统一为 { expr, tz, cause } 形状） */
function badRequest(expr: string, tz: string, cause: unknown): never {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  throw err('BAD_REQUEST', {
    detail: { expr, tz, cause: causeMessage },
    cause,
  });
}

/**
 * 校验 cron 表达式与时区；合法返回 void，非法抛 `BAD_REQUEST`。
 *
 * - 表达式：croner 原生支持 5 字段（`* * * * *`）与 `@daily` / `@hourly` / `@weekly` /
 *   `@monthly` / `@yearly` 别名（也兼容 croner 的 6/7 字段秒级语法）。
 * - 时区：必须为合法 IANA 名称（如 `UTC`、`Asia/Shanghai`），经 Intl 验证。
 *
 * @throws HarnessError(`BAD_REQUEST`) detail 形如 `{ expr, tz, cause }`
 */
export function validateCron(expr: string, tz: string): void {
  assertIanaTimezone(tz, expr);
  try {
    // 不传回调 → 仅解析不注册任何全局调度；解析失败即表达式非法
    new Cron(expr);
  } catch (e) {
    badRequest(expr, tz, e);
  }
}

/**
 * 计算下一次触发时刻。
 *
 * @param expr  cron 表达式（5 字段或 @别名）
 * @param tz    IANA 时区（表达式按该时区的本地钟面时间匹配）
 * @param from  起算时刻（默认当前时间）；返回值严格晚于 from
 * @returns 下一次触发的 UTC Date；表达式永不匹配（如 `0 0 31 2 *`）时返回 null
 * @throws HarnessError(`BAD_REQUEST`) 表达式或时区非法
 */
export function nextCronRun(expr: string, tz: string, from?: Date): Date | null {
  assertIanaTimezone(tz, expr);
  let job: Cron;
  try {
    job = new Cron(expr, { timezone: tz });
  } catch (e) {
    badRequest(expr, tz, e);
  }
  try {
    return job.nextRun(from ?? undefined);
  } catch (e) {
    badRequest(expr, tz, e);
  }
}
