/**
 * sandbox — Docker 工作区沙箱模块桶导出（types / docker 适配器 / SandboxManager）。
 *
 * 典型组装（内核 provider 阶段）：
 * ```ts
 * const client = createDockerClient({ dockerHost: config.dockerHost }); // 不可用返回 null
 * const sandbox = new SandboxManager({ config, client, logger });
 * await sandbox.start(); // 恢复扫描 + 空闲停机定时器（优雅降级：无 Docker 仅 warn）
 * registerSandboxRoutes(app, { checker, manager: sandbox });
 * ```
 */
export * from './types.js';
export * from './docker.js';
export * from './manager.js';
