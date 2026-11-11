export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'notes.theme';

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    // Storage unavailable: fall back to the system theme.
  }
  return 'auto';
}

/** `auto` follows the system; the CSS tokens in app.css key off `data-theme`. */
export function applyThemePref(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'auto') delete root.dataset.theme;
  else root.dataset.theme = pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Not remembered, still applied for this session.
  }
}

export function onSystemThemeChange(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

/** Small typed wrapper for UI preferences kept in localStorage. */
export function pref<T>(key: string, fallback: T): { get(): T; set(v: T): void } {
  const k = `notes.${key}`;
  return {
    get() {
      try {
        const raw = localStorage.getItem(k);
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    set(v: T) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        // Ignore: the preference just is not remembered.
      }
    },
  };
}
