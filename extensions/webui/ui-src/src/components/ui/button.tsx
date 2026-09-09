import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * vendored from shadcn/ui (MIT) — button
 *
 * 尺寸/阴影走主题令牌（styles.css :root 缺省 = 本 vendored 版像素，theme.tsx 运行期覆盖）：
 * - h-(--ui-ctl-h)=36px / px-(--ui-ctl-px)=16px / py-(--ui-ctl-py)=8px（default 档与原
 *   h-9/px-4/py-2 逐像素一致）；sm/lg/icon 档以 calc 相对令牌派生（-4px/+4px 等）；
 * - 控件微阴影 shadow-[var(--ui-shadow-ctl)] 缺省 = 原 xs 档微阴影（0 1px 2px 0 rgb(0 0 0 / 5%)）。
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[var(--ui-shadow-ctl)] hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground shadow-[var(--ui-shadow-ctl)] hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-[var(--ui-shadow-ctl)] hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground shadow-[var(--ui-shadow-ctl)] hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        // default 档：h-(--ui-ctl-h)=36px(px-4=16px/py-2=8px) 与原 h-9/px-4/py-2 一致
        default: 'h-(--ui-ctl-h) px-(--ui-ctl-px) py-(--ui-ctl-py) has-[>svg]:px-[calc(var(--ui-ctl-px)-4px)]',
        // sm 档：32px/12px 与原 h-8/px-3 一致
        sm: 'h-[calc(var(--ui-ctl-h)-4px)] rounded-md gap-1.5 px-[calc(var(--ui-ctl-px)-4px)] has-[>svg]:px-[calc(var(--ui-ctl-px)-6px)]',
        // lg 档：40px/24px 与原 h-10/px-6 一致
        lg: 'h-[calc(var(--ui-ctl-h)+4px)] rounded-md px-[calc(var(--ui-ctl-px)+8px)] has-[>svg]:px-(--ui-ctl-px)',
        // icon 档：36px/32px 与原 size-9/size-8 一致
        icon: 'size-(--ui-ctl-h)',
        'icon-sm': 'size-[calc(var(--ui-ctl-h)-4px)]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
