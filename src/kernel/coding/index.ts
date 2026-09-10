/**
 * coding — 沙箱化代码执行会话模块桶导出（types / CodingEngine / 扩展桥）。
 *
 * 选型说明：引擎走**受控子进程路径**（非 Docker）。内核 SandboxManager 为
 * Docker 门禁能力（SANDBOX_DISABLED 语义 + 扩展桥 SEC-4 把 workspaceId 钉死为
 * `ext-<extId>`，无法表达多会话），而 coding 工具面要求任意开发机开箱可用、
 * 每会话独立工作目录——故按会话目录（`<dataDir>/coding-workspaces/<sessionId>/`）
 * + 白名单 + argv 直传的受控子进程实现；强隔离仍由 SandboxManager 承担。
 *
 * 典型组装（providers/core-services.ts）：
 * ```ts
 * const engine = new CodingEngine({ dataDir: config.dataDir, logger });
 * kernel.container.instance(CONTAINER_KEYS.coding, engine);
 * // 桥并入 ext.bridges：
 * ...createCodingBridge({ engine, requirePermission })
 * ```
 */
export * from './types.js';
export * from './engine.js';
export * from './bridge.js';
