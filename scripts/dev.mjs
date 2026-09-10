/**
 * scripts/dev — 本地开发编排器（npm run dev 的入口）。
 *
 * 同时起两个进程并在其输出行加前缀：
 * 1. [server] tsx watch src/main.ts —— 监听 src 目录全部源码（tsx 对已加载模块的默认监听），
 *    并经 --include 附加监听 extensions 目录：扩展源码变更同样触发内核重启
 *    （扩展跑在 worker_threads，tsx 无法自动追踪 worker 内动态加载的模块，故须显式 include）；
 * 2. [webui]  vite build --watch（cwd=extensions/webui/ui-src）—— ui-src 变更即重建
 *    extensions/webui/ui/（vite outDir），浏览器刷新即见新 UI（产物文件名带 hash，
 *    index.html 由 assets.ts 对 html 下发 no-cache，重编译后不会命中旧壳缓存）。
 *
 * 信号：SIGINT/SIGTERM 转发两个子进程后退出；任一子进程退出则终止另一个
 * （避免 tsx 崩溃后只剩无服务的 vite watcher 造成"在改代码但服务已死"的错觉）。
 *
 * 零依赖：与 scripts/release*.mjs 同款约定，不引入 concurrently 等运行器。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const UI_SRC_DIR = new URL('../extensions/webui/ui-src', import.meta.url).pathname;

/** 带行前缀起子进程：stdout/stderr 逐行加 [tag]，继承父进程 stdin/环境 */
function prefixed(tag, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const pipe = (stream, out) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => out.write(`[${tag}] ${line}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

const children = [];

/** 任一子进程退出 → 杀掉另一个（防半死状态）；正常收尾不递归 */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

children.push(
  prefixed('server', 'npx', ['tsx', 'watch', '--include', 'extensions/**/*', '--clear-screen=false', 'src/main.ts']),
);
children.push(prefixed('webui', 'npx', ['vite', 'build', '--watch', '--clearScreen', 'false'], { cwd: UI_SRC_DIR }));

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // tsx watch 对应用崩溃会自动重启（进程不退）；进程真正退出 = 编排层面故障
    process.stderr.write(`[dev] 子进程退出（code=${code} signal=${signal}），整体收尾\n`);
    shutdown();
  });
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});
