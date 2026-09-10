/**
 * ext-coding 单测 — coding 工作包（引擎 + 扩展桥 + h.coding API + 系统 MCP 工具 + 扩展壳）。
 *
 * 按工作包要求以**子进程路径为主真实跑**（node / python3 / git 本机可用，缺失时
 * skipIf 降级）；Docker 沙箱路径不在本组（SandboxManager 有独立测试，见
 * test/sandbox-manager.test.ts / test/ext-sandbox.test.ts）。
 *
 * 覆盖面：
 * - 会话生命周期：创建/复用/列表/重置/删除 + 非法 sessionId 拒绝
 * - fs 面：write/read/list + 穿越（../ 与绝对路径）与 symlink 出逃拒绝
 * - 执行面：白名单门（含可配置覆盖）、argv shell 元字符字面量安全断言、
 *   绝对路径 / ".." 参数拒绝、cwd 相对子目录、env 白名单合并、超时 kill、
 *   输出 256KB 截断、每会话并发 BUSY、会话间隔离、git init/status、
 *   runCode（node / python3）与临时文件清理
 * - 桥与工具面：coding 桥权限闸（'sandbox' + 扩展端点）与线格式、h.coding 的
 *   topic 路由、createCodingTools 目录与调用语义（含引擎缺失收敛）、
 *   extensions/coding 壳路由（vm 沙箱桩法，与 ext-samples 同款）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KERNEL_TOPICS } from '../src/extension-host/protocol.js';
import {
  createContributionsCollector,
  createHarnessApi,
} from '../src/extension-host/sandbox.js';
import { createTimerRegistry } from '../src/extension-host/vm-runtime.js';
import {
  CodingEngine,
  createCodingBridge,
  DEFAULT_ALLOWLIST,
  MAX_OUTPUT_BYTES,
} from '../src/kernel/coding/index.js';
import { createCodingTools } from '../src/kernel/mcp/system-tools.js';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as import('pino').Logger;

let dataDir = '';

/** 独立 dataDir 的引擎实例（每个用例全新的 coding-workspaces 根） */
function makeEngine(overrides: Partial<ConstructorParameters<typeof CodingEngine>[0]> = {}): CodingEngine {
  return new CodingEngine({ dataDir, logger: silentLogger, ...overrides });
}

/** HarnessError 错误码提取（未抛错 → 'NO_THROW'；无码 → 'NO_CODE'） */
function codeOf(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === 'string' ? code : 'NO_CODE';
}

async function codeOfAsync(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NO_THROW';
  } catch (e) {
    return codeOf(e);
  }
}

/** 本机能力探测（真实子进程） */
function hasBinary(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
const hasNode = hasBinary(process.execPath, ['--version']);
const hasPython = hasBinary('python3', ['--version']);
const hasGit = hasBinary('git', ['--version']);

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'opptrix-coding-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 会话生命周期
// ---------------------------------------------------------------------------

describe('CodingEngine 会话生命周期', () => {
  it('ensureSession 创建会话目录并可复用（同 id 同目录；目录即事实）', () => {
    const engine = makeEngine();
    const first = engine.ensureSession('alpha');
    expect(first.id).toBe('alpha');
    expect(existsSync(first.dir)).toBe(true);
    expect(first.dir).toBe(join(dataDir, 'coding-workspaces', 'alpha'));
    const second = engine.ensureSession('alpha');
    expect(second.dir).toBe(first.dir);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('listSessions/getSession 反映磁盘事实；未创建返回空/ null', () => {
    const engine = makeEngine();
    expect(engine.listSessions()).toEqual([]);
    engine.ensureSession('s1');
    engine.ensureSession('s2');
    const ids = engine.listSessions().map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
    expect(engine.getSession('s1')?.id).toBe('s1');
    expect(engine.getSession('ghost')).toBeNull();
  });

  it('resetSession 清空会话内容；deleteSession 移除目录（重复删除幂等 false）', () => {
    const engine = makeEngine();
    engine.fsWrite('w1', 'keep.txt', 'data');
    engine.resetSession('w1');
    expect(engine.fsList('w1').map((e) => e.name)).toEqual([]);
    expect(engine.deleteSession('w1')).toBe(true);
    expect(existsSync(join(dataDir, 'coding-workspaces', 'w1'))).toBe(false);
    expect(engine.deleteSession('w1')).toBe(false);
  });

  it('非法 sessionId（穿越/绝对路径/坏形态）一律 BAD_REQUEST', async () => {
    const engine = makeEngine();
    for (const bad of ['../evil', '/abs', 'a/b', '.hidden', '', 'a$b']) {
      try {
        engine.ensureSession(bad);
        expect.unreachable(`sessionId "${bad}" should be rejected`);
      } catch (e) {
        expect(codeOf(e)).toBe('HARNESS-1008');
      }
    }
    await expect(codeOfAsync(engine.runInSession('../evil', { cmd: 'echo' }))).resolves.toBe('HARNESS-1008');
  });
});

// ---------------------------------------------------------------------------
// fs 面
// ---------------------------------------------------------------------------

describe('CodingEngine 会话文件面', () => {
  it('fsWrite → fsRead 往返；fsList 一级列表带 size/dir 标记且隐藏引擎内部目录', () => {
    const engine = makeEngine();
    const w = engine.fsWrite('fs1', 'docs/readme.md', '# hello');
    expect(w).toEqual({ path: 'docs/readme.md', size: 7 });
    const r = engine.fsRead('fs1', 'docs/readme.md');
    expect(r.content).toBe('# hello');
    expect(r.size).toBe(7);
    expect(r.truncated).toBe(false);
    engine.fsWrite('fs1', 'b.txt', 'bb');
    const entries = engine.fsList('fs1');
    const names = entries.map((e) => e.name);
    expect(names).toContain('docs');
    expect(names).toContain('b.txt');
    expect(names).not.toContain('.coding'); // 引擎内部目录对工具面不可见
    expect(entries.find((e) => e.name === 'docs')?.dir).toBe(true);
    expect(entries.find((e) => e.name === 'b.txt')?.dir).toBe(false);
  });

  it('fsRead 不存在 → SANDBOX_NOT_FOUND；fsList 对文件列目录 → BAD_REQUEST', async () => {
    const engine = makeEngine();
    await expect(codeOfAsync(Promise.resolve().then(() => engine.fsRead('fs2', 'nope.txt')))).resolves.toBe('HARNESS-6004');
    engine.fsWrite('fs2', 'f.txt', 'x');
    await expect(codeOfAsync(Promise.resolve().then(() => engine.fsList('fs2', 'f.txt')))).resolves.toBe('HARNESS-1008');
  });

  it('路径穿越拒绝：../ 段与绝对路径在 fsWrite/fsRead/cwd 全部拒绝', async () => {
    const engine = makeEngine();
    engine.ensureSession('tr');
    for (const p of ['../escape.txt', 'a/../b.txt', '/etc/passwd', 'sub/../../out.txt']) {
      expect(await codeOfAsync(Promise.resolve().then(() => engine.fsWrite('tr', p, 'x')))).toBe('HARNESS-1008');
      expect(await codeOfAsync(Promise.resolve().then(() => engine.fsRead('tr', p)))).toBe('HARNESS-1008');
    }
    // cwd 穿越同样拒绝
    expect(await codeOfAsync(engine.runInSession('tr', { cmd: 'ls', cwd: '..' }))).toBe('HARNESS-1008');
    expect(await codeOfAsync(engine.runInSession('tr', { cmd: 'ls', cwd: '/tmp' }))).toBe('HARNESS-1008');
    // 穿越尝试没有落盘
    expect(existsSync(join(dataDir, 'escape.txt'))).toBe(false);
  });

  it('symlink 出逃拒绝：指向会话外的软链 realpath 复核 FORBIDDEN', async () => {
    const engine = makeEngine();
    engine.ensureSession('sl');
    const outside = join(dataDir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(dataDir, 'coding-workspaces', 'sl', 'leak'));
    await expect(codeOfAsync(Promise.resolve().then(() => engine.fsRead('sl', 'leak')))).resolves.toBe('HARNESS-1007');
    await expect(codeOfAsync(Promise.resolve().then(() => engine.fsWrite('sl', 'leak', 'x')))).resolves.toBe('HARNESS-1007');
  });

  it('fsRead 超过 256KB 截断（truncated 标记）', () => {
    const engine = makeEngine();
    const big = 'y'.repeat(MAX_OUTPUT_BYTES + 1024);
    engine.fsWrite('big', 'big.txt', big);
    const r = engine.fsRead('big', 'big.txt');
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(big.length);
    expect(r.content.length).toBe(MAX_OUTPUT_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 执行面
// ---------------------------------------------------------------------------

describe('CodingEngine 执行面', () => {
  it('默认白名单契约：覆盖 exec/curl/git/npm 语义的最小命令面（需求清单）', () => {
    expect([...DEFAULT_ALLOWLIST].sort()).toEqual(
      [
        'node', 'python3', 'pip', 'npm', 'npx', 'git', 'curl',
        'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
        'mkdir', 'touch', 'cp', 'mv', 'rm', 'echo', 'sed', 'awk', 'date', 'env',
      ].sort(),
    );
  });

  it('echo 基本执行：argv 直传、exitCode/stdout/durationMs 正常', async () => {
    const engine = makeEngine();
    const r = await engine.runInSession('run1', { cmd: 'echo', args: ['hello', 'world'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello world\n');
    expect(r.stderr).toBe('');
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('白名单外命令拒绝；cmd 带路径分隔符拒绝；白名单可配置覆盖', async () => {
    const engine = makeEngine();
    expect(await codeOfAsync(engine.runInSession('wl', { cmd: 'sh', args: ['-c', 'echo hi'] }))).toBe('HARNESS-1007');
    expect(await codeOfAsync(engine.runInSession('wl', { cmd: 'bash' }))).toBe('HARNESS-1007');
    expect(await codeOfAsync(engine.runInSession('wl', { cmd: 'bin/ls' }))).toBe('HARNESS-1008');
    const narrow = makeEngine({ allowlist: ['echo'] });
    expect(await codeOfAsync(narrow.runInSession('wl', { cmd: 'ls' }))).toBe('HARNESS-1007');
    await expect(narrow.runInSession('wl', { cmd: 'echo', args: ['ok'] })).resolves.toMatchObject({ exitCode: 0 });
  });

  it('安全断言：shell 元字符作为参数字面量传递（反引号 / $( ) / ; / && / | 不被解释）', async () => {
    const engine = makeEngine();
    const r = await engine.runInSession('meta', {
      cmd: 'echo',
      args: ['`id`', '$(id)', 'a;b', 'a&&b', 'a|b', '${HOME}'],
    });
    expect(r.exitCode).toBe(0);
    // 逐字面量回显：没有 shell 解释（`id` 未执行、$() 未展开、;&&| 未作为命令分隔符）
    expect(r.stdout).toBe('`id` $(id) a;b a&&b a|b ${HOME}\n');
  });

  it('argv 路径闸：绝对路径参数与 ".." 段参数拒绝（rm 仅限会话内相对路径）', async () => {
    const engine = makeEngine();
    expect(await codeOfAsync(engine.runInSession('argv', { cmd: 'cat', args: ['/etc/passwd'] }))).toBe('HARNESS-1007');
    expect(await codeOfAsync(engine.runInSession('argv', { cmd: 'cat', args: ['../../etc/passwd'] }))).toBe('HARNESS-1007');
    expect(await codeOfAsync(engine.runInSession('argv', { cmd: 'rm', args: ['-rf', '/'] }))).toBe('HARNESS-1007');
    // 会话内相对 rm 可用
    engine.fsWrite('argv', 'todelete.txt', 'x');
    const r = await engine.runInSession('argv', { cmd: 'rm', args: ['todelete.txt'] });
    expect(r.exitCode).toBe(0);
    expect(engine.fsList('argv').map((e) => e.name)).not.toContain('todelete.txt');
  });

  it('cwd 相对子目录生效；不存在的 cwd 拒绝', async () => {
    const engine = makeEngine();
    engine.fsWrite('cwd1', 'sub/inner.txt', 'inner');
    const r = await engine.runInSession('cwd1', { cmd: 'cat', args: ['inner.txt'], cwd: 'sub' });
    expect(r.stdout).toBe('inner');
    expect(await codeOfAsync(engine.runInSession('cwd1', { cmd: 'ls', cwd: 'nope' }))).toBe('HARNESS-1008');
  });

  it('env 白名单合并：自定义键注入生效；受保护键（PATH/HOME）拒绝', async () => {
    const engine = makeEngine();
    const r = await engine.runInSession('env1', {
      cmd: 'node',
      args: ['-e', 'process.stdout.write(String(process.env.MY_MARK))'],
      env: { MY_MARK: 'injected' },
    });
    expect(r.stdout).toBe('injected');
    expect(await codeOfAsync(engine.runInSession('env1', { cmd: 'echo', env: { PATH: '/evil' } }))).toBe('HARNESS-1007');
    expect(await codeOfAsync(engine.runInSession('env1', { cmd: 'echo', env: { 'bad key': 'x' } }))).toBe('HARNESS-1008');
  }, 15_000);

  it('超时 kill：sleep 型任务被 SIGTERM 终结（exitCode=-1、timedOut=true、不抛错）', async () => {
    const engine = makeEngine();
    const r = await engine.runInSession('tmo', {
      cmd: 'node',
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
    expect(r.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it('输出截断：stdout 超过 256KB 被截断并置 truncated', async () => {
    const engine = makeEngine();
    const r = await engine.runCode('trunc', {
      language: 'node',
      code: 'process.stdout.write("x".repeat(300 * 1024));',
    });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBe(MAX_OUTPUT_BYTES);
  }, 20_000);

  it('并发 BUSY：会话占用中第二个进程拒绝（SANDBOX_BUSY），结束后恢复；reset 同样被门', async () => {
    const engine = makeEngine();
    const first = engine.runInSession('busy1', {
      cmd: 'node',
      args: ['-e', 'setTimeout(() => {}, 2000)'],
      timeoutMs: 5000,
    });
    // 让第一个进程真正起跑后再撞门
    await new Promise((r) => setTimeout(r, 250));
    expect(await codeOfAsync(engine.runInSession('busy1', { cmd: 'echo', args: ['second'] }))).toBe('HARNESS-6005');
    await expect(codeOfAsync(Promise.resolve().then(() => engine.resetSession('busy1')))).resolves.toBe('HARNESS-6005');
    await first; // 第一个进程结束后门释放
    await expect(engine.runInSession('busy1', { cmd: 'echo', args: ['after'] })).resolves.toMatchObject({ exitCode: 0 });
    // 其他会话不受影响
    await expect(engine.runInSession('busy2', { cmd: 'echo' })).resolves.toMatchObject({ exitCode: 0 });
  }, 20_000);

  it('会话间隔离：sessionA 写入的文件对 sessionB 不可见', async () => {
    const engine = makeEngine();
    engine.fsWrite('iso-a', 'secret.txt', 'A-only');
    const listB = engine.fsList('iso-b');
    expect(listB.map((e) => e.name)).not.toContain('secret.txt');
    await expect(codeOfAsync(Promise.resolve().then(() => engine.fsRead('iso-b', 'secret.txt')))).resolves.toBe('HARNESS-6004');
    // 隔离的另一面：进程的 HOME 钉在本会话目录
    const r = await engine.runInSession('iso-a', { cmd: 'node', args: ['-e', 'process.stdout.write(process.env.HOME ?? "")'] });
    expect(r.stdout).toBe(join(dataDir, 'coding-workspaces', 'iso-a'));
  }, 15_000);

  it('runCode：node 捕获 console.log；python3 执行源码（本机缺失时跳过）；临时文件执行后清理', async () => {
    const engine = makeEngine();
    const node = await engine.runCode('code1', {
      language: 'node',
      code: 'const n = 40 + 2; console.log(`answer=${n}`);',
    });
    expect(node.exitCode).toBe(0);
    expect(node.stdout).toContain('answer=42');

    const tmpDir = join(dataDir, 'coding-workspaces', 'code1', '.coding', 'tmp');
    expect(readdirSync(tmpDir)).toEqual([]); // 临时源码文件已清理

    if (!hasPython) {
      expect(true).toBe(true); // skipIf 降级
      return;
    }
    const py = await engine.runCode('code1', {
      language: 'python',
      code: 'print("py-ok", 6 * 7)',
    });
    expect(py.exitCode).toBe(0);
    expect(py.stdout).toContain('py-ok 42');
    expect(readdirSync(tmpDir)).toEqual([]);
  }, 20_000);

  it('runCode 非法语言 / 空 code 拒绝；白名单命令未安装给出可诊断错误', async () => {
    const engine = makeEngine();
    expect(await codeOfAsync(engine.runCode('code2', { language: 'ruby' as never, code: 'puts 1' }))).toBe('HARNESS-1008');
    expect(await codeOfAsync(engine.runCode('code2', { language: 'node', code: '' }))).toBe('HARNESS-1008');
    // 白名单内但本机未安装：deterministic 挑一个大概率不存在的名字（monkeyspec 用 deps.allowlist 注入）
    const fake = makeEngine({ allowlist: ['definitely-not-installed-cmd'] });
    expect(await codeOfAsync(fake.runInSession('code2', { cmd: 'definitely-not-installed-cmd' }))).toBe('HARNESS-6004');
  });

  it('git init + git status 会话内可用（本机有 git；无则跳过）', async () => {
    if (!hasGit) return; // skipIf 降级
    const engine = makeEngine();
    const init = await engine.runInSession('gitproj', { cmd: 'git', args: ['init'] });
    expect(init.exitCode).toBe(0);
    engine.fsWrite('gitproj', 'hello.txt', 'hi');
    const status = await engine.runInSession('gitproj', { cmd: 'git', args: ['status', '--porcelain'] });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('?? hello.txt');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 桥 + h.coding API + 系统 MCP 工具
// ---------------------------------------------------------------------------

describe('coding 桥与工具面', () => {
  function makeBridge(engine: CodingEngine, opts: { permission?: boolean } = {}) {
    const granted = opts.permission !== false;
    return createCodingBridge({
      engine,
      requirePermission: (extId, topic, permission) => {
        if (!granted) {
          throw Object.assign(new Error(`missing ${permission}`), { code: 'HARNESS-1007' });
        }
        void extId;
        void topic;
      },
    });
  }

  it('非扩展端点调用 → RPC_PERMISSION_DENIED；权限缺失 → FORBIDDEN', async () => {
    const bridge = makeBridge(makeEngine(), { permission: false });
    const exec = bridge[KERNEL_TOPICS.codingExec];
    expect(await codeOfAsync(exec({ cmd: 'echo' }, 'kernel'))).toBe('HARNESS-2003');
    expect(await codeOfAsync(exec({ cmd: 'echo' }, 'ext:no-perm'))).toBe('HARNESS-1007');
  });

  it('exec/fs 线格式 + sessionId 缺省 "default"（真实引擎落盘验证）', async () => {
    const engine = makeEngine();
    const bridge = makeBridge(engine);
    const run = (await bridge[KERNEL_TOPICS.codingExec]({ cmd: 'echo', args: ['via-bridge'] }, 'ext:coding')) as {
      exitCode: number;
      stdout: string;
    };
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe('via-bridge\n');
    // sessionId 缺省 → 落 'default' 会话
    await bridge[KERNEL_TOPICS.codingFsWrite]({ path: 'd.txt', content: 'd' }, 'ext:coding');
    expect(engine.fsRead('default', 'd.txt').content).toBe('d');
    const entries = (await bridge[KERNEL_TOPICS.codingFsList]({}, 'ext:coding')) as Array<{ name: string }>;
    expect(entries.map((e) => e.name)).toContain('d.txt');
    // 线格式校验失败 → VALIDATION_FAILED
    expect(await codeOfAsync(bridge[KERNEL_TOPICS.codingExec]({ cmd: 42 }, 'ext:coding'))).toBe('HARNESS-1009');
  });

  it('sessions/reset/delete topic 串起会话生命周期', async () => {
    const engine = makeEngine();
    const bridge = makeBridge(engine);
    await bridge[KERNEL_TOPICS.codingFsWrite]({ sessionId: 'life', path: 'x.txt', content: 'x' }, 'ext:coding');
    const sessions = (await bridge[KERNEL_TOPICS.codingSessions]({}, 'ext:coding')) as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toContain('life');
    await bridge[KERNEL_TOPICS.codingSessionReset]({ sessionId: 'life' }, 'ext:coding');
    expect(engine.fsList('life')).toEqual([]);
    const del = (await bridge[KERNEL_TOPICS.codingSessionDelete]({ sessionId: 'life' }, 'ext:coding')) as {
      deleted: boolean;
    };
    expect(del.deleted).toBe(true);
  });

  it('h.coding API：扩展侧调用路由到 coding.* 桥 topic', async () => {
    const kernelCall = vi.fn(async () => ({ ok: true }));
    const harness = createHarnessApi({
      extId: 'coding-consumer',
      kernelCall: kernelCall as unknown as (topic: string, payload: unknown) => Promise<unknown>,
      contributions: createContributionsCollector(),
      timers: createTimerRegistry(),
      activationPhase: () => true,
    });
    await harness.coding.exec({ cmd: 'ls' });
    expect(kernelCall).toHaveBeenCalledWith(KERNEL_TOPICS.codingExec, { cmd: 'ls' });
    await harness.coding.runCode({ language: 'node', code: '1' });
    expect(kernelCall).toHaveBeenLastCalledWith(KERNEL_TOPICS.codingRunCode, { language: 'node', code: '1' });
    await harness.coding.fsWrite({ path: 'a', content: 'b' });
    await harness.coding.fsRead({ path: 'a' });
    await harness.coding.fsList({ path: '.' });
    await harness.coding.sessions();
    await harness.coding.resetSession({ sessionId: 's' });
    await harness.coding.deleteSession({ sessionId: 's' });
    const topics = kernelCall.mock.calls.map((c) => c[0]);
    expect(topics).toEqual([
      KERNEL_TOPICS.codingExec,
      KERNEL_TOPICS.codingRunCode,
      KERNEL_TOPICS.codingFsWrite,
      KERNEL_TOPICS.codingFsRead,
      KERNEL_TOPICS.codingFsList,
      KERNEL_TOPICS.codingSessions,
      KERNEL_TOPICS.codingSessionReset,
      KERNEL_TOPICS.codingSessionDelete,
    ]);
  });

  it('createCodingTools：六个 coding_* 工具在目录；执行语义接真实引擎；引擎缺失收敛 HARNESS-9001', async () => {
    const tools = createCodingTools();
    expect(tools.map((t) => t.name)).toEqual([
      'coding_exec',
      'coding_run_code',
      'coding_fs_write',
      'coding_fs_read',
      'coding_fs_list',
      'coding_sessions',
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0);
    }
    const engine = makeEngine();
    const ctx = {
      kernel: { container: { has: (k: string) => k === 'coding.engine', resolve: () => engine } },
    } as never;
    const sessions = (await tools.find((t) => t.name === 'coding_sessions')?.execute({}, ctx)) as {
      ok: boolean;
      sessions: unknown[];
    };
    expect(sessions.ok).toBe(true);
    const exec = await tools.find((t) => t.name === 'coding_exec')?.execute(
      { cmd: 'echo', args: ['tool-face'] },
      ctx,
    );
    expect(exec).toMatchObject({ ok: true, exitCode: 0, stdout: 'tool-face\n' });
    // 每会话缺省 default：fs_write 后 coding_fs_list 可见
    await tools.find((t) => t.name === 'coding_fs_write')?.execute({ path: 'via-tool.txt', content: 'tv' }, ctx);
    const list = (await tools.find((t) => t.name === 'coding_fs_list')?.execute({}, ctx)) as {
      entries: Array<{ name: string }>;
    };
    expect(list.entries.map((e) => e.name)).toContain('via-tool.txt');
    // 引擎未装配：fail-closed 结果对象（工具不抛）
    const emptyCtx = { kernel: { container: { has: () => false } } } as never;
    const missing = await tools.find((t) => t.name === 'coding_exec')?.execute({ cmd: 'ls' }, emptyCtx);
    expect(missing).toMatchObject({ ok: false, error: { code: 'HARNESS-9001' } });
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 扩展壳（vm 沙箱桩法，与 ext-samples 同款）
// ---------------------------------------------------------------------------

describe('extensions/coding 扩展壳', () => {
  type RouteHandler = (req: { params?: Record<string, string>; query?: Record<string, unknown> }) => unknown;
  interface RouteEntry {
    handler: RouteHandler;
    auth: string | undefined;
  }

  /** 在 vm context 内装载扩展源码并捕获注册路由（h.coding 以桩承载） */
  function loadRoutes(coding?: Record<string, unknown>): Map<string, RouteEntry> {
    const slot: { setup?: (h: Record<string, unknown>) => Promise<void> } = {};
    const defineExtension = (input: unknown): unknown => {
      const candidate = typeof input === 'function' ? { setup: input } : input;
      const setup = (candidate as { setup?: unknown } | null)?.setup;
      if (typeof setup !== 'function') throw new TypeError('setup must be a function');
      slot.setup = setup as (h: Record<string, unknown>) => Promise<void>;
      return candidate;
    };
    const file = fileURLToPath(new URL('../extensions/coding/index.js', import.meta.url));
    vm.runInContext(readFileSync(file, 'utf8'), vm.createContext({ defineExtension }), { filename: file });
    const routes = new Map<string, RouteEntry>();
    const h = {
      route: (method: string, path: string, handler: RouteHandler, opts?: { auth?: string }) => {
        routes.set(`${method} ${path}`, { handler, auth: opts?.auth });
      },
      coding:
        coding ??
        ({
          sessions: vi.fn(async () => [{ id: 'default', dir: '/x', createdAt: 1 }]),
          resetSession: vi.fn(async (i: unknown) => ({ ...(i as object), dir: '/x', createdAt: 1 })),
          fsList: vi.fn(async () => [{ name: 'a.txt', size: 2, dir: false }]),
        } as Record<string, unknown>),
    };
    void slot.setup?.(h);
    return routes;
  }

  it('注册声明路由：/status + 三条 /api/sessions*（auth user）', () => {
    const routes = loadRoutes();
    expect([...routes.keys()].sort()).toEqual([
      'GET /api/sessions',
      'GET /api/sessions/:id/files',
      'GET /status',
      'POST /api/sessions/:id/reset',
    ]);
    expect(routes.get('GET /api/sessions')?.auth).toBe('user');
    expect(routes.get('POST /api/sessions/:id/reset')?.auth).toBe('user');
    expect(routes.get('GET /api/sessions/:id/files')?.auth).toBe('user');
  });

  it('路由转发 h.coding 桥；内核桥错误码映射为 HTTP 状态（BUSY→409 / FORBIDDEN→403）', async () => {
    const routes = loadRoutes();
    await expect(routes.get('GET /api/sessions')?.handler({})).resolves.toEqual({
      status: 200,
      body: { sessions: [{ id: 'default', dir: '/x', createdAt: 1 }] },
    });
    await expect(routes.get('POST /api/sessions/:id/reset')?.handler({ params: { id: 'dev' } })).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      routes.get('GET /api/sessions/:id/files')?.handler({ params: { id: 'dev' }, query: { path: 'sub' } }),
    ).resolves.toEqual({
      status: 200,
      body: { sessionId: 'dev', path: 'sub', entries: [{ name: 'a.txt', size: 2, dir: false }] },
    });

    // 内核桥错误（HarnessError 形状 { code, message }）→ 可操作的 HTTP 状态映射
    const boom = (code: string) => async () => {
      throw Object.assign(new Error('bridge failed'), { code });
    };
    const busyRoutes = loadRoutes({ sessions: boom('HARNESS-6005'), resetSession: boom('HARNESS-6005'), fsList: boom('HARNESS-6005') });
    await expect(busyRoutes.get('GET /api/sessions')?.handler({})).resolves.toMatchObject({
      status: 409,
      body: { code: 'HARNESS-6005' },
    });
    const forbiddenRoutes = loadRoutes({ sessions: boom('HARNESS-1007'), resetSession: boom('HARNESS-1007'), fsList: boom('HARNESS-1007') });
    await expect(forbiddenRoutes.get('GET /api/sessions')?.handler({})).resolves.toMatchObject({
      status: 403,
      body: { code: 'HARNESS-1007' },
    });
    // 未知码回退 500
    const oddRoutes = loadRoutes({ sessions: boom('HARNESS-9999'), resetSession: boom('HARNESS-9999'), fsList: boom('HARNESS-9999') });
    await expect(oddRoutes.get('GET /api/sessions')?.handler({})).resolves.toMatchObject({ status: 500 });
  });
});
