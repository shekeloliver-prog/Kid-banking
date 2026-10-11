import { h, setBusy } from '../dom.js';
import { icon, logo } from '../icons.js';
import { api } from '../api.js';
import { passwordField, textField } from '../ui.js';

/** Login / sign-up screen. Calls onAuthed({user, unread, pending}) after success. */
export function renderAuth({ onAuthed, notice }) {
  let role = 'parent';
  let mode = 'login';
  const panel = h('div', { class: 'auth-card' });
  const root = h(
    'div',
    { class: 'auth' },
    h(
      'section',
      { class: 'auth-hero' },
      h('div', { class: 'brand' }, logo(40), h('span', null, 'Nestly')),
      h(
        'div',
        null,
        h('h1', null, 'Money lessons that stick.'),
        h('p', { class: 'lede' }, 'Nestly is the family bank where you set the rules and your kids watch their savings grow — one goal at a time.'),
        h(
          'div',
          { class: 'auth-points' },
          point('calendar', 'Allowance on autopilot', 'Weekly, biweekly or monthly — paid on time, every time.'),
          point('shield', 'Limits you control', 'Set spending caps, pause an account, approve requests.'),
          point('target', 'Goals kids love', 'Save toward the big stuff and celebrate when they get there.'),
        ),
      ),
      h(
        'div',
        { class: 'mock-stack', 'aria-hidden': 'true' },
        h('div', { class: 'mock mock-1' }, h('span', { class: 'avatar av-md', dataset: { color: 'pink' } }, '🦄'), h('div', null, h('b', null, '$42.50'), h('span', null, 'Mia · 3 goals'))),
        h('div', { class: 'mock mock-2' }, h('span', { class: 'avatar av-md', dataset: { color: 'teal' } }, '🐼'), h('div', null, h('b', null, '$18.00'), h('span', null, 'Leo · allowance Fri'))),
      ),
    ),
    h('section', { class: 'auth-panel' }, panel),
  );

  function point(ic, title, text) {
    return h('div', { class: 'auth-point' }, h('div', { class: 'ic' }, icon(ic, 20)), h('div', null, h('b', null, title), h('span', null, text)));
  }

  function draw() {
    const isParent = role === 'parent';
    const isSignup = isParent && mode === 'signup';
    const error = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const showError = (m) => {
      error.replaceChildren(icon('info', 18), h('span', null, m));
      error.hidden = false;
    };

    const name = isSignup ? textField({ label: 'Your name', placeholder: 'Sam Rivera', autocomplete: 'name', autofocus: true }) : null;
    const id = isParent
      ? textField({ label: 'Email', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', autofocus: !isSignup })
      : textField({ label: 'Username', placeholder: 'your username', autocomplete: 'username', autofocus: true });
    if (!isParent) id.input.autocapitalize = 'none';
    const pw = passwordField({
      label: isParent ? 'Password' : 'PIN',
      autocomplete: isSignup ? 'new-password' : 'current-password',
      hint: isSignup ? 'At least 8 characters.' : undefined,
    });
    const submit = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, isSignup ? 'Create my account' : isParent ? 'Log in' : "Let's go!");

    const form = h(
      'form',
      { class: 'stack', novalidate: true },
      notice && !isSignup ? h('div', { class: 'banner warn' }, icon('info', 20), h('div', null, notice)) : null,
      error,
      name?.el,
      id.el,
      pw.el,
      submit,
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      setBusy(submit, true);
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const result = isSignup
          ? await api.post('/auth/register', { name: name.input.value, email: id.input.value, password: pw.input.value, timezone: tz })
          : await api.post('/auth/login', { role, identifier: id.input.value, password: pw.input.value });
        onAuthed({ ...result, pending: 0 });
      } catch (err) {
        showError(err.message);
        setBusy(submit, false);
      }
    });

    const tabs = h(
      'div',
      { class: 'role-tabs', role: 'tablist' },
      ['parent', 'kid'].map((r) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(role === r), onClick: () => { role = r; mode = 'login'; draw(); } }, h('span', { 'aria-hidden': 'true' }, r === 'parent' ? '🧑‍💼' : '🦊'), r === 'parent' ? "I'm a parent" : "I'm a kid"),
      ),
    );

    const heading = isSignup ? 'Create your family bank' : isParent ? 'Welcome back' : 'Hi there! 👋';
    const sub = isSignup ? 'Free to try. Add your kids in a minute.' : isParent ? 'Log in to manage your family’s money.' : 'Log in with the username and PIN your parent gave you.';
    panel.replaceChildren(
      h('div', { class: 'brand auth-mobile-brand' }),
      tabs,
      h('h2', null, heading),
      h('p', { class: 'sub' }, sub),
      form,
      isParent
        ? h('p', { class: 'auth-foot' }, isSignup ? 'Already have an account? ' : 'New to Nestly? ', h('button', { type: 'button', onClick: () => { mode = isSignup ? 'login' : 'signup'; draw(); } }, isSignup ? 'Log in' : 'Create an account'))
        : h('p', { class: 'auth-foot' }, 'Forgot your PIN? Ask your parent to reset it.'),
    );
  }
  draw();
  return root;
}
