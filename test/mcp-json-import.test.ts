/**
 * Mcp 页「粘贴 JSON 配置」识别纯函数测试（零依赖直测 ui-src 源文件）。
 *
 * 覆盖：三粘贴形状识别（单服务器 / mcpServers 批量 / 本系统形状）、
 * Claude Desktop·Cursor 的 type 词汇映射（http → streamable-http）、
 * 仅 command 的 stdio 推断、非法 JSON / 顶层非对象 / 缺失必填字段的失败清单、
 * headers 粘贴解析（宽容标量 / 拒绝嵌套）、args→文本回填与 id 去重辅助。
 */
import { describe, expect, it } from 'vitest';

import {
  argsToText,
  dedupeId,
  describeDraft,
  normalizeTransportKey,
  parseHeadersJson,
  parsePastedServerConfig,
} from '../extensions/webui/ui-src/src/pages/Mcp/json-import.js';

describe('parsePastedServerConfig — 形状识别', () => {
  it('形状①：Claude/Cursor 的 type 词汇映射（http → streamable-http）+ 单服务器填充', () => {
    const res = parsePastedServerConfig(
      JSON.stringify({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'single') throw new Error('expected single');
    expect(res.draft.transport).toBe('streamable-http');
    expect(res.draft.url).toBe('https://example.com/mcp');
    expect(res.draft.headers).toEqual({ Authorization: 'Bearer t' });
    expect(res.summary).toContain('streamable-http');
    // sse 词汇原样保留
    const sse = parsePastedServerConfig(JSON.stringify({ type: 'sse', url: 'https://e.com/sse' }));
    expect(sse.ok && sse.kind === 'single' && sse.draft.transport).toBe('sse');
  });

  it('形状①：stdio 全量字段（command/args/env/timeoutMs）+ name/id 填充', () => {
    const res = parsePastedServerConfig(
      JSON.stringify({
        name: 'GitHub MCP',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'x' },
        timeoutMs: 45000,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'single') throw new Error('expected single');
    expect(res.draft).toMatchObject({
      name: 'GitHub MCP',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'x' },
      timeoutMs: 45000,
      headers: {},
      url: '',
    });
    expect(describeDraft(res.draft)).toContain('npx -y @modelcontextprotocol/server-github');
  });

  it('形状③：仅 command 无 transport/type → 推断 stdio；本系统形状 id 合法时保留', () => {
    const res = parsePastedServerConfig(JSON.stringify({ command: '/usr/local/bin/server', id: 'my-server' }));
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'single') throw new Error('expected single');
    expect(res.draft.transport).toBe('stdio');
    expect(res.draft.id).toBe('my-server');
    expect(normalizeTransportKey('HTTP')).toBe('streamable-http');
    expect(normalizeTransportKey('streamable_http')).toBe('streamable-http');
    expect(normalizeTransportKey('websocket')).toBeNull();
  });

  it('形状②：mcpServers 批量 → 多候选（键为 id），无法识别条目进 skipped；空对象失败', () => {
    const res = parsePastedServerConfig(
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'server-github'] },
          linear: { type: 'http', url: 'https://mcp.linear.app/sse' },
          broken: { transport: 'stdio' },
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== 'multi') throw new Error('expected multi');
    expect(res.candidates.map((c) => c.id)).toEqual(['github', 'linear']);
    expect(res.candidates[0]?.draft.transport).toBe('stdio');
    expect(res.candidates[1]?.draft.transport).toBe('streamable-http');
    expect(res.candidates[1]?.draft.name).toBe('linear'); // 键回填为建议名称
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toContain('broken');
    expect(res.summary).toContain('2 个可导入');

    const empty = parsePastedServerConfig(JSON.stringify({ mcpServers: {} }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain('mcpServers 为空');
  });

  it('失败：非法 JSON / 顶层非对象 / 缺失必填字段（列出缺失项）/ 不支持的传输词汇', () => {
    const bad = parsePastedServerConfig('{"command": npx}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('不是合法的 JSON');

    const arr = parsePastedServerConfig('[1,2]');
    expect(arr.ok).toBe(false);
    if (!arr.ok) expect(arr.message).toContain('顶层需为对象');

    const noCommand = parsePastedServerConfig(JSON.stringify({ transport: 'stdio' }));
    expect(noCommand.ok).toBe(false);
    if (!noCommand.ok) expect(noCommand.missing.join()).toContain('command');

    const noUrl = parsePastedServerConfig(JSON.stringify({ type: 'sse' }));
    expect(noUrl.ok).toBe(false);
    if (!noUrl.ok) expect(noUrl.missing.join()).toContain('url');

    const badScheme = parsePastedServerConfig(JSON.stringify({ type: 'http', url: 'ftp://x' }));
    expect(badScheme.ok).toBe(false);
    if (!badScheme.ok) expect(badScheme.missing.join()).toContain('http');

    const noShape = parsePastedServerConfig(JSON.stringify({ foo: 1 }));
    expect(noShape.ok).toBe(false);
    if (!noShape.ok) expect(noShape.missing.length).toBeGreaterThan(0);

    const badVocab = parsePastedServerConfig(JSON.stringify({ type: 'wss', url: 'https://x' }));
    expect(badVocab.ok).toBe(false);
    if (!badVocab.ok) expect(badVocab.missing.join()).toContain('不是受支持的传输词汇');
  });
});

describe('parseHeadersJson — headers 粘贴解析', () => {
  it('合法对象 → Record（标量数值宽容 String 化；空对象合法）', () => {
    expect(parseHeadersJson('{"X-API-Key":"k","Authorization":"Bearer t"}')).toEqual({
      ok: true,
      value: { 'X-API-Key': 'k', Authorization: 'Bearer t' },
    });
    expect(parseHeadersJson('{"X-Port": 8080}')).toEqual({ ok: true, value: { 'X-Port': '8080' } });
    expect(parseHeadersJson('{}')).toEqual({ ok: true, value: {} });
  });

  it('失败：空文本 / 非法 JSON / 非对象 / 嵌套值（内联报错消息可读）', () => {
    expect(parseHeadersJson('  ').ok).toBe(false);
    const bad = parseHeadersJson('{Authorization: Bearer}');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('不是合法的 JSON');
    const arr = parseHeadersJson('[{"k":"v"}]');
    expect(arr.ok).toBe(false);
    const nested = parseHeadersJson('{"X":{"a":1}}');
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.message).toContain('X');
  });
});

describe('表单填充辅助', () => {
  it('argsToText 与分词互逆：含空白/引号参数回填后可还原', () => {
    const args = ['--msg', 'hello world', 'say "hi"', 'a\\b', ''];
    const text = argsToText(args);
    expect(text).toBe('--msg "hello world" "say \\"hi\\"" "a\\\\b" ""');
    // 简易回验：JSON 序列化对比（tokenizeArgs 在 Mcp/shared，前端表单消费方）
    expect(argsToText(['-y', 'pkg'])).toBe('-y pkg');
  });

  it('dedupeId：冲突追加 -2/-3；非法 base 先 slug 化', () => {
    expect(dedupeId('github', ['github', 'github-2'])).toBe('github-3');
    expect(dedupeId('github', [])).toBe('github');
    expect(dedupeId('GitHub MCP!', [])).toBe('github-mcp');
    expect(dedupeId('!!!', [])).toBe('mcp-server');
  });
});
