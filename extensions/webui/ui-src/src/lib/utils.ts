import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui 类名合并（clsx 条件拼接 + tailwind-merge 冲突消解） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
