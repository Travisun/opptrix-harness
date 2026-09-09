import { NetworkIcon, ShieldAlertIcon, SparklesIcon, SquareTerminalIcon, MessageSquareTextIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/pages/_shared';

/**
 * Plugins/shared — 插件包管理页（W-T1）内部共享的 REST 类型视图、纯函数与最小组件。
 *
 * 形状与内核真值逐字段对齐：
 * - src/api/plugins.ts        REST 路由（GET list / POST install / GET :id / DELETE :id / POST refresh）；
 * - src/kernel/plugins/types.ts  InstalledPlugin / PluginManifest 契约。
 */

/** GET /api/v1/plugins 条目（内核 InstalledPlugin；:id 详情同形） */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 贡献的 skill 数 */
  skills: number;
  /** 贡献的 prompt 数 */
  prompts: number;
  /** 声明的 MCP server 数 */
  mcpServers: number;
  /** 声明的可执行脚本数 */
  scripts: number;
  /** 安装时间（UTC ISO8601） */
  installedAt: string;
}

/** GET /api/v1/skills 条目（内核 SkillEntry 最小视图；抽屉过滤插件贡献用） */
export interface SkillEntryView {
  id: string;
  name: string;
  description: string;
  /** builtin / data / extension（插件贡献固定为 extension） */
  source: string;
  /** 磁盘条目 = 目录路径；extension 条目 = 贡献方 id（插件为 `plugin:<插件id>`） */
  sourceRef: string;
}

/** GET /api/v1/mcp/servers 条目（内核 McpServerSummary 最小视图） */
export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable-http' | 'sse' | string;
  /** connected / disabled / error / never（连接态由内核维护，缺省视为未知） */
  state?: string;
}

/** 插件 zip 上传大小上限（与内核 MAX_PLUGIN_ZIP_BYTES 一致，64MB） */
export const MAX_PLUGIN_ZIP_BYTES = 64 * 1024 * 1024;

/** 插件贡献技能在 skillsRegistry 的贡献方 id（PluginRegistry.registerContributed 冠 `plugin:` 前缀） */
export function pluginSkillSourceRef(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * 判断 MCP 配置面 server id 是否属于某插件贡献。
 * 内核注入 id 为 `plugin:<pid>:<sid>`，集成层落 MCP 配置时经 ':'→'--' 归一为
 * `plugin--<pid>----<sid>` 形态（见 core-services toMcpConfigId）；两种形态都识别。
 */
export function isPluginMcpServerId(serverId: string, pluginId: string): boolean {
  return serverId.startsWith(`plugin--${pluginId}--`) || serverId.startsWith(`plugin:${pluginId}:`);
}

/** 安装重复错误（内核 BAD_REQUEST，message: 'plugin id already installed, use overwrite'） */
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

/** 卸载贡献闸错误（403 HARNESS-1007：贡献仍在用时未带 ?force=1） */
export function isContributionGateError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    (e as { status?: unknown }).status === 403 &&
    'code' in e &&
    (e as { code?: unknown }).code === 'HARNESS-1007'
  );
}

/** installedAt（UTC ISO8601）→ 本地时间串；非法值兜底 '—' */
export function formatInstalledAt(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? formatDateTime(ms) : '—';
}

/** 贡献计数 chips：Skills n · Prompts n · MCP n · Scripts n */
export function ContributionChips({ plugin }: { plugin: InstalledPlugin }): React.ReactNode {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge variant="secondary" className="gap-1">
        <SparklesIcon aria-hidden />
        Skills {plugin.skills}
      </Badge>
      <Badge variant="secondary" className="gap-1">
        <MessageSquareTextIcon aria-hidden />
        Prompts {plugin.prompts}
      </Badge>
      <Badge variant="secondary" className="gap-1">
        <NetworkIcon aria-hidden />
        MCP {plugin.mcpServers}
      </Badge>
      <Badge variant="secondary" className="gap-1">
        <SquareTerminalIcon aria-hidden />
        Scripts {plugin.scripts}
      </Badge>
    </div>
  );
}

/** 安全提示区（页面底部与空态共用） */
export function SecurityNotice(): React.ReactNode {
  return (
    <Alert variant="warning">
      <ShieldAlertIcon aria-hidden />
      <AlertTitle>安全提示</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1 pl-4">
          <li>插件脚本（scripts/）将在执行沙箱容器内运行，不会在宿主进程执行。</li>
          <li>MCP stdio 服务器进程在本机运行——请仅安装可信来源的插件包。</li>
        </ul>
      </AlertDescription>
    </Alert>
  );
}
