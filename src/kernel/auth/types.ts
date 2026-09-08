/**
 * 内核认证抽象：身份、角色、provider 契约。
 * 内核零领域语义——这里只定义"谁能进来"，不定义"能做什么"（scope 判定由调用方负责）。
 */

/** 内置角色层级：root > admin > normal */
export type AuthRole = 'root' | 'admin' | 'normal';

export interface AuthIdentity {
  userId: string;
  role: AuthRole;
  /** scope 列表；'*' 表示全部 scope */
  scopes: string[];
}

/** provider / checker 的统一验证入参 */
export interface AuthVerifyInput {
  /** 从请求提取出的令牌（如 Bearer token / query.token），可能缺失 */
  token?: string;
  /** 原始请求头（小写键），provider 可自行提取其他凭据 */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * 认证提供方。verify 返回 null 表示"本 provider 不认识该凭据"，
 * registry 会继续尝试下一个；抛错表示 provider 自身故障（向上传播）。
 */
export interface AuthProvider {
  name: string;
  verify(input: AuthVerifyInput): Promise<AuthIdentity | null>;
}
