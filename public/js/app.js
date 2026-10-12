import { h } from './dom.js';
import { api } from './api.js';
import { state, setCounts, buildParentShell, buildKidShell } from './shell.js';
import { renderAuth } from './views/auth.js';
import { toast } from './ui.js';
import { parentRoutes } from './views/parent/index.js';
import { kidRoutes } from './views/kid/index.js';

const app = document.getElementById('app');
let current = null; // { shell, view }
let pollTimer = null;

function compile(table) {
  return table.map(([pattern, view]) => {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    return { regex, keys, view };
  });
}

function navigate() {
  if (!current) return;
  const path = (location.hash.slice(1) || '/').split('?')[0];
  for (const r of current.routes) {
    const m = r.regex.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    current.view = r.view(params);
    current.shell.host.replaceChildren(current.view.el);
    current.shell.setActive(path);
    window.scrollTo(0, 0);
    return;
  }
  location.replace('#/');
}

function mountApp({ user, unread, pending }) {
  state.user = user;
  setCounts({ unread, pending });
  const shell = user.role === 'parent' ? buildParentShell(user, logout) : buildKidShell(user, logout);
  current = { shell, routes: compile(user.role === 'parent' ? parentRoutes : kidRoutes), view: null };
  app.replaceChildren(shell.el);
  navigate();
  startPolling();
}

function showAuth(notice) {
  stopPolling();
  current = null;
  state.user = null;
  document.title = 'Nestly – family banking';
  app.replaceChildren(renderAuth({ notice, onAuthed: (me) => { location.hash = '#/'; mountApp(me); } }));
}

async function logout() {
  try {
    await api.post('/auth/logout');
  } catch {
    /* already signed out */
  }
  showAuth();
}

// Quietly check for new notifications; reload the page the person is on when something arrives.
async function poll() {
  if (!state.user || document.hidden) return;
  try {
    const me = await api.get('/me');
    const before = state.unread;
    setCounts({ unread: me.unread, pending: me.pending });
    if (me.unread > before) {
      const { items } = await api.get('/notifications');
      const latest = items.find((n) => !n.read);
      if (latest) toast(latest.title, { emoji: latest.icon });
      if (current?.view?.autoRefresh && !document.querySelector('dialog[open]')) current.view.refresh({ silent: true });
    }
  } catch {
    /* offline – try again next tick */
  }
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 15000);
}
function stopPolling() {
  clearInterval(pollTimer);
}

window.addEventListener('hashchange', navigate);
window.addEventListener('focus', poll);
document.addEventListener('visibilitychange', () => !document.hidden && poll());
window.addEventListener('nestly:signed-out', () => {
  if (state.user) showAuth('Your session ended. Please log in again.');
});

function showSetupProblem(err) {
  stopPolling();
  app.replaceChildren(
    h(
      'div',
      { class: 'loading-screen' },
      h(
        'div',
        { class: 'empty', style: { maxWidth: '460px', padding: '24px' } },
        h('div', { class: 'art', 'aria-hidden': 'true' }, err.code === 'not_configured' ? '🛠️' : '😕'),
        h('h3', null, err.code === 'not_configured' ? 'Nestly isn’t set up yet' : 'Can’t reach Nestly right now'),
        h('p', null, err.message),
        h('button', { class: 'btn btn-primary', onClick: () => location.reload() }, 'Try again'),
      ),
    ),
  );
}

(async function boot() {
  try {
    const session = await api.get('/session');
    if (session.user) mountApp(session);
    else showAuth();
  } catch (err) {
    if (err.status === 503 || err.status === 0) showSetupProblem(err);
    else showAuth();
  }
})();
