'use strict';

/**
 * coding — 沙箱化代码执行会话（builtin 轻壳）。
 *
 * 引擎本体在内核（src/kernel/coding/**，受控子进程路径：会话目录 + 命令白名单 +
 * shell:false argv 直传 + 超时 kill + 输出截断 + 每会话并发 1 进程），本扩展刻意
 * 保持轻量：仅注册面向用户的 HTTP 路由（auth:'user'，最终挂载于 /ext/coding 前缀），
 * 全部经 h.coding 桥（coding.* topic，内核侧以 manifest 'sandbox' 权限收口）转发。
 *
 * LLM 工具面（coding_exec / coding_run_code / coding_fs_write / coding_fs_read /
 * coding_fs_list / coding_sessions）由内核系统 MCP 目录直接提供（system-tools.ts，
 * 容器 'coding.engine'），不经本扩展转发——与 doc-extract 的壳模式一致。
 *
 * 约定：sessionId 缺省 "default"；路径参数一律会话目录内相对（绝对路径与 ".." 段
 * 由内核引擎拒绝）；安全边界与已知局限见 src/kernel/coding/engine.ts 模块头注释。
 */

/** HARNESS-xxxx → HTTP 状态码（仅本扩展会从内核桥收到的码；未知码回退 500） */
var CODE_STATUS = {
  'HARNESS-1007': 403, // FORBIDDEN（白名单外命令 / 绝对路径或 ".." 参数 / 权限缺失）
  'HARNESS-1008': 400, // BAD_REQUEST（入参形状非法）
  'HARNESS-1009': 400, // VALIDATION_FAILED（桥线格式校验失败）
  'HARNESS-2003': 403, // RPC_PERMISSION_DENIED（非扩展端点）
  'HARNESS-6003': 500, // SANDBOX_ERROR
  'HARNESS-6004': 404, // SANDBOX_NOT_FOUND（文件/目录/命令不存在）
  'HARNESS-6005': 409, // SANDBOX_BUSY（每会话并发 1 进程，占用中）
};

/**
 * 把内核桥抛出的错误规整为 HTTP 响应（HarnessApi.route 契约：{ status, body }）。
 * 错误码一律来自内核注册表 src/kernel/errors/codes.ts，禁止裸造。
 */
function failOf(e) {
  var code = e && typeof e.code === 'string' ? e.code : 'HARNESS-9003';
  var message = e && typeof e.message === 'string' ? e.message : 'coding bridge call failed';
  var status = Object.prototype.hasOwnProperty.call(CODE_STATUS, code) ? CODE_STATUS[code] : 500;
  return { status: status, body: { code: code, message: message } };
}

defineExtension(async (h) => {
  // 能力说明入口（doc-extract 壳模式同款；工具面由内核系统 MCP 目录提供）
  h.route('GET', '/status', async () => ({
    status: 200,
    body: {
      extension: 'coding',
      builtin: true,
      engine: 'kernel CodingEngine (src/kernel/coding, controlled subprocess sessions)',
      kernelProvided: {
        mcpTools: [
          'coding_exec',
          'coding_run_code',
          'coding_fs_write',
          'coding_fs_read',
          'coding_fs_list',
          'coding_sessions',
        ],
        bridgeTopics: [
          'coding.exec',
          'coding.runCode',
          'coding.fs.write',
          'coding.fs.read',
          'coding.fs.list',
          'coding.sessions',
          'coding.session.reset',
          'coding.session.delete',
        ],
      },
      sessions: {
        defaultSessionId: 'default',
        note: '会话目录 <dataDir>/coding-workspaces/<sessionId>/；命令白名单 + shell:false + 超时 kill + 输出 256KB 截断 + 每会话并发 1 进程',
      },
    },
  }));

  // GET /ext/coding/api/sessions — 会话列表
  h.route('GET', '/api/sessions', async () => {
    try {
      const sessions = await h.coding.sessions();
      return { status: 200, body: { sessions } };
    } catch (e) {
      return failOf(e);
    }
  }, { auth: 'user' });

  // POST /ext/coding/api/sessions/:id/reset — 重置（清空）会话目录
  h.route('POST', '/api/sessions/:id/reset', async (req) => {
    try {
      const session = await h.coding.resetSession({ sessionId: req.params.id });
      return { status: 200, body: { session } };
    } catch (e) {
      return failOf(e);
    }
  }, { auth: 'user' });

  // GET /ext/coding/api/sessions/:id/files?path= — 会话内文件列表（path 缺省会话根）
  h.route('GET', '/api/sessions/:id/files', async (req) => {
    try {
      const p = typeof req.query.path === 'string' ? req.query.path : undefined;
      const entries = await h.coding.fsList({ sessionId: req.params.id, path: p });
      return { status: 200, body: { sessionId: req.params.id, path: p || '.', entries } };
    } catch (e) {
      return failOf(e);
    }
  }, { auth: 'user' });
});
