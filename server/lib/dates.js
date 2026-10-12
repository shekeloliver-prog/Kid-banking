// Calendar-date helpers. Allowance schedules are plain YYYY-MM-DD strings that
// are interpreted in the parent's timezone, so "Friday" means the parent's Friday.

const pad = (n) => String(n).padStart(2, '0');

export function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
const formatters = new Map();
export function dateInZone(date, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) formatters.set(timeZone, (f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(date);
}

export function addDays(s, n) {
  const { y, m, d } = parseYmd(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function weekday(s) {
  const { y, m, d } = parseYmd(s);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextWeekdayAfter(s, wd) {
  let delta = (wd - weekday(s) + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(s, delta);
}

// Day-of-month is limited to 1–28 so every month has it.
function nextMonthDayAfter(s, dom) {
  const { y, m, d } = parseYmd(s);
  if (d < dom) return ymd(y, m, dom);
  return m === 12 ? ymd(y + 1, 1, dom) : ymd(y, m + 1, dom);
}

/** First payment date: the next matching day strictly after `today`. */
export function firstDue(today, freq, day) {
  return freq === 'monthly' ? nextMonthDayAfter(today, day) : nextWeekdayAfter(today, day);
}

/** The payment date following `date`. */
export function advance(date, freq, day) {
  if (freq === 'weekly') return addDays(date, 7);
  if (freq === 'biweekly') return addDays(date, 14);
  return nextMonthDayAfter(date, day);
}
