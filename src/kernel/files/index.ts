/**
 * 内核文件存储模块出口。
 * 使用方统一 `import { FileService, createLocalDriver } from '../files/index.js'`。
 */
export type { FileDriver, FileRecord } from './types.js';
export { createLocalDriver } from './drivers/local.js';
export { FileService } from './service.js';
export type { FileServiceDeps } from './service.js';
