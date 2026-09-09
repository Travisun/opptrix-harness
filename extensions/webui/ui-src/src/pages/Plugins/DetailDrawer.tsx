import { useCallback, useEffect, useState } from 'react';
import {
  EyeIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  ExternalLinkIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { errText } from '@/pages/_shared';
import {
  ContributionChips,
  formatInstalledAt,
  isPluginMcpServerId,
  pluginSkillSourceRef,
} from '@/pages/Plugins/shared';
import type { InstalledPlugin, McpServerView, SkillEntryView } from '@/pages/Plugins/shared';

/**
 * DetailDrawer — 插件详情侧滑抽屉（贡献明细四段）。
 *
 * 数据来源（打开时并行拉取，各段独立容错）：
 * - GET /api/v1/plugins/:id    最新摘要（计数为准）；
 * - GET /api/v1/skills         全量技能列表 → 过滤 source=extension 且 sourceRef=`plugin:<id>`
 *                              （PluginRegistry.registerContributed 的贡献方 id），得到
 *                              技能明细（name/description）；
 * - GET /api/v1/mcp/servers    全部 MCP 配置 → 过滤 `plugin--<id>--`（':'→'--' 归一）前缀，
 *                              得到 name/transport；只读展示，管理走「MCP」页。
 * 提示词与脚本的明细清单不经 REST 暴露（仅存在于插件包 plugin.json），对应段展示计数与说明。
 */
export function PluginDetailDrawer({
  plugin,
  onClose,
}: {
  plugin: InstalledPlugin | null;
  onClose: () => void;
}): React.ReactNode {
  const open = plugin !== null;
  const [detail, setDetail] = useState<InstalledPlugin | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillEntryView[] | null>(null);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerView[] | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  /** 打开（或切换目标）时并行拉取：摘要 + 技能贡献 + MCP 贡献；关闭即清理 */
  const load = useCallback(async (pluginId: string): Promise<void> => {
    setDetail(null);
    setDetailError(null);
    setSkills(null);
    setSkillsError(null);
    setMcpServers(null);
    setMcpError(null);
    void api
      .get<InstalledPlugin>(`/api/v1/plugins/${encodeURIComponent(pluginId)}`)
      .then((res) => setDetail(res))
      .catch((e: unknown) => setDetailError(errText(e)));
    void api
      .get<SkillEntryView[]>('/api/v1/skills')
      .then((res) =>
        setSkills(
          res.filter((s) => s.source === 'extension' && s.sourceRef === pluginSkillSourceRef(pluginId)),
        ),
      )
      .catch((e: unknown) => setSkillsError(errText(e)));
    void api
      .get<McpServerView[]>('/api/v1/mcp/servers')
      .then((res) => setMcpServers(res.filter((m) => isPluginMcpServerId(m.id, pluginId))))
      .catch((e: unknown) => setMcpError(errText(e)));
  }, []);

  useEffect(() => {
    if (plugin !== null) void load(plugin.id);
  }, [plugin, load]);

  // 展示用摘要：详情未返回前回落到卡片传入的列表快照（抽屉打开时恒非空）
  const summary = detail ?? plugin;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <EyeIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{summary?.name ?? '插件详情'}</span>
            {summary !== null && (
              <Badge variant="outline" className="font-mono text-[11px]">
                v{summary.version}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">{summary?.id}</SheetDescription>
          {summary !== null && (
            <p className="text-muted-foreground text-xs">
              {summary.description !== '' ? summary.description : '（无描述）'} · 安装于{' '}
              {formatInstalledAt(summary.installedAt)}
            </p>
          )}
        </SheetHeader>

        {summary !== null && (
          <>
            {detailError !== null && <SectionError text={`摘要刷新失败：${detailError}`} />}
            <ContributionChips plugin={summary} />

            {/* 一、技能贡献（name/description 明细来自 /skills 实时过滤） */}
            <SkillSection plugin={summary} skills={skills} error={skillsError} />
            <Separator />

            {/* 二、MCP 服务器贡献（name/transport；只读，管理走 MCP 页） */}
            <McpSection plugin={summary} servers={mcpServers} error={mcpError} />
            <Separator />

            {/* 三、提示词贡献（REST 未暴露清单，展示计数） */}
            <PromptSection count={summary.prompts} />
            <Separator />

            {/* 四、脚本贡献（REST 未暴露清单，展示计数 + 沙箱提示） */}
            <ScriptSection count={summary.scripts} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** 段标题行：图标 + 名称 + 计数徽标 */
function SectionHead({
  icon: Icon,
  title,
  count,
}: {
  icon: typeof SparklesIcon;
  title: string;
  count: number;
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2">
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="text-sm font-semibold">{title}</span>
      <Badge variant="secondary" className="tabular-nums">
        {count}
      </Badge>
    </div>
  );
}

/** 段内错误行 */
function SectionError({ text }: { text: string }): React.ReactNode {
  return (
    <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

/** 段内空态行 */
function SectionEmpty({ text }: { text: string }): React.ReactNode {
  return <p className="text-muted-foreground text-xs">{text}</p>;
}

/** 一、技能贡献：清单计数 + 实时注入明细（name/description） */
function SkillSection({
  plugin,
  skills,
  error,
}: {
  plugin: InstalledPlugin;
  skills: SkillEntryView[] | null;
  error: string | null;
}): React.ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <SectionHead icon={SparklesIcon} title="技能贡献" count={plugin.skills} />
      {error !== null ? (
        <SectionError text={`技能列表加载失败：${error}（清单声明 ${plugin.skills} 条）`} />
      ) : skills === null ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-9 rounded-md" />
          <Skeleton className="h-9 rounded-md" />
        </div>
      ) : skills.length === 0 ? (
        <SectionEmpty text={plugin.skills > 0 ? '当前无注入记录（内核 refresh 后可恢复）' : '该插件未贡献技能'} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {skills.map((s) => (
            <li key={s.id} className="rounded-md border p-2.5">
              <p className="text-sm font-medium">
                {s.name}
                <span className="text-muted-foreground ml-2 font-mono text-[11px]">{s.id}</span>
              </p>
              {s.description !== '' && <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{s.description}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** MCP 连接态徽标（内核 state：connected/disabled/error/never） */
function McpStateBadge({ state }: { state: string | undefined }): React.ReactNode {
  if (state === undefined || state === '') return null;
  if (state === 'connected') return <Badge variant="success">已连接</Badge>;
  if (state === 'error') return <Badge variant="destructive">异常</Badge>;
  if (state === 'disabled') return <Badge variant="secondary">已停用</Badge>;
  return <Badge variant="outline">未连接</Badge>;
}

/** 二、MCP 服务器贡献：name + transport（只读展示，管理走 MCP 页） */
function McpSection({
  plugin,
  servers,
  error,
}: {
  plugin: InstalledPlugin;
  servers: McpServerView[] | null;
  error: string | null;
}): React.ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <SectionHead icon={NetworkIcon} title="MCP 服务器贡献" count={plugin.mcpServers} />
      {error !== null ? (
        <SectionError text={`MCP 列表加载失败：${error}（清单声明 ${plugin.mcpServers} 个）`} />
      ) : servers === null ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-9 rounded-md" />
        </div>
      ) : servers.length === 0 ? (
        <SectionEmpty text="该插件未声明 MCP 服务器" />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {servers.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2.5">
              <span className="text-sm font-medium">{m.name}</span>
              <Badge variant="outline" className="font-mono text-[11px]">
                {m.transport}
              </Badge>
              <McpStateBadge state={m.state} />
              <span className="text-muted-foreground ml-auto truncate font-mono text-[11px]" title={m.id}>
                {m.id}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
        只读展示；连接 / 启停管理请前往「MCP」页。stdio 服务器进程在本机运行。
      </p>
    </section>
  );
}

/** 三、提示词贡献：清单计数（明细不通过 REST 暴露） */
function PromptSection({ count }: { count: number }): React.ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <SectionHead icon={MessageSquareTextIcon} title="提示词贡献" count={count} />
      <SectionEmpty
        text={count > 0 ? `共 ${count} 条内联提示词；明细清单位于插件包 plugin.json（管理 API 未暴露列表）。` : '该插件未声明提示词。'}
      />
    </section>
  );
}

/** 四、脚本贡献：清单计数 + 沙箱执行提示 */
function ScriptSection({ count }: { count: number }): React.ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <SectionHead icon={SquareTerminalIcon} title="脚本贡献" count={count} />
      <SectionEmpty
        text={
          count > 0
            ? `共 ${count} 个脚本（scripts/ 目录）；仅在执行沙箱容器内运行，非宿主进程。明细位于插件包 plugin.json。`
            : '该插件未声明脚本。'
        }
      />
    </section>
  );
}
