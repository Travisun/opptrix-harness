/**
 * 全局测试环境约束：
 * - 关闭 ASR 模型后台静默下载（integration 套件 afterAll 的 rm -rf dataDir
 *   会与持续写入的模型下载竞态 → ENOTEMPTY unhandled errors）；
 *   需要真模型的用例（OCR/asr E2E）自行注入 mock 或显式开启。
 * - 固定测试时区无关性不在此处理（各用例自行控制）。
 */
process.env.HARNESS_ASR_AUTO_DOWNLOAD = '0';
process.env.HARNESS_OCR_AUTO_DOWNLOAD = '0';
