import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileTextIcon } from 'lucide-react';

// 相对导入（非 @/ 别名）：本模块的纯函数（sanitizeUrl 等）被仓库根 vitest 直接导入单测，
// 根 vitest 无路径别名，保持模块零别名依赖才可在两端解析。
import { workspaceFileRefFromUrl } from './filePreview';

/**
 * MarkdownMessage — 助手消息 Markdown 渲染（react-markdown + remark-gfm）。
 *
 * 安全策略（安全第一）：
 * - 不引入 rehype-raw → raw HTML 不解析、原样转义为纯文本（无 XSS 注入面）；
 * - 手写简易 sanitize（sanitizeMarkdownText）：长度截断 + 控制字符剔除（文本层兜底）；
 * - 所有链接/图片 URL 经 sanitizeUrl 白名单（http/https/mailto/相对路径/#锚点），其余协议
 *   （javascript:/data:/file: 等）一律拒绝（链接降级为纯文本、图片不渲染）；
 * - 全文件零 innerHTML 注入面（无任何 raw HTML 渲染通道）。
 *
 * 自定义渲染：
 * - code 块：语言标签外壳（从 fenced 的 language-xxx 提取，无标注显示 text）；
 * - table：横向滚动包裹（overflow-x-auto）；
 * - a：外链 target=_blank + rel="noopener noreferrer"；工作区文件引用
 *   （/api/v1/agents/sessions/:id/workspace/file?path=… 形态）渲染为文件 chip + 预览按钮
 *   （onPreviewFile 由 AgentChat 注入，复用 WorkspacePanel 的三态预览逻辑）；
 * - img：懒加载 + 限宽（src 已过 sanitizeUrl 白名单）。
 *
 * 流式期间回复草稿为纯文本预览（ThinkingPanel.replyDraft），不走本组件——done 后整段一次性
 * Markdown 渲染，避免流式重解析。
 */

/** Markdown 文本长度上限（防超大内容卡死渲染） */
const MAX_MARKDOWN_CHARS = 200_000;

/**
 * sanitizeMarkdownText — 文本层兜底 sanitize：截断超长输入、剔除控制字符
 * （\n \t 保留）。raw HTML 由「不引入 rehype-raw」天然转义，不在此重复处理。
 */
export function sanitizeMarkdownText(text: string): string {
  const capped = text.length > MAX_MARKDOWN_CHARS ? `${text.slice(0, MAX_MARKDOWN_CHARS)}\n…（已截断）` : text;
  return capped.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * sanitizeUrl — 链接白名单：http/https/mailto、站内相对路径（/ 开头）、页内锚点（# 开头）、
 * 无协议的相对路径放行；其余协议（javascript:/data:/vbscript:/file:…）一律拒绝（返回 null）。
 */
export function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  if (/^(https?|mailto):/i.test(trimmed)) return trimmed;
  // 无协议（相对路径 ./a、../a、foo/bar）放行
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) return trimmed;
  return null;
}

export interface MarkdownMessageProps {
  content: string;
  /** 工作区文件 chip 的预览入口（AgentChat 注入；复用 WorkspacePanel 的三态预览逻辑） */
  onPreviewFile?: (url: string, name: string) => void;
}

/** 工作区文件 chip：文件名 + 预览按钮（点击走 onPreviewFile） */
function WorkspaceFileChip({
  url,
  onPreviewFile,
}: {
  url: string;
  onPreviewFile?: (url: string, name: string) => void;
}): React.ReactNode {
  const ref = workspaceFileRefFromUrl(url);
  const name = ref?.name ?? '文件';
  return (
    <span
      data-slot="workspace-file-chip"
      className="border-border bg-background/70 inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 align-middle text-xs"
    >
      <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" title={ref?.path ?? url}>
        {name}
      </span>
      {onPreviewFile !== undefined && (
        <button
          type="button"
          data-slot="workspace-file-preview"
          className="text-primary hover:text-primary/80 shrink-0 cursor-pointer"
          onClick={() => onPreviewFile(url, name)}
        >
          预览
        </button>
      )}
    </span>
  );
}

/** 按需构建自定义渲染器（闭包注入 onPreviewFile；随 prop 变化重建） */
function buildComponents(onPreviewFile: MarkdownMessageProps['onPreviewFile']): Components {
  return {
    a: ({ node, href, children, ...props }) => {
      void node;
      const hrefStr = typeof href === 'string' ? href : '';
      const safe = hrefStr === '' ? null : sanitizeUrl(hrefStr);
      if (safe === null) return <span className="text-muted-foreground break-all">{children}</span>;
      if (workspaceFileRefFromUrl(safe) !== null) {
        return <WorkspaceFileChip url={safe} onPreviewFile={onPreviewFile} />;
      }
      return (
        <a
          {...props}
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline break-all"
        >
          {children}
        </a>
      );
    },
    pre: ({ node, children, ...props }) => {
      void node;
      // 从子 code 元素提取 language-xxx 作为语言标签；正文直接取其 children（纯文本），
      // 不复用行内 code 的 pill 样式（块级与行内样式解耦）
      let lang: string | null = null;
      let body: React.ReactNode = children;
      if (children !== null && typeof children === 'object' && 'props' in (children as object)) {
        const childProps = (children as { props?: { className?: unknown; children?: React.ReactNode } }).props ?? {};
        const cls = typeof childProps.className === 'string' ? childProps.className : '';
        if (cls.includes('language-')) lang = cls.replace(/.*language-/, '') || 'text';
        body = childProps.children ?? children;
      }
      return (
        <div data-slot="code-block" className="border-border bg-background/70 my-1.5 overflow-hidden rounded-md border">
          <div className="border-border bg-muted/60 flex items-center justify-between border-b px-2.5 py-1">
            <span data-slot="code-lang" className="text-muted-foreground text-[10px] tracking-wider uppercase">
              {lang ?? 'text'}
            </span>
          </div>
          <pre {...props} className="overflow-x-auto p-2.5">
            <code className="font-mono text-xs leading-relaxed">{body}</code>
          </pre>
        </div>
      );
    },
    code: ({ node, children, className, ...props }) => {
      void node;
      // 行内代码 pill（fenced 块的正文由 pre 组件接管渲染，此处样式不影响块级展示）
      return (
        <code
          {...props}
          className={`border-border bg-background/80 text-xs rounded border px-1 py-0.5 font-mono break-all ${className ?? ''}`}
        >
          {children}
        </code>
      );
    },
    table: ({ node, children, ...props }) => {
      void node;
      return (
        <div data-slot="table-wrap" className="my-1.5 max-w-full overflow-x-auto">
          <table
            {...props}
            className="border-border w-full border-collapse text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1"
          >
            {children}
          </table>
        </div>
      );
    },
    img: ({ node, src, alt, ...props }) => {
      void node;
      if (typeof src !== 'string' || src === '') return null;
      return <img {...props} src={src} alt={alt ?? ''} loading="lazy" className="max-w-full rounded-md" />;
    },
  };
}

/** 助手消息 Markdown 渲染（memo：内容不变不重渲） */
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  onPreviewFile,
}: MarkdownMessageProps): React.ReactNode {
  const components = useMemo(() => buildComponents(onPreviewFile), [onPreviewFile]);
  return (
    <div className="text-sm break-words" data-slot="markdown-message">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => sanitizeUrl(url) ?? ''}>
        {sanitizeMarkdownText(content)}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownMessage;
