'use strict';

/**
 * html-report — 社区扩展：LLM 生成的 HTML 报告落库 + WebUI 预览。
 *
 * 与内核架构的适配（工具目录在内核侧静态登记，执行委托给本扩展）：
 * - 扩展机制 v1 的贡献点只有 route/webhook/on/hook/expose/cron/page/menu/task，
 *   **没有工具注册面**——系统 MCP 工具 report_create / report_list / report_get /
 *   report_delete 落在 src/kernel/mcp/system-tools.ts（html-report 域），经
 *   容器 extManager（扩展注册表）→ bridgeFor → host.call 桥接到本扩展
 *   h.expose('reports') 的 create / list / get / delete 四个方法。
 * - 存储面：扩展沙箱无 fs（受限 require + VM，KERNEL_TOPICS 无文件桥 topic），
 *   「扩展数据目录 extensions-data/html-report/」的等价实现是扩展专属 SQLite
 *   （<dataDir>/db/ext/html-report.sqlite，经 h.db 单语句 + 参数绑定）；逻辑路径
 *   extensions-data/html-report/{yyyy-mm}/{reportId}.html 作为元数据落库并随
 *   report_create 返回。路径穿越防护：reportId 一律先过 UUID 严格校验（含 ../ 等
 *   形状一律拒绝），等价于文件方案的 realpath 前缀检查；SQL 全程参数绑定。
 * - HTTP 面（auth:'user'，鉴权由内核 AuthProxy 在派发前完成，token 走
 *   Authorization 或 ?token= 查询通道）：
 *   · GET /ext/html-report/reports/:id → 直接回 HTML（CSP 防脚本，供 iframe 预览）；
 *   · GET /ext/html-report/api/reports → JSON 列表（与 report_list 同语义）。
 * 注册类 API 仅在 setup（激活期）可用；h.db schema 幂等，重复激活无副作用。
 */

defineExtension(async (h) => {
  /** HTML 正文字节上限（2MB；UTF-8 字节口径，TextEncoder 精确计量） */
  const MAX_HTML_BYTES = 2 * 1024 * 1024;
  /** 标题字符上限 */
  const MAX_TITLE_CHARS = 256;
  /** 列表分页缺省与上限 */
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  /** reportId 形状：UUID（防路径穿越的第一道闸） */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  /** 预览响应的防脚本 CSP：禁脚本/外联资源，仅放行内联样式与 data: 图片 */
  const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

  // 幂等建表（扩展专属 SQLite；激活期执行一次）
  await h.db.schema([
    'CREATE TABLE IF NOT EXISTS reports ('
      + 'report_id TEXT PRIMARY KEY, '
      + 'title TEXT NOT NULL, '
      + 'session_id TEXT, '
      + 'size INTEGER NOT NULL, '
      + 'created_at INTEGER NOT NULL, '
      + 'html TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports (created_at)',
  ]);

  const encoder = new TextEncoder();

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

  /** created_at（epoch ms）→ 'yyyy-mm'（UTC，逻辑路径的月份段） */
  function monthOf(createdAt) {
    const d = new Date(createdAt);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** 行 → 逻辑对象坐标（path/url 与 report_create 契约一致） */
  function metaOf(row) {
    return {
      reportId: row.report_id,
      title: row.title,
      sessionId: row.session_id === undefined ? null : row.session_id,
      size: row.size,
      createdAt: row.created_at,
      path: `extensions-data/html-report/${monthOf(row.created_at)}/${row.report_id}.html`,
      url: `/ext/html-report/reports/${row.report_id}`,
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
    const totalRow = await h.db.get(`SELECT COUNT(*) AS total FROM reports ${where}`, params);
    const rows = await h.db.all(
      `SELECT report_id, title, session_id, size, created_at FROM reports ${where} `
        + 'ORDER BY created_at DESC, report_id DESC LIMIT ? OFFSET ?',
      [...params, opts.limit, opts.offset],
    );
    const list = Array.isArray(rows) ? rows : [];
    const total = totalRow !== null && totalRow !== undefined && typeof totalRow.total === 'number'
      ? totalRow.total
      : list.length;
    return { reports: list.map(metaOf), total, limit: opts.limit, offset: opts.offset };
  }

  // ---------------------------------------------------------------------------
  // 服务面：系统 MCP 工具（report_*）经内核扩展桥调到这里（host.call）
  // ---------------------------------------------------------------------------

  h.expose('reports', {
    /** report_create：{ title, html, sessionId? } → { reportId, path, url, ... } */
    async create(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const rawTitle = typeof input['title'] === 'string' ? input['title'].trim() : '';
      if (rawTitle === '') fail('title is required (non-empty string)');
      if (rawTitle.length > MAX_TITLE_CHARS) {
        fail(`title exceeds ${MAX_TITLE_CHARS} characters`, { maxChars: MAX_TITLE_CHARS });
      }
      if (typeof input['html'] !== 'string' || input['html'] === '') {
        fail('html must be a non-empty string');
      }
      const bytes = encoder.encode(input['html']).length;
      if (bytes > MAX_HTML_BYTES) {
        fail(`html exceeds ${MAX_HTML_BYTES} bytes`, { bytes, maxBytes: MAX_HTML_BYTES });
      }
      if (input['sessionId'] !== undefined && input['sessionId'] !== null && typeof input['sessionId'] !== 'string') {
        fail('sessionId must be a string when provided');
      }
      const sessionId = typeof input['sessionId'] === 'string' && input['sessionId'] !== '' ? input['sessionId'] : null;

      const reportId = crypto.randomUUID();
      const createdAt = Date.now();
      await h.db.run(
        'INSERT INTO reports (report_id, title, session_id, size, created_at, html) VALUES (?, ?, ?, ?, ?, ?)',
        [reportId, rawTitle, sessionId, bytes, createdAt, input['html']],
      );
      return {
        reportId,
        title: rawTitle,
        size: bytes,
        createdAt,
        path: `extensions-data/html-report/${monthOf(createdAt)}/${reportId}.html`,
        url: `/ext/html-report/reports/${reportId}`,
      };
    },

    /** report_list：{ sessionId?, limit?, offset? } → { reports, total, limit, offset } */
    async list(raw) {
      return await queryList(listOptsOf(raw));
    },

    /** report_get：{ reportId } → { title, html, meta }；不存在 → 明确错误 */
    async get(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const reportId = assertUuid(input['reportId']);
      const row = await h.db.get('SELECT * FROM reports WHERE report_id = ?', [reportId]);
      if (row === null || row === undefined) {
        fail(`report "${reportId}" not found`, { reportId });
      }
      return { reportId, title: row.title, html: row.html, meta: metaOf(row) };
    },

    /** report_delete：{ reportId } → { reportId, deleted: true }；不存在 → 明确错误 */
    async delete(raw) {
      const input = raw === null || typeof raw !== 'object' ? {} : raw;
      const reportId = assertUuid(input['reportId']);
      const result = await h.db.run('DELETE FROM reports WHERE report_id = ?', [reportId]);
      const changes = result !== null && typeof result === 'object' && typeof result.changes === 'number'
        ? result.changes
        : 0;
      if (changes === 0) {
        fail(`report "${reportId}" not found`, { reportId });
      }
      return { reportId, deleted: true };
    },
  });

  // ---------------------------------------------------------------------------
  // HTTP 面：iframe 预览 + JSON 列表（auth:'user'，内核派发前已完成鉴权）
  // ---------------------------------------------------------------------------

  /** JSON 响应公共头 */
  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

  /** 404 响应体（复用内核错误码形状） */
  function notFound(message) {
    return { status: 404, headers: JSON_HEADERS, body: { code: 'HARNESS-3004', message } };
  }

  // GET /ext/html-report/reports/:id → 直接回 HTML（CSP 防脚本，供 iframe 预览）
  h.route('GET', '/reports/:id', async (req) => {
    const reportId = (req.params === null || req.params === undefined ? '' : req.params['id']) ?? '';
    if (!UUID_RE.test(reportId)) {
      return notFound(`report not found (reportId must be a UUID, got "${reportId.slice(0, 64)}")`);
    }
    const row = await h.db.get('SELECT * FROM reports WHERE report_id = ?', [reportId]);
    if (row === null || row === undefined) {
      return notFound(`report "${reportId}" not found`);
    }
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PREVIEW_CSP,
        'x-content-type-options': 'nosniff',
      },
      body: row.html,
    };
  }, { auth: 'user' });

  // GET /ext/html-report/api/reports → JSON 列表（与 report_list 同语义；query 传参）
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
