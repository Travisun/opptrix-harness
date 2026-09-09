/**
 * PluginRegistry — 插件发现 / 聚合 / 贡献注入 / 卸载 / 脚本执行委托。
 *
 * 职责（插件包机制的中枢）：
 * - `refresh()`：扫描 `<dataDir>/plugins/<目录>/plugin.json` 聚合已安装插件（zod 全量校验，
 *   坏包跳过 + warn，绝不因单个坏包中断聚合）；并把插件贡献注入内核：
 *   - skills → `skillsRegistry.registerContributed('plugin:<id>', skills)`
 *     （file 引用在此阶段读为 body；extId 统一冠 `plugin:` 前缀）；
 *   - mcpServers → `mcpRegistry.addServer({ id: 'plugin:<pid>:<sid>', ... })`
 *     （server id 冠 `plugin:<pid>:` 前缀避免与全局 server 冲突）；
 *   注入先做整体摘除再重建（teardown/rebuild），refresh 幂等。
 * - `list()/get(id)`：聚合摘要（InstalledPlugin）。
 * - `remove(id, { force })`：卸载。插件当前有贡献注入（skills/MCP 在用）时必须
 *   `force: true`——先摘贡献再删目录；无 force → FORBIDDEN。
 * - `runScript(pluginId, scriptId, args)`：委托 deps.scriptRunner（执行沙箱容器内
 *   运行，非宿主进程）。v1 缺省未注入 → NOT_IMPLEMENTED（HARNESS-9004），由集成层
 *   接线真实现。
 *
 * 持久与升级语义：插件装在 `<dataDir>/plugins/`（数据卷）。内核 A/B 升级只替换
 * releases/slot 目录，**绝不触碰 /data/plugins**；内核升级（或扩展启用态变化）后由
 * 集成层再次调用 `refresh()` 重新聚合并重建注入。
 *
 * 依赖契约（均可选，缺省时对应能力静默降级）：
 * - skillsRegistry: SkillsRegistryLike（src/kernel/skills 并行包）；
 * - mcpRegistry: McpRegistryLike（src/kernel/mcp 并行包）；
 * - scriptRunner: ScriptRunnerLike（执行沙箱集成）。
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import { KERNEL_TOPICS } from '../../extension-host/protocol.js';
import { err, HarnessError } from '../errors/index.js';
import {
  toInstalledPlugin,
  validatePluginManifest,
  type InstalledPlugin,
  type McpRegistryLike,
  type PluginContributedSkill,
  type PluginManifest,
  type ScriptRunnerLike,
  type SkillsRegistryLike,
} from './types.js';

// ---------------------------------------------------------------------------
// 依赖契约
// ---------------------------------------------------------------------------

/** PluginRegistry 构造依赖 */
export interface PluginRegistryDeps {
  /** 数据根目录；插件目录为 `<dataDir>/plugins/` */
  dataDir: string;
  /** kernel logger（pino；坏包跳过/注入摘除等记 warn） */
  logger: Logger;
  /** skills 注册中心（可选；缺省跳过 skills 注入） */
  skillsRegistry?: SkillsRegistryLike;
  /** MCP 注册中心（可选；缺省跳过 mcpServers 注入） */
  mcpRegistry?: McpRegistryLike;
  /** 脚本执行沙箱（可选；缺省 runScript → NOT_IMPLEMENTED） */
  scriptRunner?: ScriptRunnerLike;
}

/** registry 内部缓存条目 */
interface RegistryEntry {
  plugin: InstalledPlugin;
  manifest: PluginManifest;
  /** 聚合期已解析 body 的贡献 skills（file 引用已读为文件内容） */
  skills: PluginContributedSkill[];
  /** 插件安装目录（<dataDir>/plugins/<id>） */
  dir: string;
}

/** 一个插件当前注入的贡献记录（摘除时使用） */
interface ContributedRecord {
  /** 注入的 MCP server id（已冠 plugin:<pid>: 前缀） */
  serverIds: string[];
  /** 是否注入了 skills */
  skills: boolean;
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

export class PluginRegistry {
  readonly #deps: PluginRegistryDeps;
  /** 插件 id → 聚合条目（refresh() 重建） */
  readonly #plugins = new Map<string, RegistryEntry>();
  /** 插件 id → 当前注入的贡献（refresh() 填充；remove 摘除依据） */
  readonly #contributing = new Map<string, ContributedRecord>();
  #refreshed = false;

  constructor(deps: PluginRegistryDeps) {
    this.#deps = deps;
  }

  /** 数据根目录（REST 层绑定原始 installerZip 形态时复用） */
  get dataDir(): string {
    return this.#deps.dataDir;
  }

  /** 插件安装根：`<dataDir>/plugins` */
  get pluginsRoot(): string {
    return path.join(this.#deps.dataDir, 'plugins');
  }

  /**
   * 扫描并聚合 `<dataDir>/plugins/<插件目录>/plugin.json`，重建贡献注入。
   * 坏包（清单非法 / skill 文件缺失）跳过并 warn，不影响其余插件。
   *
   * @returns 本次聚合出的全部已安装插件摘要（按 id 字典序）
   */
  async refresh(): Promise<InstalledPlugin[]> {
    const entries: RegistryEntry[] = [];
    let dirNames: string[] = [];
    try {
      dirNames = await readdir(this.pluginsRoot);
    } catch {
      dirNames = []; // plugins 目录不存在：视为空聚合
    }

    for (const name of dirNames) {
      if (name.startsWith('.')) continue; // staging/临时目录
      const dir = path.join(this.pluginsRoot, name);
      const entry = await this.#loadEntry(name, dir);
      if (entry !== null) entries.push(entry);
    }
    entries.sort((a, b) => (a.plugin.id < b.plugin.id ? -1 : a.plugin.id > b.plugin.id ? 1 : 0));

    // teardown：先整体摘除上一轮注入，再重建（refresh 幂等）
    this.#detachAll();

    // 注入（skills → registerContributed；mcpServers → addServer）
    for (const entry of entries) {
      this.#inject(entry);
    }

    this.#plugins.clear();
    for (const entry of entries) {
      this.#plugins.set(entry.plugin.id, entry);
    }
    this.#refreshed = true;
    return entries.map((e) => e.plugin);
  }

  /** 已聚合的插件摘要（按 id 字典序；refresh() 之前为空） */
  list(): InstalledPlugin[] {
    return [...this.#plugins.values()].map((e) => e.plugin);
  }

  /** 按 id 取插件摘要；未聚合/不存在返回 undefined */
  get(id: string): InstalledPlugin | undefined {
    return this.#plugins.get(id)?.plugin;
  }

  /**
   * 卸载插件：先摘贡献（removeContributed / removeServer）再删安装目录。
   * @param opts.force 插件当前有贡献在用时必须显式 force（否则 FORBIDDEN）
   * @throws EXT_NOT_FOUND 插件未安装；FORBIDDEN 有贡献在用且未 force
   */
  async remove(id: string, opts?: { force?: boolean }): Promise<void> {
    const dir = path.join(this.pluginsRoot, id);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) {
        throw err('EXT_NOT_FOUND', { message: `plugin "${id}" is not installed`, detail: { id } });
      }
    } catch (cause) {
      if (cause instanceof HarnessError) throw cause;
      throw err('EXT_NOT_FOUND', { message: `plugin "${id}" is not installed`, detail: { id } });
    }

    if (!this.#refreshed) {
      // 未经 refresh 时贡献状态未知：先聚合一次，保证摘除语义准确
      await this.refresh();
    }

    const contributed = this.#contributing.get(id);
    if (contributed !== undefined && opts?.force !== true) {
      throw err('FORBIDDEN', {
        message: `plugin "${id}" currently contributes ${contributed.skills ? 'skills ' : ''}${
          contributed.serverIds.length > 0 ? `${contributed.serverIds.length} mcp server(s) ` : ''
        }to the kernel; pass force:true (REST ?force=1) to detach them and remove`,
        detail: { id, skills: contributed.skills, mcpServers: contributed.serverIds.length },
      });
    }
    if (contributed !== undefined) {
      this.#detachContributions(id, contributed);
      this.#contributing.delete(id);
    }
    this.#plugins.delete(id);
    await this.#rmDir(dir);
  }

  /**
   * 执行插件脚本：委托 deps.scriptRunner（执行沙箱容器内运行，非宿主进程）。
   * @throws NOT_IMPLEMENTED 未注入 scriptRunner（v1 缺省，由集成层接线）；
   *          EXT_NOT_FOUND 插件或脚本 id 不存在
   */
  async runScript(
    pluginId: string,
    scriptId: string,
    args: unknown,
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const runner = this.#deps.scriptRunner;
    if (runner === undefined) {
      throw err('NOT_IMPLEMENTED', {
        message: 'plugin script execution is not wired: PluginRegistry was constructed without deps.scriptRunner ' +
          '(the execution-sandbox integration must inject it; scripts never run on the host process)',
        detail: { pluginId, scriptId },
      });
    }
    if (!this.#refreshed) await this.refresh();
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined) {
      throw err('EXT_NOT_FOUND', { message: `plugin "${pluginId}" is not installed`, detail: { pluginId } });
    }
    const script = entry.manifest.scripts.find((s) => s.id === scriptId);
    if (script === undefined) {
      throw err('EXT_NOT_FOUND', {
        message: `plugin "${pluginId}" has no script "${scriptId}"`,
        detail: { pluginId, scriptId, available: entry.manifest.scripts.map((s) => s.id) },
      });
    }
    return runner.run(pluginId, scriptId, args);
  }

  // ---------------------------------------------------------------- 内部实现

  /** 加载并校验单个插件目录；坏包 warn + 返回 null（跳过） */
  async #loadEntry(dirName: string, dir: string): Promise<RegistryEntry | null> {
    const fail = (message: string, detail?: unknown): null => {
      this.#deps.logger.warn({ pluginDir: dirName, detail }, `plugins: skipped invalid plugin package: ${message}`);
      return null;
    };
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8'));
    } catch (cause) {
      return fail('plugin.json missing or not valid JSON', [dirName, String(cause)]);
    }
    let manifest: PluginManifest;
    let skills: PluginContributedSkill[];
    try {
      manifest = validatePluginManifest(raw);
      // file 引用的 skill 文件在聚合期读为 body；此刻缺文件视为坏包
      skills = await resolveSkillBodies(dir, manifest);
    } catch (cause) {
      return fail('plugin.json invalid or referenced skill file missing', cause);
    }
    let installedAt: string;
    try {
      const st = await stat(dir);
      installedAt = epochToIso(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);
    } catch {
      installedAt = epochToIso(0);
    }
    return { plugin: toInstalledPlugin(manifest, installedAt), manifest, skills, dir };
  }

  /** 把一个插件的贡献注入 skillsRegistry / mcpRegistry 并登记 */
  #inject(entry: RegistryEntry): void {
    const { manifest, skills } = entry;
    if (this.#deps.skillsRegistry !== undefined && skills.length > 0) {
      this.#deps.skillsRegistry.registerContributed(`plugin:${manifest.id}`, skills);
    }
    const serverIds: string[] = [];
    if (this.#deps.mcpRegistry !== undefined) {
      for (const server of manifest.mcpServers) {
        const id = `plugin:${manifest.id}:${server.id}`;
        this.#deps.mcpRegistry.addServer({
          id,
          name: server.name,
          transport: server.transport,
          ...(server.command !== undefined ? { command: server.command } : {}),
          ...(server.args !== undefined ? { args: [...server.args] } : {}),
          ...(server.url !== undefined ? { url: server.url } : {}),
          ...(server.headers !== undefined ? { headers: { ...server.headers } } : {}),
          ...(server.env !== undefined ? { env: { ...server.env } } : {}),
        });
        serverIds.push(id);
      }
    }
    if (skills.length > 0 || serverIds.length > 0) {
      this.#contributing.set(manifest.id, { skills: skills.length > 0, serverIds });
    }
  }

  /** 摘除上一轮全部注入（refresh teardown 阶段） */
  #detachAll(): void {
    for (const [id, record] of this.#contributing) {
      this.#detachContributions(id, record);
    }
    this.#contributing.clear();
  }

  /** 摘除单个插件的贡献（幂等；未接线的能力静默跳过） */
  #detachContributions(id: string, record: ContributedRecord): void {
    if (record.skills) {
      this.#deps.skillsRegistry?.removeContributed(`plugin:${id}`);
    }
    for (const serverId of record.serverIds) {
      this.#deps.mcpRegistry?.removeServer(serverId);
    }
  }

  /** 尽力删除目录（不存在时静默） */
  async #rmDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 聚合辅助
// ---------------------------------------------------------------------------

/** file 引用 → 读文件为 body；返回规整后的 skills（全部带 body） */
async function resolveSkillBodies(dir: string, manifest: PluginManifest): Promise<PluginContributedSkill[]> {
  const out: PluginContributedSkill[] = [];
  for (const skill of manifest.skills) {
    let body = skill.body;
    if (body === undefined && skill.file !== undefined) {
      body = await readFile(path.join(dir, skill.file), 'utf8');
    }
    if (body === undefined || body === '') {
      throw err('VALIDATION_FAILED', {
        message: `skill "${skill.id}" has no body (inline "body" or readable "file" required)`,
        detail: { skillId: skill.id },
      });
    }
    out.push(toContributedSkill({ ...skill, body }));
  }
  return out;
}

/** 清单 skill 声明 → 贡献 skill（name 缺省取 id、description 缺省空串） */
function toContributedSkill(skill: PluginManifest['skills'][number] & { body: string }): PluginContributedSkill {
  return {
    id: skill.id,
    name: skill.name ?? skill.id,
    description: skill.description ?? '',
    body: skill.body,
  };
}

/** epoch ms → UTC ISO8601（epoch 0 兜底为 unix epoch） */
function epochToIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// 扩展线程桥（KERNEL_TOPICS.pluginsList 等）
// ---------------------------------------------------------------------------

/**
 * 插件包桥 topics：`plugins.list` 已接线（聚合摘要）；其余为 v1 预留面，
 * 返回 NOT_IMPLEMENTED 形状（能力面在 REST /api/v1/plugins）。
 */
export const PLUGIN_BRIDGE_TOPICS = {
  /** 已接线：→ { plugins: InstalledPlugin[] } */
  list: KERNEL_TOPICS.pluginsList,
  get: 'plugins.get',
  refresh: 'plugins.refresh',
  install: 'plugins.install',
  remove: 'plugins.remove',
  runScript: 'plugins.runScript',
} as const;

/** 桥处理器表（与 KernelBridgeHandlers 同形；由集成层并入 bridge handlers） */
export type PluginBridgeHandlers = Record<string, (payload: unknown, from: string) => Promise<unknown>>;

/**
 * 构造插件包 RPC 桥：
 * - `plugins.list` → `{ plugins: registry.list() }`；
 * - 其余 plugin topics → 返回 NOT_IMPLEMENTED 形状 `{ code: 'HARNESS-9004', ... }`
 *   （不抛错——扩展侧拿到形状自行判断；能力面在 REST）。
 */
export function createPluginsBridge(deps: { registry: PluginRegistry }): PluginBridgeHandlers {
  const notImplemented = (topic: string) => {
    const shape = err('NOT_IMPLEMENTED', {
      message: `plugin bridge topic "${topic}" is not wired in v1; manage plugins via REST /api/v1/plugins`,
      detail: { topic },
    }).toJSON();
    return async () => shape;
  };
  return {
    [PLUGIN_BRIDGE_TOPICS.list]: async () => ({ plugins: deps.registry.list() }),
    [PLUGIN_BRIDGE_TOPICS.get]: notImplemented(PLUGIN_BRIDGE_TOPICS.get),
    [PLUGIN_BRIDGE_TOPICS.refresh]: notImplemented(PLUGIN_BRIDGE_TOPICS.refresh),
    [PLUGIN_BRIDGE_TOPICS.install]: notImplemented(PLUGIN_BRIDGE_TOPICS.install),
    [PLUGIN_BRIDGE_TOPICS.remove]: notImplemented(PLUGIN_BRIDGE_TOPICS.remove),
    [PLUGIN_BRIDGE_TOPICS.runScript]: notImplemented(PLUGIN_BRIDGE_TOPICS.runScript),
  };
}
