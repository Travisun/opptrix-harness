import { Badge } from '@/components/ui/badge';

/**
 * Extensions/shared — 扩展管理页内部共享的 REST 类型视图、常量与纯函数。
 *
 * 形状与内核真值逐字段对齐：
 * - src/api/extensions.ts             REST 路由（POST /api/v1/extensions/install 追加段契约）
 * - src/kernel/extensions/installer.ts  ExtInstallResult / 受信目录保护语义
 */

/** 扩展 zip 上传大小上限（与内核 MAX_EXTENSION_ZIP_BYTES 一致，32MB） */
export const MAX_EXTENSION_ZIP_BYTES = 32 * 1024 * 1024;

/**
 * POST /api/v1/extensions/install 的 201 响应（内核 ExtensionInstallResponse 最小视图）。
 * 安装即落位、不自动启用：enabled 恒为 false，启用走既有信任确认流。
 */
export interface ExtensionInstallResponse {
  ok: boolean;
  id: string;
  /** 安装落位目录（<dataDir>/extensions/<id>） */
  dir: string;
  manifest: {
    id: string;
    version: string;
    /** 扩展 API 版本（manifest.api） */
    api: number;
    displayName?: string;
    permissions: string[];
  };
  enabled: boolean;
  overwrite: boolean;
}

/** host 池 → 徽标文案：内置池「内置」；社区池统一「本地扩展」（「社区」待市场上线再加） */
export function hostBadgeLabel(host: 'builtin' | 'community'): string {
  return host === 'builtin' ? '内置' : '本地扩展';
}

/** 重复安装错误（内核 400 BAD_REQUEST，message: 'extension id already installed, use overwrite'） */
export function isDuplicateInstallError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    (e as { status?: unknown }).status === 400 &&
    'message' in e &&
    typeof (e as { message?: unknown }).message === 'string' &&
    (e as { message: string }).message.includes('already installed')
  );
}

/** manifest 摘要的权限 chips（长权限（如 net:out:<domain>）可换行收缩，不断言布局） */
export function PermissionChips({ permissions }: { permissions: string[] }): React.ReactNode {
  if (permissions.length === 0) {
    return <span className="text-muted-foreground text-xs">（未声明权限）</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {permissions.map((p) => (
        <Badge
          key={p}
          variant="secondary"
          className="min-w-0 max-w-full break-all font-mono text-[11px] whitespace-normal"
        >
          {p}
        </Badge>
      ))}
    </div>
  );
}
