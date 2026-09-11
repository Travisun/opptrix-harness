/**
 * Agent 循环（runAgentLoop）单测——gateway 以「结果脚本」按调用次序出栈全 stub，
 * tools 为内存执行器（可注入异常/触发中断），不依赖真实网络。
 *
 * 覆盖：纯文本一轮完成、工具调用→执行→二轮文本（assistant/tool 消息规约回填）、
 * 多工具连续执行、工具执行异常 isError 回填不终止、工具参数 JSON 非法不执行、
 * 迭代上限强制收尾（无 tools 收尾对话）、缺省迭代上限 16、token 预算触发收束、
 * 预算未超限不收尾、signal 预先中断与轮间中断（AbortError）、工具白名单过滤与
 * 空白名单不携 tools、systemPrompt 注入与缺省 bootstrap 系统提示、旧版
 * defaultAgentSystemPrompt 兼容保留、usage 逐轮累计、
 * model 透传/缺省（网关现状语义）、空文本轮询、sleep 让出钩子、
 * deps.maxIterations 被 input.maxIterations 覆盖、缺省常量值。
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';

import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  DEFAULT_AGENT_MAX_TOKENS,
  defaultAgentSystemPrompt,
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopInput,
  type AgentLoopToolRuntime,
} from '../src/kernel/agents/runner.js';
import { assembleBootstrapPrompt } from '../src/kernel/agents/prompts/assemble.js';
import type { LlmChatInput, LlmChatResult } from '../src/kernel/llm/index.js';

const logger = pino({ level: 'silent' });

// ---------- 夹具 ----------

const SCHEMAS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  { name: 'skills_list', description: '列出技能', inputSchema: { type: 'object', properties: {} } },
  { name: 'cron_list', description: '列出定时任务', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'files_read',
    description: '读文件',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

const BASE_INPUT: AgentLoopInput = {
  agentId: 'agent-1',
  depth: 0,
  prompt: '盘点技能库并汇报',
  model: 'model-under-test',
};

/** 工具调用结果项构造 */
function toolCall(id: string, name: string, argsJson: string): { id: string; name: string; argsJson: string } {
  return { id, name, argsJson };
}

/**
 * 脚本化 gateway：chat 按次序出栈脚本结果；messages 以 structuredClone 快照记录，
 * 防止循环后续原地变更影响断言；脚本耗尽即抛错（意外多调）。
 */
function scriptedGateway(script: LlmChatResult[]) {
  const calls: LlmChatInput[] = [];
  const gateway = {
    chat: vi.fn(async (input: LlmChatInput): Promise<LlmChatResult> => {
      calls.push(structuredClone(input));
      const next = script.shift();
      if (next === undefined) throw new Error(`script exhausted (unexpected chat call #${calls.length})`);
      return next;
    }),
  };
  return { gateway, calls };
}

/** 内存工具运行时：按名注入结果工厂（缺省回显）；记录全部 execute 入参 */
function stubTools(overrides: Record<string, () => unknown> = {}): AgentLoopToolRuntime & {
  executions: Array<{ name: string; args: unknown; ctx: { agentId: string; depth: number } }>;
} {
  const executions: Array<{ name: string; args: unknown; ctx: { agentId: string; depth: number } }> = [];
  return {
    listSchemas: () => SCHEMAS.map((s) => ({ ...s, inputSchema: { ...s.inputSchema } })),
    execute: async (name, args, ctx) => {
      executions.push({ name, args, ctx });
      const factory = overrides[name];
      if (factory !== undefined) return factory();
      return { tool: name, args };
    },
    executions,
  };
}

/** 组装 deps（脚本 + 工具 + 可选依赖覆盖）并暴露 chat 调用快照 */
function makeDeps(script: LlmChatResult[], tools: AgentLoopToolRuntime, extra: Partial<AgentLoopDeps> = {}) {
  const { gateway, calls } = scriptedGateway(script);
  const deps: AgentLoopDeps = { gateway, tools, logger, ...extra };
  return { deps, calls };
}

// ---------- 基本循环 ----------

describe('runAgentLoop — 基本循环', () => {
  it('纯文本一轮完成：finalText/iterations/toolCalls/usage 与首轮消息组装', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps([{ text: '技能库共 37 项' }], tools);
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out).toEqual({
      finalText: '技能库共 37 项',
      iterations: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [
        { role: 'system', content: assembleBootstrapPrompt({ toolNames: ['skills_list', 'cron_list', 'files_read'] }) },
        { role: 'user', content: '盘点技能库并汇报' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      { role: 'system', content: assembleBootstrapPrompt({ toolNames: ['skills_list', 'cron_list', 'files_read'] }) },
      { role: 'user', content: '盘点技能库并汇报' },
    ]);
    expect(calls[0]?.tools).toEqual(SCHEMAS);
    expect(tools.executions).toEqual([]);
  });

  it('工具调用 → 执行 → 二轮文本：assistant/tool 消息按规约回填，ctx 透传 agentId/depth', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps(
      [{ text: '', toolCalls: [toolCall('call_1', 'skills_list', '{}')] }, { text: '共 37 项技能' }],
      tools,
    );
    const out = await runAgentLoop(deps, { ...BASE_INPUT, agentId: 'sub-9', depth: 2 });

    expect(out.finalText).toBe('共 37 项技能');
    expect(out.iterations).toBe(2);
    expect(out.toolCalls).toBe(1);
    expect(tools.executions).toEqual([{ name: 'skills_list', args: {}, ctx: { agentId: 'sub-9', depth: 2 } }]);
    expect(calls[1]?.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      { role: 'user', content: '盘点技能库并汇报' },
      { role: 'assistant', content: { toolCalls: [{ id: 'call_1', name: 'skills_list', arguments: '{}' }] } },
      {
        role: 'tool',
        content: { toolCallId: 'call_1', text: JSON.stringify({ tool: 'skills_list', args: {} }) },
      },
    ]);
  });

  it('多工具连续：一轮两个调用全部执行并按序回填（assistant 文本保留）', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps(
      [
        {
          text: '先查任务再读文件',
          toolCalls: [toolCall('c1', 'cron_list', '{"limit":5}'), toolCall('c2', 'files_read', '{"id":"f1"}')],
        },
        { text: 'done' },
      ],
      tools,
    );
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out.toolCalls).toBe(2);
    expect(tools.executions.map((e) => e.name)).toEqual(['cron_list', 'files_read']);
    expect(calls[1]?.messages[2]).toEqual({
      role: 'assistant',
      content: {
        text: '先查任务再读文件',
        toolCalls: [
          { id: 'c1', name: 'cron_list', arguments: '{"limit":5}' },
          { id: 'c2', name: 'files_read', arguments: '{"id":"f1"}' },
        ],
      },
    });
    expect(calls[1]?.messages[3]).toEqual({
      role: 'tool',
      content: { toolCallId: 'c1', text: JSON.stringify({ tool: 'cron_list', args: { limit: 5 } }) },
    });
    expect(calls[1]?.messages[4]).toEqual({
      role: 'tool',
      content: { toolCallId: 'c2', text: JSON.stringify({ tool: 'files_read', args: { id: 'f1' } }) },
    });
  });

  it('工具执行异常 → isError 结果回填并继续循环（工具失败是信息不是终止）', async () => {
    const tools = stubTools({
      files_read: () => {
        throw new Error('file not found: f1');
      },
    });
    const { deps, calls } = makeDeps(
      [{ text: '', toolCalls: [toolCall('c1', 'files_read', '{"id":"f1"}')] }, { text: '读取失败，据实说明' }],
      tools,
    );
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out.finalText).toBe('读取失败，据实说明');
    expect(out.toolCalls).toBe(1);
    expect(calls[1]?.messages[3]).toEqual({
      role: 'tool',
      content: { toolCallId: 'c1', text: JSON.stringify({ isError: true, error: 'file not found: f1' }) },
    });
  });

  it('工具结果不可 JSON 序列化（循环引用）→ isError 兜底回填、循环继续', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const tools = stubTools({ files_read: () => circular });
    const { deps, calls } = makeDeps(
      [{ text: '', toolCalls: [toolCall('c1', 'files_read', '{"id":"f1"}')] }, { text: '结果无法序列化' }],
      tools,
    );
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out.toolCalls).toBe(1);
    expect(calls[1]?.messages[3]).toEqual({
      role: 'tool',
      content: { toolCallId: 'c1', text: JSON.stringify({ isError: true, error: 'tool result is not JSON-serializable' }) },
    });
    expect(out.finalText).toBe('结果无法序列化');
  });

  it('工具参数 JSON 非法 → 不执行、isError 回填、循环继续', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps(
      [{ text: '', toolCalls: [toolCall('c1', 'files_read', '{not-json')] }, { text: '参数坏了' }],
      tools,
    );
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(tools.executions).toEqual([]);
    expect(out.toolCalls).toBe(0);
    const toolMsg = calls[1]?.messages[3] as { content: { text: string } };
    expect(JSON.parse(toolMsg.content.text)).toMatchObject({ isError: true });
    expect(out.finalText).toBe('参数坏了');
  });
});

// ---------- 终止兜底（迭代上限 / token 预算） ----------

describe('runAgentLoop — 终止兜底', () => {
  it('迭代上限强制收尾：每轮都在要工具 → 追加系统收尾消息、不带 tools 再对话一次', async () => {
    const tools = stubTools();
    const toolRound = (): LlmChatResult => ({ text: '', toolCalls: [toolCall('cx', 'skills_list', '{}')] });
    const { deps, calls } = makeDeps([toolRound(), toolRound(), { text: '收尾报告' }], tools, { maxIterations: 2 });
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out.finalText).toBe('收尾报告');
    expect(out.iterations).toBe(3);
    expect(out.toolCalls).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.tools).toBeUndefined();
    const last = calls[2]?.messages[calls[2].messages.length - 1];
    expect(last?.role).toBe('user');
    expect(String(last?.content)).toContain('最终报告');
    expect(calls[2]?.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('缺省迭代上限 16：常要工具时 16 轮循环 + 1 次收尾 = 17 次 chat', async () => {
    const tools = stubTools();
    const script: LlmChatResult[] = Array.from({ length: DEFAULT_AGENT_MAX_ITERATIONS }, (_, i) => ({
      text: '',
      toolCalls: [toolCall(`c${i}`, 'skills_list', '{}')],
    }));
    script.push({ text: '兜底报告' });
    const { deps, calls } = makeDeps(script, tools);
    const out = await runAgentLoop(deps, BASE_INPUT);

    expect(out.iterations).toBe(DEFAULT_AGENT_MAX_ITERATIONS + 1);
    expect(out.toolCalls).toBe(DEFAULT_AGENT_MAX_ITERATIONS);
    expect(out.finalText).toBe('兜底报告');
    expect(calls).toHaveLength(DEFAULT_AGENT_MAX_ITERATIONS + 1);
    expect(calls[DEFAULT_AGENT_MAX_ITERATIONS]?.tools).toBeUndefined();
  });

  it('token 预算触发收束：usage 累计超 maxTokens → 立即无工具收尾（不再执行工具）', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps(
      [
        { text: '', toolCalls: [toolCall('c1', 'skills_list', '{}')], usage: { inputTokens: 700, outputTokens: 500 } },
        { text: '预算收尾报告', usage: { inputTokens: 40, outputTokens: 20 } },
      ],
      tools,
    );
    const out = await runAgentLoop(deps, { ...BASE_INPUT, maxTokens: 1000 });

    // 第一轮后 700+500=1200 > 1000 → 工具不执行，直接收尾
    expect(tools.executions).toEqual([]);
    expect(out.iterations).toBe(2);
    expect(out.toolCalls).toBe(0);
    expect(out.finalText).toBe('预算收尾报告');
    expect(calls[1]?.tools).toBeUndefined();
    expect(out.usage).toEqual({ inputTokens: 740, outputTokens: 520 });
    const last = calls[1]?.messages[calls[1].messages.length - 1];
    expect(String(last?.content)).toContain('token 用量预算');
  });

  it('预算未超限 → 不触发收尾，正常执行工具至文本收束', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps(
      [
        { text: '', toolCalls: [toolCall('c1', 'skills_list', '{}')], usage: { inputTokens: 700, outputTokens: 250 } },
        { text: '正常完成', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      tools,
    );
    const out = await runAgentLoop(deps, { ...BASE_INPUT, maxTokens: 1000 });

    expect(tools.executions).toHaveLength(1);
    expect(out.finalText).toBe('正常完成');
    expect(out.iterations).toBe(2);
    expect(out.toolCalls).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('缺省常量：DEFAULT_AGENT_MAX_ITERATIONS=16、DEFAULT_AGENT_MAX_TOKENS=200_000', () => {
    expect(DEFAULT_AGENT_MAX_ITERATIONS).toBe(16);
    expect(DEFAULT_AGENT_MAX_TOKENS).toBe(200_000);
  });
});

// ---------- 中断 ----------

describe('runAgentLoop — 中断（AbortError）', () => {
  it('signal 预先中断 → 抛 AbortError 且未发起任何 chat', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, calls } = makeDeps([{ text: 'x' }], stubTools());
    await expect(runAgentLoop(deps, { ...BASE_INPUT, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(0);
  });

  it('轮间中断：第一个工具执行期间 abort → 下一个工具执行前抛 AbortError', async () => {
    const controller = new AbortController();
    const tools = stubTools({
      cron_list: () => {
        controller.abort();
        return { jobs: [] };
      },
    });
    const { deps, calls } = makeDeps(
      [
        {
          text: '',
          toolCalls: [toolCall('c1', 'cron_list', '{}'), toolCall('c2', 'skills_list', '{}')],
        },
        { text: 'never reached' },
      ],
      tools,
    );
    await expect(runAgentLoop(deps, { ...BASE_INPUT, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(tools.executions).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

// ---------- 工具白名单与提示组装 ----------

describe('runAgentLoop — 工具白名单与提示组装', () => {
  it('toolNames 白名单：schemas 按目录顺序过滤后原样下发', async () => {
    const { deps, calls } = makeDeps([{ text: 'ok' }], stubTools());
    await runAgentLoop(deps, { ...BASE_INPUT, toolNames: ['files_read', 'skills_list'] });
    expect(calls[0]?.tools).toEqual([SCHEMAS[0], SCHEMAS[2]]);
  });

  it('toolNames 空数组 → 不携带 tools 参数，缺省系统提示标注无工具', async () => {
    const tools = stubTools();
    const { deps, calls } = makeDeps([{ text: 'ok' }], tools);
    await runAgentLoop(deps, { ...BASE_INPUT, toolNames: [] });
    expect(calls[0]?.tools).toBeUndefined();
    expect(String(calls[0]?.messages[0]?.content)).toContain('未提供任何工具');
    expect(tools.executions).toEqual([]);
  });

  it('systemPrompt 注入：自定义提示原样作为首条 system 消息', async () => {
    const { deps, calls } = makeDeps([{ text: 'ok' }], stubTools());
    await runAgentLoop(deps, { ...BASE_INPUT, systemPrompt: '你是专项巡检子代理。' });
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: '你是专项巡检子代理。' });
  });

  it('缺省 bootstrap 系统提示：含角色定位首句、工具目录行与最终报告约定', async () => {
    const { deps, calls } = makeDeps([{ text: 'ok' }], stubTools());
    await runAgentLoop(deps, BASE_INPUT);
    const sys = String(calls[0]?.messages[0]?.content);
    expect(sys).toContain('你是 Opptrix Harness 的智能助手');
    expect(sys).toContain('- skills_list：列出技能');
    expect(sys).toContain('最终报告');
    expect(sys).not.toContain('{{TOOL_CATALOG}}');
  });

  it('旧版 defaultAgentSystemPrompt 保留导出（已不是缺省路径）：旧格式文本不变', () => {
    expect(defaultAgentSystemPrompt(['a', 'b'])).toContain('Opptrix Harness 子代理');
    expect(defaultAgentSystemPrompt(['a', 'b'])).toContain('a、b');
    expect(defaultAgentSystemPrompt([])).toContain('未提供任何工具');
  });
});

// ---------- 用量累计与透传 ----------

describe('runAgentLoop — 用量累计与透传', () => {
  it('usage 逐轮累计（input/output 独立求和）', async () => {
    const { deps } = makeDeps(
      [
        { text: '', toolCalls: [toolCall('c1', 'skills_list', '{}')], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: '', toolCalls: [toolCall('c2', 'cron_list', '{}')], usage: { inputTokens: 20, outputTokens: 6 } },
        { text: 'done', usage: { inputTokens: 40, outputTokens: 8 } },
      ],
      stubTools(),
    );
    const out = await runAgentLoop(deps, BASE_INPUT);
    expect(out.usage).toEqual({ inputTokens: 70, outputTokens: 19 });
    expect(out.iterations).toBe(3);
    expect(out.toolCalls).toBe(2);
    expect(out.finalText).toBe('done');
  });

  it('model 透传；未指定时保持网关现状语义（model 缺省不指定）', async () => {
    const { deps, calls } = makeDeps([{ text: 'a' }, { text: 'b' }], stubTools());
    await runAgentLoop(deps, { ...BASE_INPUT, model: 'gpt-x' });
    expect(calls[0]?.model).toBe('gpt-x');
    await runAgentLoop(deps, { agentId: 'a', depth: 0, prompt: 'p' });
    expect(calls[1]?.model).toBeUndefined();
  });

  it('空文本且无工具调用 → 继续轮询直至拿到文本（迭代上限兜底）', async () => {
    const { deps, calls } = makeDeps([{ text: '' }, { text: '' }, { text: '第三轮出结果' }], stubTools());
    const out = await runAgentLoop(deps, BASE_INPUT);
    expect(out.finalText).toBe('第三轮出结果');
    expect(out.iterations).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('sleep 让出钩子：每个工具轮结束后调用一次（参数 0）', async () => {
    const sleep = vi.fn(async () => {});
    const { deps } = makeDeps(
      [
        { text: '', toolCalls: [toolCall('c1', 'skills_list', '{}')] },
        { text: '', toolCalls: [toolCall('c2', 'skills_list', '{}')] },
        { text: 'done' },
      ],
      stubTools(),
      { sleep },
    );
    await runAgentLoop(deps, BASE_INPUT);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
  });

  it('deps.maxIterations 被 input.maxIterations 覆盖', async () => {
    // deps 声明 5 轮；input 收敛为 1 轮 → 1 次循环 + 1 次收尾；若覆盖失效，
    // 第 3 次 chat 会因脚本耗尽抛错
    const { deps, calls } = makeDeps(
      [{ text: '', toolCalls: [toolCall('cx', 'skills_list', '{}')] }, { text: '报告' }],
      stubTools(),
      { maxIterations: 5 },
    );
    const out = await runAgentLoop(deps, { ...BASE_INPUT, maxIterations: 1 });
    expect(calls).toHaveLength(2);
    expect(out.iterations).toBe(2);
    expect(out.finalText).toBe('报告');
    expect(calls[1]?.tools).toBeUndefined();
  });
});
