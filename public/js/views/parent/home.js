import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { state } from '../../shell.js';
import { money, greeting } from '../../format.js';
import { activityList, emptyState, countUp } from '../../ui.js';
import { kidCard, requestItem, choreClaimItem, addFundsDialog, moneyDialog, addKidDialog } from './parts.js';

export function kidGrid(d, refresh) {
  const sendTo = (kid) => moneyDialog({ mode: 'send', kids: d.kids, kidId: kid?.id, balanceCents: d.balanceCents, onDone: refresh });
  const addKid = () => addKidDialog({ onDone: (id) => (location.hash = `#/kids/${id}`) });
  if (!d.kids.length) {
    return h('div', { class: 'card' }, emptyState({
      emoji: '🧒',
      title: 'Add your first kid',
      text: 'Create a login for your child. You decide how much they get, when, and what they can spend.',
      action: h('button', { class: 'btn btn-primary btn-lg', onClick: addKid }, icon('userPlus', 20), 'Add a kid'),
    }));
  }
  return h('div', { class: 'grid grid-kids' }, d.kids.map((k) => kidCard(k, { onSend: sendTo })), h('button', { class: 'add-tile', onClick: addKid }, h('span', { class: 'plus' }, icon('plus', 24)), 'Add another kid'));
}

function onboarding(d, refresh) {
  const o = d.onboarding;
  if (o.funds && o.kid && o.allowance) return null;
  const firstKid = d.kids[0];
  const step = (n, done, title, text, onClick) =>
    h('button', { class: `step ${done ? 'done' : ''}`, onClick }, h('span', { class: 'dot' }, done ? icon('check', 15) : String(n)), h('div', null, h('b', null, title), h('span', null, text)));
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, 'Get set up in 3 steps'), h('p', { class: 'card-sub' }, 'A couple of minutes and your family bank is open.'))),
    h(
      'div',
      { class: 'steps' },
      step(1, o.funds, 'Add practice funds', 'Fill your balance with play money.', () => addFundsDialog({ balanceCents: d.balanceCents, onDone: refresh })),
      step(2, o.kid, 'Add your kid', 'Give them a login and an avatar.', () => addKidDialog({ onDone: (id) => (location.hash = `#/kids/${id}`) })),
      step(3, o.allowance, 'Set an allowance', 'Pay on a schedule, automatically.', () => (firstKid ? (location.hash = `#/kids/${firstKid.id}`) : addKidDialog({ onDone: (id) => (location.hash = `#/kids/${id}`) }))),
    ),
  );
}

export const homeView = defineView({
  title: 'Home',
  autoRefresh: true,
  load: () => api.get('/parent/overview'),
  render: (d, { refresh }) => {
    const first = state.user.name.split(' ')[0];
    const amount = h('div', { class: 'hero-amount', 'aria-live': 'polite' }, money(d.balanceCents));
    if (!state._homeCounted) {
      state._homeCounted = true;
      countUp(amount, d.balanceCents);
    }
    const send = () => moneyDialog({ mode: 'send', kids: d.kids, balanceCents: d.balanceCents, onDone: refresh });
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, `${greeting()}, ${first}`), h('p', null, 'Here’s how your family’s money is doing.'))),
      onboarding(d, refresh),
      h(
        'section',
        { class: 'hero-card' },
        h('div', { class: 'eyebrow' }, 'Your balance'),
        amount,
        h(
          'div',
          { class: 'cluster' },
          h('button', { class: 'btn btn-light', onClick: () => addFundsDialog({ balanceCents: d.balanceCents, onDone: refresh }) }, icon('plus', 18), 'Add funds'),
          h('button', { class: 'btn btn-glass', onClick: send, disabled: !d.kids.length }, icon('send', 18), 'Send to a kid'),
        ),
      ),
      h(
        'section',
        { class: 'grid grid-3 stats' },
        stat('users', "In kids' accounts", money(d.totals.kidsBalanceCents), d.kids.length ? `across ${d.kids.length} kid${d.kids.length === 1 ? '' : 's'}` : 'no kids yet'),
        stat('target', 'In savings goals', money(d.totals.kidsSavedCents), 'saved for the good stuff'),
        stat('trend', 'Spent this week', money(d.totals.spent7dCents), 'last 7 days'),
      ),
      d.pendingRequests.length || d.pendingChores.length
        ? h(
            'section',
            null,
            h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you'), h('a', { class: 'link', href: '#/requests' }, 'View all', icon('right', 16))),
            h('div', { class: 'card card-flush' }, [
              ...d.pendingChores.slice(0, 3).map((c) => choreClaimItem(c, { onDone: refresh })),
              ...d.pendingRequests.slice(0, 3).map((r) => requestItem(r, { onDone: refresh })),
            ]),
          )
        : null,
      h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Your kids'), d.kids.length ? h('a', { class: 'link', href: '#/kids' }, 'Manage', icon('right', 16)) : null), kidGrid(d, refresh)),
      d.recent.length
        ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Recent activity'), h('a', { class: 'link', href: '#/activity' }, 'See all', icon('right', 16))), activityList(d.recent, 'parent'))
        : null,
    );
  },
});

function stat(ic, label, value, foot) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon(ic, 17), label), h('div', { class: 'value' }, value), h('div', { class: 'foot' }, foot));
}

export const kidsView = defineView({
  title: 'Kids',
  autoRefresh: true,
  load: () => api.get('/parent/overview'),
  render: (d, { refresh }) =>
    h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Kids'), h('p', null, d.kids.length ? `${money(d.totals.kidsBalanceCents + d.totals.kidsSavedCents)} across ${d.kids.length} account${d.kids.length === 1 ? '' : 's'}.` : 'Add a kid to get started.'))),
      kidGrid(d, refresh),
    ),
});

