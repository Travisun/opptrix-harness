/**
 * Chat 会话树 + 工作区文件面板 UI 源码契约测试（静态源码断言，与 admin-pages.test.ts /
 * agent-session-ui.test.ts 同款约定——不渲染组件，断言源码契约面）。
 *
 * 覆盖：
 * - pages/AgentChat.tsx 与新增 pages/AgentChat/WorkspacePanel.tsx 存在且无 console.*；
 * - 会话树：buildSessionTree 按 parent_id 组树（孤儿按根处理）、子会话缩进 + 「↳ 子会话」
 *   徽标、父会话展开/收起钮、操作菜单「新建子会话」（POST 带 parent_id）、「新建对话」仍根会话；
 * - 子会话面包屑：父会话名可点击跳回；
 * - 工作区抽屉：「📁 文件」入口、右侧 320px Sheet、文件树逐层懒加载、上传（FileReader→base64
 *   →PUT，≤8MB 前端校验）、预览三态（文本/图片/HTML iframe + ?token=）、a[download] 下载、
 *   删除确认、EmptyState 空态文案；
 * - 工具调用渲染增强：workspace_write/read/delete、report_create（url 直开 + token）、
 *   browser_screenshot 缩略图；通用折叠保留兜底；
 * - lib/api.ts 追加面：workspaceApi 方法组（list/fileUrl/read/write/remove）与 url 形状；
 * - 降级契约：parent_id/user_id 后端未落地时按 undefined 处理（可选字段 + 可选链）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'webui', 'ui-src', 'src');

/** 源码 console.* 禁用断言（与 admin-pages.test.ts 同款收口） */
function expectNoConsole(file: string, src: string): void {
  expect(src, `${file} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
}

describe('Chat 会话树 + 工作区文件面板（ui-src 源码契约）', () => {
  const page = readFileSync(join(UI_SRC, 'pages', 'AgentChat.tsx'), 'utf8');
  const panel = readFileSync(join(UI_SRC, 'pages', 'AgentChat', 'WorkspacePanel.tsx'), 'utf8');
  const apiLib = readFileSync(join(UI_SRC, 'lib', 'api.ts'), 'utf8');

  it('1. 三文件存在（AgentChat.tsx / AgentChat/WorkspacePanel.tsx / lib/api.ts）且均无 console.*', () => {
    for (const rel of ['pages/AgentChat.tsx', 'pages/AgentChat/WorkspacePanel.tsx', 'lib/api.ts']) {
      expect(existsSync(join(UI_SRC, ...rel.split('/'))), `${rel} missing`).toBe(true);
    }
    expectNoConsole('pages/AgentChat.tsx', page);
    expectNoConsole('pages/AgentChat/WorkspacePanel.tsx', panel);
    expectNoConsole('lib/api.ts', apiLib);
  });

  it('2. 会话树：buildSessionTree 按 parent_id 组树 + 孤儿按根处理 + 子会话缩进 + 「↳ 子会话」徽标 + 展开/收起钮', () => {
    // 组树函数：按 parent_id 分组；父缺失（已删孤儿）落入 roots（按根处理，不丢失）
    expect(page).toContain('function buildSessionTree(sessions: AgentSession[]): SessionTreeNode[]');
    expect(page).toContain('const pid = s.parent_id ?? null;');
    expect(page).toContain('roots.push(node)');
    expect(page).toContain('孤儿（父已删）按根处理');
    // 可见列表按缩进深度展平（子会话缩进渲染；防环防御）
    expect(page).toContain('visibleNodes');
    expect(page).toContain('depth + 1');
    // 子会话徽标（仅当父会话存在且展开时随缩进渲染）
    expect(page).toContain('↳ 子会话');
    expect(page).toContain('const isChild = depth > 0');
    // 父会话展开/收起钮（点击不切换会话）+ 折叠集合
    expect(page).toContain('展开子会话');
    expect(page).toContain('收起子会话');
    expect(page).toContain('aria-expanded={expanded}');
    expect(page).toContain('toggleExpanded');
  });

  it('3. 子会话操作菜单「新建子会话」（POST 带 parent_id）；「新建对话」仍建根会话（无 parentId）', () => {
    // 会话项操作菜单：DropdownMenu + 新建子会话项 → createChildSession
    expect(page).toContain('@/components/ui/dropdown-menu');
    expect(page).toContain('<DropdownMenu>');
    expect(page).toContain('新建子会话');
    expect(page).toContain('const createChildSession');
    // 以当前会话为 parentId 创建并切换
    expect(page).toContain('parent_id: parent.id');
    expect(page).toContain('openSession(created.id)');
    // 根会话惰性创建不携带 parent_id（新建对话仍是根）
    expect(page).toContain("model !== '' ? { model } : {}");
    expect(page).toContain('const startNewConversation');
  });

  it('4. 子会话顶部面包屑「父会话名 / 当前会话名」，点击父名跳回父会话', () => {
    expect(page).toContain('aria-label="会话面包屑"');
    expect(page).toContain('openSession(parentSession.id)');
    expect(page).toContain('返回父会话');
    // 父会话解析走可选链（parent_id 未落地/根会话/父已删 → null 不渲染）
    expect(page).toContain('activeSession?.parent_id');
  });

  it('5. 工作区入口：对话区顶栏「📁 文件」按钮 → 右侧 320px 抽屉（Sheet，可收起）', () => {
    // 入口按钮 + 面板接线（当前会话 id / 开合受控）
    expect(page).toContain('📁 文件');
    expect(page).toContain("import { WorkspacePanel } from '@/pages/AgentChat/WorkspacePanel'");
    expect(page).toContain('<WorkspacePanel');
    expect(page).toContain('sessionId={activeId}');
    expect(page).toContain('onOpenChange={setWsOpen}');
    // 抽屉：Sheet side="right" 固定 320px
    expect(panel).toContain('@/components/ui/sheet');
    expect(panel).toContain('<Sheet open={open} onOpenChange={onOpenChange}>');
    expect(panel).toContain('side="right"');
    expect(panel).toContain('w-[320px]');
  });

  it('6. 文件树：GET workspace 逐层懒加载（recursive=false）、目录折叠展开、名称/大小/时间', () => {
    // 单层懒加载：recursive=false 逐层拉取（根目录传空串）
    expect(panel).toContain('workspaceApi.list(sessionId, dir, false)');
    expect(panel).toContain("loadChildren('')");
    // 目录折叠展开（懒拉子级缓存）
    expect(panel).toContain('const toggleDir');
    expect(panel).toContain('dirChildren');
    expect(panel).toContain('expandedDirs');
    // 每项展示 名称 / 大小 / 时间
    expect(panel).toContain('formatBytes(entry.size)');
    expect(panel).toContain('formatDateTime(entry.mtime)');
    expect(panel).toContain('title={entry.path}');
  });

  it('7. 上传：input[file] → FileReader 转 base64 → PUT（≤8MB 前端校验）→ 刷新列表 + toast', () => {
    expect(panel).toContain('type="file"');
    expect(panel).toContain('const MAX_UPLOAD_BYTES = 8 * 1024 * 1024');
    expect(panel).toContain('file.size > MAX_UPLOAD_BYTES');
    expect(panel).toContain('new FileReader()');
    expect(panel).toContain('readAsDataURL(file)');
    expect(panel).toContain('workspaceApi.write(sessionId, file.name, base64)');
    expect(panel).toContain("toast.success('上传成功', file.name)");
    expect(panel).toContain('await reloadAll()');
  });

  it('8. 预览三态：文本（read + 截断）/ 图片（img 直链）/ HTML（Dialog + iframe src=file 端点 + ?token=）', () => {
    // 预览类型判定：image/html/text；未知二进制不提供预览
    expect(panel).toContain("type PreviewKind = 'image' | 'html' | 'text'");
    expect(panel).toContain('function previewKind(entry: WorkspaceEntry)');
    // HTML：iframe 直链（fileUrl 内置 ?token= 通道）
    expect(panel).toContain("previewKindOf === 'html'");
    expect(panel).toContain('<iframe');
    expect(panel).toContain('src={previewUrl}');
    expect(panel).toContain('workspaceApi.fileUrl(sessionId, preview.path)');
    // 图片：img 直链直接预览；文本：workspaceApi.read 拉正文 + 超长截断
    expect(panel).toContain('<img src={previewUrl}');
    expect(panel).toContain('.read(sessionId, entry.path)');
    expect(panel).toContain('TEXT_PREVIEW_MAX_CHARS');
  });

  it('9. 下载（a href file 端点 download 属性）与删除（Dialog 确认 → DELETE）', () => {
    expect(panel).toContain('download={entry.name}');
    expect(panel).toContain('workspaceApi.fileUrl(sessionId, entry.path)');
    // 删除确认弹窗 → workspaceApi.remove → 刷新
    expect(panel).toContain('删除文件');
    expect(panel).toContain('该操作不可撤销');
    expect(panel).toContain('const confirmDelete');
    expect(panel).toContain('workspaceApi.remove(sessionId, deleteTarget.path)');
  });

  it('10. 空状态 EmptyState：「工作区暂无文件，对话中生成的报告/截图/代码产物会出现在这里」', () => {
    expect(panel).toContain('@/pages/_shared');
    expect(panel).toContain('<EmptyState');
    expect(panel).toContain('工作区暂无文件，对话中生成的报告/截图/代码产物会出现在这里');
  });

  it('11. 工具调用渲染增强：workspace_write/read/delete、report_create（url 直开 + token）、browser_screenshot 缩略图；通用折叠兜底保留', () => {
    // 受管工具名集合 + 按序配对（成功结果 FIFO 归还，失败走通用折叠）
    expect(page).toContain('TRACKED_TOOL_NAMES');
    expect(page).toContain("'workspace_write', 'workspace_read', 'workspace_delete', 'report_create', 'browser_screenshot'");
    expect(page).toContain('function mapToolResults(messages: AgentMessage[])');
    // workspace_write → 「已写入 📄 {path} (size)」；read/delete 同理（path 主键）
    expect(page).toContain('已写入 📄');
    expect(page).toContain('已读取 📄');
    expect(page).toContain('已删除 📄');
    expect(page).toContain('formatBytes(payload.size)');
    // report_create → 「报告已生成」+ 预览按钮（url + ?token= 直开）
    expect(page).toContain('报告已生成');
    expect(page).toContain('withToken(reportUrl)');
    expect(page).toContain('typeof payload.url !== \'string\' || payload.url === \'\'');
    // browser_screenshot → 内嵌缩略图（workspace file 端点直链）点击放大
    expect(page).toContain('data-tool-result="browser_screenshot"');
    expect(page).toContain('workspaceApi.fileUrl(sessionId, path)');
    expect(page).toContain('function screenshotPathFromArgs');
    // 现有通用折叠保留为兜底
    expect(page).toContain('<details');
    expect(page).toContain('调用了 {toolCalls.length} 个工具');
  });

  it('12. lib/api.ts 追加面：workspaceApi 方法组（list/fileUrl/read/write/remove）与 url 形状', () => {
    expect(apiLib).toContain('export const workspaceApi');
    const seg = apiLib.slice(apiLib.indexOf('export const workspaceApi'));
    for (const method of ['list:', 'fileUrl:', 'read:', 'write:', 'remove:']) {
      expect(seg, `workspaceApi.${method} missing`).toContain(method);
    }
    // url 形状：/api/v1/agents/sessions/:id/workspace?path=&recursive=（列表）
    expect(apiLib).toContain('`/api/v1/agents/sessions/${encodeURIComponent(sessionId)}/workspace`');
    expect(seg).toContain('?path=${encodeURIComponent(path)}&recursive=');
    // file 直链 / 读 / 写 / 删（?token= 查询通道 + { path, content } 写体 + ?path= 定位删）
    expect(seg).toContain('/file?${query}&token=${encodeURIComponent(token)}');
    expect(seg).toContain('/file?path=${encodeURIComponent(path)}');
    expect(seg).toContain("{ path, content }");
    // 列表条目契约：name/path/type/size/mtime
    expect(apiLib).toContain('export interface WorkspaceEntry');
    expect(apiLib).toContain("type: 'file' | 'dir'");
  });

  it('13. 后端字段未落地的降级契约：parent_id/user_id 为可选字段，读取走可选链不崩溃', () => {
    // AgentSession 视图：parent_id/user_id 均可选（后端并行落地前按 undefined 处理）
    expect(page).toContain('user_id?: string | null;');
    expect(page).toContain('parent_id?: string | null;');
    // 组树/面包屑/子会话判定全部容忍缺失值（?? null 与可选链）
    expect(page).toContain('s.parent_id ?? null');
    expect(page).toContain('activeSession?.parent_id');
    // 工作区条目字段同样容忍缺失（entries 兜底空数组）
    expect(panel).toContain('res.entries ?? []');
    expect(panel).toContain('(rootEntries ?? [])');
  });
});
