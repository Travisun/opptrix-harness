import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRightIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
  UploadCloudIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { workspaceApi, type WorkspaceEntry } from '@/lib/api';
import { cn } from '@/lib/utils';
import { EmptyState, errText, formatBytes, formatDateTime } from '@/pages/_shared';

/**
 * WorkspacePanel — 会话工作区文件抽屉（/chat 对话区顶栏「📁 文件」入口，右侧 320px 可收起）。
 *
 * - 列表：GET workspace?path=&recursive=false 逐层懒加载（目录点击展开/收起，子级按需拉取）；
 *   每项展示 名称 / 大小 / 修改时间，行内操作：预览 / 下载 / 删除；
 * - 预览三态：图片（Dialog + <img src=file 端点>）、HTML（Dialog + iframe src=file 端点 +
 *   ?token=，报告 CSP 由端点下发）、文本（workspaceApi.read → Dialog <pre>；超长截断）；
 *   未知二进制仅提供 下载/删除；
 * - 上传：input[file] → FileReader 转 dataURL → base64 → PUT workspace/file
 *   （前端 ≤8MB 校验），成功后刷新列表 + toast；
 * - 删除：Dialog 确认 → DELETE workspace/file?path= → 刷新；
 * - 空态：EmptyState「工作区暂无文件…」。
 */

/** 上传体积上限（前端校验 8MB） */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 文本预览截断长度（防超大日志撑爆 Dialog） */
const TEXT_PREVIEW_MAX_CHARS = 200_000;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const HTML_EXTS = new Set(['html', 'htm']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'scss', 'less', 'yml', 'yaml', 'xml', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'toml', 'ini', 'cfg',
  'conf', 'env', 'properties', 'graphql', 'proto', 'vue', 'svelte', 'dockerfile', 'makefile',
]);

/** 文件预览类型：image → <img> 直链；html → iframe 直链；text → 拉取文本；null = 仅下载/删除 */
type PreviewKind = 'image' | 'html' | 'text';

function previewKind(entry: WorkspaceEntry): PreviewKind | null {
  if (entry.type !== 'file') return null;
  const ext = (entry.name.split('.').pop() ?? '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (HTML_EXTS.has(ext)) return 'html';
  // 无扩展名（Makefile/ LICENSE 等）按文本尝试；有扩展名但不在白名单 → 未知二进制
  return entry.name.includes('.') ? (TEXT_EXTS.has(ext) ? 'text' : null) : 'text';
}

export interface WorkspacePanelProps {
  /** 当前会话 id（null = 尚未落库的新对话，面板不拉数据） */
  sessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 目录展开态的懒加载子项（root 用 entries，子目录用 children[path]） */
export function WorkspacePanel({ sessionId, open, onOpenChange }: WorkspacePanelProps): React.ReactNode {
  const [rootEntries, setRootEntries] = useState<WorkspaceEntry[] | null>(null);
  const [dirChildren, setDirChildren] = useState<Map<string, WorkspaceEntry[]>>(new Map());
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<WorkspaceEntry | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 展开目录集合的 ref 镜像（reloadAll 闭包读取现值，避免陈旧闭包/频繁重建） */
  const expandedRef = useRef<Set<string>>(expandedDirs);
  expandedRef.current = expandedDirs;

  /** 单层目录懒加载 */
  const loadChildren = useCallback(
    async (dir: string): Promise<WorkspaceEntry[]> => {
      if (sessionId === null) return [];
      const res = await workspaceApi.list(sessionId, dir, false);
      return res.entries ?? [];
    },
    [sessionId],
  );

  /** 全量刷新：根列表 + 全部已展开目录（删除/上传后调用，保持展开态） */
  const reloadAll = useCallback(async (): Promise<void> => {
    if (sessionId === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const root = await loadChildren('');
      setRootEntries(root);
      const next = new Map<string, WorkspaceEntry[]>();
      for (const dir of expandedRef.current) {
        try {
          next.set(dir, await loadChildren(dir));
        } catch {
          /* 目录可能已被删：丢弃其子项缓存并折叠 */
          setExpandedDirs((prev) => {
            const nxt = new Set(prev);
            nxt.delete(dir);
            return nxt;
          });
        }
      }
      setDirChildren(next);
    } catch (e) {
      setRootEntries([]);
      setLoadError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, loadChildren]);

  // 抽屉打开 / 切换会话 → 拉取（重置展开态）；关闭 → 清缓存（下次打开重新拉新）
  useEffect(() => {
    if (open && sessionId !== null) {
      setExpandedDirs(new Set());
      setDirChildren(new Map());
      void reloadAll();
    } else if (!open) {
      setRootEntries(null);
      setDirChildren(new Map());
      setExpandedDirs(new Set());
      setLoadError(null);
    }
  }, [open, sessionId, reloadAll]);

  /** 目录展开/收起（首次展开时懒拉子级） */
  const toggleDir = (entry: WorkspaceEntry): void => {
    const dir = entry.path;
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!dirChildren.has(dir)) {
      loadChildren(dir)
        .then((entries) => {
          setDirChildren((prev) => {
            const next = new Map(prev);
            next.set(dir, entries);
            return next;
          });
        })
        .catch((e: unknown) => toast.error('目录读取失败', errText(e)));
    }
  };

  /** 打开预览：text 先拉正文，image/html 直接弹直链 */
  const openPreview = (entry: WorkspaceEntry): void => {
    const kind = previewKind(entry);
    if (kind === null || sessionId === null) return;
    setPreview(entry);
    if (kind === 'text') {
      setPreviewText(null);
      setPreviewLoading(true);
      workspaceApi
        .read(sessionId, entry.path)
        .then((text) =>
          setPreviewText(
            text.length > TEXT_PREVIEW_MAX_CHARS ? `${text.slice(0, TEXT_PREVIEW_MAX_CHARS)}\n…（已截断）` : text,
          ),
        )
        .catch((e: unknown) => {
          setPreview(null);
          toast.error('读取失败', errText(e));
        })
        .finally(() => setPreviewLoading(false));
    }
  };

  /** 上传：FileReader → dataURL → base64 → PUT（≤8MB 前端校验） */
  const upload = (file: File): void => {
    if (sessionId === null) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('上传失败', `文件超过 8MB 上限（${formatBytes(file.size)}）`);
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      void (async () => {
        try {
          await workspaceApi.write(sessionId, file.name, base64);
          toast.success('上传成功', file.name);
          await reloadAll();
        } catch (e) {
          toast.error('上传失败', errText(e));
        } finally {
          setUploading(false);
        }
      })();
    };
    reader.onerror = () => {
      setUploading(false);
      toast.error('上传失败', '本地读取文件失败');
    };
    reader.readAsDataURL(file);
  };

  const confirmDelete = async (): Promise<void> => {
    if (deleteTarget === null || sessionId === null) return;
    setDeleting(true);
    try {
      await workspaceApi.remove(sessionId, deleteTarget.path);
      toast.success('已删除', deleteTarget.path);
      setDeleteTarget(null);
      await reloadAll();
    } catch (e) {
      toast.error('删除失败', errText(e));
    } finally {
      setDeleting(false);
    }
  };

  const previewKindOf = preview !== null ? previewKind(preview) : null;
  const previewUrl = preview !== null && sessionId !== null ? workspaceApi.fileUrl(sessionId, preview.path) : '';

  /** 树行（目录 + 文件通用）；目录展开后递归渲染子行 */
  const renderRows = (entries: WorkspaceEntry[], depth: number): React.ReactNode => (
    <>
      {entries.map((entry) => {
        const isDir = entry.type === 'dir';
        const expanded = expandedDirs.has(entry.path);
        const kind = previewKind(entry);
        return (
          <Fragment key={entry.path}>
            <div
              className="group hover:bg-muted/60 flex items-center gap-1 rounded-md pr-1.5 transition-colors"
              style={{ paddingLeft: `${6 + depth * 14}px` }}
              data-path={entry.path}
            >
              {isDir ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1 py-1.5 text-left"
                  onClick={() => toggleDir(entry)}
                  aria-label={`${expanded ? '收起' : '展开'}目录 ${entry.name}`}
                >
                  <ChevronRightIcon
                    className={cn('text-muted-foreground size-3.5 shrink-0 transition-transform', expanded && 'rotate-90')}
                    aria-hidden
                  />
                  {expanded ? (
                    <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  ) : (
                    <FolderIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                  )}
                  <span className="truncate text-xs font-medium">{entry.name}</span>
                </button>
              ) : (
                <>
                  <FileIcon className="text-muted-foreground ml-5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 cursor-pointer truncate py-1.5 text-xs" onClick={() => openPreview(entry)} title={entry.path}>
                    {entry.name}
                  </span>
                </>
              )}
              <span className="text-muted-foreground hidden shrink-0 text-[10px] tabular-nums sm:inline">
                {isDir ? '' : formatBytes(entry.size)}
              </span>
              <span className="text-muted-foreground hidden shrink-0 text-[10px] tabular-nums md:inline">
                {formatDateTime(entry.mtime)}
              </span>
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                {kind !== null && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-6"
                    aria-label={`预览 ${entry.name}`}
                    onClick={() => openPreview(entry)}
                  >
                    <EyeIcon className="size-3.5" aria-hidden />
                  </Button>
                )}
                {sessionId !== null && (
                  <a
                    href={workspaceApi.fileUrl(sessionId, entry.path)}
                    download={entry.name}
                    aria-label={`下载 ${entry.name}`}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex size-6 items-center justify-center rounded-md transition-colors"
                  >
                    <DownloadIcon className="size-3.5" aria-hidden />
                  </a>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive size-6"
                  aria-label={`删除 ${entry.name}`}
                  onClick={() => setDeleteTarget(entry)}
                >
                  <Trash2Icon className="size-3.5" aria-hidden />
                </Button>
              </span>
            </div>
            {isDir && expanded && (dirChildren.get(entry.path) ?? []).length > 0 && (
              <div>{renderRows(dirChildren.get(entry.path) ?? [], depth + 1)}</div>
            )}
            {isDir && expanded && (dirChildren.get(entry.path) ?? []).length === 0 && (
              <p className="text-muted-foreground py-0.5 text-[11px]" style={{ paddingLeft: `${34 + depth * 14}px` }}>
                （空目录）
              </p>
            )}
          </Fragment>
        );
      })}
    </>
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex w-[320px] gap-0 border-l border-border p-0 sm:max-w-[320px]"
          data-slot="workspace-panel"
        >
          <SheetHeader className="border-b border-border px-4 py-3">
            <SheetTitle className="flex items-center gap-1.5 text-sm">📁 文件</SheetTitle>
            <SheetDescription className="text-xs">当前会话的工作区（子会话继承根会话工作区）</SheetDescription>
          </SheetHeader>

          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 flex-1 gap-1 px-2.5 text-xs"
              disabled={uploading || sessionId === null}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : <UploadCloudIcon className="size-3.5" aria-hidden />}
              {uploading ? '上传中…' : '上传文件'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7"
              aria-label="刷新文件列表"
              disabled={loading || sessionId === null}
              onClick={() => {
                void reloadAll();
              }}
            >
              <RefreshCwIcon className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
            </Button>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) upload(file);
                e.target.value = ''; // 允许重复选择同一文件
              }}
            />
          </div>

          <div className="flex-1 overflow-y-auto px-1.5 py-2" aria-label="工作区文件树">
            {sessionId === null ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">发送首条消息创建对话后即可使用工作区。</p>
            ) : loading && rootEntries === null ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-xs">
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
                正在加载…
              </div>
            ) : loadError !== null ? (
              <p className="text-destructive px-3 py-4 text-xs break-all">{loadError}</p>
            ) : (rootEntries ?? []).length === 0 ? (
              <EmptyState
                icon={FolderOpenIcon}
                title="工作区暂无文件"
                description="工作区暂无文件，对话中生成的报告/截图/代码产物会出现在这里"
                className="border-none px-3 py-8"
              />
            ) : (
              renderRows(rootEntries ?? [], 0)
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* 预览：图片 <img> 直链 / HTML iframe 直链（?token= 由 fileUrl 内置）/ 文本 <pre> */}
      <Dialog open={preview !== null} onOpenChange={(o) => (o ? undefined : setPreview(null))}>
        <DialogContent
          className={cn(
            'flex flex-col gap-0 overflow-hidden p-0',
            previewKindOf === 'image'
              ? 'w-[min(760px,92vw)] sm:max-w-[min(760px,92vw)]'
              : 'flex max-h-[85vh] w-[min(880px,92vw)] sm:max-w-[min(880px,92vw)]',
          )}
        >
          <DialogHeader className="min-w-0 border-b border-border px-4 py-3">
            <DialogTitle className="truncate text-sm">{preview?.name ?? '预览'}</DialogTitle>
            <DialogDescription className="text-xs">{preview?.path ?? ''}</DialogDescription>
          </DialogHeader>
          {preview !== null && previewKindOf === 'image' && (
            <div className="flex max-h-[75vh] items-center justify-center overflow-auto bg-white p-3">
              <img src={previewUrl} alt={preview.name} className="max-h-[70vh] max-w-full rounded-md object-contain" />
            </div>
          )}
          {preview !== null && previewKindOf === 'html' && (
            <iframe key={preview.path} src={previewUrl} title={`文件预览 ${preview.name}`} className="h-[68vh] w-full flex-1 bg-white" />
          )}
          {preview !== null && previewKindOf === 'text' && (
            <pre className="text-muted-foreground max-h-[70vh] flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
              {previewLoading ? '正在读取…' : (previewText ?? '')}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => (o ? undefined : setDeleteTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-sm">删除文件</DialogTitle>
            <DialogDescription className="text-xs">
              确定删除「{deleteTarget?.path ?? ''}」？该操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
