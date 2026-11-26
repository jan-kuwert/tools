import type { FrameId } from './editor';

// Preferences only. Never store documents, filenames or consent here.
const KEY = 'tools:prefs';

export interface Prefs {
  theme?: 'system' | 'light' | 'dark';
  imageFormat?: 'image/jpeg' | 'image/png' | 'image/webp';
  imageQuality?: number;
  editorFrame?: FrameId;
}

export const loadPrefs = (): Prefs => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
};

export const savePrefs = (patch: Prefs): void => {
  localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
};

export const resetPrefs = (): void => {
  localStorage.removeItem(KEY);
  delete document.documentElement.dataset.theme;
};

export const applyTheme = (theme: Prefs['theme']): void => {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
};

export const cycleTheme = (): void => {
  const order: NonNullable<Prefs['theme']>[] = ['system', 'light', 'dark'];
  const next = order[(order.indexOf(loadPrefs().theme ?? 'system') + 1) % order.length];
  savePrefs({ theme: next });
  applyTheme(next);
};
