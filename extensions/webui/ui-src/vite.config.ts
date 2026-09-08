import { defineConfig } from 'vite';

import vue from '@vitejs/plugin-vue';

/**
 * webui 构建配置。
 *
 * - base './'：产物被内核挂载在 `/ext/webui/ui/` 前缀下（src/kernel/extensions/assets.ts，
 *   root=<extDir>/ui、index:false）。相对 base 让 index.html 内的资产引用
 *   （`./assets/*.js`）在该前缀下自洽解析，且未来内核若把同一产物接管到 /admin
 *   等其他前缀也无需重建。（任务书原写 base:'/' 是按 /admin 根前缀假设；实际内核
 *   挂载前缀为 /ext/webui/ui/，相对路径是唯一同时兼容两者的选择。）
 * - outDir '../ui'：产物直接落到扩展目录的 ui/（内核静态资产约定的目录名），
 *   .gitignore 已用 `!extensions/webui/ui/` 白名单跟踪该目录。
 * - SPA 路由用 hash 模式（vue-router createWebHashHistory）：静态挂载无目录索引
 *   （index:false）也无 rewrite 能力，history 模式的深链刷新会 404。
 */
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: '../ui',
    emptyOutDir: true,
    sourcemap: false,
  },
});
