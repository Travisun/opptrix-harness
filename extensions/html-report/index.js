'use strict';

/**
 * html-report — 社区扩展：LLM 生成的 HTML 报告索引 + WebUI 预览入口。
 *
 * MCP-First 存储分工（与内核 src/kernel/mcp/system-tools.ts 的 report_* 域配套）：
 * - **正文一律存对话工作区**：内核工具（report_create）经 WorkspaceService 把 HTML
 *   落到目标会话工作区 `reports/{uuid}.html`，经 REST 预览端点
 *   GET /api/v1/agents/sessions/{rootId}/workspace/file?path=… 取用。扩展沙箱无 fs，
 *   不再（也不能）存正文。
 * - **扩展自有 SQLite 只存索引元数据**：<dataDir>/db/ext/html-report.sqlite 的
 *   report_index 表（report_id/title/session_id/path/size/created_at）。旧 reports
 *   表（正文内联）自本版本起弃用——表保留不动（无破坏性迁移），新读写全部走 report_index。
 * - 服务面（内核经扩展桥 host.call 到这里）：h.expose('reports') 的
 *   index / list / get / delete 四个方法（create 已废弃：正文不经扩展）。
 * - HTTP 面（auth:'user'，鉴权由内核 AuthProxy 在派发前完成）：
 *   · GET /ext/html-report/reports/:id → 302 重定向到工作区 REST 预览端点（正文在
 *     工作区，扩展只负责把坐标翻译成 url；老链接不断）；
 *   · GET /ext/html-report/api/reports → JSON 索引列表（与 report_list 同语义）。
 * 防穿越：reportId 一律先过 UUID 严格校验（含 ../ 等形状一律拒绝）；SQL 全程参数绑定。
 * 注册类 API 仅在 setup（激活期）可用；h.db schema 幂等，重复激活无副作用。
 */

defineExtension(async (h) => {
  /** 标题字符上限 */
  const MAX_TITLE_CHARS = 256;
  /** 列表分页缺省与上限 */
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  /** reportId 形状：UUID（防路径穿越的第一道闸） */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** 索引 path 形状：工作区内相对路径 reports/<uuid>.html（内核工具写入的固定坐标） */
  const PATH_RE = /^reports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html$/i;

  // 幂等建表（扩展专属 SQLite 索引表；激活期执行一次。旧 reports 表弃用不删）
  await h.db.schema([
    'CREATE TABLE IF NOT EXISTS report_index ('
      + 'report_id TEXT PRIMARY KEY, '
      + 'title TEXT NOT NULL, '
      + 'session_id TEXT NOT NULL, '
      + 'path TEXT NOT NULL, '
      + 'size INTEGER NOT NULL, '
      + 'created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_report_index_created_at ON report_index (created_at)',
  ]);

  /** 统一失败形状：抛 Error（worker 序列化为 RPC 错误信封，message 原样透传） */
  function fail(message, detail) {
    const e = new Error(message);
    if (detail !== undefined) e.detail = detail;
    throw e;
  }

  /** reportId 的 UUID 严格校验（../ 等穿越形状在此被拒） */
  function assertUuid(reportId) {
    if (typeof reportId !== 'string' || !UUID_RE.test(reportId)) {
      fail(`reportId must be a UUID (got "${String(reportId).slice(0, 64)}")`, { reportId: String(reportId).slice(0, 64) });
    }
    return reportId;
  }

  /** 行 → 索引对象（path 为工作区相对路径；url 由内核工具/预览路由按坐标拼装） */
  function metaOf(row) {
    return {
      reportId: row.report_id,
      title: row.title,
      sessionId: row.session_id,
      size: row.size,
      createdAt: row.created_at,
      path: row.path,
    };
  }

  /** list 入参规整：{ sessionId?, limit?, offset? }（limit 1..200，offset ≥ 0） */
  function listOptsOf(raw) {
    const input = raw === null || typeof raw !== 'object' ? {} : raw;
    const opts = {};
    if (typeof input['sessionId'] === 'string' && input['sessionId'] !== '') {
      opts.sessionId = input['sessionId'];
    } else if (typeof input['session_id'] === 'string' && input['session_id'] !== '') {
      opts.sessionId = input['session_id'];
    }
    const limit = Number(input['limit']);
    opts.limit = Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : DEFAULT_LIMIT;
    const offset = Number(input['offset']);
    opts.offset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    return opts;
  }

  /** 列表查询（按 createdAt 降序、report_id 降序稳定破并列；含总数） */
  async function queryList(opts) {
    const where = opts.sessionId === undefined ? '' : 'WHERE session_id = ?';
    const params = opts.sessionId === undefined ? [] : [opts.sessionId];
    const totalRow = await h.db.get(`SELECT COUNT(*) AS total FROM report_index ${where}`, params);
    const rows = await h.db.all(
      `SELECT report_id, title, session_id, path, size, created_at FROM report_index ${where} `
        + 'ORDER BY created_at DESC, report_id DESC LIMIT ? OFFSET ?',
      [...params, opts.limit, opts.offset],
    );
    const list = Array.isArray(rows) ? rows : [];
    const total = totalRow !== null && totalRow !== undefined && typeof totalRow.total === 'number'
      ? totalRow.total
      : list.length;
    return { reports: list.map(metaOf), total, limit: opts.limit, offset: opts.offset };
  }

  /** 索引入参核验（内核工具 report_create 的登记面；形状不符一律拒绝） */
  function assertIndexInput(input) {
    const reportId = assertUuid(input['reportId']);
    const rawTitle = typeof input['title'] === 'string' ? input['title'].trim() : '';
    if (rawTitle === '') fail('title is required (non-empty string)');
    if (rawTitle.length > MAX_TITLE_CHARS) {
      fail(`title exceeds ${MAX_TITLE_CHARS} characters`, { maxChars: MAX_TITLE_CHARS });
    }
    if (typeof input['sessionId'] !== 'string' || input['sessionId'] === '') {
      fail('sessionId is required (report body lives in the conversation workspace)');
    }
    if (typeof input['path'] !== 'string' || !PATH_RE.test(input['path'])) {
      fail('path must be the workspace-relative "reports/<uuid>.html" coordinate', { path: String(input['path'] ?? '').slice(0, 64) });
    }
    const size = Number(input['size']);
    if (!Number.isInteger(size) || size < 0) fail('size must be a non-negative integer');
    const createdAt = Number(input['createdAt']);
    if (!Number.isInteger(createdAt) || createdAt < 0) fail('createdAt must be an epoch-milliseconds integer');
    return { reportId, title: rawTitle, sessionId: input['sessionId'], path: input['path'], size, createdAt };
  }

  // ---------------------------------------------------------------------------
  // 服务面：系统 MCP 工具（report_*）经内核扩展桥调到这里（host.call）
  // ---------------------------------------------------------------------------

  h.expose('reports', {
    /** index：{ reportId, title, path, sessionId, size, createdAt } → 索引对象（重复登记拒绝） */
    async index(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const row = assertIndexInput(input);
      await h.db.run(
        'INSERT INTO report_index (report_id, title, session_id, path, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [row.reportId, row.title, row.sessionId, row.path, row.size, row.createdAt],
      );
      return { reportId: row.reportId, title: row.title, sessionId: row.sessionId, path: row.path, size: row.size, createdAt: row.createdAt };
    },

    /** list：{ sessionId?, limit?, offset? } → { reports, total, limit, offset }（索引，不含正文） */
    async list(raw) {
      return await queryList(listOptsOf(raw));
    },

    /** get：{ reportId } → 索引对象；不存在 → 明确错误 */
    async get(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const reportId = assertUuid(input['reportId']);
      const row = await h.db.get('SELECT * FROM report_index WHERE report_id = ?', [reportId]);
      if (row === null || row === undefined) {
        fail(`report "${reportId}" not found`, { reportId });
      }
      return metaOf(row);
    },

    /** delete：{ reportId } → { ...索引对象, deleted: true }（坐标供内核删工作区正文）；不存在 → 明确错误 */
    async delete(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const reportId = assertUuid(input['reportId']);
      const row = await h.db.get('SELECT * FROM report_index WHERE report_id = ?', [reportId]);
      if (row === null || row === undefined) {
        fail(`report "${reportId}" not found`, { reportId });
      }
      await h.db.run('DELETE FROM report_index WHERE report_id = ?', [reportId]);
      return { ...metaOf(row), deleted: true };
    },
  });

  // ---------------------------------------------------------------------------
  // HTTP 面：预览重定向 + JSON 索引列表（auth:'user'，内核派发前已完成鉴权）
  // ---------------------------------------------------------------------------

  /** JSON 响应公共头 */
  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

  /** 404 响应体（复用内核错误码形状） */
  function notFound(message) {
    return { status: 404, headers: JSON_HEADERS, body: { code: 'HARNESS-3004', message } };
  }

  // GET /ext/html-report/reports/:id → 302 到工作区 REST 预览端点（正文在工作区，
  // 扩展把索引坐标翻译成 url；透传原 query（含 ?token= 认证通道），老链接不断）
  h.route('GET', '/reports/:id', async (req) => {
    const reportId = (req.params === null || req.params === undefined ? '' : req.params['id']) ?? '';
    if (!UUID_RE.test(reportId)) {
      return notFound(`report not found (reportId must be a UUID, got "${reportId.slice(0, 64)}")`);
    }
    const row = await h.db.get('SELECT * FROM report_index WHERE report_id = ?', [reportId]);
    if (row === null || row === undefined) {
      return notFound(`report "${reportId}" not found`);
    }
    // 手工拼 query（沙箱无 URLSearchParams；encodeURIComponent 为标准全局）
    const query = req.query === null || req.query === undefined ? {} : req.query;
    const parts = [`path=${encodeURIComponent(row.path)}`];
    for (const key of Object.keys(query)) {
      if (key === 'path') continue;
      const value = query[key];
      if (typeof value === 'string') parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    return {
      status: 302,
      headers: { location: `/api/v1/agents/sessions/${row.session_id}/workspace/file?${parts.join('&')}` },
      body: '',
    };
  }, { auth: 'user' });

  // GET /ext/html-report/api/reports → JSON 索引列表（与 report_list 同语义；query 传参）
  h.route('GET', '/api/reports', async (req) => {
    const query = req.query === null || req.query === undefined ? {} : req.query;
    const opts = listOptsOf({
      sessionId: query['session_id'],
      limit: query['limit'] !== undefined ? Number(query['limit']) : undefined,
      offset: query['offset'] !== undefined ? Number(query['offset']) : undefined,
    });
    const body = await queryList(opts);
    return { status: 200, headers: JSON_HEADERS, body };
  }, { auth: 'user' });
});
