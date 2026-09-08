/**
 * unzipper 的最小环境类型声明（该包无官方 types，@types/unzipper 未安装）。
 *
 * 仅声明本项目用到的 API 面：`Open.file(path)` / `Open.buffer(data)` 打开一个 zip，
 * 返回条目清单（含目录条目）；每个文件条目可 `buffer()` 解出完整内容。
 * 用途：src/kernel/plugins/installer.ts 的插件包解包（Package-First：unzipper 已登记
 * docs/dependencies.md）。若后续引入 @types/unzipper，可删除本文件。
 */
declare module 'unzipper' {
  /** zip 内单个条目（目录条目 path 以 '/' 结尾、type='Directory'） */
  export interface UnzipEntry {
    path: string;
    type: 'File' | 'Directory';
    /** 解压并返回条目完整内容 */
    buffer(): Promise<Buffer>;
  }

  /** 已打开的 zip 归档 */
  export interface UnzipArchive {
    files: UnzipEntry[];
  }

  const unzipper: {
    Open: {
      /** 从磁盘文件打开 zip */
      file(path: string): Promise<UnzipArchive>;
      /** 从内存 Buffer 打开 zip */
      buffer(data: Buffer): Promise<UnzipArchive>;
    };
  };

  export default unzipper;
}
