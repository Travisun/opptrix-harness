/**
 * 本地磁盘文件驱动：`<rootDir>/<relPath>` 的字节桶实现。
 *
 * 安全约定（fail-closed）：
 * - relPath 必须是 POSIX 风格相对路径；绝对路径、`..` 段、反斜杠、NUL 字节一律拒绝
 *   （`HARNESS-1008` BAD_REQUEST），杜绝路径穿越逃出 rootDir；
 * - 解析后再次用 `path.relative` 复核最终路径仍在 rootDir 内（双保险，防符号链接以外
 *   的规范化遗漏）；
 * - `delete` 对 ENOENT 幂等返回 false；`read` 对 ENOENT 抛 `HARNESS-3004`
 *   EXT_NOT_FOUND（登记错误码中语义最贴近的 404）。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { err } from '../../errors/index.js';
import type { FileDriver } from '../types.js';

/** 校验 relPath 并解析为 rootDir 内的绝对路径；越界/非法即抛 BAD_REQUEST */
function safeResolve(rootDir: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath === '') {
    throw err('BAD_REQUEST', { message: 'file path must be a non-empty relative path', detail: { relPath } });
  }
  if (relPath.includes('\0')) {
    throw err('BAD_REQUEST', { message: 'file path must not contain NUL bytes', detail: { relPath } });
  }
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || isAbsolute(relPath) || /^[a-zA-Z]:/.test(normalized)) {
    throw err('BAD_REQUEST', {
      message: 'file path must be relative (absolute paths are rejected)',
      detail: { relPath },
    });
  }
  const segments = normalized.split('/');
  if (segments.includes('..')) {
    throw err('BAD_REQUEST', {
      message: 'file path must not contain ".." segments (path traversal rejected)',
      detail: { relPath },
    });
  }
  const full = resolve(rootDir, normalized);
  const rel = relative(rootDir, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw err('BAD_REQUEST', {
      message: 'file path escapes the driver root directory (path traversal rejected)',
      detail: { relPath },
    });
  }
  return full;
}

/** ENOENT 判定 */
function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT';
}

/**
 * 创建本地磁盘驱动。
 * @param rootDir 存储根目录（绝对路径；目录本身不强制预先存在，写入时按需创建）
 */
export function createLocalDriver(rootDir: string): FileDriver {
  const root = resolve(rootDir);

  return {
    root,

    async put(relPath: string, data: Buffer): Promise<void> {
      const full = safeResolve(root, relPath);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, data);
    },

    async read(relPath: string): Promise<Buffer> {
      const full = safeResolve(root, relPath);
      try {
        return await readFile(full);
      } catch (e) {
        if (isEnoent(e)) {
          throw err('EXT_NOT_FOUND', { message: `file content missing on disk: ${relPath}`, detail: { relPath } });
        }
        throw e;
      }
    },

    async delete(relPath: string): Promise<boolean> {
      const full = safeResolve(root, relPath);
      try {
        await rm(full);
        return true;
      } catch (e) {
        if (isEnoent(e)) return false;
        throw e;
      }
    },

    async stat(relPath: string): Promise<{ size: number } | null> {
      const full = safeResolve(root, relPath);
      try {
        const st = await stat(full);
        return st.isFile() ? { size: st.size } : null;
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
    },

    async list(prefix?: string): Promise<string[]> {
      let entries: string[];
      try {
        // Node >=20.1：recursive readdir 返回相对 root 的路径串（平台分隔符）
        entries = await readdir(root, { recursive: true });
      } catch (e) {
        if (isEnoent(e)) return [];
        throw e;
      }
      const out: string[] = [];
      for (const entry of entries) {
        const rel = entry.split(sep).join('/');
        if (rel === '' || rel.endsWith('/')) continue;
        if (prefix !== undefined && !rel.startsWith(prefix)) continue;
        try {
          const st = await stat(join(root, entry));
          if (st.isFile()) out.push(rel);
        } catch {
          /* stat 失败（竞态删除/权限）跳过该条目，不让 list 整体失败 */
        }
      }
      return out.sort();
    },
  };
}
