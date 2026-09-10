/**
 * filePreview — 工作区文件预览类型判定与 workspace file 直链解析（纯函数）。
 *
 * 从 WorkspacePanel 抽取共享：对话消息里的工作区文件引用（MarkdownMessage 渲染的文件 chip）
 * 与文件树面板（WorkspacePanel）用同一套「按扩展名三分类」逻辑决定预览方式：
 * - image → <img> 直链；html → iframe 直链（?token=，报告 CSP 由端点下发）；text → 拉取文本 <pre>；
 * - 未知二进制 → null（仅下载/删除，不预览）。
 */

export type PreviewKind = 'image' | 'html' | 'text';

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export const HTML_EXTS = new Set(['html', 'htm']);
export const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'css', 'scss', 'less', 'yml', 'yaml', 'xml', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql', 'toml', 'ini', 'cfg',
  'conf', 'env', 'properties', 'graphql', 'proto', 'vue', 'svelte', 'dockerfile', 'makefile',
]);

/**
 * previewKindOfName — 按文件名（扩展名）判定预览类型：
 * 无扩展名（Makefile/LICENSE 等）按文本尝试；有扩展名但不在白名单 → 未知二进制（null）。
 */
export function previewKindOfName(name: string): PreviewKind | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (HTML_EXTS.has(ext)) return 'html';
  return name.includes('.') ? (TEXT_EXTS.has(ext) ? 'text' : null) : 'text';
}

/** workspace file 直链形态：/api/v1/agents/sessions/:id/workspace/file?path=...（&token=... 可选） */
const WORKSPACE_FILE_URL_RE = /^\/api\/v1\/agents\/sessions\/([^/]+)\/workspace\/file\?(.*)$/;

/** 从 workspace file 直链解析出 {sessionId, path, name}（非该形态 → null） */
export function workspaceFileRefFromUrl(url: string): { sessionId: string; path: string; name: string } | null {
  const match = WORKSPACE_FILE_URL_RE.exec(url.split('#')[0] ?? '');
  if (match === null) return null;
  const sessionId = match[1] ?? '';
  try {
    const query = new URLSearchParams(match[2] ?? '');
    const path = query.get('path') ?? '';
    if (path === '') return null;
    const name = path.split('/').pop() ?? path;
    return { sessionId, path, name };
  } catch {
    return null;
  }
}
