/**
 * Skills/md-editor — 轻量 Markdown 编辑器（CodeMirror 6 封装）。
 *
 * 选型（Package-First，ENGINEERING.md 最高约束）：实现「富 Markdown 代码输入框」
 * 前评估了两条路径——
 * 1. CodeMirror 6（@uiw/react-codemirror + @codemirror/lang-markdown）：行号/语法
 *    高亮/换行/历史撤销/缩进开箱即用，产品级编辑体验，维护成本外包给社区包；
 * 2. 增强 textarea：零依赖、体积零增，但行号/高亮/选区都要手搓，自研成本与
 *    缺陷面显著更高。
 * 依据 Package-First「禁止默认自研」选 1：新增 @uiw/react-codemirror +
 * @codemirror/lang-markdown（+ 显式声明 @codemirror/language、@lezer/highlight），
 * 体积代价约 +400KB min（gzip 约 +110KB，vite build 产物可见）——Dashboard 为登录后
 * 的 admin 工具，一次性加载可接受。
 *
 * 主题适配：不用内置 light/dark 配色，而是用 CSS 变量（--background/--foreground/
 * --muted/--primary…）自建主题与 Markdown 高亮——变量随 ThemeProvider 亮暗切换
 * （system 模式跟随系统），编辑器与设计令牌永远同色，无需两套硬编码色值。
 *
 * 契约：value/onChange 受控 + height（CSS 高度串）；行号、软换行、Tab 缩进、
 * Markdown 语法高亮；关闭自动补全/括号闭合（提示词正文不需要）。
 */
import { useMemo } from 'react';

import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror';

import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** Markdown 语法高亮（CSS 变量取色，亮暗自动适配，无需两套定义） */
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '600', color: 'var(--foreground)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--primary)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--muted-foreground)' },
  { tag: t.monospace, color: 'var(--primary)' },
  { tag: t.quote, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--primary)' },
  { tag: t.meta, color: 'var(--muted-foreground)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.contentSeparator, color: 'var(--muted-foreground)' },
]);

/** 编辑器配色（跟随应用设计令牌；dark 标志切换选区/光标等内置暗色默认值） */
function paletteTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { color: 'var(--foreground)', backgroundColor: 'transparent', fontSize: '12px' },
      '.cm-content': {
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
        caretColor: 'var(--foreground)',
      },
      '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
      '.cm-gutters': {
        backgroundColor: 'var(--muted)',
        color: 'var(--muted-foreground)',
        border: 'none',
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      },
      '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 55%, transparent)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in oklab, var(--primary) 22%, transparent) !important',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { overflow: 'auto' },
    },
    { dark },
  );
}

/** md-editor 组件属性（value/onChange 受控；height 为 CSS 高度串） */
export interface MdEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 编辑区高度（如 '320px'）；缺省 320px */
  height?: string;
  /** 无障碍标签（外层容器 aria-label） */
  ariaLabel?: string;
  /** 校验失败态（描红边框） */
  invalid?: boolean;
  /** 占位提示（空内容时显示） */
  placeholder?: string;
}

export function MdEditor({
  value,
  onChange,
  height = '320px',
  ariaLabel,
  invalid = false,
  placeholder,
}: MdEditorProps): React.ReactNode {
  const { resolvedMode } = useTheme();
  const dark = resolvedMode === 'dark';

  const extensions = useMemo<Extension[]>(
    () => [markdown(), EditorView.lineWrapping, syntaxHighlighting(mdHighlight)],
    [],
  );
  const theme = useMemo(() => paletteTheme(dark), [dark]);

  return (
    <div
      className={cn(
        'border-input bg-background overflow-hidden rounded-md border',
        invalid && 'border-destructive',
        '[&_.cm-editor]:h-full',
      )}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={theme}
        extensions={extensions}
        height={height}
        placeholder={placeholder}
        indentWithTab
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          autocompletion: false,
          closeBrackets: false,
          bracketMatching: false,
          highlightSelectionMatches: false,
          highlightActiveLine: true,
          syntaxHighlighting: false, // 用上方 CSS 变量版高亮，避免与内置 defaultHighlightStyle 叠加
          tabSize: 2,
        }}
      />
    </div>
  );
}
