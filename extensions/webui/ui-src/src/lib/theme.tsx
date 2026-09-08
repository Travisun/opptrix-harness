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
 * theme — 主题 Token 体系（模式 → 预设 → 自定义，按序覆盖）。
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
 * 5. 自定义覆盖（custom）：键值对直改任意 CSS 变量；持久化 localStorage('ui.tokens')。
 *
 * 全部经 document.documentElement.style.setProperty 应用（内联样式优先级高于样式表的
 * :root/.dark 定义，样式表仅承载缺省值）；重应用前先清空上一轮内联属性，保证
 * resetToDefaults() 与预设切换无残留。应用顺序固定：mode → preset → radius/density → custom。
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

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
// 持久化键（与 index.html 防闪烁脚本、Settings 外观定制器共用）
// ---------------------------------------------------------------------------

const MODE_KEY = 'ui.mode';
const ACCENT_KEY = 'ui.accent';
const RADIUS_KEY = 'ui.radius';
const DENSITY_KEY = 'ui.density';
const CUSTOM_KEY = 'ui.tokens';

export const DEFAULT_MODE: ThemeMode = 'system';
export const DEFAULT_ACCENT = 'default';
export const DEFAULT_RADIUS = '0.5rem';
export const DEFAULT_DENSITY: Density = 'comfortable';

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

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: 'light' | 'dark';
  accent: string;
  radius: string;
  density: Density;
  /** 自定义 CSS 变量覆盖（键须以 -- 开头） */
  customTokens: Record<string, string>;
  setMode(mode: ThemeMode): void;
  setAccent(id: string): void;
  setRadius(value: string): void;
  setDensity(density: Density): void;
  /** 合并写入自定义覆盖（传 null 值表示删除该键） */
  setCustomTokens(tokens: Record<string, string | null>): void;
  /** 清空全部主题偏好（模式/预设/圆角/密度/自定义），恢复 styles.css 缺省 */
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

    // 4. 自定义覆盖（最后应用，优先级最高）
    apply(customTokens);
  }, [resolvedMode, accent, radius, density, customTokens]);

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
    removeStored(CUSTOM_KEY);
    setModeState(DEFAULT_MODE);
    setAccentState(DEFAULT_ACCENT);
    setRadiusState(DEFAULT_RADIUS);
    setDensityState(DEFAULT_DENSITY);
    setCustomTokensState({});
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedMode,
      accent,
      radius,
      density,
      customTokens,
      setMode,
      setAccent,
      setRadius,
      setDensity,
      setCustomTokens,
      resetToDefaults,
    }),
    [mode, resolvedMode, accent, radius, density, customTokens, setMode, setAccent, setRadius, setDensity, setCustomTokens, resetToDefaults],
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
