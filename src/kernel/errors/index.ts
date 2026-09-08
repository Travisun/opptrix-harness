/**
 * 内核错误模块出口。
 * 使用方统一 `import { HarnessError, err, ERR_CODES } from '../errors/index.js'`。
 */
export { HarnessError, err } from './HarnessError.js';
export { ERR_CODES } from './codes.js';
export type { ErrorDomain, ErrorCodeDef, ErrorCodeName } from './codes.js';
