import * as React from 'react';

import { cn } from '@/lib/utils';

/** vendored from shadcn/ui (MIT) — skeleton */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-accent animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
