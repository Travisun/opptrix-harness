import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Pagination — 全局分页条（shadcn 风格，客户端分页的配对组件）。
 *
 * 与页面侧「数据一次性拉取 + 前端切片」的客户端分页配套使用：
 *
 *   const [page, setPage] = useState(1);
 *   const pageSize = 20;
 *   const paged = data.slice((page - 1) * pageSize, page * pageSize);
 *   // 表格/列表渲染 paged，底部接：
 *   <Pagination page={page} pageSize={pageSize} total={data.length} onPageChange={setPage} />
 *
 * 结构：上一页 / 下一页按钮 + 页码显示（x / y）+ 总条数与每页条数说明。
 * 约定：total=0（无数据）时整条隐藏（空态由页面自身兜底）；page 超出页数范围时
 * 内部收敛到有效页展示（onPageChange 只在用户点击时回调，不会越界）。
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}): React.ReactNode {
  if (total <= 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return (
    <div
      data-slot="pagination"
      className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2', className)}
    >
      <p className="text-muted-foreground text-xs tabular-nums">
        共 {total} 条 · 每页 {pageSize} 条
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          aria-label="上一页"
          disabled={safePage <= 1}
          onClick={() => {
            onPageChange(safePage - 1);
          }}
        >
          <ChevronLeftIcon aria-hidden />
          上一页
        </Button>
        <span className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
          第 {safePage} / {totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          aria-label="下一页"
          disabled={safePage >= totalPages}
          onClick={() => {
            onPageChange(safePage + 1);
          }}
        >
          下一页
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
