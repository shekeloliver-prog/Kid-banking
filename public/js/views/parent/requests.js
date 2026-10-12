import { h } from '../../dom.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { emptyState } from '../../ui.js';
import { requestItem, requestHistoryRow } from './parts.js';

export const requestsView = defineView({
  title: 'Requests',
  autoRefresh: true,
  load: () => api.get('/requests'),
  render: ({ items }, { refresh }) => {
    const pending = items.filter((r) => r.status === 'pending');
    const past = items.filter((r) => r.status !== 'pending');
    const soft = () => refresh({ silent: true });
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Requests'), h('p', null, 'When your kids ask for money, it shows up here.'))),
      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you')),
        pending.length
          ? h('div', { class: 'card card-flush' }, pending.map((r) => requestItem(r, { onDone: soft })))
          : h('div', { class: 'card' }, emptyState({ emoji: '🎈', title: 'All caught up', text: 'No one is waiting on you right now.' }))),
      past.length ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Earlier')), h('div', { class: 'card card-flush' }, past.map(requestHistoryRow))) : null,
    );
  },
});
