/**
 * ServiceProvider — 服务提供者基类（Laravel 风格生命周期编排）。
 *
 * - register：只做容器绑定登记，不做任何有副作用的实际工作（可同步可异步）。
 * - boot：所有提供者的 register 都完成后才会被内核调用，此时可安全 resolve 依赖。
 * - stop：内核优雅关停时调用，逆序释放资源。
 *
 * boot/stop 默认空实现，子类按需覆写。
 */
import type { Container } from './Container.js';

export abstract class ServiceProvider {
  /** 注册阶段：仅向容器登记绑定（bind/singleton/instance/alias）。 */
  abstract register(c: Container): void | Promise<void>;

  /** 启动阶段：全部 register 完成后执行；默认空实现。 */
  async boot(c: Container): Promise<void> {}

  /** 关停阶段：内核优雅退出时执行；默认空实现。 */
  async stop(c: Container): Promise<void> {}
}
