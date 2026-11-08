import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api, download } from '../../api.js';
import { toast, confirmModal, passwordField, pill, switchControl, segmented } from '../../ui.js';
import { timeAgo } from '../../format.js';
import { getTheme, setTheme, THEMES, getTextSize, setTextSize, getReduceMotion, setReduceMotion } from '../../theme.js';

const MAX_RULES = 8;
const RULE_IDEAS = ['Ask before spending more than $20', 'Save a little from every allowance', 'Chores come before screens', 'Be kind when you ask for money'];

// ───────────────────────── house rules ─────────────────────────

/** Rules the whole family agrees on. Kids see them on their home screen. */
export function rulesCard({ rules: initial }) {
  let rules = [...initial];
  const list = h('div', { class: 'stack-sm' });
  const add = h('button', { class: 'btn btn-sm', type: 'button' }, icon('plus', 16), 'Add a rule');
  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save rules');
  const ideas = h('div', { class: 'chips' });

  const draw = () => {
    list.replaceChildren(
      ...rules.map((text, i) => {
        const input = h('input', { class: 'input', value: text, maxlength: 90, placeholder: 'e.g. Ask before spending more than $20', 'aria-label': `Rule ${i + 1}` });
        input.addEventListener('input', () => (rules[i] = input.value));
        return h('div', { class: 'rule-edit' }, h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)), input, h('button', { class: 'btn btn-ghost btn-icon btn-sm', type: 'button', 'aria-label': `Remove rule ${i + 1}`, onClick: () => { rules.splice(i, 1); draw(); } }, icon('x', 16)));
      }),
    );
    add.disabled = rules.length >= MAX_RULES;
    const unused = RULE_IDEAS.filter((t) => !rules.includes(t));
    ideas.hidden = !unused.length || rules.length >= MAX_RULES;
    ideas.replaceChildren(...unused.map((t) => h('button', { class: 'chip', type: 'button', onClick: () => { rules.push(t); draw(); } }, t)));
  };
  add.addEventListener('click', () => {
    rules.push('');
    draw();
    list.querySelector('.rule-edit:last-child input')?.focus();
  });
  save.addEventListener('click', async () => {
    setBusy(save, true);
    try {
      const r = await api.put('/rules', { rules });
      rules = r.rules;
      draw();
      toast(rules.length ? 'House rules saved. Your kids can see them now' : 'House rules cleared', { emoji: '📜' });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(save, false);
    }
  });
  draw();
  return h(
    'section',
    { class: 'card', id: 'rules' },
    h('h2', { class: 'card-title' }, 'House rules 📜'),
    h('p', { class: 'text-2', style: { margin: '6px 0 16px' } }, `Write down what your family agrees on, up to ${MAX_RULES} rules. Kids see them on their home screen and get a heads-up when they change.`),
    list,
    h('div', { style: { margin: '14px 0' } }, ideas),
    h('div', { class: 'cluster' }, add, save),
  );
}

// ───────────────────────── display ─────────────────────────

const THEME_UI = { system: ['Auto', 'sparkle'], light: ['Light', 'sun'], dark: ['Dark', 'moon'] };

const seg = (label, options, get, set) => segmented({ label, options, get, set, className: 'theme-seg' });

/** Look and feel for this device: theme, text size, reduced motion. */
export function displayCard() {
  const motion = switchControl({ checked: getReduceMotion(), label: 'Reduce motion', onChange: (on) => setReduceMotion(on) });
  return h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title', style: { marginBottom: '4px' } }, 'Display'),
    h('p', { class: 'small muted', style: { marginBottom: '16px' } }, 'Saved on this device.'),
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Appearance'), h('div', { class: 'desc' }, 'Light, dark, or follow your device.')), seg('Appearance', THEMES.map((t) => [t, THEME_UI[t][0], THEME_UI[t][1]]), getTheme, setTheme)),
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Text size'), h('div', { class: 'desc' }, 'Make everything a little bigger.')), seg('Text size', [['normal', 'Normal'], ['large', 'Large']], getTextSize, setTextSize)),
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Reduce motion'), h('div', { class: 'desc' }, 'Fewer animations, no confetti.')), motion.el),
  );
}

// ───────────────────────── devices ─────────────────────────

/** Everywhere this account is signed in, with a way to sign out the ones you don't recognise. */
export function devicesCard() {
  const body = h('div', { class: 'stack-sm' }, h('p', { class: 'muted small' }, 'Loading…'));
  async function load() {
    try {
      const { items } = await api.get('/auth/sessions');
      body.replaceChildren(
        h('div', { class: 'card-flush device-list' }, items.map((s) => {
          const out = h('button', { class: 'btn btn-sm', type: 'button' }, 'Sign out');
          out.addEventListener('click', async () => {
            setBusy(out, true);
            try {
              await api.del(`/auth/sessions/${s.id}`);
              toast(`${s.device} was signed out`, { emoji: '👋' });
              load();
            } catch (e) {
              toast(e.message, { tone: 'error' });
              setBusy(out, false);
            }
          });
          return h('div', { class: 'row' },
            h('div', { class: 'row-icon info', 'aria-hidden': 'true' }, icon('devices', 20)),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, s.device, ' ', s.current ? pill('This device', 'pos') : null), h('div', { class: 'row-sub' }, `Signed in ${timeAgo(s.signedInAt)} · last active ${timeAgo(s.lastActive)}`)),
            s.current ? null : out);
        })),
        items.length > 1 ? h('div', null, h('button', { class: 'btn btn-sm btn-danger-soft', type: 'button', onClick: signOutOthers }, icon('logout', 16), 'Sign out everywhere else')) : h('p', { class: 'small muted' }, 'Only this device is signed in.'),
      );
    } catch (e) {
      body.replaceChildren(h('p', { class: 'muted small' }, e.message));
    }
  }
  async function signOutOthers(e) {
    const b = e.currentTarget;
    setBusy(b, true);
    try {
      await api.post('/auth/sessions/revoke-others');
      toast('Signed out everywhere else', { emoji: '🔒' });
      load();
    } catch (err) {
      toast(err.message, { tone: 'error' });
      setBusy(b, false);
    }
  }
  load();
  return h('section', { class: 'card' }, h('h2', { class: 'card-title' }, 'Where you’re signed in'), h('p', { class: 'small muted', style: { margin: '4px 0 14px' } }, 'Don’t recognise one? Sign it out, then change your password.'), body);
}

// ───────────────────────── your data ─────────────────────────

function deleteAccountDialog(user) {
  const pw = passwordField({ label: 'Your password', autofocus: true });
  confirmModal({
    title: 'Delete your account?',
    text: `This permanently deletes ${user.name}'s family account, every kid account, and all of their goals, chores, lessons and history. It can't be undone. Download your data first if you want a copy.`,
    extra: pw.el,
    confirmLabel: 'Delete everything',
    onConfirm: async () => {
      await api.del('/me', { password: pw.input.value });
      try {
        sessionStorage.setItem('nestly-notice', 'Your account and all of its data were deleted.');
      } catch {
        /* the sign-in screen just won't say so */
      }
      location.reload(); // back to the sign-in screen with a clean slate
      return false; // keep the dialog from flashing closed before the reload
    },
  });
}

export function dataCard(user) {
  const dl = h('button', { class: 'btn', type: 'button' }, icon('download', 17), 'Download my data');
  dl.addEventListener('click', async () => {
    setBusy(dl, true);
    try {
      await download('/export.json', 'nestly-data.json');
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(dl, false);
    }
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', { class: 'card-title' }, 'Your data'),
    h('p', { class: 'text-2', style: { margin: '6px 0 14px' } }, 'Everything your family has put into Nestly belongs to you. Download a copy any time. Passwords are never included.'),
    h('div', { class: 'cluster' }, dl),
    h('hr', { class: 'divider' }),
    h('div', { class: 'control' },
      h('div', null, h('b', null, 'Delete account'), h('div', { class: 'desc' }, 'Removes your family and all of its data for good.')),
      h('button', { class: 'btn btn-sm btn-danger-soft', type: 'button', onClick: () => deleteAccountDialog(user) }, icon('trash', 16), 'Delete')),
  );
}
