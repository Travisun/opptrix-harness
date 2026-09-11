/**
 * 系统提示词 bootstrap 分层架构单测——bootstrap 资产结构 + 纯函数装配器 + runner 集成。
 *
 * 覆盖：bootstrap 7 节锚点齐全且节序固定、各节正文非空、占位符与激活说明到位；
 * parseBootstrapSections/renderBootstrapSections 切分还原幂等；buildToolCatalogSection
 * 的中文名映射、未知名回退、按域分组与组序、空清单占位、行数上限截断；
 * assembleBootstrapPrompt 的目录注入替换、toolCatalog 覆盖、#skills 节按能力保留/剔除
 * （缺省派生 + 显式覆盖）、extraSections 尾部追加、48KB 截断保护、同参幂等；
 * runAgentLoop 集成（mock gateway）：缺省 system 消息含 bootstrap 特征串与工具目录行、
 * 会话 systemPrompt 整体替换、skill_activate 白名单决定技能发现节。
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  BOOTSTRAP_PROMPT_MAX_CHARS,
  BOOTSTRAP_SECTION_IDS,
  SKILL_ACTIVATE_TOOL,
  TOOL_CATALOG_MAX_LINES,
  assembleBootstrapPrompt,
  buildToolCatalogSection,
  parseBootstrapSections,
  renderBootstrapSections,
} from '../src/kernel/agents/prompts/assemble.js';
import { BOOTSTRAP_PROMPT } from '../src/kernel/agents/prompts/bootstrap.js';
import { MAX_ACTIVATED_SKILLS_PER_SESSION } from '../src/kernel/agents/skill-session.js';
import { runAgentLoop, type AgentLoopInput, type AgentLoopToolRuntime } from '../src/kernel/agents/runner.js';
import type { LlmChatInput, LlmChatResult } from '../src/kernel/llm/index.js';

const logger = pino({ level: 'silent' });

// ---------- bootstrap 资产结构 ----------

describe('BOOTSTRAP_PROMPT — 结构完整性', () => {
  it('7 节锚点齐全且按既定节序排列', () => {
    expect(parseBootstrapSections(BOOTSTRAP_PROMPT).map((s) => s.id)).toEqual([...BOOTSTRAP_SECTION_IDS]);
  });

  it('每个锚点节正文非空', () => {
    const sections = parseBootstrapSections(BOOTSTRAP_PROMPT);
    expect(sections.length).toBe(BOOTSTRAP_SECTION_IDS.length);
    for (const section of sections) {
      expect(section.content.trim()).not.toBe('');
    }
  });

  it('tools-catalog 节含目录占位符；skills 节含激活工具名与激活上限', () => {
    const byId = new Map(parseBootstrapSections(BOOTSTRAP_PROMPT).map((s) => [s.id, s.content]));
    expect(byId.get('tools-catalog')).toContain('{{TOOL_CATALOG}}');
    expect(byId.get('skills')).toContain(SKILL_ACTIVATE_TOOL);
    expect(byId.get('skills')).toContain(String(MAX_ACTIVATED_SKILLS_PER_SESSION));
  });
});

// ---------- 切分与还原 ----------

describe('parseBootstrapSections / renderBootstrapSections — 切分还原', () => {
  it('切分 → 还原幂等：parse∘render∘parse 与 parse 深相等', () => {
    const parsed = parseBootstrapSections(BOOTSTRAP_PROMPT);
    const reparsed = parseBootstrapSections(renderBootstrapSections(parsed));
    expect(reparsed).toEqual(parsed);
  });

  it('无锚点文本 → 空数组；自定义锚点文本按序切分（正文 trim）', () => {
    expect(parseBootstrapSections('没有任何锚点的普通文本')).toEqual([]);
    const source = '<!-- section:alpha -->\nA 正文  \n\n<!-- section:beta -->\nB 正文\n';
    expect(parseBootstrapSections(source)).toEqual([
      { id: 'alpha', content: 'A 正文' },
      { id: 'beta', content: 'B 正文' },
    ]);
  });
});

// ---------- 工具目录段 ----------

describe('buildToolCatalogSection — 工具目录段', () => {
  it('已知工具映射为中文名一行式条目', () => {
    const section = buildToolCatalogSection(['workspace_read', 'report_create']);
    expect(section).toContain('- workspace_read：读取工作区文件');
    expect(section).toContain('- report_create：生成 HTML 报告');
  });

  it('未知工具名回退原名', () => {
    expect(buildToolCatalogSection(['totally_unknown_tool'])).toContain('- totally_unknown_tool：totally_unknown_tool');
  });

  it('按域分组且组序固定：cron/subagent 归任务，files_* 归其他', () => {
    const section = buildToolCatalogSection([
      'files_read',
      'cron_create',
      'workspace_read',
      'subagent_spawn',
      'skills_list',
      'skill_activate',
      'browser_navigate',
      'report_create',
      'coding_exec',
    ]);
    const order = ['### 工作区', '### 报告', '### 浏览器', '### 代码执行', '### 技能', '### 任务', '### 其他'].map(
      (title) => section.indexOf(title),
    );
    expect(order.every((idx) => idx >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(section).toContain('- cron_create：创建定时任务');
    expect(section).toContain('- subagent_spawn：派出子代理');
    expect(section).toContain('- skill_activate：激活技能');
    expect(section).toContain('- files_read：读取文件');
  });

  it('空清单 → 「未提供任何工具」占位', () => {
    expect(buildToolCatalogSection([])).toBe('（本次未提供任何工具）');
  });

  it(`行数上限 ${TOOL_CATALOG_MAX_LINES}：超出截断并附剩余数说明`, () => {
    const many = Array.from({ length: 100 }, (_, i) => `ext_tool_${i}`);
    const section = buildToolCatalogSection(many);
    expect(section.split('\n').length).toBe(TOOL_CATALOG_MAX_LINES);
    expect(section).toContain('另有 62 个工具未列入目录');
    expect(section).toContain('### 其他');
  });
});

// ---------- 装配器 ----------

describe('assembleBootstrapPrompt — 装配器', () => {
  it('目录注入：占位符被替换为按域分组的目录行', () => {
    const prompt = assembleBootstrapPrompt({ toolNames: ['workspace_read'] });
    expect(prompt).not.toContain('{{TOOL_CATALOG}}');
    expect(prompt).toContain('- workspace_read：读取工作区文件');
    expect(prompt).toContain('你是 Opptrix Harness 的智能助手');
  });

  it('toolCatalog 显式覆盖：目录段原样注入、不再走现生成', () => {
    const prompt = assembleBootstrapPrompt({ toolNames: ['workspace_read'], toolCatalog: 'CUSTOM-CATALOG-LINE' });
    expect(prompt).toContain('CUSTOM-CATALOG-LINE');
    expect(prompt).not.toContain('- workspace_read：读取工作区文件');
  });

  it('#skills 节缺省派生：白名单含 skill_activate 才保留', () => {
    expect(assembleBootstrapPrompt({ toolNames: ['workspace_read'] })).not.toContain('技能发现');
    expect(assembleBootstrapPrompt({ toolNames: ['workspace_read', SKILL_ACTIVATE_TOOL] })).toContain('技能发现');
  });

  it('#skills 节显式覆盖：hasSkillTools=false 剔除、true 强制保留', () => {
    const forcedOff = assembleBootstrapPrompt({ toolNames: [SKILL_ACTIVATE_TOOL], hasSkillTools: false });
    expect(forcedOff).not.toContain('技能发现');
    const forcedOn = assembleBootstrapPrompt({ toolNames: [], hasSkillTools: true });
    expect(forcedOn).toContain('技能发现');
  });

  it('extraSections 追加尾部（带锚点行）；空白正文跳过', () => {
    const prompt = assembleBootstrapPrompt({
      toolNames: [],
      extraSections: [
        { id: 'team-style', content: '团队风格：先结论后过程。' },
        { id: 'empty', content: '   ' },
      ],
    });
    expect(prompt).toContain('<!-- section:team-style -->');
    expect(prompt.trimEnd().endsWith('团队风格：先结论后过程。')).toBe(true);
    expect(prompt).not.toContain('<!-- section:empty -->');
  });

  it(`截断保护：超过 ${BOOTSTRAP_PROMPT_MAX_CHARS} 字符从尾部截断并附标记`, () => {
    const TRUNCATION_MARKER = '\n…（system prompt 超长已截断）';
    const prompt = assembleBootstrapPrompt({ toolNames: [], toolCatalog: 'x'.repeat(60 * 1024) });
    expect(prompt.endsWith('…（system prompt 超长已截断）')).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(BOOTSTRAP_PROMPT_MAX_CHARS + TRUNCATION_MARKER.length);
  });

  it('纯函数幂等：同参两次调用结果深相等，入参不被修改', () => {
    const toolNames = ['workspace_read', 'skills_list'];
    const extraSections = [{ id: 'ext', content: '扩展节' }];
    const a = assembleBootstrapPrompt({ toolNames, extraSections });
    const b = assembleBootstrapPrompt({ toolNames, extraSections });
    expect(a).toEqual(b);
    expect(toolNames).toEqual(['workspace_read', 'skills_list']);
    expect(extraSections).toEqual([{ id: 'ext', content: '扩展节' }]);
  });
});

// ---------- runner 集成（mock gateway） ----------

const SCHEMAS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  { name: 'workspace_read', description: '读取工作区文件', inputSchema: { type: 'object', properties: {} } },
  { name: 'report_create', description: '生成 HTML 报告', inputSchema: { type: 'object', properties: {} } },
  { name: SKILL_ACTIVATE_TOOL, description: '激活技能', inputSchema: { type: 'object', properties: {} } },
];

const BASE_INPUT: AgentLoopInput = {
  agentId: 'agent-1',
  depth: 0,
  prompt: '盘点并汇报',
};

/** 脚本化 gateway：单轮文本收束即可（只关心首条 system 消息的组装） */
function makeDeps() {
  const calls: LlmChatInput[] = [];
  const gateway = {
    chat: vi.fn(async (input: LlmChatInput): Promise<LlmChatResult> => {
      calls.push(structuredClone(input));
      return { text: 'ok' };
    }),
  };
  const tools: AgentLoopToolRuntime = {
    listSchemas: () => SCHEMAS.map((s) => ({ ...s })),
    execute: async () => ({}),
  };
  return { deps: { gateway, tools, logger }, calls };
}

describe('runAgentLoop × bootstrap 装配 — 集成', () => {
  it('缺省 system 消息含 bootstrap 特征串与工具目录行，且不含占位符', async () => {
    const { deps, calls } = makeDeps();
    await runAgentLoop(deps, BASE_INPUT);
    const sys = String(calls[0]?.messages[0]?.content);
    expect(sys).toContain('你是 Opptrix Harness 的智能助手');
    expect(sys).toContain('- workspace_read：读取工作区文件');
    expect(sys).toContain('- report_create：生成 HTML 报告');
    expect(sys).not.toContain('{{TOOL_CATALOG}}');
  });

  it('白名单含 skill_activate → system 消息含技能发现节；不含 → 剔除', async () => {
    const withSkill = makeDeps();
    await runAgentLoop(withSkill.deps, BASE_INPUT);
    expect(String(withSkill.calls[0]?.messages[0]?.content)).toContain('技能发现');

    const withoutSkill = makeDeps();
    await runAgentLoop(withoutSkill.deps, { ...BASE_INPUT, toolNames: ['workspace_read'] });
    const sys = String(withoutSkill.calls[0]?.messages[0]?.content);
    expect(sys).not.toContain('技能发现');
    expect(sys).toContain('- workspace_read：读取工作区文件');
  });

  it('会话 systemPrompt 仍整体替换：原样作为首条 system 消息', async () => {
    const { deps, calls } = makeDeps();
    await runAgentLoop(deps, { ...BASE_INPUT, systemPrompt: '你是专项巡检子代理。' });
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: '你是专项巡检子代理。' });
  });
});
