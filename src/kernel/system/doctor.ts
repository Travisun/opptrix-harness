/**
 * doctor — 内核环境体检（运行前自检）。
 *
 * 检查项（任一失败则整体 ok=false）：
 * - dataDir：目录可创建/可写（mkdir recursive + 写删探针文件）
 * - diskSpace：dataDir 所在文件系统可用空间（statfs：bavail*bsize < 512MB 为 warn 级失败，detail 带 "warn:" 前缀）
 * - timezone：配置时区必须是合法 IANA 名称
 * - nodeVersion：Node >= 22.5（package.json engines 约束）
 * - memory：os.freemem() < 256MB 为告警级失败（detail 带 "warn:" 前缀）
 *
 * 设计约定：
 * - doctor 只诊断、不开药：返回结构化结果，是否阻断启动由调用方决定
 * - 单项检查自身抛错不算崩溃，折算为该项 ok=false 并把错误信息写进 detail
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import semver from 'semver';
import type { HarnessConfig } from '../config/index.js';

export interface DoctorCheck {
  /** 检查项标识（稳定，供上层展示/断言） */
  id: string;
  /** 是否通过 */
  ok: boolean;
  /** 面向开发者的可操作说明（告警级失败以 "warn:" 开头） */
  detail: string;
}

export interface DoctorReport {
  /** 所有检查全部通过才为 true */
  ok: boolean;
  checks: DoctorCheck[];
}

/** 磁盘可用空间下限：512MB */
const MIN_DISK_FREE_BYTES = 512 * 1024 * 1024;
/** 最低 Node 版本（与 package.json engines 对齐） */
const MIN_NODE_VERSION = '22.5.0';
/** 空闲内存告警阈值：256MB */
const MIN_FREE_MEM_BYTES = 256 * 1024 * 1024;

function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 运行全部环境体检。
 * @param cfg 内核配置（读取 dataDir / timezone）
 */
export async function runDoctor(cfg: HarnessConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    await checkDataDir(cfg),
    await checkDiskSpace(cfg),
    checkTimezone(cfg),
    checkNodeVersion(),
    checkMemory(),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** dataDir 可写：mkdir recursive + 写删探针文件 */
async function checkDataDir(cfg: HarnessConfig): Promise<DoctorCheck> {
  const id = 'dataDir';
  try {
    await fsp.mkdir(cfg.dataDir, { recursive: true });
    const probe = `${cfg.dataDir.replace(/\/+$/, '')}/.doctor-probe-${process.pid}-${Date.now()}`;
    await fsp.writeFile(probe, 'opptrix doctor probe', 'utf8');
    await fsp.rm(probe, { force: true });
    return { id, ok: true, detail: `dataDir "${cfg.dataDir}" is writable` };
  } catch (e) {
    return {
      id,
      ok: false,
      detail: `dataDir "${cfg.dataDir}" is not writable: ${errMsg(e)} — check HARNESS_DATA_DIR and directory permissions`,
    };
  }
}

/** 磁盘可用空间：statfs(dataDir)，bavail*bsize < 512MB 为 warn 级失败 */
async function checkDiskSpace(cfg: HarnessConfig): Promise<DoctorCheck> {
  const id = 'diskSpace';
  try {
    const st = await fsp.statfs(cfg.dataDir);
    const availBytes = st.bavail * st.bsize;
    if (availBytes < MIN_DISK_FREE_BYTES) {
      return {
        id,
        ok: false,
        detail: `warn: low disk space — ${bytesToMb(availBytes)}MB available on the filesystem of "${cfg.dataDir}" (minimum ${bytesToMb(MIN_DISK_FREE_BYTES)}MB)`,
      };
    }
    return { id, ok: true, detail: `${bytesToMb(availBytes)}MB available on the filesystem of "${cfg.dataDir}"` };
  } catch (e) {
    return {
      id,
      ok: false,
      detail: `cannot stat filesystem of "${cfg.dataDir}": ${errMsg(e)}`,
    };
  }
}

/** 时区有效：必须是可被 Intl 识别的 IANA 名称 */
function checkTimezone(cfg: HarnessConfig): DoctorCheck {
  const id = 'timezone';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
    return { id, ok: true, detail: `timezone "${cfg.timezone}" is a valid IANA name` };
  } catch {
    return {
      id,
      ok: false,
      detail: `invalid IANA timezone "${cfg.timezone}" — set HARNESS_TIMEZONE (e.g. "UTC", "Asia/Shanghai")`,
    };
  }
}

/** Node 版本 >= 22.5（semver 比较） */
function checkNodeVersion(): DoctorCheck {
  const id = 'nodeVersion';
  const current = process.versions.node;
  const ok = semver.gte(current, MIN_NODE_VERSION);
  return {
    id,
    ok,
    detail: ok
      ? `node ${current} satisfies >= ${MIN_NODE_VERSION}`
      : `node ${current} is below the required ${MIN_NODE_VERSION} — upgrade Node.js`,
  };
}

/** 空闲内存：os.freemem() < 256MB 为告警级失败 */
function checkMemory(): DoctorCheck {
  const id = 'memory';
  const free = os.freemem();
  if (free < MIN_FREE_MEM_BYTES) {
    return {
      id,
      ok: false,
      detail: `warn: low free memory — ${bytesToMb(free)}MB free (recommended >= ${bytesToMb(MIN_FREE_MEM_BYTES)}MB)`,
    };
  }
  return { id, ok: true, detail: `${bytesToMb(free)}MB free memory` };
}
