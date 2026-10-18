import { h } from './dom.js';
import { icon, logo } from './icons.js';
import { api } from './api.js';
import { avatar, toast, formModal, passwordField } from './ui.js';
import { timeAgo } from './format.js';
import { getTheme, setTheme, THEMES } from './theme.js';

export const state = { user: null, unread: 0, pending: 0, listeners: new Set() };
export const onState = (fn) => {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
};
export function setCounts({ unread, pending }) {
  state.unread = unread ?? state.unread;
  state.pending = pending ?? state.pending;
  state.listeners.forEach((fn) => fn());
}

const brand = (href = '#/') => h('a', { class: 'brand', href, 'aria-label': 'Nestly home' }, logo(34), h('span', null, 'Nestly'));

// ───────────── dropdowns ─────────────
function dropdown(trigger, build) {
  const wrap = h('div', { class: 'anchor' }, trigger);
  let panel = null;
  const close = () => {
    panel?.remove();
    panel = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => {
    if (panel && !wrap.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      close();
      trigger.focus();
    }
  };
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', async () => {
    if (panel) return close();
    panel = h('div');
    wrap.appendChild(panel);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
    const content = await build(close);
    if (panel) panel.replaceWith((panel = content));
  });
  return wrap;
}

export function notificationsBell() {
  const dot = h('span', { class: 'dot', hidden: true });
  const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Notifications' }, icon('bell', 21), dot);
  const sync = () => {
    dot.textContent = state.unread > 9 ? '9+' : String(state.unread);
    dot.hidden = state.unread === 0;
    btn.setAttribute('aria-label', state.unread ? `Notifications, ${state.unread} new` : 'Notifications');
  };
  onState(sync);
  sync();
  return dropdown(btn, async (close) => {
    let data;
    try {
      data = await api.get('/notifications');
    } catch (e) {
      return h('div', { class: 'popover' }, h('div', { class: 'popover-head' }, h('b', null, 'Notifications')), h('p', { class: 'muted', style: { padding: '18px' } }, e.message));
    }
    const items = data.items.map((n) =>
      h(
        'button',
        {
          class: `note-item ${n.read ? '' : 'unread'}`,
          type: 'button',
          onClick: () => {
            close();
            if (n.link) location.hash = n.link;
          },
        },
        h('div', { class: 'e', 'aria-hidden': 'true' }, n.icon),
        h('div', { style: { minWidth: 0 } }, h('b', null, n.title), n.body ? h('span', null, n.body) : null, h('span', { class: 'tiny' }, timeAgo(n.createdAt))),
      ),
    );
    if (data.unread) {
      api.post('/notifications/read').then(() => setCounts({ unread: 0 })).catch(() => {});
    }
    return h(
      'div',
      { class: 'popover', role: 'dialog', 'aria-label': 'Notifications' },
      h('div', { class: 'popover-head' }, h('b', null, 'Notifications'), data.unread ? h('span', { class: 'pill pill-primary' }, `${data.unread} new`) : null),
      items.length ? items : h('p', { class: 'muted', style: { padding: '28px 18px', textAlign: 'center' } }, "You're all caught up ✨"),
    );
  });
}

function changePasswordDialog(user) {
  const isKid = user.role === 'kid';
  const cur = passwordField({ label: isKid ? 'Current PIN' : 'Current password', autofocus: true });
  const next = passwordField({ label: isKid ? 'New PIN' : 'New password', autocomplete: 'new-password', hint: isKid ? 'At least 6 characters.' : 'At least 8 characters.' });
  formModal({
    title: isKid ? 'Change my PIN' : 'Change password',
    subtitle: 'You’ll stay signed in here and be signed out everywhere else.',
    fields: [cur.el, next.el],
    submitLabel: 'Update',
    accent: user.color,
    onSubmit: async () => {
      await api.post('/auth/password', { current: cur.input.value, next: next.input.value });
      toast(isKid ? 'PIN updated' : 'Password updated');
    },
  });
}
export { changePasswordDialog };

const THEME_LABEL = { system: 'Match my device', light: 'Light', dark: 'Dark' };
function themeMenuItem() {
  const label = h('span', null);
  const btn = h('button', { role: 'menuitem', type: 'button' }, icon('moon', 18), h('span', { class: 'grow' }, 'Appearance'), label);
  const sync = () => (label.textContent = THEME_LABEL[getTheme()]);
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // stay open so the change is visible
    setTheme(THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length]);
    sync();
  });
  sync();
  return btn;
}

function userMenu(user, onLogout) {
  const btn = h('button', { class: 'icon-btn user-btn', type: 'button', 'aria-label': 'Account menu', style: { padding: '0', border: '0', background: 'none' } }, avatar(user.role === 'kid' ? user : { ...user, avatar: user.name.trim()[0]?.toUpperCase() ?? '?', color: 'violet' }, 'sm'));
  return dropdown(btn, (close) =>
    h(
      'div',
      { class: 'menu', role: 'menu' },
      h('div', { class: 'menu-label' }, user.role === 'kid' ? `@${user.username}` : user.email),
      user.role === 'parent' ? h('button', { role: 'menuitem', onClick: () => { close(); location.hash = '#/settings'; } }, icon('sliders', 18), 'Settings') : null,
      user.role === 'kid' ? h('button', { role: 'menuitem', onClick: () => { close(); changePasswordDialog(user); } }, icon('key', 18), 'Change my PIN') : null,
      themeMenuItem(),
      h('button', { role: 'menuitem', onClick: onLogout }, icon('logout', 18), 'Log out'),
    ),
  );
}

// ───────────── shells ─────────────
const PARENT_NAV = [
  { href: '#/', label: 'Home', icon: 'home', match: (p) => p === '/', tab: true },
  { href: '#/kids', label: 'Kids', icon: 'users', match: (p) => p.startsWith('/kids'), tab: true },
  { href: '#/chores', label: 'Chores', icon: 'check', match: (p) => p === '/chores', tab: true },
  { href: '#/requests', label: 'Requests', icon: 'inbox', match: (p) => p === '/requests', badge: true, tab: true },
  { href: '#/activity', label: 'Activity', icon: 'list', match: (p) => p === '/activity' },
  { href: '#/insights', label: 'Insights', icon: 'trend', match: (p) => p === '/insights' },
  { href: '#/funding', label: 'Funding', icon: 'wallet', match: (p) => p === '/funding' },
  { href: '#/settings', label: 'Settings', icon: 'sliders', match: (p) => p === '/settings' },
];
// Phones only have room for five tabs; everything else lives behind "More".
const MORE_TAB = { href: '#/more', label: 'More', icon: 'more', match: (p) => ['/more', '/activity', '/insights', '/funding', '/settings'].includes(p) };

export function buildParentShell(user, onLogout) {
  const host = h('main', { class: 'main', id: 'view', tabindex: '-1' });
  const links = PARENT_NAV.map((n) => {
    const badge = n.badge ? h('span', { class: 'badge', hidden: true }) : null;
    const a = h('a', { href: n.href }, icon(n.icon, 21), h('span', null, n.label), badge);
    return { n, a, badge };
  });
  const tabLinks = [...PARENT_NAV.filter((n) => n.tab), MORE_TAB].map((n) => {
    const badge = n.badge ? h('span', { class: 'badge', hidden: true }) : null;
    return { n, a: h('a', { href: n.href }, icon(n.icon, 22), h('span', null, n.label), badge), badge };
  });
  const syncBadges = () => {
    for (const l of [...links, ...tabLinks]) {
      if (!l.badge) continue;
      l.badge.textContent = String(state.pending);
      l.badge.hidden = state.pending === 0;
    }
  };
  onState(syncBadges);
  syncBadges();

  const el = h(
    'div',
    { class: 'shell' },
    h(
      'aside',
      { class: 'sidebar' },
      brand(),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, links.map((l) => l.a)),
      h(
        'div',
        { class: 'side-foot' },
        h('div', { class: 'practice-note' }, '🪙 Practice money. Nothing here moves real dollars — it’s a safe place to learn.'),
        h('div', { class: 'usercard' }, avatar({ avatar: user.name.trim()[0]?.toUpperCase() ?? '?', color: 'violet' }, 'sm'), h('div', { class: 'who ellipsis' }, h('b', { class: 'ellipsis' }, user.name), h('span', { class: 'ellipsis' }, 'Parent')), h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': 'Log out', title: 'Log out', onClick: onLogout }, icon('logout', 18))),
      ),
    ),
    h(
      'div',
      { class: 'main-col' },
      h('header', { class: 'topbar' }, brand(), h('div', { class: 'spacer' }), notificationsBell(), userMenu(user, onLogout)),
      host,
    ),
    h('nav', { class: 'tabbar', 'aria-label': 'Main' }, tabLinks.map((l) => l.a)),
  );
  const setActive = (path) => {
    for (const l of [...links, ...tabLinks]) {
      if (l.n.match(path)) l.a.setAttribute('aria-current', 'page');
      else l.a.removeAttribute('aria-current');
    }
  };
  return { el, host, setActive };
}

const KID_NAV = [
  { href: '#/', label: 'Home', icon: 'home', match: (p) => p === '/' },
  { href: '#/goals', label: 'Goals', icon: 'target', match: (p) => p === '/goals' },
  { href: '#/chores', label: 'Chores', icon: 'check', match: (p) => p === '/chores' },
  { href: '#/activity', label: 'Activity', icon: 'list', match: (p) => p === '/activity' },
  { href: '#/ask', label: 'Ask', icon: 'hand', match: (p) => p === '/ask' },
];

export function buildKidShell(user, onLogout) {
  const host = h('main', { class: 'kid-main', id: 'view', tabindex: '-1' });
  const links = KID_NAV.map((n) => ({ n, a: h('a', { href: n.href }, icon(n.icon, 20), h('span', null, n.label)) }));
  const el = h(
    'div',
    { class: 'kid-shell', dataset: { color: user.color } },
    h(
      'header',
      { class: 'kid-top' },
      h('div', { class: 'kid-top-in' }, avatar(user, 'sm'), h('b', { style: { fontSize: '18px' }, title: user.name }, user.name), h('nav', { class: 'kid-nav', 'aria-label': 'Main' }, links.map((l) => l.a)), h('div', { style: { flex: 1 } }), notificationsBell(), userMenu(user, onLogout)),
    ),
    host,
  );
  const setActive = (path) => {
    for (const l of links) {
      if (l.n.match(path)) l.a.setAttribute('aria-current', 'page');
      else l.a.removeAttribute('aria-current');
    }
  };
  return { el, host, setActive };
}
