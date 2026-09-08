/**
 * MCP 配置持久化（`<dataDir>/mcp/config.json`）。
 *
 * 约定（与 storage/secretkey.ts 同款原子写手法）：
 * - 文件为 `McpServerConfig[]` 的 JSON（pretty print + 尾换行，便于人工审计/迁移）；
 * - 写入走「同目录临时文件 + rename」：0600 权限（env/headers 可含凭据），POSIX 原子替换，
 *   读方要么看到旧全量要么看到新全量，进程任意时刻崩溃都不会留下半写配置；
 * - 首次 load 后整表缓存于内存，读多写少；增删改在缓存上完成并整表落盘（v1 配置量级
 *   为个位数～几十条，整表写足够；读写竞态由 Node 单线程事件循环天然规避跨调用交错）；
 * - 磁盘上的条目逐条经 zod 复核：损坏 JSON fail-fast（INTERNAL，指明修复动作），
 *   个别非法条目 fail-fast（VALIDATION_FAILED，列出坏 id）——配置是管理员手工可编辑面，
 *   静默吞错会演变成「为什么我的 server 不见了」。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { err, HarnessError } from '../errors/index.js';
import { validateMcpServerConfig, type McpServerConfig } from './types.js';

/** dataDir 下的 MCP 配置子目录与文件名 */
const CONFIG_DIR = 'mcp';
const CONFIG_FILE = 'config.json';

/** PATCH 允许修改的字段（id/transport/command/url 等身份与拓扑字段不可变——删了重加） */
export interface McpConfigPatch {
  name?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export class McpConfigStore {
  /** 配置文件绝对路径（`<dataDir>/mcp/config.json`） */
  readonly #file: string;
  /** 已水合的内存缓存；undefined = 尚未从磁盘加载 */
  #cache: McpServerConfig[] | undefined;

  constructor(deps: { dataDir: string }) {
    if (typeof deps.dataDir !== 'string' || deps.dataDir === '') {
      throw err('VALIDATION_FAILED', {
        message: '[mcp.config-store] dataDir is required (non-empty string) to locate mcp/config.json',
        detail: { dataDir: typeof deps.dataDir },
      });
    }
    this.#file = path.join(deps.dataDir, CONFIG_DIR, CONFIG_FILE);
  }

  /** 配置文件路径（诊断/文档用） */
  get file(): string {
    return this.#file;
  }

  /**
   * 读取全部 server 配置（首次从磁盘水合，之后走内存缓存）。
   * 文件不存在视为空配置（首次启动常态）。
   */
  async load(): Promise<McpServerConfig[]> {
    await this.#hydrate();
    return this.#cache!.map((cfg) => ({ ...cfg }));
  }

  /**
   * 整表校验并落盘（同时替换内存缓存）。供批量迁移/外部装配使用；
   * 常规增删改走 add/remove/setEnabled/update（内部自动 save）。
   */
  async save(list: McpServerConfig[]): Promise<void> {
    const validated = list.map((cfg) => validateMcpServerConfig(cfg));
    this.#assertUniqueIds(validated);
    await this.#writeThrough(validated);
  }

  /** 按 id 取单条配置（未水合先水合；不存在返回 undefined） */
  async get(id: string): Promise<McpServerConfig | undefined> {
    await this.#hydrate();
    return this.#cache!.find((cfg) => cfg.id === id);
  }

  /**
   * 新增一条配置（zod + 跨字段校验；id 重复 → VALIDATION_FAILED）。
   * @returns 归一化后的存储形状（补充缺省字段后的深拷贝）
   */
  async add(cfg: McpServerConfig): Promise<McpServerConfig> {
    await this.#hydrate();
    const validated = validateMcpServerConfig(cfg);
    if (this.#cache!.some((existing) => existing.id === validated.id)) {
      throw err('VALIDATION_FAILED', {
        message: `mcp server id "${validated.id}" already exists — use PATCH to modify or DELETE + POST to replace it`,
        detail: { id: validated.id },
      });
    }
    this.#cache!.push(validated);
    await this.#writeThrough(this.#cache!);
    return { ...validated };
  }

  /**
   * 删除一条配置。
   * @returns 是否确有配置被删除（id 不存在返回 false，不抛错）
   */
  async remove(id: string): Promise<boolean> {
    await this.#hydrate();
    const next = this.#cache!.filter((cfg) => cfg.id !== id);
    if (next.length === this.#cache!.length) return false;
    await this.#writeThrough(next);
    return true;
  }

  /** 只改 enabled（PERSIST 后返回更新后的配置；id 不存在 → EXT_NOT_FOUND 语义的 404） */
  async setEnabled(id: string, enabled: boolean): Promise<McpServerConfig> {
    return await this.update(id, { enabled });
  }

  /**
   * 局部更新（PATCH 面：name / headers / enabled）。
   * id 与 transport 等身份字段不可变：变更拓扑请删除后重建（连接语义才有一致定义）。
   */
  async update(id: string, patch: McpConfigPatch): Promise<McpServerConfig> {
    await this.#hydrate();
    const idx = this.#cache!.findIndex((cfg) => cfg.id === id);
    if (idx === -1) {
      throw err('EXT_NOT_FOUND', {
        message: `mcp server "${id}" is not configured`,
        detail: { id },
      });
    }
    const current = this.#cache![idx]!;
    const next = validateMcpServerConfig({
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    this.#cache![idx] = next;
    await this.#writeThrough(this.#cache!);
    return { ...next };
  }

  // ------------------------------------------------------------------ 内部

  /** 从磁盘水合缓存（幂等；失败后重置缓存以便下次重试） */
  async #hydrate(): Promise<void> {
    if (this.#cache !== undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.#file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cache = [];
        return;
      }
      throw err('INTERNAL', {
        message: `[mcp.config-store] failed to read config file "${this.#file}" (code: ${String((e as NodeJS.ErrnoException).code)})`,
        cause: e,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 管理员手编损坏是真实场景：fail-fast 并给出可操作修复动作，绝不静默清空
      throw err('INTERNAL', {
        message:
          `[mcp.config-store] config file "${this.#file}" is not valid JSON. ` +
          'Fix the file manually (or delete it to start with an empty server list).',
        cause: e,
      });
    }
    if (!Array.isArray(parsed)) {
      throw err('INTERNAL', {
        message:
          `[mcp.config-store] config file "${this.#file}" must contain a JSON array of server configs ` +
          `(got ${parsed === null ? 'null' : typeof parsed}). Fix the file manually or delete it.`,
      });
    }
    // 逐条复核：坏条目指名道姓（id 可用时），防「server 莫名消失」式排查黑洞
    const entries: McpServerConfig[] = [];
    for (const entry of parsed) {
      try {
        entries.push(validateMcpServerConfig(entry));
      } catch (e) {
        const entryId =
          entry !== null && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
            ? (entry as { id: string }).id
            : '<unknown>';
        throw err('VALIDATION_FAILED', {
          message: `[mcp.config-store] entry "${entryId}" in "${this.#file}" is invalid: ` +
            `${e instanceof HarnessError ? e.message : String(e)}`,
          detail: { id: entryId },
          cause: e,
        });
      }
    }
    this.#assertUniqueIds(entries);
    this.#cache = entries;
  }

  /** 整表原子落盘（tmp + chmod 0600 + rename，同 secretkey.ts 手法）并刷新缓存 */
  async #writeThrough(list: McpServerConfig[]): Promise<void> {
    this.#cache = list.map((cfg) => ({ ...cfg }));
    const dir = path.dirname(this.#file);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.#file}.tmp`;
    const body = `${JSON.stringify(list, null, 2)}\n`;
    try {
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      // writeFile 的 mode 仅创建时生效；显式 chmod 兜底（已存在/异常 umask 场景）
      await chmod(tmp, 0o600);
      await rename(tmp, this.#file);
    } catch (e) {
      throw err('INTERNAL', {
        message: `[mcp.config-store] failed to persist config file "${this.#file}": ` +
          `${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      });
    }
  }

  /** id 唯一性断言（save 整表入口的重复防护） */
  #assertUniqueIds(list: McpServerConfig[]): void {
    const seen = new Set<string>();
    for (const cfg of list) {
      if (seen.has(cfg.id)) {
        throw err('VALIDATION_FAILED', {
          message: `mcp config contains duplicate id "${cfg.id}" — ids must be unique`,
          detail: { id: cfg.id },
        });
      }
      seen.add(cfg.id);
    }
  }
}
