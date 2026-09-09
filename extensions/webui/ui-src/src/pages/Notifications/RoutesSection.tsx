/**
 * RoutesSection — 默认渠道路由规则编辑节（通知中心「路由规则」Tab）。
 *
 * - GET /api/v1/notifications/routes  读取规则数组（settings 持久化）；
 * - PUT /api/v1/notifications/routes  保存（match.level + channels[driver + target JSON]；
 *   level 选「any」= 匹配全部级别；target 提交前做 JSON 校验，空串 → null）。
 * 命中规则的通知按规则的 channels 生成投递计划（显式传入优先，见 NotificationManager）。
 */
import { useCallback, useEffect, useState } from 'react';
import { PlusIcon, RefreshCwIcon, SaveIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText, parseJsonInput } from '@/pages/_shared';
import type { NotificationDrivers, NotificationRouteRule } from '@/pages/_shared';

/** 级别候选（'any' = 匹配全部级别） */
const LEVEL_OPTIONS = ['info', 'success', 'warning', 'error'] as const;

/** 驱动选择候选：drivers.notification + 已有规则中出现过的 driver（保证回显不丢项） */
function driverOptions(drivers: NotificationDrivers | null, rules: NotificationRouteRule[]): string[] {
  const set = new Set<string>(drivers?.notification ?? []);
  for (const rule of rules) for (const ch of rule.channels) if (ch.driver !== '') set.add(ch.driver);
  return [...set];
}

/** 规则行内渠道的编辑视图（target 以文本编辑，提交时解析 JSON） */
type RouteChannelDraft = { driver: string; target: unknown };

export default function RoutesSection({
  drivers,
}: {
  drivers: NotificationDrivers | null;
}): React.ReactNode {
  const [rules, setRules] = useState<NotificationRouteRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.get<unknown>('/api/v1/notifications/routes', { silent: true });
      setRules(Array.isArray(res) ? (res as NotificationRouteRule[]) : []);
    } catch {
      // 未配置过路由（部分实现返回 404/空）：按空规则数组处理
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    // 提交前对每条 target 做 JSON 校验（空串 → null）
    const normalized: NotificationRouteRule[] = [];
    for (const rule of rules) {
      const channels: Array<{ driver: string; target: unknown }> = [];
      for (const ch of rule.channels as RouteChannelDraft[]) {
        if (ch.driver.trim() === '') {
          toast.error('请为每个渠道选择 driver');
          return;
        }
        const parsed = parseJsonInput(typeof ch.target === 'string' ? (ch.target as string) : '');
        if (!parsed.ok) {
          toast.error('target 不是合法 JSON', parsed.message);
          return;
        }
        channels.push({ driver: ch.driver.trim(), target: parsed.value ?? null });
      }
      if (channels.length === 0) {
        toast.error('每条规则至少需要一个投递渠道');
        return;
      }
      normalized.push({ match: { level: rule.match.level ?? 'any' }, channels });
    }
    setSaving(true);
    try {
      await api.put('/api/v1/notifications/routes', normalized);
      toast.success('路由规则已保存');
    } catch (e) {
      toast.error('保存失败', errText(e));
    } finally {
      setSaving(false);
    }
  }, [rules]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          按级别匹配将通知投递到渠道；未命中任何规则的通知只进站内收件箱。
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={saving}>
            <RefreshCwIcon aria-hidden />
            重新读取
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            <SaveIcon aria-hidden />
            {saving ? '保存中…' : '保存规则'}
          </Button>
        </div>
      </div>

      {rules.length === 0 && (
        <Card>
          <CardContent className="text-muted-foreground px-4 py-4 text-sm">
            尚未配置路由规则——所有通知只进站内收件箱。
          </CardContent>
        </Card>
      )}

      {rules.map((rule, ri) => (
        <Card key={ri} className={cn('gap-2 py-3')}>
          <CardContent className="flex flex-col gap-2.5 px-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">规则 {ri + 1}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                title="删除规则"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setRules((prev) => prev.filter((_, i) => i !== ri))}
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Label className="w-24 shrink-0 text-xs">匹配级别</Label>
              <Select
                value={rule.match.level ?? 'any'}
                onValueChange={(v) =>
                  setRules((prev) => prev.map((r, i) => (i === ri ? { ...r, match: { level: v } } : r)))
                }
              >
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">any（全部）</SelectItem>
                  {LEVEL_OPTIONS.map((lv) => (
                    <SelectItem key={lv} value={lv}>
                      {lv}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(rule.channels as RouteChannelDraft[]).map((ch, ci) => (
              <div key={ci} className="rounded border border-dashed p-2.5">
                <div className="flex items-center gap-2">
                  <Label className="w-24 shrink-0 text-xs">渠道 driver</Label>
                  <Select
                    value={ch.driver}
                    onValueChange={(v) =>
                      setRules((prev) =>
                        prev.map((r, i) =>
                          i === ri
                            ? { ...r, channels: r.channels.map((c, j) => (j === ci ? { ...c, driver: v } : c)) }
                            : r,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue placeholder="选择 driver" />
                    </SelectTrigger>
                    <SelectContent>
                      {driverOptions(drivers, rules).map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title="删除渠道"
                    className="text-destructive ml-auto hover:bg-destructive/10 hover:text-destructive"
                    onClick={() =>
                      setRules((prev) =>
                        prev.map((r, i) => (i === ri ? { ...r, channels: r.channels.filter((_, j) => j !== ci) } : r)),
                      )
                    }
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  <Label className="text-muted-foreground text-xs">target（JSON，可为空）</Label>
                  <Textarea
                    value={
                      typeof ch.target === 'string'
                        ? (ch.target as string)
                        : ch.target === null || ch.target === undefined
                          ? ''
                          : JSON.stringify(ch.target, null, 2)
                    }
                    onChange={(e) =>
                      setRules((prev) =>
                        prev.map((r, i) =>
                          i === ri
                            ? { ...r, channels: r.channels.map((c, j) => (j === ci ? { ...c, target: e.target.value } : c)) }
                            : r,
                        ),
                      )
                    }
                    placeholder="{}"
                    className="min-h-14 font-mono text-xs"
                    disabled={saving}
                  />
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              disabled={saving}
              onClick={() =>
                setRules((prev) =>
                  prev.map((r, i) => (i === ri ? { ...r, channels: [...r.channels, { driver: '', target: '' }] } : r)),
                )
              }
            >
              <PlusIcon aria-hidden />
              添加渠道
            </Button>
          </CardContent>
        </Card>
      ))}

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={saving}
        onClick={() => setRules((prev) => [...prev, { match: { level: 'any' }, channels: [{ driver: '', target: '' }] }])}
      >
        <PlusIcon aria-hidden />
        添加规则
      </Button>
    </div>
  );
}
