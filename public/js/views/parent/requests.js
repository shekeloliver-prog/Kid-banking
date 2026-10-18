import { h } from '../../dom.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { emptyState } from '../../ui.js';
import { requestItem, requestHistoryRow, choreClaimItem } from './parts.js';

export const requestsView = defineView({
  title: 'Requests',
  autoRefresh: true,
  load: async () => {
    const [requests, chores] = await Promise.all([api.get('/requests'), api.get('/chores')]);
    return { items: requests.items, claims: chores.claims };
  },
  render: ({ items, claims }, { refresh }) => {
    const pending = items.filter((r) => r.status === 'pending');
    const past = items.filter((r) => r.status !== 'pending');
    const soft = () => refresh({ silent: true });
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Requests'), h('p', null, 'When your kids ask for money, it shows up here.'))),
      claims.length ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Chores to check')), h('div', { class: 'card card-flush' }, claims.map((c) => choreClaimItem(c, { onDone: soft })))) : null,
      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Money requests')),
        pending.length
          ? h('div', { class: 'card card-flush' }, pending.map((r) => requestItem(r, { onDone: soft })))
          : h('div', { class: 'card' }, emptyState({ emoji: '🎈', title: claims.length ? 'No money requests' : 'All caught up', text: claims.length ? 'Just chores to check above.' : 'No one is waiting on you right now.' }))),
      past.length ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Earlier')), h('div', { class: 'card card-flush' }, past.map(requestHistoryRow))) : null,
    );
  },
});
