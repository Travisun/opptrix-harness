import { useEffect, useState } from 'react';

import { api, getCachedUser, type MeResult } from '@/lib/api';

/**
 * useIdentity — 当前登录身份（面板内自取，不依赖顶栏缓存）。
 *
 * - 实时口径：GET /api/v1/auth/me（silent，失败回退 localStorage 'ui.user' 登录缓存）；
 * - isAdmin：role 'admin' | 'root'（与内核 requireAdmin 的放行口径一致）→
 *   决定「新建频道」入口显隐；/me 不可用且无缓存时 identity 为 null → 同样隐藏；
 * - 模块级缓存 + in-flight 去重：面板随 desktopOpen/mobileOpen 频繁挂卸，避免重复请求。
 */
export interface ChatIdentity {
  userId: string;
  username: string | null;
  role: string;
  isAdmin: boolean;
}

let cache: ChatIdentity | null = null;
let inflight: Promise<ChatIdentity | null> | null = null;

/** 登录缓存兜底（Login 写入 { id, username, role }） */
function fromCachedUser(): ChatIdentity | null {
  const user = getCachedUser();
  if (user === null) return null;
  const userId = user.userId ?? user.id ?? '';
  return {
    userId,
    username: user.username ?? null,
    role: user.role ?? '',
    isAdmin: user.role === 'admin' || user.role === 'root',
  };
}

async function fetchIdentity(): Promise<ChatIdentity | null> {
  try {
    const me = await api.get<MeResult>('/api/v1/auth/me', { silent: true });
    cache = {
      userId: me.userId,
      username: me.username,
      role: me.role,
      isAdmin: me.role === 'admin' || me.role === 'root',
    };
  } catch {
    // 403/401/网络失败：回退登录缓存（非 admin → 隐藏新建频道入口）
    cache = fromCachedUser();
  }
  return cache;
}

export function useIdentity(): ChatIdentity | null {
  const [identity, setIdentity] = useState<ChatIdentity | null>(() => cache ?? fromCachedUser());

  useEffect(() => {
    let alive = true;
    if (inflight === null) {
      const task = fetchIdentity();
      inflight = task;
      void task.then(() => {
        if (inflight === task) inflight = null;
      });
    }
    void inflight.then((value) => {
      if (alive) setIdentity(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return identity;
}
