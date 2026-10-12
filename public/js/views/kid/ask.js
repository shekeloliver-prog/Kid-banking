import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { money, timeAgo } from '../../format.js';
import { pill, emptyState } from '../../ui.js';
import { askDialog, cancelRequestButton } from './parts.js';

const TONE = { pending: ['Waiting', 'warn'], approved: ['Yes! 🎉', 'pos'], declined: ['Not this time', 'neg'], cancelled: ['Cancelled', ''] };

export const askView = defineView({
  title: 'Ask',
  autoRefresh: true,
  load: () => api.get('/kid/overview'),
  render: (d, { refresh }) => {
    const soft = () => refresh({ silent: true });
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } },
        h('div', null, h('h1', null, 'Ask for money'), h('p', null, `${d.parentName} will get a message and can say yes or no.`)),
        h('button', { class: 'btn btn-accent', onClick: () => askDialog({ kid: d.kid, onDone: soft }) }, icon('hand', 18), 'New request')),
      d.requests.length
        ? h('div', { class: 'card card-flush' }, d.requests.map((r) => {
            const [label, tone] = TONE[r.status];
            return h('div', { class: 'row' },
              h('div', { class: 'row-icon', 'aria-hidden': 'true' }, r.status === 'approved' ? '✅' : r.status === 'declined' ? '🙅' : '🙋'),
              h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, `“${r.reason}”`), h('div', { class: 'row-sub' }, [money(r.amountCents), timeAgo(r.createdAt), r.responseNote ? `${d.parentName}: ${r.responseNote}` : null].filter(Boolean).join(' · '))),
              h('div', { class: 'cluster', style: { gap: '6px', flexWrap: 'nowrap' } }, pill(label, tone), r.status === 'pending' ? cancelRequestButton(r, soft) : null));
          }))
        : h('div', { class: 'card' }, emptyState({ emoji: '🙋', title: 'Need something?', text: 'Ask your parent for money and tell them what it’s for.', action: h('button', { class: 'btn btn-accent btn-lg', onClick: () => askDialog({ kid: d.kid, onDone: soft }) }, 'Ask now') })),
    );
  },
});
