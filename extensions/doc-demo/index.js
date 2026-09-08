'use strict';

/**
 * doc-demo — 文档解析演示扩展。
 *
 * - POST /parse（最终挂载 /ext/doc-demo/parse，body 传 { fileId }）：
 *   读取 text/plain 文件，统计 行数 / 词数 / 字符数，并发送一条成功通知；
 * - h.expose('parse', { run })：把同一解析逻辑以服务形式暴露（线格式 'parse.run'，
 *   参数 { fileId }），供本扩展的 file.uploaded 自动卡片链路经 h.call 复用；
 * - 订阅 file.uploaded：新上传的 text/plain 文件自动解析（h.call('doc-demo',
 *   'parse.run', { fileId })），结果以 doc-parse 卡片发到 'general' 频道
 *   （解析或频道发送失败一律静默，演示扩展侧的容错路径）。
 *
 * 沙箱不注入 Buffer / atob（见 src/extension-host/vm-runtime.ts 注入清单），
 * h.files.read 经内核返回 base64 字符串（kernel-handlers.ts filesRead），
 * 因此用下方纯 JS 解码实现；ASCII 场景解码后长度 == 字节数，统计语义一致。
 */

/**
 * 纯 JS base64 解码（标准字母表；忽略空白与填充以外的非法字符；
 * 按 6bit 累积 → 8bit 输出逐字节还原，非 ASCII 内容按 Latin-1 语义展开）。
 */
function base64Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(input).replace(/[^A-Za-z0-9+/]/g, '');
  let out = '';
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | alphabet.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * 文本统计：lines（结尾换行不另计一行，'' → 0）、words（空白分隔的非空段）、
 * chars（解码后长度；ASCII 输入等价字节数）。
 */
function countText(text) {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  return {
    lines: text === '' ? 0 : withoutTrailingNewline.split('\n').length,
    words: text.split(/\s+/).filter(Boolean).length,
    chars: text.length,
  };
}

/**
 * 解析核心（路由与 parse.run 服务共用）：读取文件 → 统计 → 成功通知。
 * @returns {Promise<{ fileId: string, lines: number, words: number, chars: number }>}
 */
async function parseDocument(h, fileId) {
  const text = base64Decode(await h.files.read(fileId));
  const stats = countText(text);
  await h.notify.send({ title: '文档解析完成', body: `${fileId}: ${stats.words} 词`, level: 'success' });
  return { fileId, ...stats };
}

defineExtension(async (h) => {
  // 解析路由：POST /ext/doc-demo/parse，body { fileId }（缺 fileId → 400 形状，不读文件）
  h.route('POST', '/parse', async (req) => {
    const fileId = req.body?.fileId;
    if (!fileId) {
      return { status: 400, body: { code: 'HARNESS-1009', message: 'fileId required' } };
    }
    return { status: 200, body: await parseDocument(h, fileId) };
  });

  // 暴露 parse 服务（h.call('doc-demo', 'parse.run', { fileId })；manifest.provides 已声明）
  h.expose('parse', {
    run: async (args) => {
      const fileId = args && typeof args === 'object' ? args.fileId : undefined;
      if (!fileId) {
        throw new TypeError('parse.run requires args { fileId: string }');
      }
      return parseDocument(h, fileId);
    },
  });

  // 新上传的 text/plain 文件 → 解析 → general 频道发卡片；失败静默
  h.on('file.uploaded', async (file) => {
    if (!file || file.mime !== 'text/plain') return;
    const result = await h.call('doc-demo', 'parse.run', { fileId: file.id }).catch(() => null);
    if (!result) return;
    await h.chat
      .send({
        slug: 'general',
        content: { type: 'card', card: { kind: 'doc-parse', fileId: file.id, ...result } },
      })
      .catch(() => {}); // general 频道不存在等情况：静默失败
  });
});
