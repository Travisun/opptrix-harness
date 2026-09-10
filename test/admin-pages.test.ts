/**
 * 管理台三页（Skills / MCP / Plugins）源码契约测试（静态源码断言，与
 * agent-session-ui.test.ts / webui.test.ts 同款约定——不渲染组件，断言源码契约面）。
 *
 * 覆盖：
 * - 三页面文件存在（pages/Skills.tsx、pages/Mcp.tsx、pages/Plugins.tsx）且无 console.*；
 * - router.tsx 含 /skills /mcp /plugins 三条路由（AppShell 内、RequireAuth 守卫内）；
 * - lib/api.ts 追加面：skillsApi / mcpApi / pluginsApi 方法组 + getSystemMcpTools
 *   （/mcp JSON-RPC tools/list 探测）存在（api 方法存在断言）；
 * - 每页关键渲染契约：Tabs/表格/Switch/Dialog/抽屉/分页与 REST 端点消费；
 * - 新增子件（CreateSkillPanel / SystemServerCard）存在且契约完整。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'webui', 'ui-src', 'src');

/** 源码 console.* 禁用断言（与 webui.test.ts 同款收口） */
function expectNoConsole(file: string, src: string): void {
  expect(src, `${file} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
}

describe('管理台三页（Skills / MCP / Plugins）源码契约', () => {
  const skillsPage = readFileSync(join(UI_SRC, 'pages', 'Skills.tsx'), 'utf8');
  const mcpPage = readFileSync(join(UI_SRC, 'pages', 'Mcp.tsx'), 'utf8');
  const pluginsPage = readFileSync(join(UI_SRC, 'pages', 'Plugins.tsx'), 'utf8');
  const router = readFileSync(join(UI_SRC, 'router.tsx'), 'utf8');
  const apiLib = readFileSync(join(UI_SRC, 'lib', 'api.ts'), 'utf8');

  it('1. 三页面文件存在（pages/Skills.tsx、pages/Mcp.tsx、pages/Plugins.tsx）且均无 console.*', () => {
    for (const rel of ['pages/Skills.tsx', 'pages/Mcp.tsx', 'pages/Plugins.tsx']) {
      expect(existsSync(join(UI_SRC, ...rel.split('/'))), `${rel} missing`).toBe(true);
    }
    expectNoConsole('pages/Skills.tsx', skillsPage);
    expectNoConsole('pages/Mcp.tsx', mcpPage);
    expectNoConsole('pages/Plugins.tsx', pluginsPage);
  });

  it('2. router.tsx：/skills、/mcp、/plugins 三条路由注册在 AppShell 内、RequireAuth 守卫内', () => {
    for (const route of ['/skills', '/mcp', '/plugins']) {
      expect(router, `route missing: ${route}`).toContain(`path="${route}"`);
    }
    for (const pageImport of [
      "import SkillsPage from '@/pages/Skills'",
      "import McpPage from '@/pages/Mcp'",
      "import PluginsPage from '@/pages/Plugins'",
    ]) {
      expect(router).toContain(pageImport);
    }
    // 三条路由均在 <AppShell /> 段内注册（管理台内页），且整体在 RequireAuth 守卫内
    const appShell = router.indexOf('<AppShell />');
    expect(appShell).toBeGreaterThan(-1);
    for (const route of ['/skills', '/mcp', '/plugins']) {
      expect(router.indexOf(`path="${route}"`)).toBeGreaterThan(appShell);
    }
    expect(router).toContain('RequireAuth');
    expectNoConsole('router.tsx', router);
  });

  it('3. lib/api.ts 追加面：skillsApi / mcpApi / pluginsApi 方法组与 getSystemMcpTools 存在（api 方法存在断言）', () => {
    // Skills：list/get/create/remove/refresh（GET|POST|DELETE /api/v1/skills*）
    expect(apiLib).toContain('export const skillsApi');
    for (const method of ['list:', 'get:', 'create:', 'remove:', 'refresh:']) {
      expect(apiLib.slice(apiLib.indexOf('export const skillsApi')), `skillsApi.${method} missing`).toContain(method);
    }
    expect(apiLib).toContain("'/api/v1/skills'");
    expect(apiLib).toContain("'/api/v1/skills/refresh'");
    // MCP：servers CRUD + connect + tools
    expect(apiLib).toContain('export const mcpApi');
    for (const method of ['listServers:', 'createServer:', 'patchServer:', 'removeServer:', 'connectServer:', 'listTools:']) {
      expect(apiLib.slice(apiLib.indexOf('export const mcpApi')), `mcpApi.${method} missing`).toContain(method);
    }
    expect(apiLib).toContain("'/api/v1/mcp/servers'");
    expect(apiLib).toContain('/connect');
    // Plugins：list/get/install/remove/refresh（zip multipart + ?force=1 卸载）
    expect(apiLib).toContain('export const pluginsApi');
    for (const method of ['list:', 'get:', 'install:', 'remove:', 'refresh:']) {
      expect(apiLib.slice(apiLib.indexOf('export const pluginsApi')), `pluginsApi.${method} missing`).toContain(method);
    }
    expect(apiLib).toContain('`/api/v1/plugins/install');
    expect(apiLib).toContain('?force=1');
    // 系统 MCP 服务端探测：JSON-RPC tools/list 直连 /mcp（Accept 双类型 + Bearer）
    expect(apiLib).toContain('export async function getSystemMcpTools');
    expect(apiLib).toContain("method: 'tools/list'");
    expect(apiLib).toContain("'application/json, text/event-stream'");
    expect(apiLib).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
  });

  it('4. Skills 页面：Tabs（技能列表 + 新建技能）+ 表格 + 启用 Switch + 数据卷删改闸 + 分页 + 抽屉/弹窗接线', () => {
    // Tabs 双页签（列表 + 新建）
    expect(skillsPage).toContain('TabsList');
    expect(skillsPage).toContain('技能列表');
    expect(skillsPage).toContain('新建技能');
    // 列表表格 + 行内启用状态 Switch（frontmatter 只读事实）+ 客户端分页
    expect(skillsPage).toContain('<Table');
    expect(skillsPage).toContain('<Switch');
    expect(skillsPage).toContain('@/components/pagination');
    expect(skillsPage).toContain('<Pagination');
    expect(skillsPage).toContain('.slice(');
    // 数据卷来源删改闸（webui.test.ts 同款契约串）+ 弹窗/抽屉接线
    expect(skillsPage).toContain("source === 'data'");
    expect(skillsPage).toContain('EditSkillDialog');
    expect(skillsPage).toContain('DeleteSkillDialog');
    expect(skillsPage).toContain('SkillDetailSheet');
    // 新建 Tab 表单面板 + 重扫（POST /refresh）
    expect(skillsPage).toContain('CreateSkillPanel');
    expect(skillsPage).toContain('skillsApi');
    expect(skillsPage).toContain('重扫');
  });

  it('5. Mcp 页面：双区块（客户端连接 + 系统服务端）+ 测试连接 + 启停 Switch + 删除确认 + 分页', () => {
    // 区块标题：客户端连接 + 系统服务端
    expect(mcpPage).toContain('MCP 客户端连接');
    expect(mcpPage).toContain('系统 MCP 服务端');
    expect(mcpPage).toContain('SystemServerCard');
    // 客户端表格：传输/状态徽标 + 工具数 + 启停 Switch + 测试连接（POST :id/connect）
    expect(mcpPage).toContain('<Table');
    expect(mcpPage).toContain('<Switch');
    expect(mcpPage).toContain('TransportBadge');
    expect(mcpPage).toContain('StateBadge');
    expect(mcpPage).toContain('测试');
    expect(mcpPage).toContain('mcpApi');
    // 删除 Dialog 确认 + 新建连接 Dialog + 详情区 + 客户端分页
    expect(mcpPage).toContain('删除 MCP 服务器');
    expect(mcpPage).toContain('ServerCreateDialog');
    expect(mcpPage).toContain('ServerEditDialog');
    expect(mcpPage).toContain('ServerDetail');
    expect(mcpPage).toContain('<Pagination');
    expect(mcpPage).toContain('.slice(');
  });

  it('6. SystemServerCard：/mcp 只读状态卡——端点/协议/鉴权元信息 + tools/list 探测 + 折叠工具目录表', () => {
    const card = readFileSync(join(UI_SRC, 'pages', 'Mcp', 'SystemServerCard.tsx'), 'utf8');
    // 端点 /mcp + 只读状态元信息（协议 / 鉴权 / 工具总数）
    expect(card).toContain('/mcp');
    expect(card).toContain('协议');
    expect(card).toContain('鉴权');
    expect(card).toContain('工具总数');
    // 目录经 getSystemMcpTools（JSON-RPC tools/list）探测；成功/不可探测徽标二态
    expect(card).toContain('getSystemMcpTools');
    expect(card).toContain('运行中');
    expect(card).toContain('不可探测');
    // 折叠目录（details/summary）+ Table（工具名/描述）
    expect(card).toContain('<details');
    expect(card).toContain('<summary');
    expect(card).toContain('<Table');
    expectNoConsole('SystemServerCard.tsx', card);
  });

  it('7. Plugins 页面：已装插件表格（版本 + 贡献摘要 badges + 安装时间）+ 安装/卸载/详情接线 + 分页', () => {
    // 表格列契约：版本徽标 + 贡献摘要 badges + 安装时间
    expect(pluginsPage).toContain('<Table');
    expect(pluginsPage).toContain('ContributionChips');
    expect(pluginsPage).toContain('版本');
    expect(pluginsPage).toContain('formatInstalledAt');
    // 安装弹窗（zip 上传，安装中反馈 → 成功 toast / 失败 errText 在 InstallDialog 内）+ 卸载确认 + 详情抽屉
    expect(pluginsPage).toContain('安装插件');
    expect(pluginsPage).toContain('InstallDialog');
    expect(pluginsPage).toContain('UninstallDialog');
    expect(pluginsPage).toContain('PluginDetailDrawer');
    // 聚合刷新（POST /plugins/refresh）+ 客户端分页 + 安全提示
    expect(pluginsPage).toContain('pluginsApi');
    expect(pluginsPage).toContain('refresh');
    expect(pluginsPage).toContain('<Pagination');
    expect(pluginsPage).toContain('SecurityNotice');
  });

  it('8. CreateSkillPanel：新建 Tab 表单面板——id slug 联动 + MdEditor 正文 + 字节上限 + skillsApi.create 提交', () => {
    const panel = readFileSync(join(UI_SRC, 'pages', 'Skills', 'CreateSkillPanel.tsx'), 'utf8');
    // 表单字段（ID/名称/描述/标签/作者）+ md-editor 正文 + 128KB 字节口径
    expect(panel).toContain('MdEditor');
    expect(panel).toContain('parseSkillFile');
    expect(panel).toContain('slugifyId');
    expect(panel).toContain('BODY_LIMIT_BYTES');
    // 提交面：POST /api/v1/skills（skillsApi.create）+ 创建成功回调
    expect(panel).toContain('skillsApi.create');
    expect(panel).toContain('onCreated');
    expectNoConsole('CreateSkillPanel.tsx', panel);
  });
});
