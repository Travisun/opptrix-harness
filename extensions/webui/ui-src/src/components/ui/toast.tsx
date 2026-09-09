import * as React from 'react';
import { AlertCircleIcon, CheckCircle2Icon, InfoIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * toast — 轻量自研通知（context + 模块级事件总线）。
 *
 * - `toast.success/info/error(...)` 全局函数：非组件环境（如 lib/api.ts）可直接调用；
 * - `<ToastProvider>`：挂载视口，订阅事件总线渲染队列（最多同屏 5 条，自动过期）。
 * 刻意不引 sonner/radix-toast：本管理台只需要右下角堆叠的轻提示。
 */

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** 展示时长毫秒；默认 4000 */
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  leaving?: boolean;
}

type Listener = (items: ToastItem[]) => void;

const MAX_VISIBLE = 5;
const DEFAULT_TTL = 4000;
const LEAVE_ANIMATION_MS = 150;

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const fn of listeners) fn([...items]);
}

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  // 先标记离场（播放退出过渡），再真正移除
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, LEAVE_ANIMATION_MS);
}

function push(options: ToastOptions): number {
  const id = ++seq;
  const ttl = options.durationMs ?? DEFAULT_TTL;
  items = [...items.slice(-(MAX_VISIBLE - 1)), { ...options, id }];
  emit();
  timers.set(
    id,
    setTimeout(() => dismiss(id), ttl),
  );
  return id;
}

export const toast = {
  info: (title: string, description?: string): number => push({ title, description, variant: 'info' }),
  success: (title: string, description?: string): number => push({ title, description, variant: 'success' }),
  error: (title: string, description?: string): number => push({ title, description, variant: 'error' }),
  dismiss,
};

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof InfoIcon; ring: string; iconColor: string }> = {
  info: { icon: InfoIcon, ring: 'border-border', iconColor: 'text-foreground' },
  success: { icon: CheckCircle2Icon, ring: 'border-emerald-600/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
  error: { icon: AlertCircleIcon, ring: 'border-destructive/40', iconColor: 'text-destructive' },
};

export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const [queue, setQueue] = React.useState<ToastItem[]>(items);

  React.useEffect(() => {
    listeners.add(setQueue);
    setQueue([...items]); // 同步已积压（Provider 挂载前发出的）toast
    return () => {
      listeners.delete(setQueue);
    };
  }, []);

  return (
    <>
      {children}
      <div
        aria-live="polite"
        aria-label="通知提示"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {queue.map((item) => {
          const style = VARIANT_STYLES[item.variant ?? 'info'];
          const Icon = style.icon;
          return (
            <div
              key={item.id}
              role="status"
              className={cn(
                'bg-popover text-popover-foreground pointer-events-auto flex w-full items-start gap-3 rounded-lg border p-4 shadow-lg transition-all duration-150',
                style.ring,
                item.leaving === true ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100',
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', style.iconColor)} aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="text-sm leading-snug font-medium break-words">{item.title}</p>
                {item.description !== undefined && (
                  <p className="text-muted-foreground text-xs leading-relaxed break-words">{item.description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => dismiss(item.id)}
                className="text-muted-foreground/70 hover:text-foreground -mt-0.5 shrink-0 rounded p-0.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
