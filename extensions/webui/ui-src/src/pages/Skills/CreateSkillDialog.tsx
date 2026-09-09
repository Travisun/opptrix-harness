/**
 * Skills/CreateSkillDialog — 新建技能弹窗（admin，富编辑体验）。
 *
 * - POST /api/v1/skills（内核 admin 门禁；写入数据卷 `<dataDir>/skills/<id>/SKILL.md`
 *   并在写后自动 refresh）→ 201 { id, path }；成功后回调 onCreated（父级重载列表）。
 * - 客户端校验与内核契约逐条对齐：id `^[a-z0-9-]{1,64}$`、name/description 非空、
 *   正文非空且 ≤128KB（UTF-8 字节实时计数，超限禁提交——zod 按字符、字节口径在此前置）。
 * - 注册 id 以「ID」为准（frontmatter name 恒写 ID，见 kernel writer；展示名 name
 *   仅收口校验）；author 可选（frontmatter author 键）。
 * - 正文用 md-editor（CodeMirror 6，见 ./md-editor）替代裸 textarea。
 * - 「粘贴 SKILL.md」导入（./frontmatter 纯函数）：完整文件（`---` 文件头 + 正文）
 *   自动拆解回填表单（name/description/tags/author；version/enabled 仅提示——POST
 *   不接收，version 由 writer 固定 1.0.0、enabled 标记保存后丢失）；纯 Markdown
 *   整体作为正文。
 * - id 由名称 slug 自动生成（slugifyId），手动改过 id 后不再联动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardPasteIcon, SquarePenIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText, parseCsv } from '@/pages/_shared';
import { parseSkillFile, slugifyId } from '@/pages/Skills/frontmatter';
import { MdEditor } from '@/pages/Skills/md-editor';

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
  /** 用户是否手动改过 id（改过则名称→slug 联动停止） */
  const [idTouched, setIdTouched] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 表单填写 | 粘贴 SKILL.md 导入 */
  const [tab, setTab] = useState<'form' | 'paste'>('form');
  const [pasteRaw, setPasteRaw] = useState('');

  /** 关闭即重置表单（避免上次输入残留） */
  useEffect(() => {
    if (!open) {
      setId('');
      setIdTouched(false);
      setName('');
      setDescription('');
      setTags('');
      setAuthor('');
      setBody('');
      setBusy(false);
      setError(null);
      setTab('form');
      setPasteRaw('');
    }
  }, [open]);

  /** 名称 → id slug 联动（仅当 id 未被手动编辑） */
  const handleNameChange = useCallback(
    (value: string): void => {
      setName(value);
      if (!idTouched) setId(slugifyId(value));
    },
    [idTouched],
  );

  /** 粘贴内容实时解析（识别 frontmatter / 纯正文） */
  const parsed = useMemo(() => parseSkillFile(pasteRaw), [pasteRaw]);

  /** 粘贴导入：frontmatter 字段回填表单、正文进编辑器，切回表单页 */
  const importFromPaste = useCallback((): void => {
    const { fields } = parsed;
    if (fields.name !== undefined && fields.name.trim() !== '') {
      setName(fields.name);
      const slug = slugifyId(fields.name);
      if (slug !== '') {
        setId(slug);
        setIdTouched(true); // 来自文件的 id 视为已定，避免后续名称输入覆盖
      }
    }
    if (fields.description !== undefined && fields.description.trim() !== '') setDescription(fields.description);
    if (fields.author !== undefined && fields.author.trim() !== '') setAuthor(fields.author);
    if (fields.tags.length > 0) setTags(fields.tags.join(', '));
    setBody(parsed.body);
    setTab('form');
  }, [parsed]);

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
      const trimmedAuthor = author.trim();
      const created = await api.post<SkillCreated>('/api/v1/skills', {
        id,
        name: name.trim(),
        description: description.trim(),
        body,
        ...(tagList.length > 0 ? { tags: tagList } : {}),
        ...(trimmedAuthor !== '' ? { author: trimmedAuthor } : {}),
      });
      toast.success('技能已创建', `${created.id} 已写入数据卷并刷新到列表`);
      onCreated();
      onOpenChange(false);
    } catch (e) {
      setError(errText(e)); // api 层已 toast 错误本身，这里补内联展示
    } finally {
      setBusy(false);
    }
  }, [canSubmit, id, name, description, body, tags, author, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
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

        <Tabs value={tab} onValueChange={(v) => setTab(v === 'paste' ? 'paste' : 'form')}>
          <TabsList>
            <TabsTrigger value="form">
              <SquarePenIcon aria-hidden />
              填写表单
            </TabsTrigger>
            <TabsTrigger value="paste">
              <ClipboardPasteIcon aria-hidden />
              粘贴 SKILL.md
            </TabsTrigger>
          </TabsList>

          {/* 粘贴导入页：完整 SKILL.md / 纯 Markdown → 实时识别 → 回填表单 */}
          <TabsContent value="paste" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="create-skill-paste">SKILL.md 原文（可含 frontmatter 文件头）</Label>
                <Button variant="outline" size="sm" onClick={importFromPaste} disabled={pasteRaw.trim() === ''}>
                  识别并回填表单
                </Button>
              </div>
              <Textarea
                id="create-skill-paste"
                value={pasteRaw}
                onChange={(e) => setPasteRaw(e.target.value)}
                placeholder={'---\nname: weekly-report\ndescription: 一句话描述\n---\n\n# 技能正文…'}
                className="min-h-56 font-mono text-xs"
                aria-label="粘贴 SKILL.md 原文"
                spellCheck={false}
              />
            </div>

            {/* 实时识别结果 */}
            {pasteRaw.trim() === '' ? (
              <p className="text-muted-foreground text-xs leading-relaxed">
                粘贴完整 SKILL.md（<code className="bg-muted rounded px-1 font-mono">---</code>{' '}
                文件头 + 正文）自动拆解回填表单；不带文件头的纯 Markdown 将整体作为正文。
              </p>
            ) : parsed.hasFrontmatter ? (
              <div className="bg-muted/50 flex flex-col gap-1 rounded-md border p-2.5 text-xs leading-relaxed">
                <span className="text-foreground font-medium">已识别 frontmatter 文件头</span>
                <span className="text-muted-foreground">
                  name：<span className="text-foreground font-mono">{parsed.fields.name ?? '—'}</span>
                  <span className="mx-1.5">·</span>
                  description：
                  <span className="text-foreground line-clamp-1 inline-block max-w-72 align-bottom">
                    {parsed.fields.description ?? '—'}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  author：<span className="text-foreground font-mono">{parsed.fields.author ?? '—'}</span>
                  <span className="mx-1.5">·</span>
                  tags：<span className="text-foreground font-mono">{parsed.fields.tags.join(', ') || '—'}</span>
                </span>
                {(parsed.fields.version !== undefined || parsed.fields.enabled === false) && (
                  <span className="text-muted-foreground">
                    version（{parsed.fields.version ?? '—'}）与 enabled
                    不随导入保存：写路径固定 version 1.0.0，enabled 标记由创建重置为启用。
                  </span>
                )}
                {parsed.unknownKeys.length > 0 && (
                  <span className="text-muted-foreground">
                    未识别字段（不会保存）：{parsed.unknownKeys.join('、')}
                  </span>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                未识别到 frontmatter 文件头——将整体作为正文导入，请在表单页补全 ID / 名称 / 描述。
              </p>
            )}
          </TabsContent>

          {/* 表单页 */}
          <TabsContent value="form" className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-skill-id">ID</Label>
                <Input
                  id="create-skill-id"
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    setIdTouched(true);
                  }}
                  placeholder="weekly-report"
                  aria-invalid={id !== '' && !idValid}
                  autoComplete="off"
                  spellCheck={false}
                />
                {!idTouched && id !== '' ? (
                  <p className="text-muted-foreground text-xs">由名称自动生成，可手动修改。</p>
                ) : null}
                {id !== '' && !idValid && (
                  <p className="text-destructive text-xs">仅允许小写字母、数字与连字符（1–64 位）。</p>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-skill-name">名称</Label>
                <Input
                  id="create-skill-name"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
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

            <div className="grid gap-3 sm:grid-cols-2">
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
                <Label htmlFor="create-skill-author">作者（可选）</Label>
                <Input
                  id="create-skill-author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  placeholder="team-platform"
                  autoComplete="off"
                />
              </div>
            </div>

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
                height="280px"
                ariaLabel="技能正文 Markdown 编辑器"
                invalid={body !== '' && (body.trim() === '' || bodyBytes > BODY_LIMIT_BYTES)}
                placeholder="# 技能正文（Markdown 提示词/指令，frontmatter 由表单字段在保存时组装）"
              />
              {bodyBytes > BODY_LIMIT_BYTES && <p className="text-destructive text-xs">正文超过 128KB 上限，请精简后再提交。</p>}
            </div>
          </TabsContent>
        </Tabs>

        {error !== null && (
          <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit || tab !== 'form'}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
