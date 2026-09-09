/**
 * 进程入口（Entry point）。
 *
 * 职责仅限：加载 .env → 构造 Kernel → 注册进程级信号/异常处理器 → boot。
 * 业务/扩展的装配请通过 ServiceProvider + kernel.useProvider() 完成，不要写在此文件。
 *
 * 【全仓库唯一例外】本文件允许 console.error 兜底：仅用于 Kernel/logger 尚未就绪
 * （new Kernel() 构造阶段抛错，pino 实例还不存在）时的最后输出通道；
 * Kernel 构造完成之后一律使用 kernel logger（pino），见 logError()。
 */
import { CONTAINER_KEYS, Kernel } from './kernel/Kernel.js';
import { loadDotenv } from './kernel/config/index.js';

/** 仅限 logger 未就绪期的兜底输出（见文件头注释的唯一例外说明） */
function fallbackError(message: string, e: unknown): void {
  console.error(`[main] ${message}:`, e);
}

async function main(): Promise<void> {
  await loadDotenv();

  let kernel: Kernel;
  try {
    kernel = new Kernel();
  } catch (e) {
    // 构造失败（如配置校验不通过）：pino logger 尚未创建，允许 console.error 兜底
    fallbackError('kernel construction failed', e);
    process.exit(1);
  }

  const logError = (message: string, e: unknown): void => {
    try {
      kernel.getLogger().error({ err: e }, message);
    } catch {
      // logger 自身故障时才走兜底（唯一例外）
      fallbackError(message, e);
    }
  };

  // 信号处理只允许出现在 main.ts：内核保持无信号副作用，可嵌入任意宿主。
  // 信号触发的优雅停机完成后确定性退出（exit 0）：第三方库可能残留未 unref 的
  // keep-alive 句柄，依赖「事件循环自然清空」会让容器编排器等待超时。
  const shutdownAndExit = (signal: string) => {
    void kernel
      .handleSignal(signal)
      .catch((e) => logError(`shutdown after ${signal} failed`, e))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdownAndExit('SIGTERM'));
  process.on('SIGINT', () => shutdownAndExit('SIGINT'));

  // 未捕获的 Promise 拒绝：仅记录，不崩进程
  process.on('unhandledRejection', (reason) => {
    logError('unhandledRejection (process keeps running)', reason);
  });

  // 未捕获异常：记录 + 尝试优雅关停后继续运行（按约定不崩进程）
  process.on('uncaughtException', (e) => {
    logError('uncaughtException (graceful shutdown attempted, process keeps running)', e);
    void kernel
      .shutdown(`uncaughtException: ${e instanceof Error ? e.message : String(e)}`)
      .catch((shutdownErr) => logError('shutdown after uncaughtException failed', shutdownErr));
  });

  try {
    await kernel.boot();
  } catch (e) {
    logError('kernel boot failed', e);
    process.exit(1);
  }
  printWelcomeBanner(kernel);
}

/** 首启人读横幅：管理台地址 / 账号 / 凭据位置（人类可读，不经 pino JSON） */
function printWelcomeBanner(kernel: Kernel): void {
  const config = kernel.getConfig();
  const auth = kernel.container.has(CONTAINER_KEYS.authIdentity)
    ? (kernel.container.resolve<import('./kernel/auth/types.js').AuthIdentity>(CONTAINER_KEYS.authIdentity) as unknown as {
        token: string;
        source: string;
      })
    : null;
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const line = '─'.repeat(64);
  const credLine =
    auth?.source === 'env'
      ? `  密码     HARNESS_TOKEN 环境变量值（自定义 root 令牌）`
      : `  初始密码  文件 ${config.dataDir}/root-token 的内容（cat 即可查看）`;
  const out = [
    '',
    line,
    `  ✅ Opptrix Harness OS 已就绪（${config.env}）`,
    line,
    `  管理台   http://${host}:${config.port}/admin`,
    `  账号     owner`,
    credLine,
    `  API      http://${host}:${config.port}/api/v1 （Bearer ${config.dataDir}/root-token 内容）`,
    `  数据目录  ${config.dataDir}`,
    line,
    '',
  ].join('\n');
  // 面向运维的人类可读输出：pino JSON 对首启指引不友好（文档化例外，同 fallbackError）
  process.stdout.write(out + '\n');
}

main().catch((e) => {
  // Kernel/logger 尚未就绪阶段的致命错误：允许 console.error 兜底（唯一例外）
  fallbackError('fatal error before kernel initialization completed', e);
  process.exit(1);
});
