/**
 * 数据密钥管理（secrets 落盘加密 AES-256-GCM 的根密钥）。
 *
 * 约定：
 * - 密钥文件 `<dataDir>/secret.key`：32 字节原始随机数（`randomBytes(32)`，AES-256 密钥长度）。
 * - 已存在 → 直接读取返回（幂等）；不存在 → 生成并「临时文件 + rename」原子落盘（0600），
 *   保证进程任意时刻崩溃都不会留下半写密钥。
 * - 历史文件可能带过宽权限（手工创建/旧版本写入）：读取时 chmod 0600 兜底。
 * - 密钥内容永不写入日志/错误信息；文件损坏（长度 ≠ 32）fail-fast 抛 INTERNAL，
 *   由运维从备份恢复或删除重置（删除后旧加密数据不可解密，见 secrets.ts 告警语义）。
 *
 * 装配契约：由集成方在 boot 期调用并把返回值注入 `SecretsService` 的 `secretKey`
 * （见 src/kernel/Kernel.ts 的 secrets 登记——集成接线不在本模块职责内）。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { err } from '../errors/index.js';

/** dataDir 下的数据密钥文件名 */
const KEY_FILE = 'secret.key';
/** 原子写使用的临时文件名（同目录 + rename 保证原子性） */
const KEY_TMP_FILE = `${KEY_FILE}.tmp`;
/** AES-256 密钥长度（字节） */
export const SECRET_KEY_BYTES = 32;

/**
 * 读取或创建数据密钥（幂等）。
 * @param cfg.dataDir 数据目录；密钥固定为 `<dataDir>/secret.key`
 * @returns 32 字节数据密钥
 * @throws HarnessError（INTERNAL）文件读取失败（非 ENOENT）或既有文件损坏（长度 ≠ 32）
 */
export async function loadOrCreateSecretKey(cfg: { dataDir: string }): Promise<Buffer> {
  if (typeof cfg?.dataDir !== 'string' || cfg.dataDir === '') {
    throw err('VALIDATION_FAILED', {
      message: '[secretkey] dataDir is required (non-empty string) to locate secret.key',
      detail: { dataDir: typeof cfg?.dataDir },
    });
  }
  const file = path.join(cfg.dataDir, KEY_FILE);

  let persisted: Buffer | undefined;
  try {
    persisted = await readFile(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw err('INTERNAL', {
        message: `[secretkey] failed to read secret key file "${file}" (code: ${String(code)})`,
        cause: e,
      });
    }
    // ENOENT：尚无数据密钥，走生成路径
  }

  if (persisted !== undefined) {
    if (persisted.length !== SECRET_KEY_BYTES) {
      // 损坏 fail-fast：绝不能拿错误长度的字节当 AES-256 密钥用
      throw err('INTERNAL', {
        message:
          `[secretkey] secret key file "${file}" is corrupt (expected ${SECRET_KEY_BYTES} bytes, ` +
          `got ${persisted.length}). Restore it from backup, or delete it and re-set all secrets ` +
          '(previously encrypted secrets become permanently unreadable).',
        detail: { file, bytes: persisted.length, expected: SECRET_KEY_BYTES },
      });
    }
    // 历史文件可能带过宽权限（手工创建）：chmod 0600 兜底（与 root-token 同策略）
    try {
      await chmod(file, 0o600);
    } catch (e) {
      throw err('INTERNAL', {
        message: `[secretkey] failed to tighten secret key file permissions on "${file}" (chmod 0600)`,
        cause: e,
      });
    }
    return persisted;
  }

  const key = randomBytes(SECRET_KEY_BYTES);
  await mkdir(cfg.dataDir, { recursive: true });
  const tmp = path.join(cfg.dataDir, KEY_TMP_FILE);
  await writeFile(tmp, key, { mode: 0o600 });
  // writeFile 的 mode 仅在创建时生效；显式 chmod 兜底（文件已存在/异常 umask 场景）
  await chmod(tmp, 0o600);
  // 同目录 rename：POSIX 原子替换，读方要么看到旧密钥要么看到完整新密钥
  await rename(tmp, file);
  return key;
}
