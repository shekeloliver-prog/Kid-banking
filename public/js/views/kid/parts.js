import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { formModal, confirmModal, moneyField, textField, pickerGrid, toast, confetti } from '../../ui.js';
import { money, moneyCompact, CATEGORY, GOAL_EMOJI } from '../../format.js';

const SVG = 'http://www.w3.org/2000/svg';

// ───────────────────────── dialogs ─────────────────────────

export function spendDialog({ kid, onDone }) {
  const amount = moneyField({ label: 'How much did you spend?', quick: [200, 500, 1000, 2000] });
  let category = 'food';
  const cats = pickerGrid({
    items: Object.keys(CATEGORY),
    value: category,
    className: 'cat-grid',
    label: 'What was it for?',
    render: (c) => h('button', { class: 'cat' }, h('span', { class: 'e', 'aria-hidden': 'true' }, CATEGORY[c].emoji), CATEGORY[c].label),
    onPick: (c) => (category = c),
  });
  const note = textField({ label: 'Note (optional)', placeholder: 'What did you get?', maxlength: 140 });
  const remaining = kid.weeklyLimitCents != null ? Math.max(0, kid.weeklyLimitCents - kid.spent7dCents) : null;
  formModal({
    title: 'Spend money',
    subtitle: 'Record something you bought.',
    accent: kid.color,
    fields: [
      h('div', { class: 'balance-line' }, h('span', null, 'You have'), h('b', null, money(kid.balanceCents))),
      remaining != null ? h('div', { class: 'balance-line', style: { marginTop: '-10px' } }, h('span', null, 'Left to spend this week'), h('b', null, money(Math.min(remaining, kid.balanceCents)))) : null,
      amount.el,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'What was it for?'), cats.el),
      note.el,
    ],
    submitLabel: 'Spend it',
    onSubmit: async () => {
      const cents = amount.getCents();
      if (!(cents > 0)) throw new Error('Type how much you spent.');
      await api.post('/kid/spend', { amountCents: cents, category, note: note.input.value || null });
      toast(`Spent ${money(cents)} on ${CATEGORY[category].label.toLowerCase()}`, { emoji: CATEGORY[category].emoji });
      onDone?.();
    },
  });
}

export function askDialog({ kid, onDone }) {
  const amount = moneyField({ label: 'How much do you need?', quick: [500, 1000, 2000, 5000] });
  const reason = textField({ label: 'What for?', placeholder: 'e.g. Movie with friends', maxlength: 140 });
  formModal({
    title: 'Ask for money',
    subtitle: kid.maxRequestCents != null ? `You can ask for up to ${moneyCompact(kid.maxRequestCents)} at a time.` : 'Your parent will get a message and can say yes or no.',
    accent: kid.color,
    fields: [amount.el, reason.el],
    submitLabel: 'Send request',
    onSubmit: async () => {
      const cents = amount.getCents();
      if (!(cents > 0)) throw new Error('Type how much you’d like.');
      if (!reason.input.value.trim()) throw new Error('Tell your parent what it’s for.');
      await api.post('/kid/requests', { amountCents: cents, reason: reason.input.value });
      toast('Request sent! Fingers crossed 🤞', { emoji: '🙋' });
      onDone?.();
    },
  });
}

export function newGoalDialog({ kid, onDone }) {
  const name = textField({ label: 'What are you saving for?', placeholder: 'e.g. New skateboard', maxlength: 40, autofocus: true });
  let emoji = GOAL_EMOJI[0];
  const emojis = pickerGrid({ items: GOAL_EMOJI, value: emoji, className: 'emoji-grid', label: 'Pick an icon', render: (e) => h('button', { class: 'emoji-btn', 'aria-label': e }, e), onPick: (e) => (emoji = e) });
  const target = moneyField({ label: 'How much does it cost?', quick: [2000, 5000, 10000], autofocus: false });
  formModal({
    title: 'New savings goal',
    subtitle: 'Set a target and watch it fill up.',
    accent: kid.color,
    fields: [name.el, h('div', { class: 'field' }, h('span', { class: 'label' }, 'Pick an icon'), emojis.el), target.el],
    submitLabel: 'Start saving',
    onSubmit: async () => {
      const cents = target.getCents();
      if (!(cents >= 100)) throw new Error('A goal is at least $1.');
      await api.post('/kid/goals', { name: name.input.value, emoji, targetCents: cents });
      toast('Goal created — let’s go!', { emoji });
      onDone?.();
    },
  });
}

export function goalMoneyDialog({ mode, goal, kid, onDone }) {
  const saving = mode === 'save';
  const room = goal.targetCents - goal.savedCents;
  const have = saving ? Math.min(room, kid.balanceCents) : goal.savedCents;
  const amount = moneyField({ label: 'How much?', quick: [], autofocus: true });
  const quick = h('div', { class: 'chips' },
    [500, 1000, 2000].filter((c) => c < have).map((c) => h('button', { class: 'chip', type: 'button', onClick: () => amount.set(c) }, moneyCompact(c))),
    have > 0 ? h('button', { class: 'chip', type: 'button', onClick: () => amount.set(have) }, saving ? (have === room ? 'Rest of goal' : 'All I can') : 'Everything') : null);
  formModal({
    title: saving ? `Save for ${goal.name}` : `Take out of ${goal.name}`,
    subtitle: saving ? `${money(room)} to go · you have ${money(kid.balanceCents)}` : `${money(goal.savedCents)} saved so far`,
    accent: kid.color,
    fields: [amount.el, quick],
    submitLabel: saving ? 'Save it' : 'Take it out',
    onSubmit: async () => {
      const cents = amount.getCents();
      if (!(cents > 0)) throw new Error('Type an amount first.');
      const r = await api.post(`/kid/goals/${goal.id}/${saving ? 'save' : 'withdraw'}`, { amountCents: cents });
      if (saving && r.reached) {
        confetti();
        toast(`You did it! “${goal.name}” is fully funded 🎉`, { emoji: '🏆' });
      } else toast(saving ? `Saved ${money(cents)}` : `Took out ${money(cents)}`, { emoji: saving ? '🐷' : '💰' });
      onDone?.();
    },
  });
}

export function buyGoalDialog({ goal, kid, onDone }) {
  confirmModal({
    title: `Buy “${goal.name}”?`,
    text: `You’ve saved ${money(goal.savedCents)} for this. Buying it uses up that money, and your parent will see it. 🎉`,
    confirmLabel: 'Yes, buy it!',
    tone: 'primary',
    onConfirm: async () => {
      await api.post(`/kid/goals/${goal.id}/purchase`);
      confetti();
      toast(`Enjoy your ${goal.name}!`, { emoji: goal.emoji });
      onDone?.();
    },
  });
  void kid;
}

export function removeGoalDialog({ goal, onDone }) {
  confirmModal({
    title: `Remove “${goal.name}”?`,
    text: goal.savedCents ? `The ${money(goal.savedCents)} you saved goes back to your spending balance.` : 'You can always start a new goal later.',
    confirmLabel: 'Remove goal',
    onConfirm: async () => {
      await api.del(`/kid/goals/${goal.id}`);
      toast('Goal removed');
      onDone?.();
    },
  });
}

// ───────────────────────── parts ─────────────────────────

export function goalRing(goal, size = 76) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, goal.savedCents / goal.targetCents);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 80 80');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (cls) => {
    const el = document.createElementNS(SVG, 'circle');
    el.setAttribute('cx', 40);
    el.setAttribute('cy', 40);
    el.setAttribute('r', r);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', 9);
    el.setAttribute('class', cls);
    return el;
  };
  const bg = mk('bg');
  const fg = mk('fg');
  fg.setAttribute('stroke-linecap', 'round');
  fg.setAttribute('stroke-dasharray', c.toFixed(2));
  fg.setAttribute('stroke-dashoffset', c.toFixed(2));
  svg.append(bg, fg);
  requestAnimationFrame(() => requestAnimationFrame(() => fg.setAttribute('stroke-dashoffset', (c * (1 - p)).toFixed(2))));
  const wrap = h('div', { class: 'ring', style: { width: `${size}px`, height: `${size}px` }, role: 'img', 'aria-label': `${Math.round(p * 100)} percent saved` }, svg, h('div', { class: 'emoji', 'aria-hidden': 'true' }, goal.emoji));
  return wrap;
}

export function goalCard(goal, kid, { onChange }) {
  const funded = goal.savedCents >= goal.targetCents;
  const p = Math.min(1, goal.savedCents / goal.targetCents);
  const actions = [];
  if (funded) actions.push(h('button', { class: 'btn btn-primary', disabled: kid.frozen, onClick: () => buyGoalDialog({ goal, kid, onDone: onChange }) }, '🎉 Buy it!'));
  else actions.push(h('button', { class: 'btn btn-accent', disabled: kid.balanceCents <= 0, onClick: () => goalMoneyDialog({ mode: 'save', goal, kid, onDone: onChange }) }, icon('plus', 18), 'Add money'));
  if (goal.savedCents > 0) actions.push(h('button', { class: 'btn', onClick: () => goalMoneyDialog({ mode: 'withdraw', goal, kid, onDone: onChange }) }, 'Take out'));
  actions.push(h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': `Remove ${goal.name}`, title: 'Remove goal', onClick: () => removeGoalDialog({ goal, onDone: onChange }) }, icon('trash', 18)));
  return h(
    'article',
    { class: `card goal-card ${funded ? 'done' : ''}` },
    h('div', { class: 'goal-top' }, goalRing(goal), h('div', { class: 'grow' }, h('h3', { style: { fontSize: '19px', fontWeight: 800 } }, goal.name), h('div', { class: 'muted', style: { fontWeight: 600 } }, `${money(goal.savedCents)} of ${moneyCompact(goal.targetCents)}`), h('div', { class: 'small', style: { fontWeight: 700, color: funded ? 'var(--pos)' : 'var(--text-2)' } }, funded ? 'Fully funded! 🎉' : `${Math.round(p * 100)}% there`))),
    h('div', { class: 'cluster', style: { gap: '8px' } }, actions),
  );
}

export function goalMini(goal) {
  const p = Math.min(1, goal.savedCents / goal.targetCents);
  return h('a', { class: 'row', href: '#/goals' },
    h('div', { class: 'row-icon', 'aria-hidden': 'true', style: { background: 'var(--a-soft)' } }, goal.emoji),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title ellipsis' }, goal.name),
      h('div', { class: 'progress', style: { marginTop: '6px', height: '8px' }, role: 'progressbar', 'aria-valuenow': Math.round(p * 100) }, h('span', { style: { '--p': p } }))),
    h('div', { class: 'row-amount' }, moneyCompact(goal.savedCents), h('small', null, `of ${moneyCompact(goal.targetCents)}`)));
}

export function cancelRequestButton(req, onDone) {
  const b = h('button', { class: 'btn btn-ghost btn-sm' }, 'Cancel');
  b.addEventListener('click', async () => {
    setBusy(b, true);
    try {
      await api.del(`/kid/requests/${req.id}`);
      toast('Request cancelled');
      onDone();
    } catch (e) {
      toast(e.message, { tone: 'error' });
      setBusy(b, false);
    }
  });
  return b;
}

