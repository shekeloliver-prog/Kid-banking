import { h, setBusy } from './dom.js';
import { icon } from './icons.js';
import { money, parseMoney, dayLabel, timeOnly, CATEGORY, moneyCompact, formatDay } from './format.js';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────── small pieces ─────────────────────────

export const avatar = (who, size = 'md') =>
  h('span', { class: `avatar av-${size}`, dataset: { color: who.color }, 'aria-hidden': 'true' }, who.avatar);

export const pill = (label, tone = '', iconName) =>
  h('span', { class: `pill ${tone ? 'pill-' + tone : ''}` }, iconName ? icon(iconName, 13) : null, label);

export function emptyState({ emoji = '✨', title, text, action }) {
  return h('div', { class: 'empty' }, h('div', { class: 'art', 'aria-hidden': 'true' }, emoji), h('h3', null, title), text ? h('p', null, text) : null, action);
}

export function skeleton(kind = 'page') {
  const card = () => h('div', { class: 'skeleton sk-card' });
  if (kind === 'list') return h('div', { class: 'stack-sm' }, card(), card());
  return h('div', { class: 'stack-lg', 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div', { class: 'skeleton', style: { height: '36px', width: '40%' } }), h('div', { class: 'skeleton', style: { height: '170px', 'border-radius': '28px' } }), h('div', { class: 'grid grid-3' }, card(), card(), card()));
}

export function errorState(err, retry) {
  return emptyState({
    emoji: '😕',
    title: "That didn't load",
    text: err?.message ?? 'Something went wrong.',
    action: h('button', { class: 'btn btn-primary', onClick: retry }, 'Try again'),
  });
}

export function banner(tone, iconName, ...content) {
  return h('div', { class: `banner ${tone}`, role: tone === 'danger' ? 'alert' : undefined }, icon(iconName, 20), h('div', null, ...content));
}

export function meter({ label, value, max, textRight, tone }) {
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const auto = tone ?? (p >= 1 ? 'danger' : p >= 0.8 ? 'warn' : '');
  return h(
    'div',
    { class: 'meter' },
    h('div', { class: 'meter-top' }, h('span', null, label), h('span', null, textRight)),
    h('div', { class: `progress ${auto}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(p * 100) }, h('span', { style: { '--p': p } })),
  );
}

// ───────────────────────── toasts ─────────────────────────

let toastHost;
export function toast(message, { tone = 'success', emoji } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: `toast ${tone === 'error' ? 'error' : ''}` }, h('span', { class: 'e', 'aria-hidden': 'true' }, emoji ?? (tone === 'error' ? '⚠️' : '✅')), h('span', null, message));
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, tone === 'error' ? 5200 : 3200);
}

// ───────────────────────── modals ─────────────────────────

export function openModal({ title, subtitle, body, footer, container, onClose }) {
  const dlg = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' });
  const close = () => {
    if (dlg.open) dlg.close();
  };
  const bodyEl = h('div', { class: 'modal-body' }, body);
  // `container` lets a caller supply a <form> so Enter submits and buttons are associated with it.
  const main = container ?? h('div');
  main.classList.add('modal-form');
  main.append(bodyEl, footer ?? '');
  dlg.appendChild(
    h(
      'div',
      { class: 'modal-in' },
      h(
        'div',
        { class: 'modal-head' },
        h('div', null, h('h2', { id: 'modal-title' }, title), subtitle ? h('p', null, subtitle) : null),
        h('button', { class: 'btn btn-ghost btn-icon btn-sm x', type: 'button', 'aria-label': 'Close', onClick: close }, icon('x', 18)),
      ),
      main,
    ),
  );
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  const first = dlg.querySelector('[data-autofocus]') ?? dlg.querySelector('input:not([type=hidden]), select, textarea');
  if (first) first.focus();
  return { el: dlg, close, bodyEl };
}

/**
 * A modal wrapping a form. `onSubmit(modal)` does the work; throw to show an inline error,
 * return `false` to keep the dialog open, anything else closes it.
 */
export function formModal({ title, subtitle, fields, submitLabel = 'Save', tone = 'primary', cancelLabel = 'Cancel', onSubmit, accent }) {
  const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: `btn btn-${accent && tone === 'primary' ? 'accent' : tone}`, type: 'submit' }, submitLabel);
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button' }, cancelLabel);
  const modal = openModal({
    title,
    subtitle,
    container: h('form', { novalidate: true }),
    body: [error, fields],
    footer: h('div', { class: 'modal-foot' }, cancel, submit),
  });
  if (accent) modal.el.dataset.color = accent;
  cancel.addEventListener('click', modal.close);

  const showError = (msg) => {
    error.replaceChildren(icon('info', 18), h('span', null, msg));
    error.hidden = false;
    modal.bodyEl.scrollTo?.({ top: 0, behavior: 'smooth' });
  };
  modal.el.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    setBusy(submit, true);
    try {
      const result = await onSubmit({ ...modal, showError });
      if (result !== false) modal.close();
    } catch (err) {
      showError(err.message || 'Something went wrong.');
    } finally {
      setBusy(submit, false);
    }
  });
  return { ...modal, showError };
}

export function confirmModal({ title, text, confirmLabel = 'Confirm', tone = 'danger', onConfirm, extra }) {
  return formModal({
    title,
    fields: [h('p', { class: 'text-2' }, text), extra ?? null],
    submitLabel: confirmLabel,
    tone,
    onSubmit: onConfirm,
  });
}

// ───────────────────────── fields ─────────────────────────

let uid = 0;
export const nextId = (p = 'f') => `${p}${++uid}`;

export function textField({ label, hint, type = 'text', value = '', placeholder, autocomplete, maxlength, inputmode, autofocus, name }) {
  const id = nextId();
  const input = h('input', { class: 'input', id, type, value, placeholder, autocomplete, maxlength, inputmode, name, 'data-autofocus': autofocus ? '' : undefined });
  return { el: h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null), input };
}

export function passwordField({ label, hint, autocomplete = 'current-password', placeholder, autofocus, name }) {
  const id = nextId();
  const input = h('input', { class: 'input', id, type: 'password', autocomplete, placeholder, name, 'data-autofocus': autofocus ? '' : undefined });
  const toggle = h('button', { class: 'reveal', type: 'button', 'aria-label': 'Show password' }, icon('eye', 20));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye', 20));
  });
  return { el: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'input-wrap' }, input, toggle), hint ? h('div', { class: 'hint' }, hint) : null), input };
}

/** Dollar input. getCents() returns NaN until the box holds a valid amount. */
export function moneyField({ label = 'Amount', value = 0, quick = [500, 1000, 2000, 5000], hint, autofocus = true }) {
  const id = nextId();
  const input = h('input', { class: 'input', id, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', 'data-autofocus': autofocus ? '' : undefined });
  const listeners = [];
  const set = (cents) => {
    input.value = cents ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '';
    listeners.forEach((fn) => fn());
  };
  input.addEventListener('input', () => {
    let v = input.value.replace(/[^0-9.]/g, '');
    const dot = v.indexOf('.');
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
    if (v !== input.value) input.value = v;
    listeners.forEach((fn) => fn());
  });
  const chips = quick.length
    ? h('div', { class: 'chips' }, quick.map((c) => h('button', { class: 'chip', type: 'button', onClick: () => { set(c); input.focus(); } }, moneyCompact(c))))
    : null;
  if (value) set(value);
  return {
    el: h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'money-input' }, h('span', { class: 'cur', 'aria-hidden': 'true' }, '$'), input), chips, hint ? h('div', { class: 'hint' }, hint) : null),
    input,
    getCents: () => parseMoney(input.value),
    set,
    onChange: (fn) => listeners.push(fn),
  };
}

export function switchControl({ checked = false, label, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, 'aria-label': label });
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return { el: h('label', { class: 'switch' }, input, h('span', { class: 'track' })), input };
}

export function pickerGrid({ items, value, className, render, onPick, label }) {
  let current = value;
  const buttons = items.map((item) => {
    const b = render(item);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(item === current));
    b.addEventListener('click', () => {
      current = item;
      buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(items[i] === current)));
      onPick?.(item);
    });
    return b;
  });
  const el = h('div', { class: className, role: 'group', 'aria-label': label }, buttons);
  return { el, get: () => current };
}

// ───────────────────────── activity ─────────────────────────

/** Turns a ledger row into display bits. `view` is whose eyes are looking at it. */
export function describeTx(tx, view) {
  const who = tx.owner?.name;
  const cp = tx.counterparty ?? 'someone';
  const cat = CATEGORY[tx.category] ?? CATEGORY.other;
  const goalName = tx.counterparty ?? 'a goal';
  switch (tx.kind) {
    case 'deposit':
      return { icon: 'plus', tone: 'pos', title: 'Added practice funds', sub: null };
    case 'send':
      return { icon: 'send', tone: 'info', title: `Sent to ${cp}`, sub: tx.note };
    case 'receive':
      return { icon: 'receive', tone: 'pos', title: `From ${cp}`, sub: tx.note };
    case 'allowance_out':
      return { icon: 'calendar', tone: 'info', title: `Allowance to ${cp}`, sub: tx.note };
    case 'allowance_in':
      return { icon: 'calendar', tone: 'pos', title: 'Allowance', sub: `${tx.note ?? ''}`.trim() || `From ${cp}` };
    case 'takeback_in':
      return { icon: 'undo', tone: 'warn', title: `Taken back from ${cp}`, sub: tx.note };
    case 'takeback_out':
      return { icon: 'undo', tone: 'warn', title: `Returned to ${cp}`, sub: tx.note };
    case 'closed_in':
      return { icon: 'users', tone: 'warn', title: tx.note ?? 'Account closed', sub: null };
    case 'spend':
      return { emoji: cat.emoji, tone: 'neg', title: view === 'parent' ? `${who} spent on ${cat.label.toLowerCase()}` : cat.label, sub: tx.note };
    case 'goal_save':
      return { icon: 'target', tone: 'primary', title: view === 'parent' ? `${who} saved for “${goalName}”` : `Saved for “${goalName}”`, sub: null, neutral: true };
    case 'goal_release':
      return { icon: 'target', tone: 'warn', title: view === 'parent' ? `${who} took money out of “${goalName}”` : `Took out of “${goalName}”`, sub: null, neutral: true };
    case 'goal_purchase':
      return { icon: 'gift', tone: 'neg', title: view === 'parent' ? `${who} bought “${goalName}”` : `Bought “${goalName}”`, sub: '🎉 Goal reached' };
    default:
      return { icon: 'list', tone: '', title: tx.kind, sub: tx.note };
  }
}

export function txRow(tx, view) {
  const d = describeTx(tx, view);
  const amountClass = d.neutral ? 'muted' : tx.amountCents > 0 ? 'pos' : tx.amountCents < 0 ? 'neg' : '';
  const sign = d.neutral ? '' : tx.amountCents > 0 ? '+' : tx.amountCents < 0 ? '−' : '';
  const sub = [d.sub, timeOnly(tx.createdAt)].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'row' },
    d.emoji ? h('div', { class: `row-icon ${d.tone}`, 'aria-hidden': 'true' }, d.emoji) : h('div', { class: `row-icon ${d.tone}` }, icon(d.icon, 20)),
    h('div', { class: 'row-main' }, h('div', { class: 'row-title ellipsis' }, d.title), h('div', { class: 'row-sub ellipsis' }, sub)),
    h('div', { class: `row-amount ${amountClass}` }, sign + money(Math.abs(tx.amountCents))),
  );
}

/** A day-grouped activity list. Pass `loadMore` to get a "Show more" button. */
export function activityList(items, view, { loadMore, hasMore, emptyText } = {}) {
  const root = h('div', { class: 'card card-flush' });
  const list = h('div', { class: 'list' });
  root.appendChild(list);
  let lastDay = null;
  const add = (rows) => {
    for (const tx of rows) {
      const label = dayLabel(tx.createdAt);
      if (label !== lastDay) {
        list.appendChild(h('div', { class: 'day-label' }, label));
        lastDay = label;
      }
      list.appendChild(txRow(tx, view));
    }
  };
  if (!items.length) {
    list.appendChild(emptyState({ emoji: '🧾', title: 'Nothing here yet', text: emptyText ?? 'Activity shows up here as money moves.' }));
  } else add(items);

  if (loadMore) {
    const btn = h('button', { class: 'btn btn-ghost btn-block', style: { 'border-radius': '0', 'border-top': '1px solid var(--border)' } }, 'Show more');
    btn.hidden = !hasMore;
    btn.addEventListener('click', async () => {
      setBusy(btn, true);
      try {
        const { rows, more } = await loadMore();
        add(rows);
        btn.hidden = !more;
      } catch (e) {
        toast(e.message, { tone: 'error' });
      } finally {
        setBusy(btn, false);
      }
    });
    root.appendChild(btn);
  }
  return root;
}

// ───────────────────────── chart ─────────────────────────

const niceMax = (v) => {
  if (v <= 0) return 500;
  const steps = [500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 500000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 100000) * 100000;
};
const tick = (c) => (c === 0 ? '$0' : c >= 100000 ? `$${c / 100000}K` : c % 100 ? `$${(c / 100).toFixed(2)}` : `$${c / 100}`);

/** Spending by day: HTML columns so labels, hover and keyboard focus all just work. */
export function spendChart(days) {
  const peak = niceMax(Math.max(...days.map((d) => d.spentCents)));
  const root = h('div', { class: 'chart' });
  const plot = h('div', { class: 'chart-plot' });
  const grid = h('div', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (const f of [0, 0.5, 1]) grid.appendChild(h('i', { style: { bottom: `${f * 100}%` } }, h('span', null, tick(peak * f))));
  const tip = h('div', { class: 'chart-tip', 'aria-hidden': 'true' });
  const cols = h('div', { class: 'chart-cols', style: { '--n': days.length } });
  const show = (col, d) => {
    tip.replaceChildren(h('b', null, money(d.spentCents)), h('span', null, formatDay(d.date, { weekday: 'long', month: 'short', day: 'numeric' })));
    const pr = plot.getBoundingClientRect();
    const cr = col.getBoundingClientRect();
    const barTop = pr.height * (1 - d.spentCents / peak);
    tip.style.left = `${cr.left - pr.left + cr.width / 2 + 38}px`;
    tip.style.top = `${Math.max(barTop, 46) - 6}px`;
    tip.classList.add('show');
  };
  const hide = () => tip.classList.remove('show');
  days.forEach((d, i) => {
    const col = h('button', {
      type: 'button',
      class: `chart-col ${d.spentCents ? '' : 'zero'}`,
      'aria-label': `${formatDay(d.date, { weekday: 'long', month: 'long', day: 'numeric' })}: ${money(d.spentCents)} spent`,
    }, h('div', { class: 'bar', style: { '--h': d.spentCents / peak, '--i': i } }));
    col.addEventListener('pointerenter', () => show(col, d));
    col.addEventListener('focus', () => show(col, d));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
    cols.appendChild(col);
  });
  plot.append(grid, cols);
  const axis = h('div', { class: 'chart-x', style: { '--n': days.length } }, days.map((d, i) => h('span', null, i % 2 === (days.length - 1) % 2 ? formatDay(d.date, { month: 'numeric', day: 'numeric' }) : '')));
  const table = h(
    'details',
    { class: 'chart-table' },
    h('summary', null, 'View as table'),
    h('table', null, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Spent'))), h('tbody', null, days.slice().reverse().map((d) => h('tr', null, h('td', null, formatDay(d.date)), h('td', null, money(d.spentCents)))))),
  );
  root.append(h('div', { style: { position: 'relative' } }, plot, tip), axis, table);
  return root;
}

// ───────────────────────── delight ─────────────────────────

export function countUp(el, cents, ms = 800) {
  if (reducedMotion() || !Number.isFinite(cents)) {
    el.textContent = money(cents);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = money(Math.round(cents * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function confetti() {
  if (reducedMotion()) return;
  const canvas = h('canvas', { id: 'confetti', 'aria-hidden': 'true' });
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = (canvas.width = window.innerWidth * dpr);
  const H = (canvas.height = window.innerHeight * dpr);
  const colors = ['#8a6bff', '#4aa8ff', '#28d3bf', '#4fd98a', '#ffd04d', '#ff9a4d', '#ff7eb6'];
  const bits = Array.from({ length: 140 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.25,
    y: H * 0.55,
    vx: (Math.random() - 0.5) * 16 * dpr,
    vy: (-Math.random() * 16 - 6) * dpr,
    s: (Math.random() * 7 + 5) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  const frame = (now) => {
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.42 * dpr;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t / 2600);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.s / 2, -b.s / 3, b.s, b.s * 0.6);
      ctx.restore();
    }
    if (t < 2600) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
