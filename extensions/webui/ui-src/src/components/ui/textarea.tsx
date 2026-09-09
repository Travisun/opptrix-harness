import * as React from 'react';

import { cn } from '@/lib/utils';

/** vendored from shadcn/ui (MIT) — textarea（px/py/阴影走主题令牌，缺省 = 原 px-3/py-2/shadow-xs） */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-[calc(var(--ui-ctl-px)-4px)] py-(--ui-ctl-py) text-base shadow-[var(--ui-shadow-ctl)] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
