import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { avatar, pill, meter, formModal, confirmModal, moneyField, textField, passwordField, pickerGrid, toast, banner } from '../../ui.js';
import { money, moneyCompact, describeAllowance, timeAgo, AVATARS, COLORS, formatDay } from '../../format.js';

// ───────────────────────── dialogs ─────────────────────────

export function addFundsDialog({ balanceCents, onDone }) {
  const amount = moneyField({ label: 'How much practice money?', quick: [1000, 2500, 5000, 10000] });
  formModal({
    title: 'Add practice funds',
    subtitle: `Current balance ${money(balanceCents)}`,
    fields: [
      amount.el,
      banner('', 'info', h('b', null, 'This is play money. '), 'It lets you try Nestly end to end. Linking a real card is coming soon — nothing real is charged.'),
    ],
    submitLabel: 'Add funds',
    onSubmit: async () => {
      const cents = amount.getCents();
      if (!(cents > 0)) throw new Error('Enter an amount to add.');
      if (cents > 50000) throw new Error('You can add up to $500 at a time.');
      await api.post('/parent/funds', { amountCents: cents });
      toast(`Added ${money(cents)}`, { emoji: '🪙' });
      onDone?.();
    },
  });
}

function kidPicker(kids, selectedId, onPick) {
  let current = selectedId;
  const buttons = kids.map((k) => {
    const b = h('button', { type: 'button', class: 'kid-pick', dataset: { color: k.color }, 'aria-pressed': String(k.id === current) }, avatar(k, 'xs'), k.name);
    b.addEventListener('click', () => {
      current = k.id;
      buttons.forEach((x, i) => x.setAttribute('aria-pressed', String(kids[i].id === current)));
      onPick(k);
    });
    return b;
  });
  return { el: h('div', { class: 'field' }, h('span', { class: 'label' }, 'Who is it for?'), h('div', { class: 'picker-kids' }, buttons)), get: () => current };
}

/** Send money to a kid, or take it back. */
export function moneyDialog({ mode, kids, kidId, balanceCents, onDone }) {
  const isSend = mode === 'send';
  let kid = kids.find((k) => k.id === kidId) ?? (kids.length === 1 ? kids[0] : null);
  const picker = kids.length > 1 ? kidPicker(kids, kid?.id, (k) => { kid = k; sync(); }) : null;
  const amount = moneyField({ label: 'Amount', quick: isSend ? [500, 1000, 2000, 5000] : [500, 1000, 2000], autofocus: !!kid });
  const note = textField({ label: 'Note (optional)', placeholder: isSend ? 'e.g. For the book fair' : 'e.g. Returning the extra from lunch', maxlength: 140 });
  const line = h('div', { class: 'balance-line' });
  const sync = () => {
    const cents = amount.getCents();
    const have = isSend ? balanceCents : kid?.balanceCents;
    line.replaceChildren(
      h('span', null, isSend ? 'Your balance' : kid ? `${kid.name}'s balance` : 'Pick a kid'),
      h('b', null, have == null ? '—' : money(have)),
    );
    if (kid) modal.el.dataset.color = kid.color;
    modal.submit.textContent = cents > 0 ? `${isSend ? 'Send' : 'Take back'} ${money(cents)}` : isSend ? 'Send money' : 'Take back';
  };
  const modal = formModal({
    title: isSend ? 'Send money' : 'Take money back',
    subtitle: isSend ? 'Moves money from your balance to their account instantly.' : 'Moves money from their account back to yours.',
    fields: [picker?.el, amount.el, line, note.el],
    submitLabel: isSend ? 'Send money' : 'Take back',
    accent: kid?.color,
    onSubmit: async () => {
      if (!kid) throw new Error('Pick who this is for.');
      const cents = amount.getCents();
      if (!(cents > 0)) throw new Error('Enter an amount first.');
      await api.post(`/kids/${kid.id}/${isSend ? 'send' : 'take'}`, { amountCents: cents, note: note.input.value || null });
      toast(isSend ? `Sent ${money(cents)} to ${kid.name}` : `Took back ${money(cents)} from ${kid.name}`, { emoji: isSend ? '💸' : '↩️' });
      onDone?.();
    },
  });
  modal.submit = modal.el.querySelector('button[type=submit]');
  amount.onChange(sync);
  sync();
  return modal;
}

function kidIdentityFields(initial = {}) {
  let av = initial.avatar ?? AVATARS[Math.floor(Math.random() * AVATARS.length)];
  let color = initial.color ?? COLORS[Math.floor(Math.random() * COLORS.length)];
  const name = textField({ label: 'Name', placeholder: 'e.g. Mia', value: initial.name ?? '', maxlength: 40, autocomplete: 'off', autofocus: true });
  const preview = h('div', { class: 'preview', dataset: { color } }, h('span'), h('div', null, h('b', { style: { fontSize: '17px' } }), h('div', { class: 'small muted' }, 'This is how they’ll look in Nestly')));
  const draw = () => {
    preview.dataset.color = color;
    preview.firstChild.replaceWith(avatar({ avatar: av, color }, 'lg'));
    preview.querySelector('b').textContent = name.input.value.trim() || 'Your kid';
  };
  const avatars = pickerGrid({
    items: AVATARS,
    value: av,
    className: 'emoji-grid',
    label: 'Avatar',
    render: (a) => h('button', { class: 'emoji-btn', 'aria-label': `Avatar ${a}` }, a),
    onPick: (a) => { av = a; draw(); },
  });
  const colors = pickerGrid({
    items: COLORS,
    value: color,
    className: 'swatches',
    label: 'Color',
    render: (c) => h('button', { class: 'swatch', dataset: { color: c }, 'aria-label': c }),
    onPick: (c) => { color = c; draw(); },
  });
  name.input.addEventListener('input', draw);
  draw();
  return {
    name,
    get: () => ({ name: name.input.value, avatar: av, color }),
    nodes: [preview, name.el, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Pick an avatar'), avatars.el), h('div', { class: 'field' }, h('span', { class: 'label' }, 'Favorite color'), colors.el)],
  };
}

export function addKidDialog({ onDone }) {
  const identity = kidIdentityFields();
  const uname = textField({ label: 'Username', hint: 'Letters, numbers and underscores. Your kid types this to log in.', placeholder: 'mia_fox', maxlength: 20, autocomplete: 'off' });
  uname.input.autocapitalize = 'none';
  let touched = false;
  uname.input.addEventListener('input', () => (touched = true));
  identity.name.input.addEventListener('input', () => {
    if (!touched) uname.input.value = identity.name.input.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  });
  const pin = passwordField({ label: 'PIN or password', hint: 'At least 6 characters. Easy for them to remember, hard to guess.', autocomplete: 'new-password' });
  formModal({
    title: 'Add a kid',
    subtitle: 'They’ll get their own login and a safe place to save.',
    fields: [...identity.nodes, uname.el, pin.el],
    submitLabel: 'Create account',
    onSubmit: async () => {
      const id = identity.get();
      const { id: kidId } = await api.post('/kids', { ...id, username: uname.input.value, password: pin.input.value });
      toast(`${id.name}'s account is ready`, { emoji: '🎉' });
      onDone?.(kidId);
    },
  });
}

export function editKidDialog(kid, onDone) {
  const identity = kidIdentityFields(kid);
  formModal({
    title: `Edit ${kid.name}`,
    fields: identity.nodes,
    submitLabel: 'Save',
    onSubmit: async () => {
      await api.patch(`/kids/${kid.id}`, identity.get());
      toast('Saved');
      onDone?.();
    },
  });
}

export function resetPinDialog(kid) {
  const pin = passwordField({ label: 'New PIN or password', autocomplete: 'new-password', autofocus: true, hint: 'At least 6 characters. They’ll be signed out everywhere.' });
  formModal({
    title: `Reset ${kid.name}'s PIN`,
    fields: [pin.el],
    submitLabel: 'Reset PIN',
    accent: kid.color,
    onSubmit: async () => {
      await api.post(`/kids/${kid.id}/password`, { password: pin.input.value });
      toast(`${kid.name}'s PIN was reset`, { emoji: '🔑' });
    },
  });
}

export function removeKidDialog(kid, onDone) {
  const pw = passwordField({ label: 'Your password', autofocus: true });
  const total = kid.balanceCents + kid.savedCents;
  confirmModal({
    title: `Remove ${kid.name}?`,
    text: `This closes ${kid.name}'s account and signs them out for good.${total ? ` Their ${money(total)} comes back to your balance.` : ''} This can't be undone.`,
    extra: pw.el,
    confirmLabel: 'Remove account',
    onConfirm: async () => {
      const r = await api.del(`/kids/${kid.id}`, { password: pw.input.value });
      toast(`${kid.name}'s account was removed${r.returnedCents ? ` · ${money(r.returnedCents)} returned` : ''}`);
      onDone?.();
    },
  });
}

// ───────────────────────── parts ─────────────────────────

export function kidCard(kid, { onSend }) {
  const allowance = describeAllowance(kid.allowance);
  return h(
    'article',
    { class: 'card kid-card', dataset: { color: kid.color } },
    h(
      'div',
      { class: 'cluster', style: { flexWrap: 'nowrap' } },
      avatar(kid, 'md'),
      h('div', { class: 'grow' }, h('div', { class: 'name ellipsis' }, kid.name), h('div', { class: 'small muted ellipsis' }, `@${kid.username}`)),
      kid.frozen ? pill('Paused', 'warn', 'pause') : null,
    ),
    h('div', null, h('div', { class: 'eyebrow' }, 'Spending balance'), h('div', { class: 'balance' }, money(kid.balanceCents))),
    h(
      'div',
      { class: 'facts' },
      h('div', null, icon('target', 16), kid.activeGoals ? `${money(kid.savedCents)} saved in ${kid.activeGoals} goal${kid.activeGoals === 1 ? '' : 's'}` : 'No savings goals yet'),
      h('div', null, icon('calendar', 16), allowance ? `Allowance ${allowance}` : 'No allowance set'),
    ),
    kid.weeklyLimitCents != null
      ? meter({ label: 'Spent this week', value: kid.spent7dCents, max: kid.weeklyLimitCents, textRight: `${money(kid.spent7dCents)} of ${moneyCompact(kid.weeklyLimitCents)}` })
      : null,
    kid.pendingRequests ? h('a', { href: '#/requests' }, pill(`${kid.pendingRequests} request${kid.pendingRequests === 1 ? '' : 's'} waiting`, 'primary', 'hand')) : null,
    h(
      'div',
      { class: 'cluster', style: { marginTop: 'auto' } },
      h('button', { class: 'btn btn-accent btn-sm', onClick: () => onSend(kid) }, icon('send', 16), 'Send money'),
      h('a', { class: 'btn btn-soft btn-sm', href: `#/kids/${kid.id}`, style: { '--btn-fg': 'var(--text)', '--btn-bg': 'var(--bg-soft)' } }, 'Manage', icon('right', 16)),
    ),
  );
}

export function requestItem(req, { onDone, balanceCents }) {
  const approve = h('button', { class: 'btn btn-primary btn-sm' }, icon('check', 16), 'Approve');
  const decline = h('button', { class: 'btn btn-danger-soft btn-sm' }, 'Not now');
  approve.addEventListener('click', async () => {
    setBusy(approve, true);
    try {
      await api.post(`/requests/${req.id}/approve`, {});
      toast(`Sent ${money(req.amountCents)} to ${req.kid.name}`, { emoji: '💸' });
      onDone();
    } catch (e) {
      toast(e.message, { tone: 'error' });
      setBusy(approve, false);
    }
  });
  decline.addEventListener('click', () => {
    const note = textField({ label: 'Add a note (optional)', placeholder: 'e.g. Let’s wait until next week', maxlength: 140, autofocus: true });
    formModal({
      title: `Say no to ${req.kid.name}?`,
      subtitle: `${money(req.amountCents)} · ${req.reason}`,
      fields: [note.el],
      submitLabel: 'Decline request',
      tone: 'danger',
      onSubmit: async () => {
        await api.post(`/requests/${req.id}/decline`, { note: note.input.value || null });
        toast('Request declined');
        onDone();
      },
    });
  });
  void balanceCents;
  return h(
    'div',
    { class: 'request-card', dataset: { color: req.kid.color } },
    avatar(req.kid, 'md'),
    h('div', { class: 'grow' }, h('div', { class: 'row-title' }, `${req.kid.name} asks for `, h('span', { class: 'amount' }, money(req.amountCents))), h('div', { class: 'row-sub' }, `“${req.reason}” · ${timeAgo(req.createdAt)}`)),
    h('div', { class: 'cluster' }, decline, approve),
  );
}

export function requestHistoryRow(req) {
  const tone = req.status === 'approved' ? 'pos' : req.status === 'declined' ? 'neg' : '';
  return h(
    'div',
    { class: 'row' },
    avatar(req.kid, 'sm'),
    h('div', { class: 'row-main' }, h('div', { class: 'row-title ellipsis' }, `${req.kid.name} · ${money(req.amountCents)}`), h('div', { class: 'row-sub ellipsis' }, `“${req.reason}”${req.responseNote ? ` — ${req.responseNote}` : ''}`)),
    h('div', { style: { textAlign: 'right' } }, pill(req.status === 'cancelled' ? 'Cancelled' : req.status[0].toUpperCase() + req.status.slice(1), tone), h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, formatDay((req.decidedAt ?? req.createdAt).slice(0, 10), { month: 'short', day: 'numeric' }))),
  );
}
