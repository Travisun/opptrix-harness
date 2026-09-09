/**
 * ServerCreateDialog — 「添加服务器」Dialog（POST /api/v1/mcp/servers）。
 *
 * 字段（与内核 mcpCreateBodySchema 同规则的前端校验，ui-src 未引入 zod → 手工镜像）：
 * - 名称（必填 1..200）与可选 id（留空按名称 slug 生成；须匹配 ^[a-z0-9][a-z0-9_-]*$ 且不与既有重复）；
 * - 传输 Select 三值：stdio | streamable-http | sse；
 * - stdio → command（必填）+ args（空格分词、支持引号）+ env（键值对编辑器）；
 * - streamable-http / sse → URL（必填，http/https）；
 * - 超时 ms 可选（整数 ∈ [1000, 600000]，缺省内核 30s）。
 *
 * 连接语义：POST 只落盘配置，不会自动连接 —— 创建成功后提示到列表显式「连接」。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';

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
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import {
  MCP_ID_PATTERN,
  MCP_TIMEOUT_MAX_MS,
  MCP_TIMEOUT_MIN_MS,
  MCP_TRANSPORTS,
  KeyValueEditor,
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

  // 每次打开重置为空表单（避免上一次的草稿残留）
  useEffect(() => {
    if (open) setDraft(EMPTY_DRAFT);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
          <DialogDescription>
            保存仅写入配置（不自动连接）；创建后请在列表中显式「连接」以拉取工具/资源/提示目录。
          </DialogDescription>
        </DialogHeader>
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
                需以 http:// 或 https:// 开头；鉴权头可在创建后经「编辑」补充（headers）。
              </p>
            </div>
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
      </DialogContent>
    </Dialog>
  );
}
