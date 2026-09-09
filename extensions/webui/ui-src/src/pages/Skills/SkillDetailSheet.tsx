/**
 * Skills/SkillDetailSheet — 技能详情侧滑抽屉。
 *
 * 元信息（version/author/tags/sourceRef/bodyBytes/files）直接来自列表条目即时渲染；
 * 正文经 GET /api/v1/skills/:id 惰性获取（含 body），以保留空白的等宽 <pre> 只读
 * 展示（不引第三方 Markdown 渲染库），并提供「复制正文」（剪贴板 + execCommand 回退）。
 */
import { useCallback, useEffect, useState } from 'react';
import { CopyIcon, FileCodeIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { copyText, errText, formatBytes } from '@/pages/_shared';
import { SourceBadge, type SkillDetailView, type SkillEntryView } from './shared';

export function SkillDetailSheet({
  skill,
  onOpenChange,
}: {
  skill: SkillEntryView | null;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 失败重试计数（变更触发重新拉取） */
  const [attempt, setAttempt] = useState(0);
  const targetId = skill?.id ?? null;

  useEffect(() => {
    if (targetId === null) return;
    let alive = true;
    setLoading(true);
    setDetail(null);
    setError(null);
    api
      .get<SkillDetailView>(`/api/v1/skills/${encodeURIComponent(targetId)}`)
      .then((res) => {
        if (alive) setDetail(res);
      })
      .catch((e: unknown) => {
        if (alive) setError(errText(e)); // api 层已 toast 错误本身，这里补内联展示
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [targetId, attempt]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (detail === null) return;
    const ok = await copyText(detail.body);
    if (ok) toast.success('已复制', '技能正文已复制到剪贴板');
    else toast.error('复制失败', '当前环境不支持剪贴板访问');
  }, [detail]);

  return (
    <Sheet open={skill !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-xl">
        <SheetHeader className="gap-1.5">
          <SheetTitle className="flex flex-wrap items-center gap-2">
            <span className="truncate" title={skill?.name}>
              {skill?.name}
            </span>
            {skill !== null && <SourceBadge source={skill.source} />}
            {skill !== null && !skill.enabled && <Badge variant="warning">已停用</Badge>}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">{skill?.id}</SheetDescription>
          {skill?.description !== undefined && (
            <p className="text-muted-foreground text-sm leading-relaxed">{skill.description}</p>
          )}
        </SheetHeader>

        {skill !== null && (
          <div className="flex flex-col gap-4 px-4 pb-4">
            {/* 元信息栅格（列表条目即有，无需等待正文请求） */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-lg border p-3 text-sm sm:grid-cols-3">
              <MetaItem label="版本" value={skill.version ?? '—'} mono={skill.version !== undefined} />
              <MetaItem label="作者" value={skill.author ?? '—'} />
              <MetaItem label="正文大小" value={formatBytes(skill.bodyBytes)} mono />
              <MetaItem label="附属文件" value={`${skill.files.length} 个`} mono />
              <div className="col-span-2 flex flex-col gap-1 sm:col-span-3">
                <span className="text-muted-foreground text-xs">
                  {skill.source === 'extension' ? '贡献扩展' : '技能目录'}
                </span>
                <span className="font-mono text-xs break-all" title={skill.sourceRef}>
                  {skill.sourceRef}
                </span>
              </div>
              {skill.tags.length > 0 && (
                <div className="col-span-2 flex flex-wrap items-center gap-1 sm:col-span-3">
                  {skill.tags.map((t) => (
                    <Badge key={t} variant="secondary" className="text-[11px]">
                      {t}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* 正文（SKILL.md，剥离 frontmatter 后的 Markdown；空白保留只读展示） */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">正文（SKILL.md）</span>
                <Button variant="outline" size="sm" onClick={() => void handleCopy()} disabled={detail === null}>
                  <CopyIcon aria-hidden />
                  复制正文
                </Button>
              </div>
              {loading && (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-11/12" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-20 w-full" />
                </div>
              )}
              {!loading && error !== null && (
                <div className="text-destructive flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm">
                  <span className="flex items-center gap-1.5">
                    <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
                    正文读取失败：{error}
                  </span>
                  <Button variant="outline" size="sm" className="w-fit" onClick={() => setAttempt((a) => a + 1)}>
                    <RefreshCwIcon aria-hidden />
                    重试
                  </Button>
                </div>
              )}
              {!loading && error === null && detail !== null && (
                <pre className="bg-muted text-foreground/90 max-h-[60vh] overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                  {detail.body}
                </pre>
              )}
            </div>

            {/* 附属文件清单（v1 仅登记：不执行、不下发） */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">附属文件</span>
              {skill.files.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {skill.files.map((f) => (
                    <li key={f} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5">
                      <FileCodeIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                      <span className="truncate font-mono text-xs" title={f}>
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-xs">无附属文件（仅 SKILL.md 单文件技能包）</p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** 元信息栅格单项 */
function MetaItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={mono ? 'truncate font-mono text-xs' : 'truncate text-xs'} title={value}>
        {value}
      </span>
    </div>
  );
}
