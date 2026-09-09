/**
 * Skills/EditSkillDialog — 编辑技能弹窗（admin；仅数据卷来源技能）。
 *
 * 数据面：REST 无 PUT（GET /api/v1/skills/:id 只读、POST 创建、DELETE 删除），
 * 保存 = **DELETE 旧 id + POST 新表单**（两步均由内核写后自动 registry.refresh，
 * onSaved 后父级重载列表即可）。id 可改（= 迁移目录：删旧目录、建新目录）。
 *
 * - 打开时 GET /api/v1/skills/:id 惰性取详情（条目元信息 + 剥离 frontmatter 后的
 *   正文 body），表单预填；版本/停用事实来自条目（GET 应答含 entry 全字段）。
 * - 版本提示：POST 契约不接收 version，保存由 kernel writer 固定 1.0.0——对话框
 *   如实展示当前版本与「保存后重置」提示，不提供可编辑的 version 输入（避免静默
 *   丢弃用户输入）。
 * - 停用事实提示：enabled:false 的技能保存重建后该标记丢失（恢复启用）。
 * - 失败语义：DELETE 失败 → 原技能不动；POST 失败（如新 id 已存在）→ 旧目录已删，
 *   表单保留，提示用户修正后重试或重新创建（数据面无事务，见报告）。
 * - 正文用 md-editor（CodeMirror 6）；字节上限与创建侧一致（128KB）。
 * - builtin/extension 来源不可编辑：入口由 Skills 页按 `source === 'data'` 隐藏，
 *   本组件内部对非 data 目标再兜底禁用提交。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PencilIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

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
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText, parseCsv } from '@/pages/_shared';
import { MdEditor } from '@/pages/Skills/md-editor';
import type { SkillDetailView, SkillEntryView } from '@/pages/Skills/shared';

/** 技能 id 合法形态（与内核 SKILL_NAME_PATTERN 一致） */
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** 正文 UTF-8 字节上限（与内核 SKILL_BODY_MAX_BYTES 一致：128KB） */
const BODY_LIMIT_BYTES = 128 * 1024;

export function EditSkillDialog({
  target,
  onClose,
  onSaved,
}: {
  /** 编辑目标（null = 关闭）；仅数据卷来源技能由调用方传入 */
  target: SkillEntryView | null;
  onClose: () => void;
  /** 保存成功后的回调：父级重载列表（DELETE/POST 内核均已自动 refresh） */
  onSaved: () => void;
}): React.ReactNode {
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 加载失败重试计数 */
  const [attempt, setAttempt] = useState(0);

  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** DELETE 旧目录已成功（POST 失败后的重试只补执行写回，不再重复 DELETE） */
  const [oldDeleted, setOldDeleted] = useState(false);

  const targetId = target?.id ?? null;

  /** 打开/切换目标：重置表单并 GET 详情（条目元信息 + 正文）预填 */
  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setBusy(false);
    setError(null);
    setOldDeleted(false);
    setId('');
    setName('');
    setDescription('');
    setTags('');
    setAuthor('');
    setBody('');
    if (targetId === null) return;
    let alive = true;
    setLoading(true);
    api
      .get<SkillDetailView>(`/api/v1/skills/${encodeURIComponent(targetId)}`)
      .then((res) => {
        if (!alive) return;
        setDetail(res);
        setId(res.id);
        setName(res.name);
        setDescription(res.description);
        setTags(res.tags.join(', '));
        setAuthor(res.author ?? '');
        setBody(res.body);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(errText(e)); // api 层已 toast 错误本身，这里补内联展示
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [targetId, attempt]);

  /** 名称输入（编辑态不与 id 联动：预填的既有 id 不因改名被静默替换） */
  const handleNameChange = useCallback((value: string): void => {
    setName(value);
  }, []);

  /** 正文 UTF-8 字节数（与内核字节级上限同口径） */
  const bodyBytes = useMemo(() => new TextEncoder().encode(body).length, [body]);
  const idValid = ID_PATTERN.test(id);
  const nameValid = name.trim() !== '';
  const descriptionValid = description.trim() !== '';
  const bodyValid = body.trim() !== '' && bodyBytes <= BODY_LIMIT_BYTES;
  const targetEditable = target !== null && target.source === 'data';
  const canSubmit = targetEditable && detail !== null && idValid && nameValid && descriptionValid && bodyValid && !busy;

  /** 保存 = DELETE 旧 id + POST 新表单（REST 无 PUT；两步内核均自动 refresh）。
   * POST 失败后的重试只补执行写回（旧目录已删，重复 DELETE 会 404）。 */
  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit || target === null) return;
    setBusy(true);
    setError(null);
    if (!oldDeleted) {
      try {
        await api.delete(`/api/v1/skills/${encodeURIComponent(target.id)}`);
        setOldDeleted(true);
      } catch (e) {
        // 删除失败（如被 builtin 同名遮蔽 → 403）：原技能未动，可直接重试
        setError(`移除旧目录失败，技能未被修改：${errText(e)}`);
        setBusy(false);
        return;
      }
    }
    try {
      const tagList = parseCsv(tags);
      const trimmedAuthor = author.trim();
      await api.post('/api/v1/skills', {
        id,
        name: name.trim(),
        description: description.trim(),
        body,
        ...(tagList.length > 0 ? { tags: tagList } : {}),
        ...(trimmedAuthor !== '' ? { author: trimmedAuthor } : {}),
      });
      toast.success('技能已保存', `${target.id} → ${id} 已写回数据卷并刷新到列表`);
      onSaved();
      onClose();
    } catch (e) {
      // 旧目录已删、重建失败（如新 id 已存在/校验失败）：表单保留，修正后重试或重新创建
      setError(
        `旧目录「${target.id}」已删除，但写回「${id}」失败：${errText(e)}。请修正表单后重试（重试将仅执行写回），或取消后按当前表单重新创建。`,
      );
    } finally {
      setBusy(false);
    }
  }, [canSubmit, target, oldDeleted, id, name, description, body, tags, author, onSaved, onClose]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PencilIcon className="text-primary size-5" aria-hidden />
            编辑技能
          </DialogTitle>
          <DialogDescription>
            数据卷技能无独立更新端点：保存 = 删除旧目录 <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{target?.id ?? ''}</code>{' '}
            后按表单重建（修改 ID 即迁移目录）。
          </DialogDescription>
        </DialogHeader>

        {/* 加载骨架 */}
        {loading && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
            <Skeleton className="h-9" />
            <Skeleton className="h-64" />
          </div>
        )}

        {/* 加载失败：重试 */}
        {!loading && loadError !== null && (
          <div className="text-destructive flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm">
            <span className="flex items-start gap-1.5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              技能详情加载失败：{loadError}
            </span>
            <Button variant="outline" size="sm" className="w-fit" onClick={() => setAttempt((a) => a + 1)}>
              <RefreshCwIcon aria-hidden />
              重试
            </Button>
          </div>
        )}

        {/* 表单（详情加载成功后） */}
        {!loading && loadError === null && detail !== null && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-skill-id">ID</Label>
                <Input
                  id="edit-skill-id"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  aria-invalid={id !== '' && !idValid}
                  autoComplete="off"
                  spellCheck={false}
                />
                {detail !== null && id !== detail.id ? (
                  <p className="text-muted-foreground text-xs">将迁移到新 ID（删除旧目录后按新 ID 重建）。</p>
                ) : null}
                {id !== '' && !idValid && (
                  <p className="text-destructive text-xs">仅允许小写字母、数字与连字符（1–64 位）。</p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-skill-name">名称</Label>
                <Input
                  id="edit-skill-name"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">展示名；注册名恒为「ID」（frontmatter name 由写路径固定）。</p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-skill-description">描述</Label>
              <Input
                id="edit-skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-invalid={description !== '' && !descriptionValid}
                autoComplete="off"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-skill-tags">标签（逗号分隔）</Label>
                <Input
                  id="edit-skill-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-skill-author">作者（可选）</Label>
                <Input
                  id="edit-skill-author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-skill-version">版本</Label>
                <Input id="edit-skill-version" value={detail.version ?? '—'} disabled aria-readonly />
                <p className="text-muted-foreground text-xs">
                  {detail.version !== undefined && detail.version !== '1.0.0' ? '保存后将重置为 1.0.0。' : '由写路径固定。'}
                </p>
              </div>
            </div>

            {detail.enabled === false && (
              <p className="text-muted-foreground text-xs leading-relaxed">
                该技能当前带 <span className="text-foreground font-mono">enabled: false</span>{' '}
                停用事实；保存重建后该标记将丢失（恢复启用）。
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>正文（SKILL.md，Markdown）</Label>
                <span
                  className={cn(
                    'text-muted-foreground tabular-nums text-xs',
                    bodyBytes > BODY_LIMIT_BYTES && 'text-destructive',
                  )}
                >
                  {bodyBytes} / {BODY_LIMIT_BYTES} 字节
                </span>
              </div>
              <MdEditor
                value={body}
                onChange={setBody}
                height="300px"
                ariaLabel="技能正文 Markdown 编辑器"
                invalid={body !== '' && (body.trim() === '' || bodyBytes > BODY_LIMIT_BYTES)}
                placeholder="# 技能正文（Markdown 提示词/指令，frontmatter 由表单字段在保存时组装）"
              />
              {bodyBytes > BODY_LIMIT_BYTES && <p className="text-destructive text-xs">正文超过 128KB 上限，请精简后再提交。</p>}
            </div>
          </div>
        )}

        {error !== null && (
          <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
