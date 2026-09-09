'use strict';

/**
 * doc-extract — 文档内容提取（builtin 轻壳）。
 *
 * 提取引擎本体在内核（src/kernel/fileextract/**，跑在内核任务线程池），本扩展刻意保持
 * 轻量：只注册一个 /status 说明路由。系统 MCP 工具 `files_extract`、REST
 * `/api/v1/extract*` 与内核桥 topic（extract.file / extract.status）均由内核直接提供，
 * 不经本扩展转发——manifest 声明 'files:read' 仅表示本扩展家族对该能力的访问身份，
 * 引擎调用方的权限由内核桥/REST 各自的门禁收口。
 */
defineExtension(async (h) => {
  h.route('GET', '/status', async () => ({
    status: 200,
    body: {
      extension: 'doc-extract',
      builtin: true,
      engine: 'kernel task pool (src/kernel/fileextract)',
      kernelProvided: {
        rest: [
          'POST /api/v1/extract',
          'POST /api/v1/extract/file/:fileId',
          'GET /api/v1/extract/status',
        ],
        mcpTools: ['files_extract'],
        bridgeTopics: ['extract.file', 'extract.status'],
      },
      formats: {
        text: ['.txt', '.md', '.csv', '.json', '.xml', '.html', '.log'],
        pdf: ['.pdf (weak text layer auto-upgrades to OCR when models are ready)'],
        office: ['.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls'],
        ocr: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'],
      },
      note:
        '系统 MCP 工具由内核提供（本扩展仅为能力说明入口）；'
        + 'OCR 模型状态见 GET /api/v1/extract/status。',
    },
  }));
});
