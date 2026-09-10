/**
 * net/dispatcher — 进程级出站网络基线（零依赖，无全局 dispatcher 替换）。
 *
 * 为什么只做 DNS 序：家宽/机房常见「IPv6 路由不通」的双栈环境里，undici 对双栈域名
 * 按 DNS 返回序连接，首个地址为 IPv6 时 SYN 挂死直至超时（curl 因 happy-eyeballs 快速
 * 回退反而正常）。`dns.setDefaultResultOrder('ipv4first')` 让解析序 IPv4 优先，IPv6
 * 正常的环境不受影响（IPv4 亦可达）；这是 Node 原生 API，不替换全局 dispatcher——
 * 曾试验 npm undici 的 setGlobalDispatcher（autoSelectFamily Agent），实测与 tsx 运行
 * 时下的 OpenAI SDK fetch 路径存在兼容性问题（请求异常失败），已弃用。
 *
 * 代理：undici 的 global fetch 默认不读 HTTP(S)_PROXY 环境变量。需要代理出网的部署
 * 以 NODE_USE_ENV_PROXY=1 启动（Node 原生支持，无第三方依赖），不做进程内接管。
 *
 * 线程语义：dns 默认序是 node:dns 模块级状态（per-thread）。LLM 适配器、文件提取、
 * ASR、浏览器引擎等出站调用均在主线程；worker 内扩展出站一律经桥回主线程（架构保证），
 * 故主线程设置一次即可。
 */
import dns from 'node:dns';

let installed = false;

/** 安装出站网络基线（幂等；必须在任何出站 fetch 之前——main.ts 进程入口处） */
export function installNetworkDispatcher(): void {
  if (installed) return;
  installed = true;
  dns.setDefaultResultOrder('ipv4first');
}

/** 供测试探针读取安装状态 */
export function isNetworkDispatcherInstalled(): boolean {
  return installed;
}

/** 仅测试用：重置幂等闩 */
export function resetNetworkDispatcherForTest(): void {
  installed = false;
}
