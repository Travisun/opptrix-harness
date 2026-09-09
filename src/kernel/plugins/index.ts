/**
 * plugins — 插件包（Plugin Package）机制出口。
 *
 * 生命周期：installPluginZip / installPluginDir（安装）→ PluginRegistry.refresh
 * （发现聚合 + 贡献注入）→ list/get（查询）→ runScript（沙箱脚本）→ remove（卸载）。
 * 扩展线程 RPC 经 createPluginsBridge（plugins.list 已接线，其余 NOT_IMPLEMENTED 形状）。
 *
 * 持久与升级语义：插件装在 `<dataDir>/plugins/`，内核 A/B 升级只换 releases/slot、
 * 绝不触碰该目录；升级后再次 refresh() 即重建聚合与注入。
 */
export {
  PLUGIN_ID_PATTERN,
  PLUGIN_NESTED_ID_PATTERN,
  PLUGIN_LIMITS,
  isSafePluginRelativePath,
  pluginManifestSchema,
  toInstalledPlugin,
  validatePluginManifest,
} from './types.js';
export type {
  InstalledPlugin,
  McpRegistryLike,
  PluginContributedSkill,
  PluginManifest,
  PluginMcpServerConfig,
  PluginMcpServerSpec,
  PluginPromptSpec,
  PluginScriptSpec,
  PluginSkillSpec,
  ScriptRunnerLike,
  SkillsRegistryLike,
} from './types.js';

export { installPluginDir, installPluginZip, type PluginInstallConfig, type PluginInstallOptions } from './installer.js';

export {
  PLUGIN_BRIDGE_TOPICS,
  PluginRegistry,
  createPluginsBridge,
  type PluginBridgeHandlers,
  type PluginRegistryDeps,
} from './registry.js';
