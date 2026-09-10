/**
 * Agent Chat 全屏界面骨架契约测试（静态源码断言，与 webui.test.ts 同款约定）。
 *
 * 覆盖：
 * - pages/AgentChat.tsx 存在且为全屏双栏骨架：280px 会话列表 + 品牌区（Opptrix Harness）+
 *   「新建对话」+ 归档 badge + 底部「← Dashboard」（Link to /admin）；
 * - router.tsx 的 /chat 路由在 RequireAuth 内、AppShell 之外（全屏独立 Layout）；
 * - 对话区契约：Enter 发送（IME 守卫）、模型 Select、tool_calls 折叠、SSE `agent:{sessionId}`
 *   订阅 + message.created 追加、REST 端点与内核 /api/v1/agents/sessions* 契约对齐；
 * - 工程契约：无 console.*；shadcn 主题令牌（bg-background/border-border/bg-primary）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'extensions', 'webui', 'ui-src', 'src');

/** 源码 console.* 禁用断言（与 webui.test.ts 同款收口） */
function expectNoConsole(file: string, src: string): void {
  expect(src, `${file} uses console.*`).not.toMatch(/\bconsole\.(log|error|warn|info|debug)/);
}

describe('Agent Chat 全屏骨架（ui-src 源码契约）', () => {
  const page = readFileSync(join(UI_SRC, 'pages', 'AgentChat.tsx'), 'utf8');
  const router = readFileSync(join(UI_SRC, 'router.tsx'), 'utf8');

  it('1. AgentChat.tsx 存在：全屏双栏布局（h-svh + 280px 侧栏）、品牌区 + 新建对话 + 归档 badge', () => {
    // 全屏 Layout（不经 AppShell）：根容器占满视口、左栏固定 280px
    expect(page).toContain('h-svh');
    expect(page).toContain('w-[280px]');
    // 品牌：与 Dashboard 侧栏同款（Opptrix Harness 主标 + BoxesIcon logo 方块）
    expect(page).toContain('Opptrix Harness');
    expect(page).toContain('BoxesIcon');
    expect(page).toContain('bg-primary');
    // 「新建对话」按钮 + 会话归档 badge
    expect(page).toContain('新建对话');
    expect(page).toContain('归档');
    // 底部「← Dashboard」= Link to /admin
    expect(page).toContain('to="/admin"');
    expect(page).toContain('Dashboard');
    expectNoConsole('AgentChat.tsx', page);
  });

  it('2. router.tsx：/chat 注册在 RequireAuth 内、AppShell 之外（全屏独立 Layout）', () => {
    expect(router).toContain("import AgentChatPage from '@/pages/AgentChat'");
    expect(router).toContain('path="/chat"');
    const chatRoute = router.indexOf('path="/chat"');
    const appShell = router.indexOf('<AppShell');
    expect(chatRoute).toBeGreaterThan(-1);
    expect(appShell).toBeGreaterThan(-1);
    // /chat 在 AppShell 段之前注册（不经 AppShell 包裹）
    expect(chatRoute).toBeLessThan(appShell);
    // 仍在认证守卫内（RequireAuth 包裹全部业务路由）
    expect(router).toContain('RequireAuth');
    expectNoConsole('router.tsx', router);
  });

  it('3. 对话区契约：Enter 发送（IME 守卫）、模型 Select、附件占位、Skills/MCP chip、tool_calls 折叠', () => {
    // Composer：Enter 发送 + Shift+Enter 换行 + IME 组合输入守卫
    expect(page).toContain("e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing");
    // 模型 Select（GET /api/v1/llm/models 目录）+ 附件按钮占位 + 快捷 chip
    expect(page).toContain('SelectTrigger');
    expect(page).toContain('/api/v1/llm/models');
    expect(page).toContain('附件');
    expect(page).toContain('Skills');
    expect(page).toContain('MCP');
    // tool_calls 折叠展示（details/summary）+ user/assistant 对齐
    expect(page).toContain('toolCalls');
    expect(page).toContain('<details');
    expect(page).toContain('justify-end');
    expect(page).toContain('justify-start');
    // 消息输入框 aria 标签
    expect(page).toContain('消息输入框');
  });

  it('4. 实时面契约：SSE 订阅 agent:{sessionId} + message.created 追加 + replay-gap 对账；REST 契约对齐', () => {
    // SSE：topic `agent:{sessionId}`（connectSse）+ message.created 追加（幂等去重）
    expect(page).toContain('connectSse');
    expect(page).toContain('agent:${sessionId}');
    expect(page).toContain("e.event !== 'message.created'");
    expect(page).toContain('onReplayGap');
    // lib/sse.ts 已登记 agent 会话事件名（named frame 才会分发）
    const sse = readFileSync(join(UI_SRC, 'lib', 'sse.ts'), 'utf8');
    expect(sse).toContain("'message.created'");
    expect(sse).toContain("'generation.cancelled'");
    // REST 端点与内核 /api/v1/agents/sessions* 契约对齐
    expect(page).toContain('/api/v1/agents/sessions');
    expect(page).toContain('/messages');
    expect(page).toContain('/cancel');
    // 新建对话自动标题：首条 user 消息前 30 字符
    expect(page).toContain('AUTO_TITLE_MAX_CHARS = 30');
    expect(page).toContain("api.patch<AgentSession>");
  });

  it('5. 样式契约：shadcn 主题令牌（--background/--foreground/--border 的 Tailwind 映射），暗色跟随 .dark', () => {
    // 根容器与分隔线走主题令牌（亮暗两套变量由 styles.css + .dark 提供）
    expect(page).toContain('bg-background');
    expect(page).toContain('text-foreground');
    expect(page).toContain('border-border');
    expect(page).toContain('bg-muted');
    // 组件面统一走 shadcn ui 封装（Button/Badge/Select/Textarea）
    for (const ui of ['@/components/ui/button', '@/components/ui/badge', '@/components/ui/select', '@/components/ui/textarea']) {
      expect(page).toContain(ui);
    }
  });
});
