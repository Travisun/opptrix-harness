/**
 * Extensions 页扩展授信（trust）UI 契约测试（静态源码断言 + 纯函数直测）。
 *
 * 覆盖：
 * - trust.ts 纯函数：isTrustRequired（403 HARNESS-3012 / EXT_TRUST_REQUIRED 识别）、
 *   trustPermissions（信任闸错误 detail.permissions 提取）、permissionLabel
 *   （权限中文映射与内核白名单全量对齐）、trustStatus / trustStatusLabel
 *   （builtin / trusted / untrusted）、BUILTIN_LOCKED_EXTS（内置锁定名单）；
 * - TrustDialog.tsx：导出组件存在 + 安全披露契约（「信任此扩展？」/ 权限 badges /
 *   danger 主按钮「我已了解风险，信任并继续」）；
 * - Extensions.tsx：引用 TrustDialog 与共享 isTrustRequired、confirmTrust:true 重试；
 * - ExtensionCard.tsx：信任状态 badge / 安全详情面板 / 内置锁定 tooltip；
 * - _shared.tsx：ExtSummary.trustedAt（内核授信时间透传）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_LOCKED_EXTS,
  KNOWN_PERMISSIONS,
  isBuiltinLockedExt,
  isTrustRequired,
  permissionLabel,
  trustPermissions,
  trustStatus,
  trustStatusLabel,
} from '../extensions/webui/ui-src/src/pages/Extensions/trust.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = join(REPO_ROOT, 'extensions', 'webui', 'ui-src', 'src');

/** 构造信任闸形状的 ApiError（与 lib/api.toApiError 的 { code, message, detail, status } 对齐） */
function trustErr(overrides: Partial<{ code: string; status: number; detail: unknown }> = {}): Record<string, unknown> {
  return {
    code: 'HARNESS-3012',
    status: 403,
    message: 'third-party extension requires manual trust confirmation',
    ...overrides,
  };
}

describe('isTrustRequired — 信任闸错误识别（403 HARNESS-3012 / EXT_TRUST_REQUIRED）', () => {
  it('403 + HARNESS-3012 / EXT_TRUST_REQUIRED 命中；其他 code / 状态码 / 非对象一律不命中', () => {
    expect(isTrustRequired(trustErr())).toBe(true);
    expect(isTrustRequired(trustErr({ code: 'EXT_TRUST_REQUIRED' }))).toBe(true);
    // 其他错误照旧 errText toast：权限不足（403 HARNESS-1007）、激活失败（500）、校验（400）
    expect(isTrustRequired(trustErr({ code: 'HARNESS-1007' }))).toBe(false);
    expect(isTrustRequired(trustErr({ status: 500 }))).toBe(false);
    expect(isTrustRequired(trustErr({ status: 400 }))).toBe(false);
    expect(isTrustRequired(trustErr({ code: 'EXT_TRUST_REQUIRED', status: 404 }))).toBe(false);
    // 非 ApiError 形状
    expect(isTrustRequired(new Error('boom'))).toBe(false);
    expect(isTrustRequired(null)).toBe(false);
    expect(isTrustRequired(undefined)).toBe(false);
    expect(isTrustRequired('403 HARNESS-3012')).toBe(false);
  });
});

describe('trustPermissions — 信任闸错误 detail.permissions 提取', () => {
  it('提取字符串权限、过滤非字符串；detail 缺失/非对象/权限非数组 → []', () => {
    const e = trustErr({
      detail: { id: 'echo-bot', permissions: ['http', 'db', 42, null], confirmHint: 'POST /api/v1/extensions/echo-bot/enable {"confirmTrust":true}' },
    });
    expect(trustPermissions(e)).toEqual(['http', 'db']);
    expect(trustPermissions(trustErr())).toEqual([]);
    expect(trustPermissions(trustErr({ detail: 'boom' }))).toEqual([]);
    expect(trustPermissions(trustErr({ detail: { permissions: 'http' } }))).toEqual([]);
    expect(trustPermissions({})).toEqual([]);
    expect(trustPermissions(null)).toEqual([]);
  });
});

describe('permissionLabel — 权限中文映射与内核白名单全量对齐', () => {
  it('KNOWN_PERMISSIONS 与内核 manifest.ts PERMISSION_WHITELIST 全等，且每项都有中文说明', () => {
    const manifestSrc = readFileSync(join(REPO_ROOT, 'src', 'kernel', 'extensions', 'manifest.ts'), 'utf8');
    const start = manifestSrc.indexOf('const PERMISSION_WHITELIST');
    const end = manifestSrc.indexOf(']);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = manifestSrc.slice(start, end);
    // 单引号字面量、至多一段冒号（排除注释里的 rpc:call:<targetExtId> 示例）
    const whitelist = [...block.matchAll(/'([a-z][a-z0-9]*(?::[a-z][a-z0-9]*)?)'/g)].map((m) => m[1] ?? '');
    const whitelistSet = new Set(whitelist);
    expect(new Set(KNOWN_PERMISSIONS)).toEqual(whitelistSet);
    for (const p of whitelistSet) {
      const label = permissionLabel(p);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(p);
      expect(label).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it('task 约定映射：db/http/llm/secrets/files 全覆盖（secrets/files 为展示别名）', () => {
    expect(permissionLabel('db')).toBe('独立数据库');
    expect(permissionLabel('http')).toBe('网络请求');
    expect(permissionLabel('llm')).toBe('模型调用');
    expect(permissionLabel('secrets')).toBe('凭据读取');
    expect(permissionLabel('files')).toBe('文件访问');
    expect(permissionLabel('files:read')).toContain('文件');
    expect(permissionLabel('files:write')).toContain('文件');
  });

  it('参数化权限按前缀带参说明（net:out:<domain> / rpc:call:<id>）；未知权限兜底非空', () => {
    expect(permissionLabel('net:out:api.example.com')).toContain('api.example.com');
    expect(permissionLabel('net:out:api.example.com')).toContain('外发');
    expect(permissionLabel('rpc:call:auth')).toContain('auth');
    expect(permissionLabel('rpc:call:auth')).toContain('RPC');
    expect(permissionLabel('totally:unknown').length).toBeGreaterThan(0);
    expect(permissionLabel('totally:unknown')).toBe('其他权限');
  });
});

describe('trustStatus — 信任状态判定（builtin / trusted / untrusted）', () => {
  it('builtin 池恒为 builtin；community 按 trustedAt 区分已授信/未授信', () => {
    expect(trustStatus({ host: 'builtin', trustedAt: null })).toBe('builtin');
    expect(trustStatus({ builtin: true, host: 'community' })).toBe('builtin');
    expect(trustStatus({ host: 'community', trustedAt: 1720000000000 })).toBe('trusted');
    expect(trustStatus({ host: 'community', trustedAt: null })).toBe('untrusted');
    expect(trustStatus({ host: 'community' })).toBe('untrusted');
  });

  it('trustStatusLabel：内置 / 已授信 / 未授信', () => {
    expect(trustStatusLabel('builtin')).toBe('内置');
    expect(trustStatusLabel('trusted')).toBe('已授信');
    expect(trustStatusLabel('untrusted')).toBe('未授信');
  });
});

describe('BUILTIN_LOCKED_EXTS — 内置锁定名单（auth / webui / doc-extract）', () => {
  it('名单恰为三个系统内置扩展，且与 repo extensions/ 目录的 manifest.builtin=true 交叉一致', () => {
    expect([...BUILTIN_LOCKED_EXTS].sort()).toEqual(['auth', 'doc-extract', 'webui']);
    for (const id of BUILTIN_LOCKED_EXTS) {
      const manifest = readFileSync(join(REPO_ROOT, 'extensions', id, 'manifest.json'), 'utf8');
      expect(manifest, `${id} manifest.builtin`).toContain('"builtin": true');
      expect(isBuiltinLockedExt(id)).toBe(true);
    }
    // 样例扩展不在锁定名单（可停用/卸载）
    expect(isBuiltinLockedExt('echo-bot')).toBe(false);
    expect(isBuiltinLockedExt('hello-world')).toBe(false);
    expect(isBuiltinLockedExt('')).toBe(false);
  });
});

describe('授信 UI 源码契约（ui-src 静态断言）', () => {
  const trustSrc = readFileSync(join(UI_SRC, 'pages', 'Extensions', 'trust.ts'), 'utf8');
  const dialogSrc = readFileSync(join(UI_SRC, 'pages', 'Extensions', 'TrustDialog.tsx'), 'utf8');
  const pageSrc = readFileSync(join(UI_SRC, 'pages', 'Extensions.tsx'), 'utf8');
  const cardSrc = readFileSync(join(UI_SRC, 'pages', 'Extensions', 'ExtensionCard.tsx'), 'utf8');

  it('TrustDialog.tsx 存在且导出 TrustDialog / TrustDialogTarget / PermissionBadges，含安全披露契约', () => {
    expect(dialogSrc).toContain('export function TrustDialog');
    expect(dialogSrc).toContain('export interface TrustDialogTarget');
    expect(dialogSrc).toContain('export function PermissionBadges');
    // 标题 + 风险警示 + 权限 badges（中文说明映射）
    expect(dialogSrc).toContain('信任此扩展？');
    expect(dialogSrc).toContain('该扩展将在隔离环境中运行，但可申请以下权限');
    expect(dialogSrc).toContain('permissionLabel');
    // danger 主按钮 + 取消
    expect(dialogSrc).toContain('我已了解风险，信任并继续');
    expect(dialogSrc).toContain('variant="destructive"');
    expect(dialogSrc).toContain('取消');
    // 扩展名 / 来源 / 版本
    expect(dialogSrc).toContain('来源：');
    expect(dialogSrc).toContain('v{target.version}');
  });

  it('Extensions.tsx 引用 TrustDialog 与共享 isTrustRequired，确认后带 confirmTrust:true 重试 enable', () => {
    expect(pageSrc).toContain("import { TrustDialog } from '@/pages/Extensions/TrustDialog'");
    expect(pageSrc).toContain('<TrustDialog');
    expect(pageSrc).toContain("from '@/pages/Extensions/trust'");
    expect(pageSrc).toContain('isTrustRequired');
    expect(pageSrc).toContain('trustPermissions');
    // 识别函数抽到共享模块，页面不再本地定义
    expect(pageSrc).not.toMatch(/function isTrustRequired/);
    // 授信重试契约：POST /:id/enable body { confirmTrust: true }（src/api/extensions.ts enableBodySchema）
    expect(pageSrc).toContain('{ confirmTrust: true }');
    expect(pageSrc).toContain('/enable`');
  });

  it('ExtensionCard 安全面板：信任状态 badge + 安全详情行展开（权限中文清单）+ 内置锁定 tooltip', () => {
    expect(cardSrc).toContain('TrustStatusBadge');
    expect(cardSrc).toContain('trustStatus');
    expect(cardSrc).toContain('安全详情');
    expect(cardSrc).toContain('PermissionBadges');
    expect(cardSrc).toContain('声明权限');
    // 内置锁定：锁定图标 + tooltip 文案 + Switch/卸载禁用（与内核 core-builtin 保护一致）
    expect(cardSrc).toContain('LockIcon');
    expect(cardSrc).toContain('系统内置，不可禁用或卸载');
    expect(cardSrc).toContain('isBuiltinLockedExt');
    expect(cardSrc).toContain('disabled={busyAction !== undefined || locked}');
  });

  it('_shared.tsx ExtSummary 透传内核 trustedAt；新改动文件全部无 console.*', () => {
    const sharedSrc = readFileSync(join(UI_SRC, 'pages', '_shared.tsx'), 'utf8');
    expect(sharedSrc).toContain('trustedAt?: number | null');
    const files: ReadonlyArray<readonly [string, string]> = [
      ['pages/Extensions/trust.ts', trustSrc],
      ['pages/Extensions/TrustDialog.tsx', dialogSrc],
      ['pages/Extensions.tsx', pageSrc],
      ['pages/Extensions/ExtensionCard.tsx', cardSrc],
    ];
    for (const [file, src] of files) {
      expect(src, `${file} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
    }
  });
});
