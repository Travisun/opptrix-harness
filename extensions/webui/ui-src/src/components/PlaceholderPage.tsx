import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { NavItem } from '@/lib/nav';

/**
 * PlaceholderPage — 未实现页面的统一空态。
 *
 * 壳层（本包）把全部路由一次注册到位；W2/W3/W4 页面包按 NAV_GROUPS 里的批次标注
 * 逐页替换实现。占位页渲染「组件名 + 后续批次实现」空态，禁止白屏。
 */
export function PlaceholderPage({ item }: { item: NavItem }): React.ReactNode {
  const Icon = item.icon;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{item.title}</h2>
        <p className="text-muted-foreground text-sm">{item.description}</p>
      </div>
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-full">
            <Icon className="size-7" aria-hidden />
          </div>
          <p className="text-base font-medium">{item.title}</p>
          <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
            页面骨架已就绪，内容与交互由「{item.batch}」批次填充实现。
          </p>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">后续批次实现</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">
              {item.path}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
