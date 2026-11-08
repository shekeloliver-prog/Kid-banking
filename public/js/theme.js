// Display preferences, remembered on this device: light / dark / follow-the-system, text size, and reduced motion.
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

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just won't persist */
  }
};

export const getTextSize = () => (read('nestly-text') === 'large' ? 'large' : 'normal');
export function setTextSize(size) {
  write('nestly-text', size === 'large' ? 'large' : null);
  applyTheme();
}

/** True when the person turned on "Reduce motion" here (a device-level setting is honoured separately by CSS). */
export const getReduceMotion = () => read('nestly-motion') === 'reduce';
export function setReduceMotion(on) {
  write('nestly-motion', on ? 'reduce' : null);
  applyTheme();
}

export function applyTheme() {
  const root = document.documentElement;
  const mode = getTheme();
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  if (getTextSize() === 'large') root.setAttribute('data-text', 'large');
  else root.removeAttribute('data-text');
  if (getReduceMotion()) root.setAttribute('data-motion', 'reduce');
  else root.removeAttribute('data-motion');
}
