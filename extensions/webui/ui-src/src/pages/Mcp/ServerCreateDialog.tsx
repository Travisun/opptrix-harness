/**
 * ServerCreateDialog — 「添加服务器」Dialog（POST /api/v1/mcp/servers）。
 *
 * 顶部两个 Tab：
 * - 「表单填写」：字段与内核 mcpCreateBodySchema 同规则的前端校验（ui-src 未引入
 *   zod → 手工镜像）——名称（必填 1..200）与可选 id（留空按名称 slug 生成；须匹配
 *   ^[a-z0-9][a-z0-9_-]*$ 且不与既有重复）；传输 Select 三值：stdio | streamable-http | sse；
 *   stdio → command（必填）+ args（空格分词、支持引号）+ env（键值对编辑器）；
 *   streamable-http / sse → URL（必填，http/https）+ headers（键值对编辑器，可选）；
 *   超时 ms 可选（整数 ∈ [1000, 600000]，缺省内核 30s）。
 * - 「粘贴 JSON 配置」：三种粘贴形状自动识别（Mcp/json-import.ts 纯函数）——
 *   ① 单服务器对象 {transport|type, command|url, args?, env?, headers?}（兼容
 *     Claude Desktop / Cursor 的 type 词汇，'http' → streamable-http）→ 识别成功
 *     填充表单字段并切回表单 Tab + 摘要提示；识别失败内联列出缺失字段；
 *   ② {mcpServers:{<id>:{...}}}（Claude Desktop 官方格式）→ 展开为多选列表勾选导入
 *     （逐个 POST，id 与既有/本批次自动去重，成功/失败分计数）；
 *   ③ 已是本系统形状（transport 词汇 + name/id/timeoutMs）。
 *
 * 连接语义：POST 只落盘配置，不会自动连接 —— 创建成功后提示到列表显式「连接」。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BracesIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText } from '@/pages/_shared';
import {
  describeDraft,
  dedupeId,
  argsToText,
  parsePastedServerConfig,
  type ImportCandidate,
  type PastedServerDraft,
} from '@/pages/Mcp/json-import';
import {
  MCP_ID_PATTERN,
  MCP_TIMEOUT_MAX_MS,
  MCP_TIMEOUT_MIN_MS,
  MCP_TRANSPORTS,
  KeyValueEditor,
  entriesOf,
  isValidHttpUrl,
  recordOfEntries,
  slugifyId,
  toastApiError,
  tokenizeArgs,
  type KeyValueEntry,
  type McpTransport,
} from '@/pages/Mcp/shared';

const EMPTY_DRAFT = {
  name: '',
  idText: '',
  transport: 'stdio' as McpTransport,
  command: '',
  argsText: '',
  envEntries: [{ key: '', value: '' }] as KeyValueEntry[],
  url: '',
  headerEntries: [{ key: '', value: '' }] as KeyValueEntry[],
  timeoutText: '',
};

/** 表单草稿 → POST body（校验失败返回 null 并 toast 首个问题，风格同 Cron 页） */
function draftToBody(
  draft: typeof EMPTY_DRAFT,
  existingIds: string[],
): { id: string; body: Record<string, unknown> } | null {
  const name = draft.name.trim();
  if (name === '') {
    toast.error('请填写服务器名称');
    return null;
  }
  if (name.length > 200) {
    toast.error('服务器名称过长', '名称需在 1-200 个字符之间');
    return null;
  }
  const id = draft.idText.trim() === '' ? slugifyId(name) : draft.idText.trim();
  if (!MCP_ID_PATTERN.test(id)) {
    toast.error(
      'id 不合法',
      'id 需匹配 ^[a-z0-9][a-z0-9_-]*$（小写字母/数字开头，仅小写字母、数字、下划线、连字符）',
    );
    return null;
  }
  if (id.length > 64) {
    toast.error('id 过长', 'id 最长 64 个字符');
    return null;
  }
  if (existingIds.includes(id)) {
    toast.error('id 已存在', `已有服务器占用 id「${id}」— 换一个 id，或删除后重建`);
    return null;
  }
  const body: Record<string, unknown> = { id, name, transport: draft.transport };
  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (command === '') {
      toast.error('stdio 传输需要填写 command', 'command 为要 spawn 的可执行文件（绝对路径或 PATH 可解析名）');
      return null;
    }
    if (command.length > 2048) {
      toast.error('command 过长', 'command 最长 2048 个字符');
      return null;
    }
    body['command'] = command;
    const args = tokenizeArgs(draft.argsText);
    if (args.length > 128) {
      toast.error('args 过多', 'args 最多 128 个参数');
      return null;
    }
    if (args.length > 0) body['args'] = args;
    const env = recordOfEntries(draft.envEntries);
    if (!env.ok) {
      toast.error('env 存在重复键', env.message);
      return null;
    }
    if (Object.keys(env.value).length > 0) body['env'] = env.value;
  } else {
    const url = draft.url.trim();
    if (url === '') {
      toast.error(`${draft.transport === 'sse' ? 'sse' : 'streamable-http'} 传输需要填写 URL`, 'URL 为 server 端的 http/https 端点');
      return null;
    }
    if (!isValidHttpUrl(url)) {
      toast.error('URL 不合法', 'URL 必须以 http:// 或 https:// 开头且可解析');
      return null;
    }
    body['url'] = url;
    const headers = recordOfEntries(draft.headerEntries);
    if (!headers.ok) {
      toast.error('headers 存在重复键', headers.message);
      return null;
    }
    if (Object.keys(headers.value).length > 0) body['headers'] = headers.value;
  }
  const timeoutText = draft.timeoutText.trim();
  if (timeoutText !== '') {
    const timeout = Number(timeoutText);
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout)) {
      toast.error('超时不合法', `超时需为整数毫秒（${MCP_TIMEOUT_MIN_MS} - ${MCP_TIMEOUT_MAX_MS}）`);
      return null;
    }
    if (timeout < MCP_TIMEOUT_MIN_MS || timeout > MCP_TIMEOUT_MAX_MS) {
      toast.error('超时超出允许区间', `timeoutMs 允许 ${MCP_TIMEOUT_MIN_MS} - ${MCP_TIMEOUT_MAX_MS} 毫秒`);
      return null;
    }
    body['timeoutMs'] = timeout;
  }
  return { id, body };
}

/** 导入候选 → POST body（识别阶段已校验形状；name 缺省回退为 id） */
function bodyFromDraft(draft: PastedServerDraft, id: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id,
    name: draft.name !== '' ? draft.name : id,
    transport: draft.transport,
  };
  if (draft.transport === 'stdio') {
    body['command'] = draft.command;
    if (draft.args.length > 0) body['args'] = draft.args;
    if (Object.keys(draft.env).length > 0) body['env'] = draft.env;
  } else {
    body['url'] = draft.url;
    if (Object.keys(draft.headers).length > 0) body['headers'] = draft.headers;
  }
  if (draft.timeoutMs !== null) body['timeoutMs'] = draft.timeoutMs;
  return body;
}

export function ServerCreateDialog({
  open,
  onOpenChange,
  existingIds,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 既有 server id（前端重复 id 预检，避免 400 往返） */
  existingIds: string[];
  onCreated: (id: string) => Promise<void> | void;
}): React.ReactNode {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  /** 顶部 Tab：表单填写 | 粘贴 JSON 配置 */
  const [mode, setMode] = useState<'form' | 'paste'>('form');
  /** 粘贴区文本 */
  const [pasteText, setPasteText] = useState('');
  /** 粘贴识别失败（内联报错：message + 缺失字段清单） */
  const [pasteError, setPasteError] = useState<{ message: string; missing: string[] } | null>(null);
  /** 形状② mcpServers 候选（多选导入） */
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [skippedNote, setSkippedNote] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  // 每次打开重置为空表单与粘贴态（避免上一次的草稿残留）
  useEffect(() => {
    if (open) {
      setDraft(EMPTY_DRAFT);
      setMode('form');
      setPasteText('');
      setPasteError(null);
      setCandidates(null);
      setSkippedNote(null);
      setSelectedIds(new Set());
      setSubmitting(false);
    }
  }, [open]);

  const isRemote = draft.transport !== 'stdio';

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      const parsed = draftToBody(draft, existingIds);
      if (parsed === null) return;
      setSubmitting(true);
      try {
        // POST /api/v1/mcp/servers → 201 配置；只落盘不连接（连接显式走 /connect）
        await api.post('/api/v1/mcp/servers', parsed.body, { silent: true });
        toast.success(
          '已保存配置（未连接）',
          `「${draft.name.trim()}」仅写入配置，需在列表中点击「连接」建立会话`,
        );
        onOpenChange(false);
        await onCreated(parsed.id);
      } catch (err) {
        toastApiError(err, '创建失败');
      } finally {
        setSubmitting(false);
      }
    },
    [draft, existingIds, onCreated, onOpenChange],
  );

  /** 粘贴识别：单服务器 → 填充表单并切回表单 Tab；mcpServers → 多选候选列表 */
  const handleParse = useCallback((): void => {
    setPasteError(null);
    setCandidates(null);
    setSkippedNote(null);
    const res = parsePastedServerConfig(pasteText);
    if (!res.ok) {
      setPasteError({ message: res.message, missing: res.missing });
      return;
    }
    if (res.kind === 'single') {
      const d = res.draft;
      setDraft({
        name: d.name,
        idText: d.id ?? '',
        transport: d.transport,
        command: d.command,
        argsText: argsToText(d.args),
        envEntries: entriesOf(d.env).length > 0 ? entriesOf(d.env) : [{ key: '', value: '' }],
        url: d.url,
        headerEntries: entriesOf(d.headers).length > 0 ? entriesOf(d.headers) : [{ key: '', value: '' }],
        timeoutText: d.timeoutMs !== null ? String(d.timeoutMs) : '',
      });
      setMode('form');
      toast.success('识别成功，已填充表单', res.summary);
      return;
    }
    setCandidates(res.candidates);
    setSelectedIds(new Set(res.candidates.map((c) => c.id)));
    setSkippedNote(res.skipped.length > 0 ? res.skipped.join('；') : null);
  }, [pasteText]);

  /** 批量导入勾选候选：逐个 POST（id 与既有/本批次去重），成功/失败分计数 */
  const handleImport = useCallback(async (): Promise<void> => {
    if (candidates === null) return;
    const chosen = candidates.filter((c) => selectedIds.has(c.id));
    if (chosen.length === 0) {
      toast.info('未勾选任何条目', '勾选要导入的服务器后再试');
      return;
    }
    setImporting(true);
    const usedIds = new Set(existingIds);
    const imported: string[] = [];
    const failed: string[] = [];
    try {
      for (const candidate of chosen) {
        const id = dedupeId(candidate.draft.id ?? candidate.id, [...usedIds]);
        try {
          await api.post('/api/v1/mcp/servers', bodyFromDraft(candidate.draft, id), { silent: true });
          usedIds.add(id);
          imported.push(id);
        } catch (e) {
          failed.push(`${candidate.draft.name || candidate.id}（${errText(e)}）`);
        }
      }
    } finally {
      setImporting(false);
    }
    if (imported.length > 0) {
      toast.success(
        `已导入 ${imported.length} 个服务器（未连接）`,
        `${imported.join('、')} — 需在列表中显式「连接」建立会话`,
      );
      onOpenChange(false);
      await onCreated(imported[0] ?? '');
    }
    if (failed.length > 0) {
      toast.error(`${failed.length} 个条目导入失败`, failed.slice(0, 2).join('；'));
    }
  }, [candidates, selectedIds, existingIds, onCreated, onOpenChange]);

  const toggleCandidate = (id: string, checked: boolean): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
          <DialogDescription>
            保存仅写入配置（不自动连接）；创建后请在列表中显式「连接」以拉取工具/资源/提示目录。
          </DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(value) => setMode(value === 'paste' ? 'paste' : 'form')}>
          <TabsList>
            <TabsTrigger value="form">表单填写</TabsTrigger>
            <TabsTrigger value="paste">粘贴 JSON 配置</TabsTrigger>
          </TabsList>

          {/* ── Tab 1：表单填写 ── */}
          <TabsContent value="form">
            <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mcp-name">名称</Label>
                  <Input
                    id="mcp-name"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="例如 GitHub MCP"
                    disabled={submitting}
                    maxLength={200}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mcp-transport">传输</Label>
                  <Select
                    value={draft.transport}
                    onValueChange={(value) => setDraft({ ...draft, transport: value as McpTransport })}
                    disabled={submitting}
                  >
                    <SelectTrigger id="mcp-transport" className="w-full">
                      <SelectValue placeholder="选择传输形态" />
                    </SelectTrigger>
                    <SelectContent>
                      {MCP_TRANSPORTS.map((t) => (
                        <SelectItem key={t} value={t} className="font-mono">
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-id">id（可选，留空按名称生成）</Label>
                <Input
                  id="mcp-id"
                  value={draft.idText}
                  onChange={(e) => setDraft({ ...draft, idText: e.target.value })}
                  placeholder={slugifyId(draft.name) || '例如 github-mcp'}
                  disabled={submitting}
                  maxLength={64}
                  className="font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">小写字母/数字开头，仅小写字母、数字、下划线、连字符；创建后不可变更。</p>
              </div>

              {isRemote ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-url">URL</Label>
                    <Input
                      id="mcp-url"
                      value={draft.url}
                      onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                      placeholder="https://example.com/mcp"
                      disabled={submitting}
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      required
                    />
                    <p className="text-muted-foreground text-xs">
                      需以 http:// 或 https:// 开头；鉴权头可在下方 headers 或创建后经「编辑」补充。
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>headers（可选，随每次请求发送，可含 Authorization）</Label>
                    <KeyValueEditor
                      entries={draft.headerEntries}
                      onChange={(headerEntries) => setDraft({ ...draft, headerEntries })}
                      disabled={submitting}
                      keyPlaceholder="键，如 Authorization"
                      valuePlaceholder="值，如 Bearer xxx"
                      addLabel="添加请求头"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-command">command</Label>
                    <Input
                      id="mcp-command"
                      value={draft.command}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      placeholder="npx 或 /usr/local/bin/server"
                      disabled={submitting}
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      required
                    />
                    <p className="text-muted-foreground text-xs">stdio 传输必填：要 spawn 的可执行文件（绝对路径或 PATH 可解析名）。</p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mcp-args">args（可选，空格分词，支持引号）</Label>
                    <Input
                      id="mcp-args"
                      value={draft.argsText}
                      onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                      placeholder={'-y @modelcontextprotocol/server-github --verbose'}
                      disabled={submitting}
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-muted-foreground text-xs">
                      分词示例：`--msg &quot;hello world&quot;` → ['--msg', 'hello world']。
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>env（可选，追加到最小安全环境之后）</Label>
                    <KeyValueEditor
                      entries={draft.envEntries}
                      onChange={(envEntries) => setDraft({ ...draft, envEntries })}
                      disabled={submitting}
                      keyPlaceholder="键，如 GITHUB_TOKEN"
                      valuePlaceholder="值"
                      addLabel="添加环境变量"
                    />
                  </div>
                </>
              )}

              <div className="flex flex-col gap-2">
                <Label htmlFor="mcp-timeout">超时 ms（可选，缺省 30000）</Label>
                <Input
                  id="mcp-timeout"
                  type="number"
                  value={draft.timeoutText}
                  onChange={(e) => setDraft({ ...draft, timeoutText: e.target.value })}
                  placeholder="30000"
                  disabled={submitting}
                  min={MCP_TIMEOUT_MIN_MS}
                  max={MCP_TIMEOUT_MAX_MS}
                  step={1000}
                  className="font-mono"
                />
                <p className="text-muted-foreground text-xs">单次 MCP RPC 预算，允许 {MCP_TIMEOUT_MIN_MS} - {MCP_TIMEOUT_MAX_MS} 毫秒。</p>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? '保存中…' : '保存配置'}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          {/* ── Tab 2：粘贴 JSON 配置（三形状自动识别） ── */}
          <TabsContent value="paste" className="flex flex-col gap-3">
            <Textarea
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                if (pasteError !== null) setPasteError(null);
              }}
              placeholder={`单服务器：{ "type": "http", "url": "https://example.com/mcp" }\n或 Claude Desktop：{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "server-github"] } } }`}
              disabled={importing}
              className="min-h-40 font-mono text-xs"
              spellCheck={false}
              aria-label="粘贴 JSON 配置"
            />

            {pasteError !== null && (
              <div className="text-destructive flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs" role="alert">
                <span>{pasteError.message}</span>
                {pasteError.missing.length > 0 && (
                  <ul className="text-destructive/90 list-disc pl-4">
                    {pasteError.missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {candidates !== null && (
              <div className="flex flex-col gap-2">
                <p className="text-xs">
                  识别为 <span className="font-medium">mcpServers 批量配置</span>
                  ：{candidates.length} 个可导入 — 勾选要导入的条目：
                </p>
                <div className="flex flex-col gap-1.5">
                  {candidates.map((candidate) => (
                    <label
                      key={candidate.id}
                      className="hover:bg-muted/50 flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(candidate.id)}
                        onChange={(e) => toggleCandidate(candidate.id, e.target.checked)}
                        disabled={importing}
                        className="mt-0.5 size-4 shrink-0"
                        aria-label={`导入 ${candidate.draft.name || candidate.id}`}
                      />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">
                          {candidate.draft.name || candidate.id}
                          <span className="text-muted-foreground ml-2 font-mono text-xs">{candidate.id}</span>
                        </span>
                        <span className="text-muted-foreground truncate font-mono text-xs">
                          {describeDraft(candidate.draft)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {skippedNote !== null && (
                  <p className="text-muted-foreground text-xs">跳过无法识别的条目：{skippedNote}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={importing}>
                取消
              </Button>
              <Button
                type="button"
                onClick={candidates === null ? handleParse : () => void handleImport()}
                disabled={importing || pasteText.trim() === '' || (candidates !== null && selectedIds.size === 0)}
              >
                <BracesIcon className={cn(importing && 'animate-pulse')} aria-hidden />
                {candidates === null ? '解析配置' : importing ? '导入中…' : `导入所选（${selectedIds.size}）`}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              兼容 Claude Desktop / Cursor 导出（type: stdio / sse / http 自动映射）、mcpServers 批量格式与本系统形状。
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
