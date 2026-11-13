import { useCallback, useSyncExternalStore } from 'react';

// The portal's theme (P3-1): dark or light, as `data-theme` on <html> (tokens.css has a block for each). The default
// is what the system prefers (`prefers-color-scheme`) and follows it while the person has not chosen; a choice made
// with the toggle in the top bar is remembered in this browser only (localStorage, a convenience: storage that is
// blocked or full simply means the system default next time).

export type Theme = 'dark' | 'light';

export const THEME_KEY = 'aisdlc.theme';

function stored(): Theme | null {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function prefersLight(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: light)')
      : null;
  } catch {
    return null;
  }
}

/** The theme in force: the person's choice in this browser, else the system's preference, else dark. */
export function currentTheme(): Theme {
  return stored() ?? (prefersLight()?.matches ? 'light' : 'dark');
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function apply(t: Theme): void {
  document.documentElement.dataset['theme'] = t;
  notify();
}

/** Sets `data-theme` before the first render and follows the system while nothing is chosen. */
export function initTheme(): void {
  apply(currentTheme());
  const mq = prefersLight();
  mq?.addEventListener?.('change', () => {
    if (stored() === null) apply(currentTheme());
  });
}

/** Chooses a theme for this browser (and applies it at once). */
export function chooseTheme(t: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, t);
  } catch {
    // not remembered: it still applies for this page
  }
  apply(t);
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const snapshot = (): Theme =>
  document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark';

export function useTheme(): readonly [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, snapshot, snapshot);
  const set = useCallback((t: Theme) => chooseTheme(t), []);
  return [theme, set] as const;
}
