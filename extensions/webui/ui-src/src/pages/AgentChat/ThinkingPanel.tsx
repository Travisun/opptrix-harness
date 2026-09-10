import { useEffect, useRef, useState } from 'react';
import { BrainIcon, CheckIcon, ChevronDownIcon, Loader2Icon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ChatStreamSnapshot, ChatStreamToolStep } from '@/pages/AgentChat/chatStream';

/**
 * ThinkingPanel — Chat 流式过程可视化（借鉴 Opptrix ChatProcessTrace / ChatReplyDraftPreview /
 * reasoningTimeline 的结构，落地到 shadcn 主题令牌）：
 *
 * - 状态头：`模型正在思考…`（动画三点；reply 阶段切「正在生成回复…」，error 显示错误）；
 * - 思考分段灰字区：thinkingSegments 竖向时间线（段号 + 灰字），maxHeight 限制 + 自动滚底；
 * - 工具步骤卡片：label（中文）+ argsPreview 摘要 + running spinner / done ✓ / error ✗ +
 *   resultPreview 行内；
 * - 回复草稿预览：replyDraft 纯文本 5 行高预览（上下渐隐 mask + 自动滚底），流式期间不做
 *   Markdown 重解析（done 后由 MessageBubble 整段渲染）。
 *
 * 另导出 ReasoningTimeline（历史消息复用）：assistant 消息带 reasoningSegments 时渲染
 * 「查看思考过程（N 段）」折叠条，默认收起，展开为段号 + 灰字的竖轴时间线。
 */

/** 思考分段灰字区最大高度（约 6 行，超出内部滚动） */
const THINKING_MAX_HEIGHT_PX = 144;
/** 回复草稿预览行高 × 可见行数（5 行高，上下渐隐 mask） */
const DRAFT_LINE_HEIGHT_PX = 20;
const DRAFT_VISIBLE_LINES = 5;

/** 动画三点（状态头；prefers-reduced-motion 下静止为常显省略号） */
function ThinkingDots(): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden data-slot="thinking-dots">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-current size-1 animate-bounce rounded-full"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: '1s' }}
        />
      ))}
    </span>
  );
}

/** 单个工具步骤卡片：状态图标 + label + argsPreview 摘要 + resultPreview 行内 */
function ToolStepCard({ step }: { step: ChatStreamToolStep }): React.ReactNode {
  const running = step.status === 'running';
  const argsPreview = step.argsPreview?.trim() ?? '';
  const secondary = [argsPreview, step.error?.trim() ?? ''].filter(Boolean).join(' · ');
  return (
    <div
      className="bg-background/60 rounded-md border border-border/60 px-2 py-1.5"
      data-slot="tool-step"
      data-status={step.status}
    >
      <div className="flex items-center gap-1.5 text-xs">
        {running ? (
          <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : step.status === 'done' ? (
          <CheckIcon className="size-3.5 shrink-0 text-emerald-500" aria-label="已完成" />
        ) : (
          <XIcon className="text-destructive size-3.5 shrink-0" aria-label="执行出错" />
        )}
        <span
          className={cn(
            'min-w-0 truncate font-medium',
            running && 'text-foreground',
            step.status === 'error' && 'text-destructive',
            step.status === 'done' && 'text-muted-foreground',
          )}
          title={step.label}
        >
          {step.label === '' ? step.tool : step.label}
          {running ? '…' : ''}
        </span>
      </div>
      {secondary !== '' && (
        <div className="text-muted-foreground mt-0.5 truncate text-[11px]" title={secondary}>
          {secondary}
        </div>
      )}
      {!running && step.resultPreview !== undefined && step.resultPreview.trim() !== '' && (
        <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px] break-all" title={step.resultPreview}>
          {step.resultPreview}
        </div>
      )}
    </div>
  );
}

/** 流式过程面板（stream 非 null 时挂在消息流尾部） */
export function ThinkingPanel({ snapshot }: { snapshot: ChatStreamSnapshot }): React.ReactNode {
  const thinkingRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLDivElement | null>(null);

  // 思考分段/草稿更新 → 自动滚底（展示最新增量）
  useEffect(() => {
    const el = thinkingRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [snapshot.thinkingSegments]);
  useEffect(() => {
    const el = draftRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [snapshot.replyDraft]);

  const statusLabel =
    snapshot.phase === 'replying'
      ? '正在生成回复'
      : snapshot.phase === 'error'
        ? '生成失败'
        : '模型正在思考';
  const visibleSegments = snapshot.thinkingSegments.filter((s) => s.trim() !== '');

  return (
    <div
      className="max-w-[78%] space-y-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2"
      data-slot="thinking-panel"
      data-phase={snapshot.phase}
      aria-live="polite"
      aria-label="生成过程"
    >
      {/* 状态头 */}
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs" data-slot="thinking-status">
        <BrainIcon className="size-3.5 shrink-0" aria-hidden />
        <span className={cn(snapshot.phase === 'error' && 'text-destructive')}>{statusLabel}</span>
        {(snapshot.phase === 'thinking' || snapshot.phase === 'connecting' || snapshot.phase === 'replying') && (
          <ThinkingDots />
        )}
      </div>

      {/* 思考分段灰字区（竖轴时间线；maxHeight 限制 + 自动滚底） */}
      {visibleSegments.length > 0 && (
        <div
          ref={thinkingRef}
          className="border-border/60 max-h-36 space-y-1.5 overflow-y-auto border-l pl-2.5"
          style={{ maxHeight: `${THINKING_MAX_HEIGHT_PX}px` }}
          data-slot="thinking-segments"
        >
          {visibleSegments.map((seg, i) => (
            <div key={i}>
              {visibleSegments.length > 1 && (
                <div className="text-muted-foreground/70 text-[10px] select-none">第 {i + 1} 段</div>
              )}
              <p className="text-muted-foreground text-xs leading-relaxed break-words whitespace-pre-wrap">{seg}</p>
            </div>
          ))}
        </div>
      )}

      {/* 工具步骤卡片（实时状态机：running → done | error） */}
      {snapshot.toolSteps.length > 0 && (
        <div className="space-y-1.5" data-slot="tool-steps">
          {snapshot.toolSteps.map((step) => (
            <ToolStepCard key={step.id} step={step} />
          ))}
        </div>
      )}

      {/* 回复草稿 5 行预览（纯文本 + 上下渐隐 mask + 自动滚底） */}
      {snapshot.replyDraft !== '' && (
        <div
          ref={draftRef}
          className="overflow-hidden"
          style={{
            height: `${DRAFT_LINE_HEIGHT_PX * DRAFT_VISIBLE_LINES}px`,
            maskImage:
              'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 7px), transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 7px), transparent 100%)',
          }}
          data-slot="reply-draft"
          aria-label="正在生成的回复预览"
        >
          <p className="text-muted-foreground text-xs leading-5 break-words whitespace-pre-wrap">
            {snapshot.replyDraft}
          </p>
        </div>
      )}
    </div>
  );
}

/** 历史消息的思考过程折叠条（默认收起；展开为段号 + 灰字竖轴时间线） */
export function ReasoningTimeline({ segments }: { segments: string[] }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const visible = segments.filter((s) => s.trim() !== '');
  if (visible.length === 0) return null;
  return (
    <div className="mt-1.5" data-slot="reasoning-timeline">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-xs select-none"
        aria-expanded={open}
        data-slot="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <BrainIcon className="size-3.5" aria-hidden />
        查看思考过程（{visible.length} 段）
        <ChevronDownIcon className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
      </button>
      {open && (
        <ol className="border-border/70 mt-1.5 space-y-2 border-l pl-3" data-slot="reasoning-list">
          {visible.map((seg, i) => (
            <li key={i} className="relative">
              <span className="bg-border absolute top-1.5 -left-[15px] size-1.5 rounded-full" aria-hidden />
              <div className="text-muted-foreground/70 text-[10px] select-none">第 {i + 1} 段</div>
              <p className="text-muted-foreground text-xs leading-relaxed break-words whitespace-pre-wrap">{seg}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
