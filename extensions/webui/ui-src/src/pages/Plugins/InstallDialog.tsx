import { useCallback, useEffect, useRef, useState } from 'react';
import { FileArchiveIcon, PackagePlusIcon, TriangleAlertIcon, UploadCloudIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { errText, formatBytes } from '@/pages/_shared';
import { MAX_PLUGIN_ZIP_BYTES, isDuplicateInstallError } from '@/pages/Plugins/shared';
import type { InstalledPlugin } from '@/pages/Plugins/shared';

/**
 * InstallDialog — 「安装插件」上传弹窗。
 *
 * - POST /api/v1/plugins/install  multipart/form-data 单文件，field 名 `file`，≤64MB（zip）
 *   → 201 InstalledPlugin（内核在安装成功后已自动 refresh 聚合注入，列表由父级重拉）；
 * - `?overwrite=1` 覆盖安装（同 id 已装且未 overwrite → 400 'plugin id already installed,
 *   use overwrite'，此处转译为「先卸载或开启覆盖」的引导文案）；
 * - 注意 force 仅属于 DELETE（?force=1 强制卸载），安装面无 force 语义。
 */
export function InstallDialog({
  open,
  onOpenChange,
  onInstalled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 安装成功（201）后的回调：父级关闭弹窗并刷新列表 */
  onInstalled: (plugin: InstalledPlugin) => void;
}): React.ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 关闭/重开时重置表单 */
  useEffect(() => {
    if (!open) {
      setFile(null);
      setFileError(null);
      setOverwrite(false);
      setInstalling(false);
      setError(null);
    }
  }, [open]);

  /** 选择文件：.zip 扩展名 + 64MB 客户端预校验（与内核 MAX_PLUGIN_ZIP_BYTES 一致） */
  const acceptFile = useCallback((candidate: File | undefined): void => {
    setFile(null);
    setFileError(null);
    setError(null);
    if (candidate === undefined) return;
    if (!candidate.name.toLowerCase().endsWith('.zip')) {
      setFileError('仅支持 .zip 插件包（内核校验 field "file" 的 zip 扩展名）');
      return;
    }
    if (candidate.size > MAX_PLUGIN_ZIP_BYTES) {
      setFileError(`超过 64MB 上限（当前 ${formatBytes(candidate.size)}，内核将拒绝 413）`);
      return;
    }
    setFile(candidate);
  }, []);

  const install = useCallback(async (): Promise<void> => {
    if (file === null || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const plugin = await api.post<InstalledPlugin>(
        `/api/v1/plugins/install${overwrite ? '?overwrite=1' : ''}`,
        form,
      );
      toast.success('插件已安装', `${plugin.name} v${plugin.version}`);
      setFile(null);
      onInstalled(plugin);
    } catch (e) {
      if (isDuplicateInstallError(e)) {
        setError('该插件 id 已安装：请先卸载旧版本，或开启「覆盖已安装」后重试。');
      } else {
        setError(errText(e));
      }
    } finally {
      setInstalling(false);
    }
  }, [file, installing, overwrite, onInstalled]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlusIcon className="size-5" aria-hidden />
            安装插件包
          </DialogTitle>
          <DialogDescription>
            上传插件 zip 包（≤64MB）。包内需含 plugin.json 清单，技能放 skills/、脚本放 scripts/，
            MCP 服务器与提示词在清单中声明。安装成功后内核会自动聚合注入贡献。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* zip 选择区 */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-xs">插件包（.zip）</Label>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={installing}
              className="hover:bg-accent/50 focus-visible:ring-ring flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-5 text-center outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FileArchiveIcon className="text-muted-foreground size-6" aria-hidden />
              {file !== null ? (
                <span className="text-sm">
                  <span className="font-medium">{file.name}</span>
                  <span className="text-muted-foreground"> · {formatBytes(file.size)}</span>
                </span>
              ) : (
                <span className="text-muted-foreground text-sm">点击选择 .zip 插件包</span>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip"
              className="hidden"
              disabled={installing}
              onChange={(e) => {
                acceptFile(e.target.files?.[0]);
                e.target.value = ''; // 允许重复选择同一文件
              }}
            />
            <UploadHint />
            {fileError !== null && (
              <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {fileError}
              </p>
            )}
          </div>

          {/* 覆盖安装开关（?overwrite=1；force 语义仅属于 DELETE 卸载） */}
          <label className="hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border p-3">
            <Switch checked={overwrite} onCheckedChange={setOverwrite} aria-label="覆盖已安装" disabled={installing} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">覆盖已安装（overwrite）</span>
              <span className="text-muted-foreground text-xs">
                同 id 插件已装时先删旧目录再原子落位（?overwrite=1）。不开启则报「id 已安装」。
              </span>
            </span>
          </label>

          {error !== null && (
            <p className="text-destructive flex items-start gap-1.5 text-xs leading-relaxed">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>
            取消
          </Button>
          <Button onClick={() => void install()} disabled={file === null || installing}>
            <UploadCloudIcon className={cn(installing && 'animate-pulse')} aria-hidden />
            {installing ? '安装中…' : '安装'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 选择区下方的格式提示 */
function UploadHint(): React.ReactNode {
  return <p className="text-muted-foreground text-xs leading-relaxed">仅支持 .zip，单文件不超过 64MB（内核 413 HARNESS-1005）。</p>;
}
