/**
 * ServerEditDialog — 编辑服务器 Dialog（PATCH /api/v1/mcp/servers/:id）。
 *
 * 内核 PATCH 面只允许 enabled / name / headers（enabled 走列表行 Switch）；
 * transport / command / url / args / env / timeoutMs 属身份与拓扑字段，不可变 ——
 * 变更拓扑须删除后重建（连接语义才有一致定义）。因此本 Dialog 仅编辑：
 * - 名称（必填 1..200）；
 * - headers（仅 streamable-http / sse；整表替换语义 —— 清空即移除全部头）；
 *   支持键值对编辑器与「粘贴 JSON」两种输入（粘贴 `{"Authorization":"Bearer ..."}`
 *   形状 → 解析填充键值对行；解析失败内联报错，不 toast）。
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BracesIcon, ListIcon } from 'lucide-react';

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
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import {
  HeadersJsonPaste,
  KeyValueEditor,
  entriesOf,
  recordOfEntries,
  toastApiError,
  type KeyValueEntry,
  type McpServerSummary,
} from '@/pages/Mcp/shared';

export function ServerEditDialog({
  server,
  onOpenChange,
  onSaved,
}: {
  /** 编辑目标；null = 关闭 */
  server: McpServerSummary | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}): React.ReactNode {
  const [name, setName] = useState('');
  const [headerEntries, setHeaderEntries] = useState<KeyValueEntry[]>([]);
  /** headers 输入模式：key-value 编辑器 | 粘贴 JSON */
  const [headerMode, setHeaderMode] = useState<'editor' | 'paste'>('editor');
  const [submitting, setSubmitting] = useState(false);

  // 打开（目标变化）时用目标当前值重置表单
  useEffect(() => {
    if (server !== null) {
      setName(server.name);
      setHeaderEntries(entriesOf(server.headers).length > 0 ? entriesOf(server.headers) : [{ key: '', value: '' }]);
      setHeaderMode('editor');
    }
  }, [server]);

  const isRemote = server !== null && server.transport !== 'stdio';

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (server === null) return;
      const trimmed = name.trim();
      if (trimmed === '') {
        toast.error('请填写服务器名称');
        return;
      }
      if (trimmed.length > 200) {
        toast.error('服务器名称过长', '名称需在 1-200 个字符之间');
        return;
      }
      // PATCH 至少需要一个字段；name 恒携带（headers 仅 remote 支持整表替换）
      const body: Record<string, unknown> = { name: trimmed };
      if (isRemote) {
        const headers = recordOfEntries(headerEntries);
        if (!headers.ok) {
          toast.error('headers 存在重复键', headers.message);
          return;
        }
        body['headers'] = headers.value; // 空表 = 清除全部额外头（显式替换语义）
      }
      setSubmitting(true);
      try {
        await api.patch(`/api/v1/mcp/servers/${encodeURIComponent(server.id)}`, body, { silent: true });
        toast.success('已保存', trimmed);
        onOpenChange(false);
        await onSaved();
      } catch (err) {
        toastApiError(err, '保存失败');
      } finally {
        setSubmitting(false);
      }
    },
    [server, name, isRemote, headerEntries, onOpenChange, onSaved],
  );

  return (
    <Dialog open={server !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑服务器</DialogTitle>
          <DialogDescription>
            {server !== null && (
              <>
                「{server.name}」<span className="font-mono text-xs">({server.id})</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-edit-name">名称</Label>
            <Input
              id="mcp-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting || server === null}
              maxLength={200}
              required
            />
          </div>

          {isRemote ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <Label>headers（可选，随每次请求发送，可含 Authorization）</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setHeaderMode(headerMode === 'editor' ? 'paste' : 'editor')}
                  disabled={submitting}
                >
                  {headerMode === 'editor' ? (
                    <>
                      <BracesIcon aria-hidden />
                      粘贴 JSON
                    </>
                  ) : (
                    <>
                      <ListIcon aria-hidden />
                      键值对编辑
                    </>
                  )}
                </Button>
              </div>
              {headerMode === 'editor' ? (
                <KeyValueEditor
                  entries={headerEntries}
                  onChange={setHeaderEntries}
                  disabled={submitting}
                  keyPlaceholder="键，如 Authorization"
                  valuePlaceholder="值，如 Bearer xxx"
                  addLabel="添加请求头"
                />
              ) : (
                <HeadersJsonPaste
                  disabled={submitting}
                  onParsed={(value) => {
                    setHeaderEntries(entriesOf(value).length > 0 ? entriesOf(value) : [{ key: '', value: '' }]);
                    setHeaderMode('editor');
                    toast.success(`已解析 ${Object.keys(value).length} 个请求头`, '确认无误后点「保存」（整表替换语义）');
                  }}
                />
              )}
              <p className="text-muted-foreground text-xs">保存为整表替换：删除行即移除该头；下次连接生效。</p>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs leading-relaxed">
              stdio 服务器的 command / args / env / 超时为拓扑字段，创建后不可在线修改；如需变更请删除后重新添加。
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || server === null}>
              {submitting ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
