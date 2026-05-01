import { useCallback, useEffect, useState } from 'react';

export type Density = 'compact' | 'regular' | 'comfy';
export type Theme = 'light' | 'dark';

const KEY_DENSITY = 'op_dash_density';
const KEY_THEME = 'op_dash_theme';
const KEY_ORDER = 'op_dash_section_order';

function readLs(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

export function useDensity(): [Density, (d: Density) => void] {
  const [d, setD] = useState<Density>(() => (readLs(KEY_DENSITY, 'regular') as Density));
  useEffect(() => { try { localStorage.setItem(KEY_DENSITY, d); } catch { /* ignore */ } }, [d]);
  return [d, setD];
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [t, setT] = useState<Theme>(() => (readLs(KEY_THEME, 'light') as Theme));
  useEffect(() => { try { localStorage.setItem(KEY_THEME, t); } catch { /* ignore */ } }, [t]);
  return [t, setT];
}

/**
 * Persisted section ordering. Returns the user's chosen order (or null if
 * never set). The default ordering lives in the section registry.
 *
 * For now, ordering is localStorage-only. When a backend pref column lands,
 * swap this hook for a server-backed one without touching consumers.
 */
export function useSectionOrder(): [string[] | null, (order: string[]) => void] {
  const [order, setOrder] = useState<string[] | null>(() => {
    const raw = readLs(KEY_ORDER, '');
    if (!raw) return null;
    try { return JSON.parse(raw) as string[]; } catch { return null; }
  });
  const save = useCallback((next: string[]) => {
    setOrder(next);
    try { localStorage.setItem(KEY_ORDER, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);
  return [order, save];
}
