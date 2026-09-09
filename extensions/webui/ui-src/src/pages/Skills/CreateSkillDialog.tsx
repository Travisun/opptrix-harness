/**
 * Skills/CreateSkillDialog — 新建技能弹窗（admin）。
 *
 * - POST /api/v1/skills（内核 admin 门禁；写入数据卷 `<dataDir>/skills/<id>/SKILL.md`
 *   并在写后自动 refresh）→ 201 { id, path }；成功后回调 onCreated（父级重载列表）。
 * - 客户端校验与内核契约逐条对齐：id `^[a-z0-9-]{1,64}$`、name/description 非空、
 *   正文非空且 ≤128KB（UTF-8 字节实时计数，超限禁提交——zod 按字符、字节口径在此前置）。
 * - 注册 id 以「ID」为准（frontmatter name 恒写 ID，卡片展示名与 ID 一致）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SparklesIcon, TriangleAlertIcon } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText, parseCsv } from '@/pages/_shared';

/** 技能 id 合法形态（与内核 SKILL_NAME_PATTERN 一致） */
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** 正文 UTF-8 字节上限（与内核 SKILL_BODY_MAX_BYTES 一致：128KB） */
const BODY_LIMIT_BYTES = 128 * 1024;

/** POST /api/v1/skills 201 应答 */
interface SkillCreated {
  id: string;
  path: string;
}

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功后的回调：父级重载列表（内核已写后 refresh，无需再手动重扫） */
  onCreated: () => void;
}): React.ReactNode {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 关闭即重置表单（避免上次输入残留） */
  useEffect(() => {
    if (!open) {
      setId('');
      setName('');
      setDescription('');
      setTags('');
      setBody('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  /** 正文 UTF-8 字节数（与内核字节级上限同口径） */
  const bodyBytes = useMemo(() => new TextEncoder().encode(body).length, [body]);
  const idValid = ID_PATTERN.test(id);
  const nameValid = name.trim() !== '';
  const descriptionValid = description.trim() !== '';
  const bodyValid = body.trim() !== '' && bodyBytes <= BODY_LIMIT_BYTES;
  const canSubmit = idValid && nameValid && descriptionValid && bodyValid && !busy;

  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const tagList = parseCsv(tags);
      const created = await api.post<SkillCreated>('/api/v1/skills', {
        id,
        name: name.trim(),
        description: description.trim(),
        body,
        ...(tagList.length > 0 ? { tags: tagList } : {}),
      });
      toast.success('技能已创建', `${created.id} 已写入数据卷并刷新到列表`);
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(errText(e)); // api 层已 toast 错误本身，这里补内联展示
    } finally {
      setBusy(false);
    }
  }, [canSubmit, id, name, description, body, tags, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="text-primary size-5" aria-hidden />
            新建技能
          </DialogTitle>
          <DialogDescription>
            写入数据卷 <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">&lt;dataDir&gt;/skills/&lt;id&gt;/SKILL.md</code>{' '}
            并立即生效；注册名与检索均以「ID」为准。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-skill-id">ID</Label>
              <Input
                id="create-skill-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="weekly-report"
                aria-invalid={id !== '' && !idValid}
                autoComplete="off"
                spellCheck={false}
              />
              {id !== '' && !idValid && (
                <p className="text-destructive text-xs">仅允许小写字母、数字与连字符（1–64 位）。</p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-skill-name">名称</Label>
              <Input
                id="create-skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="周报导出"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-skill-description">描述</Label>
            <Input
              id="create-skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话描述技能用途（≤1024 字符）"
              aria-invalid={description !== '' && !descriptionValid}
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-skill-tags">标签（可选，逗号分隔）</Label>
            <Input
              id="create-skill-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="docs, report"
              autoComplete="off"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="create-skill-body">正文（SKILL.md）</Label>
              <span
                className={cn('text-muted-foreground tabular-nums text-xs', bodyBytes > BODY_LIMIT_BYTES && 'text-destructive')}
              >
                {bodyBytes} / {BODY_LIMIT_BYTES} 字节
              </span>
            </div>
            <Textarea
              id="create-skill-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="# 技能正文（Markdown 提示词/指令，frontmatter 之后的部分）"
              className="min-h-40 font-mono text-xs"
              aria-invalid={body !== '' && !bodyValid}
              spellCheck={false}
            />
            {bodyBytes > BODY_LIMIT_BYTES && <p className="text-destructive text-xs">正文超过 128KB 上限，请精简后再提交。</p>}
          </div>

          {error !== null && (
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
