import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * theme — 主题 Token 体系（模式 → 预设 → 圆角/密度/控件/阴影 → 自定义，按序覆盖）。
 *
 * 架构：
 * 1. 模式（mode）：'light' | 'dark' | 'system'（跟随 prefers-color-scheme），
 *    class 策略（<html class="dark">）+ colorScheme；持久化 localStorage('ui.mode')；
 *    index.html 内联脚本在首帧前做同策略预应用，防闪烁。
 * 2. 强调色预设（accent）：≥6 组预设，每组覆盖 --primary/--primary-foreground/--ring/
 *    --accent/--accent-foreground/--sidebar-primary/--sidebar-ring 等，亮暗两套取值
 *    按当前解析模式取用；持久化 localStorage('ui.accent')。
 * 3. 圆角档位（radius）：--radius 0 / 0.25 / 0.5 / 0.75 / 1rem；持久化 localStorage('ui.radius')。
 * 4. 密度（density）：comfortable / compact——行高与 padding 令牌
 *    （--density-py/--density-px/--density-line-height/--density-gap）；localStorage('ui.density')。
 * 5. 控件尺寸（controlScale + py/px ±px 微调）：compact/default/roomy 三档映射
 *    --ui-ctl-py/--ui-ctl-px/--ui-ctl-h 三组值（styles.css 缺省 = default 档 = 现版像素），
 *    并随密度档联动微调基数（紧凑档 -2/-2/-4px）；持久化 localStorage('ui.ctl', JSON)。
 * 6. 面板阴影（shadow）：none/subtle/medium/strong 四档映射 --ui-shadow-card/--ui-shadow-pop
 *    （及派生伴生 --ui-shadow-menu/--ui-shadow-ctl，见 styles.css 注释）；
 *    持久化 localStorage('ui.shadow')。
 * 7. 自定义覆盖（custom）：键值对直改任意 CSS 变量；持久化 localStorage('ui.tokens')。
 *
 * 全部经 document.documentElement.style.setProperty 应用（内联样式优先级高于样式表的
 * :root/.dark 定义，样式表仅承载缺省值）；重应用前先清空上一轮内联属性，保证
 * resetToDefaults() 与预设切换无残留。应用顺序固定：
 * mode → preset → radius/density → ctl/shadow → custom。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
export type ControlScale = 'compact' | 'default' | 'roomy';
export type ShadowLevel = 'none' | 'subtle' | 'medium' | 'strong';

/** 强调色预设：亮暗两套变量表（值与 styles.css 的 zinc 基调同构） */
export interface AccentPreset {
  id: string;
  label: string;
  light: Record<string, string>;
  dark: Record<string, string>;
}

const PRIMARY_KEYS = [
  '--primary',
  '--primary-foreground',
  '--ring',
  '--accent',
  '--accent-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-ring',
] as const;

/** 由色相生成一组完整的强调色变量（oklch） */
function accentOf(
  hue: number,
  opts: { lightChroma: number; darkChroma: number; lightTone: number; darkTone: number },
): Pick<AccentPreset, 'light' | 'dark'> {
  const { lightChroma, darkChroma, lightTone, darkTone } = opts;
  return {
    light: {
      '--primary': `oklch(${lightTone} ${lightChroma} ${hue})`,
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': `oklch(${lightTone} ${lightChroma} ${hue})`,
      '--accent': `oklch(0.96 ${Math.min(lightChroma, 0.06)} ${hue})`,
      '--accent-foreground': `oklch(${Math.max(lightTone - 0.15, 0.2)} ${lightChroma} ${hue})`,
      '--sidebar-primary': `oklch(${lightTone} ${lightChroma} ${hue})`,
      '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
      '--sidebar-ring': `oklch(${lightTone} ${lightChroma} ${hue})`,
    },
    dark: {
      '--primary': `oklch(${darkTone} ${darkChroma} ${hue})`,
      '--primary-foreground': 'oklch(0.141 0.005 285.823)',
      '--ring': `oklch(${darkTone} ${Math.max(darkChroma - 0.04, 0.02)} ${hue})`,
      '--accent': `oklch(0.3 ${Math.max(darkChroma - 0.06, 0.02)} ${hue})`,
      '--accent-foreground': `oklch(0.95 ${darkChroma} ${hue})`,
      '--sidebar-primary': `oklch(${darkTone} ${darkChroma} ${hue})`,
      '--sidebar-primary-foreground': 'oklch(0.141 0.005 285.823)',
      '--sidebar-ring': `oklch(${darkTone} ${darkChroma} ${hue})`,
    },
  };
}

/** 强调色预设 ≥6 组：default（zinc 黑白基调，即 styles.css 缺省）+ 彩色系 */
export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'default',
    label: '默认（锌灰）',
    light: {
      '--primary': 'oklch(0.21 0.006 285.885)',
      '--primary-foreground': 'oklch(0.985 0 0)',
      '--ring': 'oklch(0.705 0.015 286.067)',
      '--accent': 'oklch(0.967 0.001 286.375)',
      '--accent-foreground': 'oklch(0.21 0.006 285.885)',
      '--sidebar-primary': 'oklch(0.21 0.006 285.885)',
      '--sidebar-primary-foreground': 'oklch(0.985 0 0)',
      '--sidebar-ring': 'oklch(0.705 0.015 286.067)',
    },
    dark: {
      '--primary': 'oklch(0.92 0.004 286.32)',
      '--primary-foreground': 'oklch(0.21 0.006 285.885)',
      '--ring': 'oklch(0.552 0.016 285.938)',
      '--accent': 'oklch(0.274 0.006 286.033)',
      '--accent-foreground': 'oklch(0.985 0 0)',
      '--sidebar-primary': 'oklch(0.92 0.004 286.32)',
      '--sidebar-primary-foreground': 'oklch(0.21 0.006 285.885)',
      '--sidebar-ring': 'oklch(0.552 0.016 285.938)',
    },
  },
  {
    id: 'zinc',
    label: '石墨',
    ...accentOf(260, { lightChroma: 0.02, darkChroma: 0.03, lightTone: 0.45, darkTone: 0.75 }),
  },
  { id: 'violet', label: '紫罗兰', ...accentOf(295, { lightChroma: 0.22, darkChroma: 0.26, lightTone: 0.52, darkTone: 0.72 }) },
  { id: 'blue', label: '蓝色', ...accentOf(255, { lightChroma: 0.2, darkChroma: 0.23, lightTone: 0.55, darkTone: 0.7 }) },
  { id: 'emerald', label: '翠绿', ...accentOf(165, { lightChroma: 0.15, darkChroma: 0.17, lightTone: 0.5, darkTone: 0.72 }) },
  { id: 'amber', label: '琥珀', ...accentOf(70, { lightChroma: 0.16, darkChroma: 0.17, lightTone: 0.55, darkTone: 0.78 }) },
  { id: 'rose', label: '玫红', ...accentOf(15, { lightChroma: 0.21, darkChroma: 0.23, lightTone: 0.55, darkTone: 0.7 }) },
];

/** 圆角档位（--radius） */
export const RADIUS_STEPS: Array<{ value: string; label: string }> = [
  { value: '0rem', label: '直角' },
  { value: '0.25rem', label: '小圆角' },
  { value: '0.5rem', label: '中圆角' },
  { value: '0.75rem', label: '大圆角' },
  { value: '1rem', label: '全圆角' },
];

/** 密度档位变量表（行高与 padding 令牌） */
export const DENSITY_VARS: Record<Density, Record<string, string>> = {
  comfortable: {
    '--density-py': '0.5rem',
    '--density-px': '0.75rem',
    '--density-line-height': '1.5rem',
    '--density-gap': '0.5rem',
  },
  compact: {
    '--density-py': '0.25rem',
    '--density-px': '0.5rem',
    '--density-line-height': '1.25rem',
    '--density-gap': '0.25rem',
  },
};

// ---------------------------------------------------------------------------
// 控件尺寸（--ui-ctl-*）与面板阴影（--ui-shadow-*）
// ---------------------------------------------------------------------------

/** 控件尺寸档位基数（px）：default 档 = styles.css 缺省 = 现版像素（36/16/8） */
export const CONTROL_SCALES: Record<ControlScale, { py: number; px: number; h: number }> = {
  compact: { py: 6, px: 12, h: 32 },
  default: { py: 8, px: 16, h: 36 },
  roomy: { py: 10, px: 20, h: 40 },
};

/** 密度档对控件基数的联动微调（px）：紧凑档控件随之收紧，舒适档不动（= 现版） */
const DENSITY_CTL_ADJ: Record<Density, { py: number; px: number; h: number }> = {
  comfortable: { py: 0, px: 0, h: 0 },
  compact: { py: -2, px: -2, h: -4 },
};

/** py/px ±px 微调的取值范围（Settings 数字输入 ±1px 步进，边界裁剪） */
export const CTL_ADJ_MIN = -4;
export const CTL_ADJ_MAX = 4;
export const CTL_ADJ_STEP = 1;

/** 控件微调状态（档位 + py/px 偏移），持久化为 ui.ctl（JSON） */
export interface ControlTuning {
  scale: ControlScale;
  /** 纵向微调（px，±CTL_ADJ_RANGE 内，步进 1px） */
  pyAdj: number;
  /** 横向微调（px） */
  pxAdj: number;
}

/** 面板阴影四档：card=卡片/面板、pop=模态浮层、menu=菜单浮层、ctl=控件微阴影（派生伴生） */
export const SHADOW_PRESETS: Record<ShadowLevel, Record<string, string>> = {
  none: {
    '--ui-shadow-card': '0 0 #0000',
    '--ui-shadow-pop': '0 0 #0000',
    '--ui-shadow-menu': '0 0 #0000',
    '--ui-shadow-ctl': '0 0 #0000',
  },
  subtle: {
    // 与 styles.css :root 缺省一致 = Tailwind shadow-sm/lg/md/xs（现版像素）
    '--ui-shadow-card': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    '--ui-shadow-pop': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    '--ui-shadow-menu': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    '--ui-shadow-ctl': '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  medium: {
    '--ui-shadow-card': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    '--ui-shadow-pop': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    '--ui-shadow-menu': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    '--ui-shadow-ctl': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  strong: {
    '--ui-shadow-card': '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    '--ui-shadow-pop': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    '--ui-shadow-menu': '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    '--ui-shadow-ctl': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  },
};

/**
 * 由档位 + 密度联动 + 用户微调合成 --ui-ctl-* 三值（px 字符串，供 setProperty）。
 * 合成顺序：档位基数 → 密度微调 → 用户 ±px（最终值下限裁剪，避免负内边距）。
 */
export function ctlVarValues(tuning: ControlTuning, density: Density): Record<string, string> {
  const base = CONTROL_SCALES[tuning.scale];
  const adj = DENSITY_CTL_ADJ[density];
  const v = (basePart: number, adjPart: number, userAdj: number, min: number): string =>
    `${Math.max(basePart + adjPart + userAdj, min)}px`;
  return {
    '--ui-ctl-py': v(base.py, adj.py, tuning.pyAdj, 2),
    '--ui-ctl-px': v(base.px, adj.px, tuning.pxAdj, 2),
    '--ui-ctl-h': v(base.h, adj.h, 0, 24),
  };
}

// ---------------------------------------------------------------------------
// 持久化键（与 index.html 防闪烁脚本、Settings 外观定制器共用）
// ---------------------------------------------------------------------------

const MODE_KEY = 'ui.mode';
const ACCENT_KEY = 'ui.accent';
const RADIUS_KEY = 'ui.radius';
const DENSITY_KEY = 'ui.density';
/** 控件尺寸（档位 + py/px 微调，JSON） */
const CTL_KEY = 'ui.ctl';
/** 面板阴影档位 */
const SHADOW_KEY = 'ui.shadow';
const CUSTOM_KEY = 'ui.tokens';

export const DEFAULT_MODE: ThemeMode = 'system';
export const DEFAULT_ACCENT = 'default';
export const DEFAULT_RADIUS = '0.5rem';
export const DEFAULT_DENSITY: Density = 'comfortable';
export const DEFAULT_CONTROL_SCALE: ControlScale = 'default';
export const DEFAULT_CTL_ADJ = 0;
export const DEFAULT_SHADOW: ShadowLevel = 'subtle';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等存储不可用：主题仅本次会话生效 */
  }
}

function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

function readCustomTokens(): Record<string, string> {
  const raw = readStored(CUSTOM_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k.startsWith('--') && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

const CONTROL_SCALES_SET = new Set<string>(Object.keys(CONTROL_SCALES));
const SHADOW_LEVELS = new Set<string>(Object.keys(SHADOW_PRESETS));

function clampAdj(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_CTL_ADJ;
  return Math.min(Math.max(Math.round(n), CTL_ADJ_MIN), CTL_ADJ_MAX);
}

/** 解析 ui.ctl（JSON：{scale,pyAdj,pxAdj}；兼容旧版纯档位字符串；非法回退缺省） */
function readCtlTuning(): ControlTuning {
  const raw = readStored(CTL_KEY);
  if (raw === null) return { scale: DEFAULT_CONTROL_SCALE, pyAdj: DEFAULT_CTL_ADJ, pxAdj: DEFAULT_CTL_ADJ };
  try {
    const parsed: unknown = JSON.parse(raw);
    // 旧格式兼容：直接存档位字符串
    if (typeof parsed === 'string' && CONTROL_SCALES_SET.has(parsed)) {
      return { scale: parsed as ControlScale, pyAdj: DEFAULT_CTL_ADJ, pxAdj: DEFAULT_CTL_ADJ };
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { scale: DEFAULT_CONTROL_SCALE, pyAdj: DEFAULT_CTL_ADJ, pxAdj: DEFAULT_CTL_ADJ };
    }
    const obj = parsed as Record<string, unknown>;
    const scale = typeof obj.scale === 'string' && CONTROL_SCALES_SET.has(obj.scale)
      ? (obj.scale as ControlScale)
      : DEFAULT_CONTROL_SCALE;
    return {
      scale,
      pyAdj: typeof obj.pyAdj === 'number' ? clampAdj(obj.pyAdj) : DEFAULT_CTL_ADJ,
      pxAdj: typeof obj.pxAdj === 'number' ? clampAdj(obj.pxAdj) : DEFAULT_CTL_ADJ,
    };
  } catch {
    return { scale: DEFAULT_CONTROL_SCALE, pyAdj: DEFAULT_CTL_ADJ, pxAdj: DEFAULT_CTL_ADJ };
  }
}

function readShadowLevel(): ShadowLevel {
  const stored = readStored(SHADOW_KEY);
  return stored !== null && SHADOW_LEVELS.has(stored) ? (stored as ShadowLevel) : DEFAULT_SHADOW;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark';
  accent: string;
  radius: string;
  density: Density;
  /** 控件尺寸档位（compact/default/roomy → --ui-ctl-* 三组值） */
  controlScale: ControlScale;
  /** 控件 py/px ±px 微调（与 controlScale 一并存于 ui.ctl） */
  ctlAdjust: { py: number; px: number };
  /** 面板阴影档位（none/subtle/medium/strong → --ui-shadow-* 四组值） */
  shadow: ShadowLevel;
  /** 自定义 CSS 变量覆盖（键须以 -- 开头） */
  customTokens: Record<string, string>;
  setMode(mode: ThemeMode): void;
  setAccent(id: string): void;
  setRadius(value: string): void;
  setDensity(density: Density): void;
  setControlScale(scale: ControlScale): void;
  /** 合并写入 py/px 微调（未提供的维度保持不变；越界自动裁剪） */
  setCtlAdjust(adj: { py?: number; px?: number }): void;
  setShadow(level: ShadowLevel): void;
  /** 合并写入自定义覆盖（传 null 值表示删除该键） */
  setCustomTokens(tokens: Record<string, string | null>): void;
  /** 清空全部主题偏好（模式/预设/圆角/密度/控件/阴影/自定义），恢复 styles.css 缺省 */
  resetToDefaults(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = readStored(MODE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_MODE;
  });
  const [accent, setAccentState] = useState<string>(() => {
    const stored = readStored(ACCENT_KEY);
    return ACCENT_PRESETS.some((p) => p.id === stored) ? (stored as string) : DEFAULT_ACCENT;
  });
  const [radius, setRadiusState] = useState<string>(() => {
    const stored = readStored(RADIUS_KEY);
    return RADIUS_STEPS.some((s) => s.value === stored) ? (stored as string) : DEFAULT_RADIUS;
  });
  const [density, setDensityState] = useState<Density>(() => {
    const stored = readStored(DENSITY_KEY);
    return stored === 'comfortable' || stored === 'compact' ? stored : DEFAULT_DENSITY;
  });
  const [ctl, setCtlState] = useState<ControlTuning>(readCtlTuning);
  const [shadow, setShadowState] = useState<ShadowLevel>(readShadowLevel);
  const [customTokens, setCustomTokensState] = useState<Record<string, string>>(readCustomTokens);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // system 模式跟随系统切换
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolvedMode: 'light' | 'dark' = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  // 已应用的内联属性登记表：重应用前整体清空，避免预设/自定义切换与 reset 残留
  const appliedProps = useRef<Set<string>>(new Set());

  useEffect(() => {
    const root = document.documentElement;
    // 1. mode：class 策略 + colorScheme（样式表缺省随之切换）
    root.classList.toggle('dark', resolvedMode === 'dark');
    root.style.colorScheme = resolvedMode;

    // 清空上一轮内联覆盖
    for (const prop of appliedProps.current) root.style.removeProperty(prop);
    appliedProps.current.clear();
    const apply = (vars: Record<string, string>): void => {
      for (const [k, v] of Object.entries(vars)) {
        root.style.setProperty(k, v);
        appliedProps.current.add(k);
      }
    };

    // 2. 强调色预设（按解析后的亮暗取值）
    const preset = ACCENT_PRESETS.find((p) => p.id === accent) ?? ACCENT_PRESETS[0];
    if (preset !== undefined && preset.id !== DEFAULT_ACCENT) {
      apply(resolvedMode === 'dark' ? preset.dark : preset.light);
    }

    // 3. 圆角档位 + 密度令牌
    apply({ '--radius': radius });
    apply(DENSITY_VARS[density]);

    // 4. 控件尺寸（档位 + 密度联动 + 微调）与面板阴影档位
    apply(ctlVarValues(ctl, density));
    apply(SHADOW_PRESETS[shadow]);

    // 5. 自定义覆盖（最后应用，优先级最高）
    apply(customTokens);
  }, [resolvedMode, accent, radius, density, ctl, shadow, customTokens]);

  const setMode = useCallback((next: ThemeMode): void => {
    setModeState(next);
    writeStored(MODE_KEY, next);
  }, []);
  const setAccent = useCallback((id: string): void => {
    setAccentState(id);
    writeStored(ACCENT_KEY, id);
  }, []);
  const setRadius = useCallback((value: string): void => {
    setRadiusState(value);
    writeStored(RADIUS_KEY, value);
  }, []);
  const setDensity = useCallback((next: Density): void => {
    setDensityState(next);
    writeStored(DENSITY_KEY, next);
  }, []);
  /** 合并写入控件微调（ui.ctl 整体持久化） */
  const updateCtl = useCallback((patch: Partial<ControlTuning>): void => {
    setCtlState((prev) => {
      const next: ControlTuning = {
        scale: patch.scale ?? prev.scale,
        pyAdj: patch.pyAdj === undefined ? prev.pyAdj : clampAdj(patch.pyAdj),
        pxAdj: patch.pxAdj === undefined ? prev.pxAdj : clampAdj(patch.pxAdj),
      };
      writeStored(CTL_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const setControlScale = useCallback((scale: ControlScale): void => updateCtl({ scale }), [updateCtl]);
  const setCtlAdjust = useCallback(
    (adj: { py?: number; px?: number }): void => updateCtl({ pyAdj: adj.py, pxAdj: adj.px }),
    [updateCtl],
  );
  const setShadow = useCallback((level: ShadowLevel): void => {
    setShadowState(level);
    writeStored(SHADOW_KEY, level);
  }, []);
  const setCustomTokens = useCallback((tokens: Record<string, string | null>): void => {
    setCustomTokensState((prev) => {
      const next = { ...prev };
      for (const [k, v] of Object.entries(tokens)) {
        if (v === null) delete next[k];
        else if (k.startsWith('--')) next[k] = v;
      }
      writeStored(CUSTOM_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const resetToDefaults = useCallback((): void => {
    removeStored(MODE_KEY);
    removeStored(ACCENT_KEY);
    removeStored(RADIUS_KEY);
    removeStored(DENSITY_KEY);
    removeStored(CTL_KEY);
    removeStored(SHADOW_KEY);
    removeStored(CUSTOM_KEY);
    setModeState(DEFAULT_MODE);
    setAccentState(DEFAULT_ACCENT);
    setRadiusState(DEFAULT_RADIUS);
    setDensityState(DEFAULT_DENSITY);
    setCtlState({ scale: DEFAULT_CONTROL_SCALE, pyAdj: DEFAULT_CTL_ADJ, pxAdj: DEFAULT_CTL_ADJ });
    setShadowState(DEFAULT_SHADOW);
    setCustomTokensState({});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedMode,
      accent,
      radius,
      density,
      controlScale: ctl.scale,
      ctlAdjust: { py: ctl.pyAdj, px: ctl.pxAdj },
      shadow,
      customTokens,
      setMode,
      setAccent,
      setRadius,
      setDensity,
      setControlScale,
      setCtlAdjust,
      setShadow,
      setCustomTokens,
      resetToDefaults,
    }),
    [
      mode,
      resolvedMode,
      accent,
      radius,
      density,
      ctl,
      shadow,
      customTokens,
      setMode,
      setAccent,
      setRadius,
      setDensity,
      setControlScale,
      setCtlAdjust,
      setShadow,
      setCustomTokens,
      resetToDefaults,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) throw new Error('useTheme 必须在 <ThemeProvider> 内使用');
  return ctx;
}

/** 供测试/工具校验的预设变量键清单（运行期不直接使用） */
export const ACCENT_TOKEN_KEYS: readonly string[] = PRIMARY_KEYS;
