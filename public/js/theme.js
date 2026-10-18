// Light / dark / follow-the-system, remembered on this device.
const KEY = 'nestly-theme';
export const THEMES = ['system', 'light', 'dark'];

export function getTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* private mode: the choice just won't persist */
  }
  applyTheme();
}

export function applyTheme() {
  const mode = getTheme();
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}
