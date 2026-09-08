'use strict';

/**
 * hello-world — Opptrix Harness OS 示例扩展。
 *
 * defineExtension 仅在激活期执行一次：route/webhook/on/hook/expose/cron/page/menu
 * 必须在 setup 内注册（激活期之后调用会抛 EXT_REGISTRATION_PHASE）。
 * 完整 API 见仓库 types/harness.d.ts。
 */

defineExtension(async (h) => {
  // HTTP 路由：最终挂载于 /ext/hello-world/hello
  h.route('GET', '/hello', async () => ({ hello: 'world', from: 'hello-world' }), { auth: 'public' });

  // 订阅内核文件上传事件（payload 为 FileRecord；权限清单含 events）
  h.on('file.uploaded', async () => {
    // 示例占位：拿到 payload 后可写 h.db、发 h.notify 等
  });

  // 定时任务示例（默认注释；取消注释即启用。5 段 cron，内核默认时区）：
  // h.cron('*/5 * * * *', 'tick', async () => {
  //   h.log.info('hello-world tick');
  // });
});
