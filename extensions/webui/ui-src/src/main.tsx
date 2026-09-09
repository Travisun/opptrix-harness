import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme';
import { AppRoutes } from '@/router';

import './styles.css';

/**
 * main — 控制台入口。
 *
 * Provider 层级：Theme（模式/预设/圆角/密度/自定义覆盖 → CSS 变量）
 *   → Toast（轻量全局提示，api.ts 错误经模块级 toast() 上报）
 *   → Tooltip（侧栏折叠态/顶栏图标按钮的悬停提示）
 *   → HashRouter（静态挂载无 rewrite，历史约束）。
 * 挂载点为 index.html 的 <div id="app">（id 沿用 Vue 时代的约定：
 * 内核侧集成终验 integration.final.test.ts 断言该标记，React 对挂载点命名无要求）。
 */
const container = document.getElementById('app');
if (container === null) {
  throw new Error('挂载点缺失：<div id="app"> 不存在');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <TooltipProvider>
          <AppRoutes />
        </TooltipProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
