/**
 * ToolCallDialog — 工具调用 Dialog（POST /api/v1/mcp/tools/call）。
 *
 * - argsSchema 展示：inputSchema.properties 存在 → 逐字段表单（按 JSON Schema type
 *   分派 string/number/boolean/enum/array/object 控件，required 标记 + default 预填；
 *   原始 schema 可折叠查看）；否则 → JSON textarea（整体对象）；
 * - 超时 ms 可选（1 - 600000，缺省用服务器配置）；
 * - 结果结构化展示：content text 块列表（非 text 块 JSON 折叠展示），
 *   isError === true 时红色警示框（server 侧声明执行失败）；
 * - 错误按 {code,message,detail} toast：404 HARNESS-3004（server/工具不存在）、
 *   504 HARNESS-2001（RPC 超时）、500 HARNESS-9003（not connected 等）。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { TriangleAlertIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CodeBlock, parseJsonInput } from '@/pages/_shared';
import {
  jsonPreview,
  toastApiError,
  type McpCallToolResult,
  type McpToolRow,
} from '@/pages/Mcp/shared';

// ---------------------------------------------------------------------------
// inputSchema → 字段表单
// ---------------------------------------------------------------------------

/** 单个入参字段的渲染元信息 */
interface ToolFieldMeta {
  name: string;
  description: string | null;
  /** 归一后的控件类型：string | number | integer | boolean | enum | array | object | unknown */
  jsonType: string;
  required: boolean;
  /** schema.enum 的原始值列表（string/number；用于回转数值） */
  enumValues: Array<string | number> | null;
  /** default 的文本化（string 原样，其余 JSON） */
  defaultText: string;
}

/** 读取 schema 的展示类型（anyOf/oneOf 取第一个分支，enum 视为独立类型） */
function schemaTypeOf(schema: unknown): string {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return 'unknown';
  const rec = schema as Record<string, unknown>;
  if (typeof rec['type'] === 'string') return rec['type'];
  const union = Array.isArray(rec['anyOf']) ? rec['anyOf'] : Array.isArray(rec['oneOf']) ? rec['oneOf'] : null;
  if (union !== null && union.length > 0) return schemaTypeOf(union[0]);
  return rec['enum'] !== undefined ? 'enum' : 'unknown';
}

/** schema 对象上的可选字符串/数组字段 */
function schemaMember(schema: unknown, key: string): unknown {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  return (schema as Record<string, unknown>)[key];
}

/**
 * inputSchema → 字段列表。仅当 properties 是对象时返回字段（可为空数组 = 无入参）；
 * 结构不合规（缺 properties / 非对象）返回 null → 调用方退回 JSON textarea。
 */
function parseToolFields(schema: unknown): ToolFieldMeta[] | null {
  const props = schemaMember(schema, 'properties');
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return null;
  const requiredRaw = schemaMember(schema, 'required');
  const requiredSet = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((v): v is string => typeof v === 'string') : [],
  );
  return Object.entries(props as Record<string, unknown>).map(([name, propSchema]) => {
    const enumRaw = schemaMember(propSchema, 'enum');
    const enumValues = Array.isArray(enumRaw)
      ? enumRaw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      : null;
    const def = schemaMember(propSchema, 'default');
    const desc = schemaMember(propSchema, 'description');
    return {
      name,
      description: typeof desc === 'string' ? desc : null,
      jsonType: enumValues !== null && enumValues.length > 0 ? 'enum' : schemaTypeOf(propSchema),
      required: requiredSet.has(name),
      enumValues,
      defaultText: def === undefined || def === null ? '' : typeof def === 'string' ? def : JSON.stringify(def),
    };
  });
}

/** 字段值 → args 对象（必填缺失 / 类型不符返回错误消息；空参返回 undefined） */
function buildArgsFromFields(
  fields: ToolFieldMeta[],
  values: Record<string, string>,
): { ok: true; args: Record<string, unknown> | undefined } | { ok: false; message: string } {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim();
    if (raw === '') {
      if (field.required) return { ok: false, message: `缺少必填参数「${field.name}」` };
      continue;
    }
    if (field.jsonType === 'number' || field.jsonType === 'integer') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, message: `参数「${field.name}」需要数字（得到 "${raw}"）` };
      if (field.jsonType === 'integer' && !Number.isInteger(n)) {
        return { ok: false, message: `参数「${field.name}」需要整数` };
      }
      args[field.name] = n;
    } else if (field.jsonType === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return { ok: false, message: `参数「${field.name}」需要 true/false` };
      args[field.name] = raw === 'true';
    } else if (field.jsonType === 'array' || field.jsonType === 'object') {
      const parsed = parseJsonInput(raw);
      if (!parsed.ok) return { ok: false, message: `参数「${field.name}」不是合法 JSON：${parsed.message}` };
      if (field.jsonType === 'array' && !Array.isArray(parsed.value)) {
        return { ok: false, message: `参数「${field.name}」需要 JSON 数组` };
      }
      if (field.jsonType === 'object' &&
        (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value))) {
        return { ok: false, message: `参数「${field.name}」需要 JSON 对象` };
      }
      args[field.name] = parsed.value;
    } else if (field.enumValues !== null) {
      // enum：数值枚举回转为 number，其余按字符串
      const match = field.enumValues.find((v) => String(v) === raw);
      args[field.name] = match !== undefined ? match : raw;
    } else {
      args[field.name] = raw;
    }
  }
  return { ok: true, args: Object.keys(args).length > 0 ? args : undefined };
}

// ---------------------------------------------------------------------------
// 结果展示
// ---------------------------------------------------------------------------

/** 调用结果：content 块列表 + isError 红色警示 */
function CallResultView({ result }: { result: McpCallToolResult }): React.ReactNode {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border p-3',
        result.isError === true && 'border-destructive/50 bg-destructive/5',
      )}
    >
      <div className="flex items-center gap-2">
        {result.isError === true ? (
          <Badge variant="destructive" className="gap-1">
            <TriangleAlertIcon className="size-3" aria-hidden />
            isError
          </Badge>
        ) : (
          <Badge variant="success">成功</Badge>
        )}
        <span className="text-muted-foreground text-xs tabular-nums">{result.content.length} 个 content 块</span>
      </div>
      {result.isError === true && (
        <p className="text-destructive text-xs leading-relaxed">
          server 侧声明本次执行失败（isError: true）—— 传输层不吞错，请依据下方内容裁决。
        </p>
      )}
      {result.content.length === 0 && <p className="text-muted-foreground text-sm">（server 返回空 content）</p>}
      {result.content.map((block, i) =>
        block.type === 'text' && typeof block.text === 'string' ? (
          <CodeBlock key={i} text={block.text} className="max-h-60" />
        ) : (
          <div key={i} className="flex flex-col gap-1">
            <Badge variant="outline" className="w-fit font-mono text-[10px]">
              {block.type}
            </Badge>
            <CodeBlock text={jsonPreview(block, 4000)} className="max-h-60" />
          </div>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function ToolCallDialog({
  serverId,
  serverName,
  tool,
  onOpenChange,
}: {
  serverId: string;
  serverName: string;
  /** 调用目标工具；null = 关闭 */
  tool: McpToolRow | null;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  /** inputSchema.properties 解析结果；null = 不可结构化（退回 JSON textarea） */
  const [fieldsRaw, setFieldsRaw] = useState<ToolFieldMeta[] | null>(null);
  /** 逐字段模式的原始文本值（boolean/enum 存字符串形态） */
  const [values, setValues] = useState<Record<string, string>>({});
  const [jsonText, setJsonText] = useState('');
  const [timeoutText, setTimeoutText] = useState('');
  const [result, setResult] = useState<McpCallToolResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fields = fieldsRaw ?? [];
  const useFieldForm = useMemo(() => fieldsRaw !== null && fieldsRaw.length > 0, [fieldsRaw]);

  // 目标切换（打开/换工具）时重置全部表单态
  useEffect(() => {
    if (tool === null) return;
    setResult(null);
    setJsonText('{}');
    setTimeoutText('');
    const parsed = parseToolFields(tool.inputSchema);
    setFieldsRaw(parsed);
    setValues(Object.fromEntries((parsed ?? []).map((f) => [f.name, f.defaultText])));
  }, [tool]);

  /** Select 的「（省略）」选项归一为空串（提交时按未提供处理） */
  const setFieldValue = useCallback(
    (name: string, value: string): void => {
      setValues((prev) => ({ ...prev, [name]: value === '__omit__' ? '' : value }));
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();
      if (tool === null) return;
      let args: Record<string, unknown> | undefined;
      if (useFieldForm) {
        const built = buildArgsFromFields(fields, values);
        if (!built.ok) {
          toast.error('参数校验失败', built.message);
          return;
        }
        args = built.args;
      } else {
        const parsed = parseJsonInput(jsonText);
        if (!parsed.ok) {
          toast.error('args 不是合法 JSON', parsed.message);
          return;
        }
        if (parsed.value !== undefined) {
          if (parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
            toast.error('args 必须是 JSON 对象', '例如 {"path": "/tmp/log"}');
            return;
          }
          args = parsed.value as Record<string, unknown>;
        }
      }
      const body: Record<string, unknown> = { serverId, toolName: tool.name };
      if (args !== undefined) body['args'] = args;
      const timeoutTrimmed = timeoutText.trim();
      if (timeoutTrimmed !== '') {
        const timeout = Number(timeoutTrimmed);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) {
          toast.error('超时不合法', 'timeoutMs 需为 1 - 600000 的整数毫秒');
          return;
        }
        body['timeoutMs'] = timeout;
      }
      setSubmitting(true);
      try {
        const res = await api.post<McpCallToolResult>('/api/v1/mcp/tools/call', body, { silent: true });
        setResult(res);
        if (res.isError === true) {
          toast.info('工具已执行（isError）', 'server 侧声明执行失败，请查看结果内容');
        } else {
          toast.success('调用成功', tool.name);
        }
      } catch (err) {
        toastApiError(err, '调用失败');
      } finally {
        setSubmitting(false);
      }
    },
    [tool, serverId, useFieldForm, fields, values, jsonText, timeoutText],
  );

  return (
    <Dialog open={tool !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{tool?.name}</DialogTitle>
          <DialogDescription>
            在「{serverName}」上调用该工具
            {tool?.description !== undefined && tool.description !== '' ? `：${tool.description}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4" noValidate>
          {useFieldForm ? (
            <div className="flex flex-col gap-3">
              {fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={`mcp-field-${field.name}`} className="gap-1.5">
                    <span className="font-mono">{field.name}</span>
                    {field.required && <span className="text-destructive">*</span>}
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {field.jsonType}
                    </Badge>
                  </Label>
                  {field.description !== null && (
                    <p className="text-muted-foreground text-xs leading-relaxed">{field.description}</p>
                  )}
                  <FieldControl
                    field={field}
                    value={values[field.name] ?? ''}
                    disabled={submitting}
                    onChange={(value) => setFieldValue(field.name, value)}
                  />
                </div>
              ))}
              {tool?.inputSchema !== undefined && (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer select-none hover:text-foreground">
                    查看原始 inputSchema
                  </summary>
                  <CodeBlock text={jsonPreview(tool.inputSchema, 4000)} className="mt-2" />
                </details>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="mcp-call-json">
                args（JSON 对象
                {tool !== null && fieldsRaw === null && '，schema 不可结构化'}
                {fieldsRaw !== null && fieldsRaw.length === 0 && '，该工具未声明入参字段'}
                ）
              </Label>
              <Textarea
                id="mcp-call-json"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder='{"path": "/tmp/log"}'
                disabled={submitting}
                className="min-h-24 font-mono text-xs"
                spellCheck={false}
              />
              {tool?.inputSchema !== undefined && (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer select-none hover:text-foreground">
                    查看原始 inputSchema
                  </summary>
                  <CodeBlock text={jsonPreview(tool.inputSchema, 4000)} className="mt-2" />
                </details>
              )}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="mcp-call-timeout">超时 ms（可选，缺省用服务器配置）</Label>
            <Input
              id="mcp-call-timeout"
              type="number"
              value={timeoutText}
              onChange={(e) => setTimeoutText(e.target.value)}
              placeholder="30000"
              disabled={submitting}
              min={1}
              max={600_000}
              step={1000}
              className="font-mono"
            />
          </div>

          {result !== null && <CallResultView result={result} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              关闭
            </Button>
            <Button type="submit" disabled={submitting || tool === null}>
              {submitting ? '调用中…' : '调用'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 按字段类型分派控件（string 默认 / number / boolean / enum / array·object） */
function FieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ToolFieldMeta;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): React.ReactNode {
  if (field.jsonType === 'boolean') {
    return (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full" id={`mcp-field-${field.name}`}>
          <SelectValue placeholder="（省略）" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true" className="font-mono">true</SelectItem>
          <SelectItem value="false" className="font-mono">false</SelectItem>
          {!field.required && field.defaultText === '' && (
            <SelectItem value="__omit__">（省略）</SelectItem>
          )}
        </SelectContent>
      </Select>
    );
  }
  if (field.enumValues !== null) {
    return (
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full" id={`mcp-field-${field.name}`}>
          <SelectValue placeholder="（省略）" />
        </SelectTrigger>
        <SelectContent>
          {field.enumValues.map((v) => (
            <SelectItem key={String(v)} value={String(v)} className="font-mono">
              {String(v)}
            </SelectItem>
          ))}
          {!field.required && field.defaultText === '' && (
            <SelectItem value="__omit__">（省略）</SelectItem>
          )}
        </SelectContent>
      </Select>
    );
  }
  if (field.jsonType === 'array' || field.jsonType === 'object') {
    return (
      <Textarea
        id={`mcp-field-${field.name}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.jsonType === 'array' ? '["a", "b"]' : '{"key": "value"}'}
        disabled={disabled}
        className="min-h-16 font-mono text-xs"
        spellCheck={false}
      />
    );
  }
  return (
    <Input
      id={`mcp-field-${field.name}`}
      type={field.jsonType === 'number' || field.jsonType === 'integer' ? 'number' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={field.jsonType === 'number' || field.jsonType === 'integer' ? 'font-mono' : undefined}
      step={field.jsonType === 'integer' ? 1 : 'any'}
      spellCheck={false}
      autoComplete="off"
    />
  );
}
