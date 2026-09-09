import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileUpIcon,
  PackageOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, errText, isApiError, isAdminRole, useMe } from '@/pages/_shared';
import { BatchImportDialog } from '@/pages/Skills/BatchImportDialog';
import { CreateSkillDialog } from '@/pages/Skills/CreateSkillDialog';
import { DeleteSkillDialog } from '@/pages/Skills/DeleteSkillDialog';
import { EditSkillDialog } from '@/pages/Skills/EditSkillDialog';
import { SkillCard } from '@/pages/Skills/SkillCard';
import { SkillDetailSheet } from '@/pages/Skills/SkillDetailSheet';
import { buildSkillDrafts, type SkillDraft } from '@/pages/Skills/dragdrop';
import { EXTRACT_ENDPOINT_UNAVAILABLE, readDroppedFiles } from '@/pages/Skills/batchImport';
import {
  SKILL_SOURCE_META,
  SKILL_SOURCE_OPTIONS,
  type SkillEntryView,
  type SkillsRefreshReportView,
  type SkillSourceView,
} from '@/pages/Skills/shared';

/**
 * Skills — 技能库管理。
 *
 * - GET  /api/v1/skills        列表（一次性返回，数据量小 → 前端过滤，不含正文）；
 * - GET  /api/v1/skills/:id    详情（含正文 body；点卡片经 Sheet 惰性拉取）；
 * - POST /api/v1/skills        新建技能（admin/root；「新建技能」弹窗，写数据卷后
 *                              内核自动 refresh → 成功后重载列表）；
 * - GET+DELETE+POST            编辑技能（admin/root；仅数据卷来源——卡片「编辑」
 *                              入口 + 弹窗按表单重建；builtin/extension 来源隐藏）；
 * - DELETE /api/v1/skills/:id  删除技能（admin/root；仅数据卷来源，卡片行操作 +
 *                              confirm 弹窗；builtin/extension 来源隐藏删除）；
 * - POST /api/v1/skills/refresh 重扫技能库（admin/root；403 → 隐藏按钮并提示）。
 *
 * 拖拽批量创建（admin/root）：页面级拖拽区（dragover 高亮）接收 .md/.markdown/
 * .txt/.pdf 等多文件 → batchImport 读取/提取文本（二进制走 POST /api/v1/extract，
 * 未接线则降级提示）→ dragdrop 纯函数构建待创建清单（frontmatter 识别 / 文件名
 * + 首段 / id 去重）→ BatchImportDialog 二次确认 → 逐文件创建 + 进度 + 汇总。
 *
 * 工具条：新建技能（admin）+ 刷新（重扫 + 重载列表）+ 来源 Select（全部/内置/
 * 数据卷/扩展）+ 标签 Select（从数据聚合）+ 搜索框（前端过滤 name/description）。
 * 顶部计数与 refresh 的 bySource 同源（对同一份 entries 聚合）。
 */

/** Select「全部」哨兵值（Radix Select 不允许空串 value） */
const ALL = 'all';

export default function SkillsPage(): React.ReactNode {
  const [skills, setSkills] = useState<SkillEntryView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 重扫（POST /refresh）忙态 */
  const [rescanning, setRescanning] = useState(false);
  /** 服务端 403（无 admin/root 角色）→ 隐藏刷新按钮并提示 */
  const [forbidden, setForbidden] = useState(false);

  /** 过滤器（列表一次拉全，前端过滤） */
  const [sourceFilter, setSourceFilter] = useState<SkillSourceView | typeof ALL>(ALL);
  const [tagFilter, setTagFilter] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  /** 详情抽屉目标（列表条目即时呈现元信息，正文由 Sheet 内部拉取） */
  const [detailTarget, setDetailTarget] = useState<SkillEntryView | null>(null);
  /** 「新建技能」弹窗开关（admin） */
  const [createOpen, setCreateOpen] = useState(false);
  /** 删除确认弹窗目标（null = 关闭；仅数据卷来源可删） */
  const [deleteTarget, setDeleteTarget] = useState<SkillEntryView | null>(null);
  /** 编辑弹窗目标（null = 关闭；仅数据卷来源可编辑，builtin/extension 隐藏入口） */
  const [editTarget, setEditTarget] = useState<SkillEntryView | null>(null);
  /** 拖拽批量导入：dragover 高亮 / 读取提取忙态 / 待创建清单 */
  const [dragActive, setDragActive] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [batchDrafts, setBatchDrafts] = useState<SkillDraft[] | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  /** 角色：refresh/新建/删除要求 admin/root（与内核 requireAdmin 对齐） */
  const { me, loading: meLoading } = useMe();
  const rescanBlocked = forbidden || (me !== null && !isAdminRole(me.role));
  const canManage = me !== null && isAdminRole(me.role);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const res = await api.get<SkillEntryView[]>('/api/v1/skills');
      setSkills(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 重扫技能库（POST /api/v1/skills/refresh）→ 成功后重载列表 */
  const handleRescan = useCallback(async (): Promise<void> => {
    setRescanning(true);
    try {
      const report = await api.post<SkillsRefreshReportView>('/api/v1/skills/refresh');
      toast.success(
        '重扫完成',
        `共 ${report.total} 个技能（内置 ${report.bySource.builtin} · 数据卷 ${report.bySource.data} · 扩展 ${report.bySource.extension}）`,
      );
      await load();
    } catch (e) {
      // api 层已 toast 错误本身；403 追加降级为隐藏按钮 + 提示
      if (isApiError(e) && e.status === 403) setForbidden(true);
    } finally {
      setRescanning(false);
    }
  }, [load]);

  /** 标签聚合（全部条目的 tags 去重排序） */
  const allTags = useMemo(
    () => [...new Set((skills ?? []).flatMap((s) => s.tags))].sort((a, b) => a.localeCompare(b)),
    [skills],
  );

  /** 既有 id 集合（拖拽批量导入的 slug 去重基线） */
  const existingIds = useMemo(() => (skills ?? []).map((s) => s.id), [skills]);

  // -------------------------------------------------------------------------
  // 拖拽批量导入（admin/root）：页面级拖拽区 → 读取/提取 → 待创建清单弹窗
  // -------------------------------------------------------------------------

  const isFileDrag = useCallback((e: React.DragEvent<HTMLDivElement>): boolean =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files'), []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragActive(true);
    },
    [isFileDrag],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); // 允许 drop（压掉浏览器默认「打开文件」）
      e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    },
    [isFileDrag],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>): void => {
      if (!isFileDrag(e)) return;
      // 仅在真正离开页面根（relatedTarget 不在容器内）时熄灭高亮
      if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false);
    },
    [isFileDrag],
  );

  /** drop → 读取/提取文本 → 构建待创建清单（frontmatter/首段/id 去重）→ 二次确认弹窗 */
  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>): Promise<void> => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragActive(false);
      // 弹窗已打开（确认/进行中）时忽略新拖入，避免污染进行中的批量状态
      if (importBusy || batchOpen) return;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (!canManage) {
        toast.error('无权批量导入', '批量创建技能需要 admin / root 角色');
        return;
      }
      setImportBusy(true);
      try {
        const inputs = await readDroppedFiles(files);
        if (inputs.some((i) => i.error === EXTRACT_ENDPOINT_UNAVAILABLE)) {
          toast.info('文本提取端点未接线', 'PDF / DOCX 等二进制文件暂时无法导入，.md / .txt 不受影响');
        }
        setBatchDrafts(buildSkillDrafts(inputs, existingIds));
        setBatchOpen(true);
      } finally {
        setImportBusy(false);
      }
    },
    [isFileDrag, canManage, existingIds, importBusy, batchOpen],
  );

  /** 按来源分布计数（与 refresh 的 bySource 同一聚合口径） */
  const counts = useMemo(() => {
    const bySource: Record<SkillSourceView, number> = { builtin: 0, data: 0, extension: 0 };
    for (const s of skills ?? []) bySource[s.source] += 1;
    return bySource;
  }, [skills]);

  /** 前端过滤：来源 + 标签 + 搜索（name/description 子串） */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (skills ?? []).filter((s) => {
      if (sourceFilter !== ALL && s.source !== sourceFilter) return false;
      if (tagFilter !== ALL && !s.tags.includes(tagFilter)) return false;
      if (q !== '' && !`${s.name}\n${s.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [skills, sourceFilter, tagFilter, search]);

  const filtersActive = sourceFilter !== ALL || tagFilter !== ALL || search.trim() !== '';

  const clearFilters = useCallback((): void => {
    setSourceFilter(ALL);
    setTagFilter(ALL);
    setSearch('');
  }, []);

  return (
    <div
      className={cn('relative flex flex-col gap-6', dragActive && 'bg-primary/5 rounded-lg')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* 拖入高亮覆盖层（拖拽文件悬停 / 读取提取中） */}
      {(dragActive || importBusy) && (
        <div
          className="border-primary/50 bg-background/80 pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed"
          aria-hidden
        >
          <FileUpIcon className="text-primary size-8" />
          <p className="text-foreground text-sm font-medium">
            {importBusy ? '正在读取文件（二进制文档提取文本中）…' : '松开以批量创建技能'}
          </p>
          <p className="text-muted-foreground text-xs">支持 .md / .markdown / .txt 与 .pdf / .docx 等文档，可多选</p>
        </div>
      )}

      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Skills 技能</h2>
          <p className="text-muted-foreground text-sm">
            Agent Skills 技能库：提示词包的发现、查看与刷新。支持把{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">.md / .txt / .pdf</code>{' '}
            等文件直接拖入页面批量创建技能。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon aria-hidden />
              新建技能
            </Button>
          )}
          {rescanBlocked ? (
            <span
              className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
              title="skills write requires role admin or root"
            >
              <ShieldCheckIcon className="size-3.5" aria-hidden />
              重扫技能库需要 admin / root 角色
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRescan()}
              disabled={rescanning || meLoading}
            >
              <RefreshCwIcon className={cn(rescanning && 'animate-spin')} aria-hidden />
              {rescanning ? '重扫中…' : '刷新'}
            </Button>
          )}
        </div>
      </div>

      {/* 工具条：来源 / 标签过滤 + 搜索 */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SkillSourceView | typeof ALL)}>
          <SelectTrigger size="sm" className="w-32" aria-label="按来源过滤">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部来源</SelectItem>
            {SKILL_SOURCE_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {SKILL_SOURCE_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tagFilter} onValueChange={setTagFilter}>
          <SelectTrigger size="sm" className="w-36" aria-label="按标签过滤">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部标签</SelectItem>
            {allTags.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative ml-auto w-full sm:w-64">
          <SearchIcon
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称或描述…"
            className="pl-8"
            aria-label="搜索技能"
          />
        </div>
      </div>

      {/* 计数行（与 refresh 的 bySource 同口径） */}
      <p className="text-muted-foreground text-sm">
        共 <span className="text-foreground font-medium tabular-nums">{counts.builtin + counts.data + counts.extension}</span>{' '}
        个技能
        <span className="mx-1.5">·</span>内置 <span className="tabular-nums">{counts.builtin}</span>
        <span className="mx-1.5">·</span>数据卷 <span className="tabular-nums">{counts.data}</span>
        <span className="mx-1.5">·</span>扩展 <span className="tabular-nums">{counts.extension}</span>
        {filtersActive && (
          <>
            <span className="mx-1.5">·</span>
            匹配 <span className="text-foreground font-medium tabular-nums">{filtered.length}</span> 个
          </>
        )}
      </p>

      {/* 加载骨架 */}
      {loading && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      )}

      {/* 错误态 */}
      {!loading && error !== null && (
        <EmptyState icon={TriangleAlertIcon} title="技能列表加载失败" description={error}>
          <Button size="sm" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden />
            重试
          </Button>
        </EmptyState>
      )}

      {/* 空态：引导放置 SKILL.md 目录后重扫 */}
      {!loading && error === null && (skills?.length ?? 0) === 0 && (
        <EmptyState
          icon={PackageOpenIcon}
          title="暂无技能"
          description={
            <>
              将 SKILL.md 目录放置于{' '}
              <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">&lt;dataDir&gt;/skills/&lt;id&gt;/</code> 或
              仓库 <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">skills/</code> 目录，点击「刷新」重扫。
            </>
          }
        >
          {!rescanBlocked && (
            <Button size="sm" onClick={() => void handleRescan()} disabled={rescanning}>
              <RefreshCwIcon className={cn(rescanning && 'animate-spin')} aria-hidden />
              {rescanning ? '重扫中…' : '刷新'}
            </Button>
          )}
        </EmptyState>
      )}

      {/* 过滤无匹配 */}
      {!loading && error === null && (skills?.length ?? 0) > 0 && filtered.length === 0 && (
        <EmptyState icon={SearchIcon} title="没有匹配的技能" description="调整来源、标签或搜索关键词后再试。">
          <Button size="sm" variant="outline" onClick={clearFilters}>
            清除过滤
          </Button>
        </EmptyState>
      )}

      {/* 技能卡片网格（数据卷来源 + admin 追加悬浮「编辑」入口，与行内「删除」一致化） */}
      {!loading && error === null && filtered.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((skill) => (
            <div key={skill.id} className="relative">
              <SkillCard
                skill={skill}
                onOpen={() => setDetailTarget(skill)}
                // 行操作「删除」：仅数据卷来源 + admin（builtin 只读、extension 驻留内存，均不可删）
                onDelete={canManage && skill.source === 'data' ? () => setDeleteTarget(skill) : undefined}
              />
              {canManage && skill.source === 'data' && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`编辑技能 ${skill.name}`}
                  title="编辑该技能（数据卷目录）"
                  className="text-muted-foreground hover:text-foreground absolute right-4 bottom-3"
                  onClick={() => setEditTarget(skill)}
                >
                  <PencilIcon aria-hidden />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 详情抽屉 */}
      <SkillDetailSheet skill={detailTarget} onOpenChange={(open) => !open && setDetailTarget(null)} />

      {/* 新建技能（admin；POST 成功后内核已 refresh → 直接重载列表） */}
      <CreateSkillDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => void load()} />

      {/* 删除确认（admin；仅数据卷来源；DELETE 成功后内核已 refresh → 重载列表） */}
      <DeleteSkillDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={() => void load()} />

      {/* 编辑（admin；仅数据卷来源；保存 = DELETE+POST，内核均已 refresh → 重载列表） */}
      <EditSkillDialog target={editTarget} onClose={() => setEditTarget(null)} onSaved={() => void load()} />

      {/* 拖拽批量创建（admin；待创建清单二次确认 → 逐文件创建 → 汇总 + 重载列表） */}
      <BatchImportDialog
        open={batchOpen}
        drafts={batchDrafts ?? []}
        onOpenChange={(next) => {
          setBatchOpen(next);
          if (!next) setBatchDrafts(null);
        }}
        onCreated={() => void load()}
      />
    </div>
  );
}
