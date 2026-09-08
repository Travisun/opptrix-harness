import type { AuthIdentity, AuthProvider, AuthVerifyInput } from './types.js';

/**
 * 认证提供方注册中心。按注册顺序依次尝试所有 provider，
 * 第一个返回非 null 身份的 provider 生效；全部拒绝则返回 null。
 */
export class AuthProviderRegistry {
  #providers: AuthProvider[] = [];

  /**
   * 注册 provider（保持注册顺序）。
   * 同名 provider 重复注册视为替换（后者覆盖前者，顺序位保留在首次注册处）。
   */
  register(p: AuthProvider): void {
    const idx = this.#providers.findIndex((x) => x.name === p.name);
    if (idx >= 0) {
      this.#providers[idx] = p;
      return;
    }
    this.#providers.push(p);
  }

  /** 注销 provider；名字不存在时静默返回 */
  unregister(name: string): void {
    const idx = this.#providers.findIndex((x) => x.name === name);
    if (idx >= 0) this.#providers.splice(idx, 1);
  }

  /** 当前已注册 provider 名单（按尝试顺序） */
  list(): string[] {
    return this.#providers.map((p) => p.name);
  }

  /**
   * 顺序尝试所有 provider，返回第一个非 null 身份；全部拒绝返回 null。
   * provider 抛出的异常原样向上传播（由调用方决定降级策略）。
   */
  async verify(input: AuthVerifyInput): Promise<AuthIdentity | null> {
    for (const p of this.#providers) {
      const identity = await p.verify(input);
      if (identity !== null) return identity;
    }
    return null;
  }
}
