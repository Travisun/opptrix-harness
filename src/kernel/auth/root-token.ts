import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import path from 'node:path';

import { err } from '../errors/HarnessError.js';

/** dataDir 下的 root 令牌文件名 */
const TOKEN_FILE = 'root-token';
/** 原子写使用的临时文件名（同目录 + rename 保证原子性） */
const TOKEN_TMP_FILE = `${TOKEN_FILE}.tmp`;
/** HARNESS_TOKEN 显式注入时的最短长度（64 位 hex 令牌为 64 字符） */
const MIN_ENV_TOKEN_LENGTH = 32;

export interface EnsureRootTokenCfg {
  /** 环境注入的 break-glass root 令牌；非空则优先使用（trim 后长度 <32 抛 VALIDATION_FAILED） */
  token: string;
  dataDir: string;
  /** 生成新令牌时是否持久化到 <dataDir>/root-token */
  persistRootToken: boolean;
}

export type RootTokenSource = 'env' | 'persisted' | 'generated';

/**
 * 解析 root 令牌（break-glass）。优先级：
 * 1. cfg.token trim 后非空 → 直接使用（source 'env'）；长度 <32 抛 VALIDATION_FAILED
 *    （错误信息含 openssl 生成指引）；
 * 2. `<dataDir>/root-token` 存在且非空 → 使用（source 'persisted'），并 chmod 0600 兜底
 *    （修复历史落盘时权限过宽的文件）；
 * 3. 生成 64 位 hex 随机令牌；cfg.persistRootToken 时先写 `<dataDir>/root-token.tmp`
 *    （mode 0600）再 rename 为目标文件，保证读方要么看到旧文件要么看到完整新文件
 *    （source 'generated'）。
 *
 * 令牌内容永不写入日志/错误信息。
 */
export async function ensureRootToken(
  cfg: EnsureRootTokenCfg,
): Promise<{ token: string; source: RootTokenSource }> {
  const envToken = cfg.token.trim();
  if (envToken !== '') {
    if (envToken.length < MIN_ENV_TOKEN_LENGTH) {
      throw err('VALIDATION_FAILED', {
        message:
          `[root-token] HARNESS_TOKEN is set but too short (${envToken.length} chars; minimum ${MIN_ENV_TOKEN_LENGTH}). ` +
          'Generate a strong token with `openssl rand -hex 32` and set HARNESS_TOKEN=<value>, ' +
          'or unset it to let the kernel generate and persist one.',
        detail: { env: 'HARNESS_TOKEN', minLength: MIN_ENV_TOKEN_LENGTH, actualLength: envToken.length },
      });
    }
    return { token: envToken, source: 'env' };
  }

  const file = path.join(cfg.dataDir, TOKEN_FILE);
  let persisted: string | undefined;
  try {
    const raw = await readFile(file, 'utf8');
    const trimmed = raw.trim();
    if (trimmed !== '') persisted = trimmed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err('INTERNAL', {
        message: `failed to read root token file "${file}" (code: ${String(code)})`,
        cause: e,
      });
    }
    // ENOENT：尚无持久化令牌，走生成路径
  }
  if (persisted !== undefined) {
    // 历史文件可能带过宽权限（旧版本写入/手工创建）：chmod 0600 兜底，失败不阻断启动
    try {
      await chmod(file, 0o600);
    } catch (e) {
      throw err('INTERNAL', {
        message: `failed to tighten root token file permissions on "${file}" (chmod 0600)`,
        cause: e,
      });
    }
    return { token: persisted, source: 'persisted' };
  }

  const token = randomBytes(32).toString('hex');
  if (cfg.persistRootToken) {
    await mkdir(cfg.dataDir, { recursive: true });
    const tmp = path.join(cfg.dataDir, TOKEN_TMP_FILE);
    await writeFile(tmp, `${token}\n`, { mode: 0o600 });
    // writeFile 的 mode 仅在创建时生效；显式 chmod 兜底（文件已存在/异常 umask 场景）
    await chmod(tmp, 0o600);
    // 同目录 rename：POSIX 原子替换，读方不会看到半写文件
    await rename(tmp, file);
  }
  return { token, source: 'generated' };
}
