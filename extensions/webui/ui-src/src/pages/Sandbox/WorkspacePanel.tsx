import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftIcon,
  EyeIcon,
  FileCodeIcon,
  FolderIcon,
  RefreshCwIcon,
  SaveIcon,
  TerminalIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/pages/_shared';
import type { SandboxExecResult, SandboxFileEntry, WorkspaceInfo } from '@/pages/_shared';
import { b64OfText, errText, formatBytes, formatDuration, textOfB64 } from '@/pages/_shared';

/**
 * Sandbox/WorkspacePanel — 选中工作区的执行面板与文件面板。
 *
 * - POST /api/v1/sandbox/workspaces/:id/exec       命令输入（空格分词 ⇄ JSON 数组切换）→ 终端样式输出；
 * - GET  /api/v1/sandbox/workspaces/:id/files?path=&list=1   目录浏览（点目录进入、点文件查看）；
 * - PUT  /api/v1/sandbox/workspaces/:id/files?path= 写文件（内容 → base64）；
 * - GET  /api/v1/sandbox/workspaces/:id/files?path= 读文件（base64 → 文本回显）。
 * 路径相对家目录 /home/dev，「..」被内核拒绝。
 */

/** 空格分词（支持成对引号包裹的参数） */
function splitCommand(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out;
}

export function WorkspacePanel({
  workspace,
  onActive,
}: {
  workspace: WorkspaceInfo;
  onActive: () => void;
}): React.ReactNode {
  return (
    <div className="flex flex-col gap-4" aria-label={`工作区 ${workspace.id}`}>
      <ExecPanel workspace={workspace} onActive={onActive} />
      <FilesPanel workspace={workspace} onActive={onActive} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 执行面板
// ---------------------------------------------------------------------------

function ExecPanel({ workspace, onActive }: { workspace: WorkspaceInfo; onActive: () => void }): React.ReactNode {
  const [cmdText, setCmdText] = useState('echo hello');
  const [jsonMode, setJsonMode] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState('30000');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SandboxExecResult | null>(null);

  const run = useCallback(async (): Promise<void> => {
    let cmd: string[];
    if (jsonMode) {
      try {
        const parsed: unknown = JSON.parse(cmdText);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((p) => typeof p !== 'string')) {
          toast.error('命令数组不合法', 'JSON 数组模式需要非空的字符串数组，如 ["sh", "-c", "ls -la"]');
          return;
        }
        cmd = parsed as string[];
      } catch {
        toast.error('命令不是合法 JSON');
        return;
      }
    } else {
      cmd = splitCommand(cmdText);
      if (cmd.length === 0) {
        toast.error('请输入要执行的命令');
        return;
      }
    }
    const timeout = Number.parseInt(timeoutMs, 10);
    setRunning(true);
    setResult(null);
    try {
      const res = await api.post<SandboxExecResult>(`/api/v1/sandbox/workspaces/${encodeURIComponent(workspace.id)}/exec`, {
        cmd,
        ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
      });
      setResult(res);
      onActive(); // 刷新最近活跃时间
      if (res.timedOut) {
        toast.error('执行超时', `命令超过 ${res.durationMs} ms 被强制终止（exitCode -1），输出为已收集的部分`);
      }
    } catch (e) {
      toast.error('执行失败', errText(e));
    } finally {
      setRunning(false);
    }
  }, [cmdText, jsonMode, timeoutMs, workspace.id, onActive]);

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <TerminalIcon className="size-4" aria-hidden />
          执行命令
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          相对家目录执行
          <span className="flex items-center gap-1.5 text-[11px]">
            空格分词
            <Switch checked={jsonMode} onCheckedChange={setJsonMode} aria-label="切换 JSON 数组模式" className="scale-90" />
            JSON 数组
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={cmdText}
            onChange={(e) => setCmdText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
            }}
            placeholder={jsonMode ? '["sh", "-c", "ls -la"]' : 'ls -la / echo hello'}
            className={cn('min-h-14 flex-1 font-mono text-xs', jsonMode && 'font-mono')}
            disabled={running}
            rows={2}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="exec-timeout" className="text-muted-foreground shrink-0 text-xs">
              超时 ms
            </Label>
            <Input
              id="exec-timeout"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              inputMode="numeric"
              className="h-8 w-24 font-mono text-xs"
              disabled={running}
            />
          </div>
          <Button size="sm" onClick={() => void run()} disabled={running} className="ml-auto">
            {running ? '执行中…' : '运行'}
          </Button>
        </div>

        {/* 输出（终端样式） */}
        {running && <Skeleton className="h-24 rounded-md" />}
        {!running && result !== null && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge
                variant={result.timedOut ? 'warning' : result.exitCode === 0 ? 'success' : 'destructive'}
                className="font-mono"
              >
                exit {result.exitCode}
              </Badge>
              <span className="text-muted-foreground tabular-nums">耗时 {formatDuration(result.durationMs)}</span>
              {result.timedOut && <Badge variant="warning">已超时终止</Badge>}
            </div>
            {result.stdout !== '' && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[11px]">stdout</span>
                <CodeBlock text={result.stdout} className="max-h-56 text-foreground dark:text-emerald-300" />
              </div>
            )}
            {result.stderr !== '' && (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-[11px]">stderr</span>
                <CodeBlock text={result.stderr} className="max-h-40 text-destructive" />
              </div>
            )}
            {result.stdout === '' && result.stderr === '' && (
              <p className="text-muted-foreground text-xs italic">（无输出）</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 文件面板
// ---------------------------------------------------------------------------

function FilesPanel({ workspace, onActive }: { workspace: WorkspaceInfo; onActive: () => void }): React.ReactNode {
  const [path, setPath] = useState('.');
  const [entries, setEntries] = useState<SandboxFileEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 写文件表单 */
  const [writePath, setWritePath] = useState('');
  const [writeContent, setWriteContent] = useState('');
  const [writing, setWriting] = useState(false);
  /** 读文件 Dialog */
  const [readTarget, setReadTarget] = useState<{ path: string; text: string } | null>(null);
  const [readLoading, setReadLoading] = useState(false);

  const list = useCallback(
    async (dir: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get<SandboxFileEntry[]>(
          `/api/v1/sandbox/workspaces/${encodeURIComponent(workspace.id)}/files?list=1&path=${encodeURIComponent(dir)}`,
        );
        setEntries(res);
        setPath(dir);
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [workspace.id],
  );

  useEffect(() => {
    void list('.');
  }, [list]);

  const parentOf = (dir: string): string => {
    if (dir === '.' || dir === '' || dir === '/') return '.';
    const trimmed = dir.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx <= 0) return '.';
    return trimmed.slice(0, idx);
  };

  const readFile = useCallback(
    async (name: string): Promise<void> => {
      const full = path === '.' ? name : `${path.replace(/\/+$/, '')}/${name}`;
      setReadTarget({ path: full, text: '' });
      setReadLoading(true);
      try {
        const res = await api.get<{ path: string; contentBase64: string }>(
          `/api/v1/sandbox/workspaces/${encodeURIComponent(workspace.id)}/files?path=${encodeURIComponent(full)}`,
        );
        setReadTarget({ path: full, text: textOfB64(res.contentBase64) });
      } catch (e) {
        toast.error('读取失败', errText(e));
        setReadTarget(null);
      } finally {
        setReadLoading(false);
      }
    },
    [path, workspace.id],
  );

  const writeFile = useCallback(async (): Promise<void> => {
    const p = writePath.trim();
    if (p === '') {
      toast.error('请填写目标路径', '相对家目录（/home/dev），例如 notes/hello.txt');
      return;
    }
    if (p.includes('..')) {
      toast.error('路径不合法', '不允许包含「..」段');
      return;
    }
    setWriting(true);
    try {
      await api.put(
        `/api/v1/sandbox/workspaces/${encodeURIComponent(workspace.id)}/files?path=${encodeURIComponent(p)}`,
        { contentBase64: b64OfText(writeContent) },
      );
      toast.success('文件已写入', p);
      setWritePath('');
      setWriteContent('');
      onActive();
      await list(path);
    } catch (e) {
      toast.error('写入失败', errText(e));
    } finally {
      setWriting(false);
    }
  }, [writePath, writeContent, workspace.id, onActive, list, path]);

  const sortedEntries = (entries ?? []).slice().sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 px-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileCodeIcon className="size-4" aria-hidden />
            文件浏览
          </CardTitle>
          <CardDescription className="font-mono text-[11px]">/home/dev/{path === '.' ? '' : path}</CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon-sm"
            title="上一级"
            disabled={path === '.' || loading}
            onClick={() => void list(parentOf(path))}
          >
            <ArrowLeftIcon aria-hidden />
          </Button>
          <Button variant="outline" size="icon-sm" title="刷新" disabled={loading} onClick={() => void list(path)}>
            <RefreshCwIcon className={cn(loading && 'animate-spin')} aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {/* 路径跳转 */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void list(path.trim() === '' ? '.' : path.trim());
          }}
        >
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="路径（相对家目录，如 sub/dir）"
            className="h-8 font-mono text-xs"
            disabled={loading}
          />
          <Button type="submit" variant="outline" size="sm" disabled={loading}>
            跳转
          </Button>
        </form>

        {/* 目录列表三态 */}
        {loading && <Skeleton className="h-32 rounded-md" />}
        {!loading && error !== null && (
          <p className="text-destructive bg-destructive/5 rounded-md border border-dashed p-3 text-xs leading-relaxed">
            {error}
          </p>
        )}
        {!loading && error === null && sortedEntries.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-xs">目录为空</p>
        )}
        {!loading && error === null && sortedEntries.length > 0 && (
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border">
            {sortedEntries.map((entry) => {
              const full = path === '.' ? entry.name : `${path.replace(/\/+$/, '')}/${entry.name}`;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    className={cn(
                      'hover:bg-accent/50 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                    onClick={() => (entry.dir ? void list(full) : void readFile(entry.name))}
                  >
                    {entry.dir ? (
                      <FolderIcon className="text-amber-500 size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <FileCodeIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono" title={entry.name}>
                      {entry.name}
                      {entry.dir && '/'}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">{entry.dir ? '' : formatBytes(entry.size)}</span>
                    {!entry.dir && <EyeIcon className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* 写文件 */}
        <div className="flex flex-col gap-2 border-t pt-3">
          <Label className="text-xs font-semibold">写入文件</Label>
          <Input
            value={writePath}
            onChange={(e) => setWritePath(e.target.value)}
            placeholder="目标路径（如 notes/hello.txt）"
            className="h-8 font-mono text-xs"
            disabled={writing}
          />
          <Textarea
            value={writeContent}
            onChange={(e) => setWriteContent(e.target.value)}
            placeholder="文件内容（UTF-8 文本，按 base64 上传）"
            className="min-h-16 font-mono text-xs"
            disabled={writing}
          />
          <Button size="sm" variant="outline" onClick={() => void writeFile()} disabled={writing} className="w-fit">
            <SaveIcon aria-hidden />
            {writing ? '写入中…' : '写入'}
          </Button>
        </div>
      </CardContent>

      {/* 读文件 Dialog */}
      <Dialog open={readTarget !== null} onOpenChange={(open) => !open && setReadTarget(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="truncate font-mono text-sm">{readTarget?.path}</DialogTitle>
            <DialogDescription>文件内容（文本方式解码；二进制文件会显示乱码）</DialogDescription>
          </DialogHeader>
          {readLoading ? (
            <Skeleton className="h-40 rounded-md" />
          ) : (
            <CodeBlock text={readTarget?.text ?? ''} className="max-h-[50vh]" />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReadTarget(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
