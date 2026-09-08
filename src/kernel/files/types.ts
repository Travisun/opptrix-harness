/**
 * 文件存储模块契约：记录形状与驱动接口。
 *
 * - `FileRecord` 与 `files` 表（migration 012）一一对应，camelCase 由本模块边界负责映射；
 * - `FileDriver` 是存储后端抽象：内核只认 relPath（相对 driver root 的 POSIX 风格路径，
 *   如 `2026/09/<uuid>.txt`），不感知物理布局；换 S3/OSS 只需新 driver。
 */

/** `files` 表一行（camelCase 视图） */
export interface FileRecord {
  id: string;
  /** 上传来源扩展；null = 内核级上传 */
  extId: string | null;
  /** 原始文件名（已净化路径成分） */
  origName: string;
  /** MIME 类型；缺省 'application/octet-stream' */
  mime: string;
  /** 字节数 */
  size: number;
  /** 相对 driver root 的存储路径（POSIX 分隔符），driver root 内唯一 */
  path: string;
  /** private 仅 root/admin 可读（v1）；public 任意已认证用户可读 */
  visibility: 'private' | 'public';
  /** UTC epoch ms */
  createdAt: number;
}

/**
 * 存储驱动抽象：以 relPath 为键的字节桶。
 *
 * relPath 约定：POSIX 风格相对路径（不允许绝对路径、`..` 段、反斜杠、NUL），
 * 驱动实现必须在 root 内解析并拒绝越界（fail-closed）。
 */
export interface FileDriver {
  /** 驱动根目录（绝对路径） */
  root: string;
  /** 写入文件（缺失的父目录自动递归创建） */
  put(relPath: string, data: Buffer): Promise<void>;
  /** 读取文件内容；不存在时抛错（由驱动决定错误形状） */
  read(relPath: string): Promise<Buffer>;
  /** 删除文件；文件本就不存在返回 false，删除成功返回 true */
  delete(relPath: string): Promise<boolean>;
  /** 文件元信息；不存在返回 null */
  stat(relPath: string): Promise<{ size: number } | null>;
  /** 列出 root 下全部文件（POSIX 风格 relPath，升序）；prefix 给定时按前缀过滤 */
  list(prefix?: string): Promise<string[]>;
}
