import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * webui 构建配置（React 18 + Tailwind CSS v4 + shadcn/ui）。
 *
 * Tailwind 选型说明：选 v4（@tailwindcss/vite 一等插件 + CSS-first `@theme` 配置），
 * shadcn/ui 官方组件源码自 2025 起原生支持 v4（CSS 变量即设计 token），无需
 * tailwind.config.js/postcss 配置文件，与「CSS 变量主题体系」交付天然契合。
 *
 * - base './'：产物被内核挂载在 `/ext/webui/ui/` 前缀下（src/kernel/extensions/assets.ts，
 *   root=<extDir>/ui、index:false）。相对 base 让 index.html 内的资产引用
 *   （`./assets/*.js`）在该前缀下自洽解析，且内核若把同一产物接管到 /admin
 *   等其他前缀也无需重建。
 * - outDir '../ui'：产物直接落到扩展目录的 ui/（内核静态资产约定的目录名），
 *   .gitignore 已用 `!extensions/webui/ui/` 白名单跟踪该目录。
 * - SPA 路由用 HashRouter（react-router-dom）：静态挂载无目录索引（index:false）
 *   也无 rewrite 能力，history 模式的深链刷新会 404，hash 模式是历史约束下的唯一解。
 */
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../ui',
    emptyOutDir: true,
    sourcemap: false,
  },
});
