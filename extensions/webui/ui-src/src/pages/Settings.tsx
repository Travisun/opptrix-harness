import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleArrowUpIcon,
  DatabaseIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  SunIcon,
  Trash2Icon,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { api, type SystemInfo } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  ACCENT_PRESETS,
  RADIUS_STEPS,
  useTheme,
  type Density,
  type ThemeMode,
} from '@/lib/theme';
import {
  errText,
  formatBytes,
  formatUptime,
  LLM_PROTOCOLS,
  maskSecret,
  parseCsv,
  type BackupResult,
  type LlmModelAggregate,
  type LlmProviderConfig,
} from '@/pages/_shared';
import { EmptyState } from '@/pages/_shared';

/**
 * Settings — 设置（三节 Tabs）。
 *
 * - 「外观」：主题定制器（useTheme 全能力产品化）——模式三态卡（浅色/深色/跟随系统）、
 *   强调色预设色板圆点（7 组，选中高亮）、圆角五档分段控件、密度切换（舒适/紧凑）、
 *   自定义 --* 变量覆盖编辑器（增删改实时生效）；「恢复默认」需确认（resetToDefaults
 *   + 兜底清理 localStorage ui.tokens/ui.mode）。全部即时生效、无需保存，
 *   持久化由 ThemeProvider（localStorage ui.*）负责。
 * - 「LLM 供应商」：GET /api/v1/llm/providers 卡片列表（name/protocol/baseUrl/models/
 *   apiKeySecretRef 脱敏）；编辑 Dialog（name/protocol 三值/baseUrl/apiKeySecretRef/
 *   apiKey 明文（仅写入，保存后不可再查看）/models 逗号分隔/paramAllowlist 逗号分隔/
 *   timeoutMs）→ PUT 全量保存；删除供应商 = 从数组移除后再 PUT；
 *   GET /api/v1/llm/models 聚合展示。
 * - 「系统」：GET /api/v1/system/info 只读键值快照；POST /api/v1/system/backup
 *   （confirm → 成功 toast 展示产物路径）；「前往升级」链接。
 */

// ---------------------------------------------------------------------------
// 外观
// ---------------------------------------------------------------------------

/** 模式三态卡数据 */
const MODE_OPTIONS: Array<{ value: ThemeMode; label: string; hint: string; icon: LucideIcon }> = [
  { value: 'light', label: '浅色', hint: '亮色界面', icon: SunIcon },
  { value: 'dark', label: '深色', hint: '暗色界面', icon: MoonIcon },
  { value: 'system', label: '跟随系统', hint: '随系统偏好', icon: MonitorIcon },
];

const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
];

/** 自定义覆盖编辑器的行状态（id 供 React key / 行定位） */
interface TokenRow {
  id: number;
  name: string;
  value: string;
}

let tokenRowSeq = 0;

function AppearanceTab(): React.ReactNode {
  const theme = useTheme();
  const [rows, setRows] = useState<TokenRow[]>(() =>
    Object.entries(theme.customTokens).map(([name, value]) => ({
      id: ++tokenRowSeq,
      name,
      value,
    })),
  );
  const [resetOpen, setResetOpen] = useState(false);

  /** 提交单行到主题：合法变量名 + 非空值 → 覆盖；否则删除该覆盖（即时生效） */
  const commit = (name: string, value: string): void => {
    if (!name.startsWith('--')) return;
    theme.setCustomTokens({ [name]: value === '' ? null : value });
  };

  const updateName = (id: number, name: string): void => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return;
    if (row.name.startsWith('--')) theme.setCustomTokens({ [row.name]: null }); // 换名：摘除旧变量
    commit(name, row.value);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  };

  const updateValue = (id: number, value: string): void => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) return;
    commit(row.name, value);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
  };

  const removeRow = (id: number): void => {
    const row = rows.find((r) => r.id === id);
    if (row !== undefined && row.name.startsWith('--')) {
      theme.setCustomTokens({ [row.name]: null });
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const addRow = (): void => {
    setRows((prev) => [...prev, { id: ++tokenRowSeq, name: '', value: '' }]);
  };

  /** 恢复默认：resetToDefaults（清全部 ui.* 偏好）+ 兜底清理 ui.tokens/ui.mode */
  const confirmReset = (): void => {
    theme.resetToDefaults();
    try {
      localStorage.removeItem('ui.tokens');
      localStorage.removeItem('ui.mode');
    } catch {
      /* 存储不可用时忽略 */
    }
    setRows([]);
    setResetOpen(false);
    toast.success('已恢复默认外观', '模式 / 强调色 / 圆角 / 密度 / 自定义覆盖全部重置。');
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 模式三态卡 */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">外观模式</h3>
          <p className="text-muted-foreground text-xs">
            当前解析为{theme.resolvedMode === 'dark' ? '深色' : '浅色'}
            （跟随系统时随 prefers-color-scheme 实时切换）。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = theme.mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={selected}
                onClick={() => theme.setMode(opt.value)}
                className={cn(
                  'bg-card hover:bg-accent/50 flex flex-col items-center gap-1.5 rounded-lg border p-4 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected && 'border-primary ring-ring/30 ring-2',
                )}
              >
                <Icon className={cn('size-5', selected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="text-sm font-medium">{opt.label}</span>
                <span className="text-muted-foreground text-xs">{opt.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 强调色预设 */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">强调色</h3>
          <p className="text-muted-foreground text-xs">预设会覆盖主色 / 焦点环 / 侧栏等一整组令牌，亮暗两套自动取用。</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {ACCENT_PRESETS.map((preset) => {
            const vars = theme.resolvedMode === 'dark' ? preset.dark : preset.light;
            const color = vars['--primary'];
            const selected = theme.accent === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected}
                onClick={() => theme.setAccent(preset.id)}
                className={cn(
                  'flex w-20 flex-col items-center gap-1.5 rounded-lg border p-3 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary ring-ring/30 ring-2' : 'hover:bg-accent/50',
                )}
              >
                <span
                  className={cn(
                    'size-7 rounded-full border shadow-inner',
                    selected && 'ring-ring/40 ring-2 ring-offset-2 ring-offset-background',
                  )}
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
                <span className="text-muted-foreground w-full truncate text-center text-xs">{preset.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 圆角 */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">圆角</h3>
          <p className="text-muted-foreground text-xs">全局 --radius 令牌，五档即时切换。</p>
        </div>
        <div className="border-input inline-flex w-fit max-w-full flex-wrap gap-1 rounded-lg border p-1">
          {RADIUS_STEPS.map((step) => (
            <button
              key={step.value}
              type="button"
              aria-pressed={theme.radius === step.value}
              onClick={() => theme.setRadius(step.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                theme.radius === step.value
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {step.label}
            </button>
          ))}
        </div>
      </section>

      {/* 密度 */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium">密度</h3>
          <p className="text-muted-foreground text-xs">控制表格与列表的行高、内边距与间距令牌。</p>
        </div>
        <div className="border-input inline-flex w-fit gap-1 rounded-lg border p-1">
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={theme.density === opt.value}
              onClick={() => theme.setDensity(opt.value)}
              className={cn(
                'rounded-md px-4 py-1.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                theme.density === opt.value
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      {/* 自定义覆盖 */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">自定义覆盖</h3>
            <p className="text-muted-foreground text-xs">
              任意 -- 开头的 CSS 变量名 + 值，逐行即时生效并持久化（优先级最高）。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addRow}>
            <PlusIcon aria-hidden />
            添加变量
          </Button>
        </div>
        {rows.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-xs">
            暂无自定义覆盖。示例：--brand-500 = oklch(0.6 0.2 145)
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const valid = row.name.startsWith('--');
              return (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    className="max-w-56 font-mono text-xs"
                    value={row.name}
                    onChange={(e) => updateName(row.id, e.target.value)}
                    placeholder="--brand-500"
                    aria-label="CSS 变量名"
                  />
                  <Input
                    className="flex-1 font-mono text-xs"
                    value={row.value}
                    onChange={(e) => updateValue(row.id, e.target.value)}
                    placeholder="oklch(0.6 0.2 145)"
                    aria-label="CSS 变量值"
                  />
                  {!valid && row.name !== '' && (
                    <span className="text-destructive w-24 shrink-0 text-xs">须以 -- 开头</span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeRow(row.id)}
                    aria-label={`删除变量 ${row.name}`}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 恢复默认 */}
      <section className="border-border flex flex-col gap-3 border-t pt-4">
        <div>
          <h3 className="text-sm font-medium">恢复默认</h3>
          <p className="text-muted-foreground text-xs">
            清除模式 / 强调色 / 圆角 / 密度 / 自定义覆盖的全部本地偏好（localStorage ui.*）。
          </p>
        </div>
        <Button variant="destructive" size="sm" className="w-fit" onClick={() => setResetOpen(true)}>
          <RotateCcwIcon aria-hidden />
          恢复默认外观
        </Button>
      </section>

      {/* 恢复默认确认 */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认恢复默认外观</DialogTitle>
            <DialogDescription>
              将清除全部主题偏好并恢复缺省样式（含自定义变量覆盖），此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmReset}>
              恢复默认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLM 供应商
// ---------------------------------------------------------------------------

/** 编辑 Dialog 表单（apiKey 留空 = 沿用既有 secret 引用） */
interface LlmEditForm {
  name: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  apiKeySecretRef: string;
  modelsCsv: string;
  allowlistCsv: string;
  timeoutMs: string;
}

const EMPTY_LLM_FORM: LlmEditForm = {
  name: '',
  protocol: LLM_PROTOCOLS[0],
  baseUrl: '',
  apiKey: '',
  apiKeySecretRef: '',
  modelsCsv: '',
  allowlistCsv: '',
  timeoutMs: '',
};

function LlmTab(): React.ReactNode {
  const [providers, setProviders] = useState<LlmProviderConfig[] | null>(null);
  const [models, setModels] = useState<LlmModelAggregate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editIndex, setEditIndex] = useState(-1); // -1 = 新建；≥0 = 编辑对应下标
  const [form, setForm] = useState<LlmEditForm>(EMPTY_LLM_FORM);
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const [providerRes, modelRes] = await Promise.all([
        api.get<unknown>('/api/v1/llm/providers', { silent: true }),
        api.get<LlmModelAggregate[]>('/api/v1/llm/models', { silent: true }),
      ]);
      setProviders(Array.isArray(providerRes) ? (providerRes as LlmProviderConfig[]) : []);
      setModels(Array.isArray(modelRes) ? modelRes : []);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (index: number): void => {
    const p = index >= 0 ? providers?.[index] : undefined;
    setEditIndex(index);
    setForm(
      p === undefined
        ? EMPTY_LLM_FORM
        : {
            name: p.name,
            protocol: p.protocol,
            baseUrl: p.baseUrl,
            apiKey: '', // 明文密钥不可回显：留空表示沿用既有 secret
            apiKeySecretRef: p.apiKeySecretRef ?? '',
            modelsCsv: p.models.join(', '),
            allowlistCsv: (p.paramAllowlist ?? []).join(', '),
            timeoutMs: p.timeoutMs === undefined ? '' : String(p.timeoutMs),
          },
    );
    setEditOpen(true);
  };

  /** PUT 全量供应商数组：编辑替换对应下标 / 新建追加；删除 = 先移除再 PUT */
  const putProviders = async (next: LlmProviderConfig[], successText: string): Promise<boolean> => {
    setBusy(true);
    try {
      await api.put('/api/v1/llm/providers', next);
      toast.success(successText);
      await load(true);
      return true;
    } catch (e) {
      toast.error('保存失败', errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async (): Promise<void> => {
    const name = form.name.trim();
    const baseUrl = form.baseUrl.trim();
    const modelList = parseCsv(form.modelsCsv);
    if (name === '') {
      toast.error('请输入供应商名称');
      return;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      toast.error('baseUrl 须为 http(s):// 开头的 URL');
      return;
    }
    if (modelList.length === 0) {
      toast.error('请至少填写一个模型（逗号分隔）');
      return;
    }
    const existing = editIndex >= 0 ? providers?.[editIndex] : undefined;
    // 密钥解析：明文 apiKey 优先（服务端转存 secrets）；否则沿用输入 / 既有的 secret 引用
    const apiKey = form.apiKey.trim();
    const secretRef = form.apiKeySecretRef.trim() || existing?.apiKeySecretRef || '';
    if (apiKey === '' && secretRef === '') {
      toast.error('每个供应商需要 apiKey 明文或 apiKeySecretRef（二选一）');
      return;
    }
    const timeoutRaw = form.timeoutMs.trim();
    const timeoutMs = timeoutRaw === '' ? undefined : Number(timeoutRaw);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      toast.error('timeoutMs 须为正整数（毫秒）');
      return;
    }
    const target: LlmProviderConfig = {
      name,
      protocol: form.protocol,
      baseUrl,
      models: modelList,
      ...(apiKey !== ''
        ? { apiKey }
        : { ...(secretRef !== '' ? { apiKeySecretRef: secretRef } : {}) }),
      ...(parseCsv(form.allowlistCsv).length > 0 ? { paramAllowlist: parseCsv(form.allowlistCsv) } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    const next = [...(providers ?? [])];
    if (editIndex >= 0) next[editIndex] = target;
    else next.push(target);
    const ok = await putProviders(next, editIndex >= 0 ? '供应商已保存' : '供应商已添加');
    if (ok) setEditOpen(false);
  };

  const submitDelete = async (): Promise<void> => {
    if (deleteIndex === null) return;
    const next = (providers ?? []).filter((_, i) => i !== deleteIndex);
    const ok = await putProviders(next, '供应商已删除');
    if (ok) setDeleteIndex(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          供应商配置持久化于内核 settings，明文密钥经 secrets 脱敏存储（仅写入，不可回显）。
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            刷新
          </Button>
          <Button size="sm" onClick={() => openEdit(-1)}>
            <PlusIcon aria-hidden />
            新增供应商
          </Button>
        </div>
      </div>

      {loading && (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      )}

      {!loading && error !== null && (
        <EmptyState icon={ServerIcon} title="供应商配置加载失败" description={error}>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {!loading && error === null && providers !== null && providers.length === 0 && (
        <EmptyState
          icon={ServerIcon}
          title="还没有 LLM 供应商"
          description="添加一个 OpenAI 兼容 / Anthropic 兼容的供应商后，聊天与模型列表即可用。"
        >
          <Button size="sm" onClick={() => openEdit(-1)}>
            <PlusIcon aria-hidden />
            新增供应商
          </Button>
        </EmptyState>
      )}

      {!loading && error === null && providers !== null && providers.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {providers.map((p, i) => (
            <Card key={`${p.name}-${i}`} className="gap-3 py-4">
              <CardContent className="flex flex-col gap-3 px-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{p.name}</span>
                      <Badge variant="secondary" className="font-mono text-[11px]">
                        {p.protocol}
                      </Badge>
                    </p>
                    <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs" title={p.baseUrl}>
                      {p.baseUrl}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(i)} aria-label={`编辑 ${p.name}`}>
                      <PencilIcon aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteIndex(i)}
                      aria-label={`删除 ${p.name}`}
                    >
                      <Trash2Icon aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {p.models.map((m) => (
                    <Badge key={m} variant="outline" className="max-w-full font-mono text-[11px]">
                      <span className="truncate">{m}</span>
                    </Badge>
                  ))}
                </div>
                <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="flex items-center gap-1">
                    <KeyRoundIcon className="size-3.5" aria-hidden />
                    secret: <span className="font-mono">{maskSecret(p.apiKeySecretRef)}</span>
                  </span>
                  {p.timeoutMs !== undefined && <span>timeout {p.timeoutMs}ms</span>}
                  {(p.paramAllowlist ?? []).length > 0 && (
                    <span>params {p.paramAllowlist?.join('/')}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 模型聚合 */}
      {!loading && error === null && models !== null && models.length > 0 && (
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">模型聚合（GET /api/v1/llm/models）</CardTitle>
            <CardDescription>各供应商可见模型的聚合视图（任意已认证角色可读）。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-4">
            {models.map((agg) => (
              <div key={agg.provider} className="flex flex-wrap items-baseline gap-2">
                <span className="w-28 shrink-0 truncate text-sm font-medium" title={agg.provider}>
                  {agg.provider}
                </span>
                <span className="text-muted-foreground font-mono text-xs leading-relaxed break-all">
                  {agg.models.length > 0 ? agg.models.join(' · ') : '（无模型）'}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* 编辑 / 新建 Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editIndex >= 0 ? '编辑供应商' : '新增供应商'}</DialogTitle>
            <DialogDescription>
              PUT 全量保存：保存后立即生效；密钥明文仅随本次请求写入 secrets。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="llm-name">名称</Label>
                <Input
                  id="llm-name"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="openai-main"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>协议</Label>
                <Select value={form.protocol} onValueChange={(v) => setForm((p) => ({ ...p, protocol: v }))}>
                  <SelectTrigger className="w-full" aria-label="协议">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LLM_PROTOCOLS.map((proto) => (
                      <SelectItem key={proto} value={proto} className="font-mono text-xs">
                        {proto}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="llm-baseurl">Base URL</Label>
              <Input
                id="llm-baseurl"
                value={form.baseUrl}
                onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="llm-apikey">apiKey（明文，选填）</Label>
              <Input
                id="llm-apikey"
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))}
                placeholder="sk-…"
                autoComplete="new-password"
              />
              <p className="text-destructive text-xs">仅写入：保存后转存内核 secrets，不可再查看。</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="llm-secret-ref">apiKeySecretRef（选填）</Label>
              <Input
                id="llm-secret-ref"
                value={form.apiKeySecretRef}
                onChange={(e) => setForm((p) => ({ ...p, apiKeySecretRef: e.target.value }))}
                placeholder={editIndex >= 0 ? '留空沿用既有引用' : 'llm.openai-main'}
                autoComplete="off"
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                与 apiKey 二选一；编辑时留空两项 = 沿用既有 secret 引用。
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="llm-models">Models（逗号分隔）</Label>
              <Input
                id="llm-models"
                value={form.modelsCsv}
                onChange={(e) => setForm((p) => ({ ...p, modelsCsv: e.target.value }))}
                placeholder="gpt-4o, gpt-4o-mini"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="llm-allowlist">paramAllowlist（逗号分隔，选填）</Label>
                <Input
                  id="llm-allowlist"
                  value={form.allowlistCsv}
                  onChange={(e) => setForm((p) => ({ ...p, allowlistCsv: e.target.value }))}
                  placeholder="temperature, topP"
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="llm-timeout">timeoutMs（选填）</Label>
                <Input
                  id="llm-timeout"
                  type="number"
                  min={1}
                  value={form.timeoutMs}
                  onChange={(e) => setForm((p) => ({ ...p, timeoutMs: e.target.value }))}
                  placeholder="60000"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void submitEdit()} disabled={busy}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog
        open={deleteIndex !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteIndex(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除供应商</DialogTitle>
            <DialogDescription>
              将从配置数组中移除「{deleteIndex !== null ? (providers?.[deleteIndex]?.name ?? '') : ''}」
              并全量保存。已写入 secrets 的密钥不会被自动清除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteIndex(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()} disabled={busy}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 系统
// ---------------------------------------------------------------------------

function SystemTab(): React.ReactNode {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false): Promise<void> => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.get<SystemInfo>('/api/v1/system/info', { silent: true });
      setInfo(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runBackup = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.post<BackupResult>('/api/v1/system/backup');
      toast.success('备份完成', `${res.path}（${formatBytes(res.sizeBytes)}）`);
      setBackupOpen(false);
    } catch (e) {
      toast.error('备份失败', errText(e));
      setBackupOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const counters: Array<[string, number]> =
    info?.counters === undefined || info.counters === null
      ? []
      : (Object.entries(info.counters) as Array<[string, number]>).filter(([, v]) => typeof v === 'number');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">内核运行时快照（只读）与运维操作。</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCwIcon className={cn(refreshing && 'animate-spin')} aria-hidden />
            刷新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/update">
              <CircleArrowUpIcon aria-hidden />
              前往升级
            </Link>
          </Button>
        </div>
      </div>

      {loading && <Skeleton className="h-56 rounded-lg" />}

      {!loading && error !== null && (
        <EmptyState icon={ServerIcon} title="系统信息加载失败" description={error}>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            重试
          </Button>
        </EmptyState>
      )}

      {!loading && error === null && info !== null && (
        <>
          <Card className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">系统信息（GET /api/v1/system/info）</CardTitle>
              <CardDescription>只读快照，随每次刷新更新。</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Kv label="名称" value={info.name} />
                <Kv label="环境" value={info.env} />
                <Kv label="版本" value={info.version} mono />
                <Kv label="状态" value={info.state} />
                <Kv label="运行时长" value={formatUptime(info.uptimeMs)} />
                <Kv label="Node" value={`v${info.node}`} mono />
                <Kv label="时区" value={info.timezone} mono />
              </dl>
            </CardContent>
          </Card>

          <Card className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-base">计数器快照</CardTitle>
              <CardDescription>counters 全量键值（api.requests 按路由累计）。</CardDescription>
            </CardHeader>
            <CardContent className="px-4">
              {counters.length === 0 ? (
                <p className="text-muted-foreground py-4 text-center text-sm">暂无计数数据</p>
              ) : (
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {counters.map(([key, value]) => (
                    <Kv key={key} label={key} value={value.toLocaleString('en-US')} mono />
                  ))}
                </dl>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-base">数据库备份</CardTitle>
          <CardDescription>POST /api/v1/system/backup —— 导出 kernel.sqlite 快照（admin/root）。</CardDescription>
        </CardHeader>
        <CardContent className="px-4">
          <Button variant="destructive" size="sm" onClick={() => setBackupOpen(true)}>
            <DatabaseIcon aria-hidden />
            立即备份
          </Button>
        </CardContent>
      </Card>

      {/* 备份确认 */}
      <Dialog open={backupOpen} onOpenChange={setBackupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认创建备份</DialogTitle>
            <DialogDescription>
              将数据库导出为快照文件（可能占用与库体积相当的磁盘空间）。大库耗时稍长，请耐心等待。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBackupOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button onClick={() => void runBackup()} disabled={busy}>
              {busy ? '备份中…' : '开始备份'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 只读键值对（dt/dd） */
function Kv({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.ReactNode {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0">
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className={cn('min-w-0 truncate text-right text-sm', mono && 'font-mono text-xs')} title={value}>
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export default function SettingsPage(): React.ReactNode {
  return (
    <div className="flex flex-col gap-6">
      {/* 页头 */}
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">设置</h2>
        <p className="text-muted-foreground text-sm">外观主题定制、LLM 供应商管理与系统运维操作。</p>
      </div>

      <Tabs defaultValue="appearance" className="gap-6">
        <TabsList>
          <TabsTrigger value="appearance">外观</TabsTrigger>
          <TabsTrigger value="llm">LLM 供应商</TabsTrigger>
          <TabsTrigger value="system">系统</TabsTrigger>
        </TabsList>
        <TabsContent value="appearance">
          <AppearanceTab />
        </TabsContent>
        <TabsContent value="llm">
          <LlmTab />
        </TabsContent>
        <TabsContent value="system">
          <SystemTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
