const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const money = (cents) => usd.format(cents / 100);
/** $5 for whole amounts, $5.50 otherwise. */
export const moneyCompact = (cents) => (cents % 100 === 0 ? usdWhole.format(cents / 100) : usd.format(cents / 100));
export const signedMoney = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + usd.format(Math.abs(cents) / 100);

/** Parses what someone typed into a money box ("12", "12.5", "$1,200.05") to cents, or NaN. */
export function parseMoney(str) {
  const s = String(str).replace(/[$,\s]/g, '');
  if (!/^\d*\.?\d{0,2}$/.test(s) || s === '' || s === '.') return NaN;
  return Math.round(parseFloat(s) * 100);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (i) => WEEKDAYS[i];

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** A YYYY-MM-DD string as a local Date (no timezone shifting). */
export function ymdToDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function formatDay(ymd, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return ymdToDate(ymd).toLocaleDateString('en-US', opts);
}

export const localYmd = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const key = localYmd(d);
  if (key === localYmd(today)) return 'Today';
  if (key === localYmd(yesterday)) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const timeOnly = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 6) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function describeAllowance(a) {
  if (!a.active) return null;
  const when = a.freq === 'monthly' ? `on the ${ordinal(a.day)}` : `every ${a.freq === 'biweekly' ? 'other ' : ''}${weekdayName(a.day)}`;
  return `${moneyCompact(a.cents)} ${when}`;
}

export function inDays(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(ms / 86400000);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export const CATEGORY = {
  food: { emoji: '🍕', label: 'Food' },
  games: { emoji: '🎮', label: 'Games' },
  toys: { emoji: '🧸', label: 'Toys' },
  books: { emoji: '📚', label: 'Books' },
  fun: { emoji: '🎬', label: 'Fun' },
  gifts: { emoji: '🎁', label: 'Gifts' },
  other: { emoji: '✨', label: 'Other' },
};

// Spending breakdowns also include goal purchases, which aren't a category kids can pick.
export const CATEGORY_LABEL = { ...CATEGORY, goals: { emoji: '🎯', label: 'Savings goals' } };
export const CHORE_EMOJI = ['🧹', '🍽️', '🗑️', '🛏️', '🐕', '🌱', '🚗', '📚', '👕', '🧺', '🪥', '🧽'];
export const REPEAT_LABEL = { once: 'One time', daily: 'Every day', weekly: 'Every week' };

/** 520 → "5.2%" */
export const ratePercent = (bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2).replace(/(\.\d)0$/, '$1')}%`;
/** What a year of interest at this rate adds per week on a given amount. */
export const weeklyInterest = (savedCents, bps) => Math.floor((savedCents * bps) / 10000 / 52);

export const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐯', '🐙', '🦁', '🐧', '🐨', '🐶', '🐱', '🦖', '🚀', '⚽', '🎨', '🎮'];
export const COLORS = ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'pink', 'red'];
export const GOAL_EMOJI = ['🎯', '🚲', '🎮', '🧸', '📱', '🎧', '👟', '🎸', '⚽', '🎨', '🚀', '📚', '🎁', '🏕️', '🛹', '🐶'];
