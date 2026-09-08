import { createApp, h } from 'vue';

import App from './App.vue';
import { router } from './router';
import './styles.css';

/**
 * SPA 入口：暗色主题变量挂在 :root（见 styles.css），App.vue 提供布局与 toast 容器。
 * 路由用 hash 模式（静态挂载无 rewrite，见 vite.config.ts 注释）。
 */
document.title = 'Opptrix Console';

createApp({
  render: () => h(App),
}).use(router).mount('#app');
