/**
 * Skills 页「拖拽批量创建」纯函数测试（零依赖直测 ui-src 源文件）。
 *
 * 覆盖（文件内容以注入式 mock 提供——buildSkillDrafts 只接收已读取的文本，
 * 不真读 fs / DOM / 网络）：
 * - classifyDroppedFile：扩展名分类（md/markdown/txt/pdf/docx/未知/隐藏文件）；
 * - firstParagraph：首段非空文本、Markdown 标记剥离、≤200 字截断省略；
 * - truncateToByteLimit：128KB 字节截断（UTF-8 多字节 / 代理对不劈开）；
 * - draftFromMarkdown / draftFromText / draftFromExtract：三类草稿字段映射
 *   （frontmatter 识别复用 parseSkillFile；无文件头回落文件名+首段；LLM 元信息
 *   优先、缺省降级；name/description 上限夹取）；
 * - dedupeSkillId + buildSkillDrafts：批内 id 去重（-2/-3、既有集合、64 位截断、
 *   空 slug 兜底）与失败清单行（unsupported / 提取失败 / 空内容）。
 */
import { describe, expect, it } from 'vitest';

import {
  baseNameOf,
  buildSkillDrafts,
  classifyDroppedFile,
  dedupeSkillId,
  draftFromExtract,
  draftFromMarkdown,
  draftFromText,
  firstParagraph,
  parseLlmMetaJson,
  truncateToByteLimit,
  type DroppedFileInput,
} from '../extensions/webui/ui-src/src/pages/Skills/dragdrop.js';

describe('classifyDroppedFile — 扩展名分类', () => {
  it('markdown / txt / 可提取二进制 / 不支持，大小写不敏感且剥离路径', () => {
    expect(classifyDroppedFile('SKILL.md')).toBe('markdown');
    expect(classifyDroppedFile('notes.MARKDOWN')).toBe('markdown');
    expect(classifyDroppedFile('/a/b/说明.TXT')).toBe('text');
    expect(classifyDroppedFile('spec.pdf')).toBe('binary');
    expect(classifyDroppedFile('C:\\docs\\报告.DOCX')).toBe('binary');
    expect(classifyDroppedFile('photo.png')).toBe('unsupported');
    expect(classifyDroppedFile('noext')).toBe('unsupported');
    expect(classifyDroppedFile('.hidden')).toBe('unsupported'); // 点开头 → 无扩展名
  });

  it('baseNameOf：去扩展名与路径分隔符（posix + win32）', () => {
    expect(baseNameOf('weekly-report.md')).toBe('weekly-report');
    expect(baseNameOf('/tmp/x/周报导出.txt')).toBe('周报导出');
    expect(baseNameOf('C:\\a\\b\\架构.DOCX')).toBe('架构');
    expect(baseNameOf('.hidden')).toBe('.hidden'); // 无扩展名形态原样保留
  });
});

describe('firstParagraph — 首段非空文本', () => {
  it('跳过空白行取首个非空段落，剥 Markdown 标记并折叠空白', () => {
    expect(firstParagraph('\n\n  \n# 周报导出\n\n把群里的周报整理成表格。\n\n第二段不应出现')).toBe('周报导出');
    expect(firstParagraph('> 引用行\n- 列表项\n2. 有序项')).toBe('引用行 列表项 有序项');
    expect(firstParagraph('   多   个  空格\t折叠  ')).toBe('多 个 空格 折叠');
    expect(firstParagraph('')).toBe('');
  });

  it('超 200 字截断并以省略号收尾（总长 ≤200）', () => {
    const long = '甲'.repeat(500);
    const out = firstParagraph(long);
    expect(out.length).toBe(200);
    expect(out.endsWith('…')).toBe(true);
    expect(firstParagraph('精'.repeat(200))).toHaveLength(200); // 恰好 200 不加省略号
  });
});

describe('truncateToByteLimit — UTF-8 字节截断', () => {
  it('未超限原样返回；超限截到 128KB 内且不劈开多字节字符', () => {
    const small = 'hello 世界';
    expect(truncateToByteLimit(small)).toEqual({ text: small, truncated: false });

    const text = '汉'.repeat(100_000); // 每字 3 字节 → 300KB
    const out = truncateToByteLimit(text);
    expect(out.truncated).toBe(true);
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(128 * 1024);
    expect(out.text.length).toBeLessThan(text.length);
  });

  it('代理对（emoji）不被劈成半截', () => {
    // 8 字节上限：二分切点落在代理对中间（孤位代理按 U+FFFD 计 3 字节）→ 回退整字
    const out = truncateToByteLimit('👍👍👍', 8);
    expect(out).toEqual({ text: '👍👍', truncated: true });
    const last = out.text.charCodeAt(out.text.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });
});

describe('draftFromMarkdown — frontmatter 识别与回落', () => {
  it('带 frontmatter：按字段创建（name/description/tags/author），id 由 name slug 化', () => {
    const raw = ['---', 'name: weekly-report', 'description: 整理周报', 'tags: [docs, report]', 'author: team', '---', '', '# 正文', '内容'].join('\n');
    const draft = draftFromMarkdown('任意文件名.md', raw);
    expect(draft).toMatchObject({
      kind: 'markdown',
      name: 'weekly-report',
      id: 'weekly-report',
      description: '整理周报',
      body: '# 正文\n内容',
      author: 'team',
      sourceNote: 'frontmatter 文件头',
      truncated: false,
    });
    expect(draft.error).toBeUndefined();
    expect(draft.tags).toEqual(['docs', 'report']);
  });

  it('无 frontmatter：文件名作 name、首段作 description、全文作 body', () => {
    const raw = '\n\n这是首段描述。\n\n正文第二段';
    const draft = draftFromMarkdown('部署手册.md', raw);
    expect(draft).toMatchObject({
      name: '部署手册',
      id: '', // 纯中文 slug 为空 → buildSkillDrafts 阶段以 'skill' 兜底去重
      description: '这是首段描述。',
      body: raw, // 无文件头 → 整体视为正文（原文保留）
      sourceNote: '文件名 + 首段',
    });
    expect(draft.tags).toEqual([]);
  });

  it('夹取：frontmatter description 超 1024 字符截断（POST 契约上限）', () => {
    const raw = `---\nname: big\ndescription: ${'长'.repeat(2000)}\n---\n\nbody`;
    const draft = draftFromMarkdown('big.md', raw);
    expect(draft.description).toHaveLength(1024);
  });
});

describe('draftFromText / draftFromExtract — 文本与提取来源', () => {
  it('.txt：文件名作 name、全文作 body、首段作 description', () => {
    const draft = draftFromText('会议纪要.txt', '纪要首行。\n第二行');
    expect(draft).toMatchObject({
      kind: 'text',
      name: '会议纪要',
      description: '纪要首行。 第二行',
      body: '纪要首行。\n第二行',
      sourceNote: '文件名 + 全文',
    });
  });

  it('extract：LLM 元信息优先；LLM 缺省降级文件名 + 首段', () => {
    const text = '一份很长的白皮书正文……';
    const withLlm = draftFromExtract('whitepaper.pdf', text, { name: '白皮书速读', description: '提炼白皮书要点' });
    expect(withLlm).toMatchObject({
      kind: 'binary',
      name: '白皮书速读',
      description: '提炼白皮书要点',
      sourceNote: '文本提取 + LLM',
    });
    const degraded = draftFromExtract('whitepaper.pdf', text);
    expect(degraded).toMatchObject({ name: 'whitepaper', description: '一份很长的白皮书正文……', sourceNote: '文本提取 + 首段' });
    expect(degraded.id).toBe('whitepaper');
  });

  it('parseLlmMetaJson：容忍代码栅栏与赘述，非法输出返回 null', () => {
    expect(parseLlmMetaJson('```json\n{"name": "摘要", "description": "生成摘要"}\n```')).toEqual({
      name: '摘要',
      description: '生成摘要',
    });
    expect(parseLlmMetaJson('好的：{"name":"A","description":"B"} 完毕')).toEqual({ name: 'A', description: 'B' });
    expect(parseLlmMetaJson('{"name":"","description":"B"}')).toBeNull();
    expect(parseLlmMetaJson('{"name":"A"}')).toBeNull();
    expect(parseLlmMetaJson('not json at all')).toBeNull();
    expect(parseLlmMetaJson('{broken')).toBeNull();
  });
});

describe('dedupeSkillId — slug 去重', () => {
  it('空闲原样；占用依序 -2/-3；空基底兜底 skill', () => {
    expect(dedupeSkillId('report', new Set())).toBe('report');
    expect(dedupeSkillId('report', new Set(['report']))).toBe('report-2');
    expect(dedupeSkillId('report', new Set(['report', 'report-2']))).toBe('report-3');
    expect(dedupeSkillId('', new Set(['skill', 'skill-2']))).toBe('skill-3');
  });

  it('基底近 64 位时后缀仍使全 id ≤64', () => {
    const base = 'a'.repeat(64);
    const out = dedupeSkillId(base, new Set([base]));
    expect(out).toBe(`${'a'.repeat(62)}-2`);
    expect(out.length).toBe(64);
    expect(dedupeSkillId(base, new Set([base, out]))).toBe(`${'a'.repeat(62)}-3`);
  });
});

describe('buildSkillDrafts — 批量清单与失败行', () => {
  it('批量构建：逐文件草稿 + 批内/既有 id 去重（同名文件 -2 而非失败）', () => {
    const inputs: DroppedFileInput[] = [
      { fileName: 'report.md', kind: 'markdown', text: '---\nname: report\ndescription: 报告\n---\n\n正文' },
      { fileName: 'report.md', kind: 'markdown', text: '---\nname: report\ndescription: 报告二\n---\n\n正文二' },
      { fileName: 'notes.txt', kind: 'text', text: '笔记内容' },
    ];
    const drafts = buildSkillDrafts(inputs, ['report']);
    expect(drafts.map((d) => d.id)).toEqual(['report-2', 'report-3', 'notes']);
    expect(drafts.every((d) => d.error === undefined)).toBe(true);
  });

  it('失败清单行：unsupported / 提取失败 / 空内容不抛错，仅标注 error', () => {
    const drafts = buildSkillDrafts([
      { fileName: 'img.png', kind: 'unsupported' },
      { fileName: 'scan.pdf', kind: 'binary', error: '文本提取失败：密码保护' },
      { fileName: 'empty.txt', kind: 'text', text: '   \n\t' },
    ]);
    expect(drafts).toHaveLength(3);
    expect(drafts[0]).toMatchObject({ kind: 'unsupported', id: '', name: 'img' });
    expect(drafts[0]?.error).toContain('不支持的文件类型');
    expect(drafts[1]?.error).toBe('文本提取失败：密码保护');
    expect(drafts[2]?.error).toBe('文件内容为空');
  });

  it('二进制提取成功走 draftFromExtract；markdown 正文超 128KB 截断并标注', () => {
    const drafts = buildSkillDrafts([
      { fileName: 'doc.docx', kind: 'binary', text: '提取出的正文' },
      { fileName: 'huge.md', kind: 'markdown', text: `# 标题\n\n${'字'.repeat(100_000)}` },
    ]);
    expect(drafts[0]).toMatchObject({ kind: 'binary', name: 'doc', body: '提取出的正文' });
    expect(drafts[0]?.error).toBeUndefined();
    const huge = drafts[1];
    expect(huge?.truncated).toBe(true);
    expect(new TextEncoder().encode(huge?.body ?? '').length).toBeLessThanOrEqual(128 * 1024);
  });
});
