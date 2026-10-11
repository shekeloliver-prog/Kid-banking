import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { money } from '../../format.js';
import { pill } from '../../ui.js';
import { addFundsDialog } from './parts.js';

export const fundingView = defineView({
  title: 'Funding',
  autoRefresh: true,
  load: () => api.get('/parent/overview'),
  render: (d, { refresh }) =>
    h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Funding'), h('p', null, 'Where the money in your family bank comes from.'))),
      h('section', { class: 'hero-card' },
        h('div', { class: 'eyebrow' }, 'Available to send'),
        h('div', { class: 'hero-amount' }, money(d.balanceCents)),
        h('div', { class: 'cluster' }, h('button', { class: 'btn btn-light', onClick: () => addFundsDialog({ balanceCents: d.balanceCents, onDone: refresh }) }, icon('plus', 18), 'Add practice funds'))),
      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Payment methods')),
        h('div', { class: 'coming-card' },
          h('div', { class: 'fake-card', 'aria-hidden': 'true' }, h('div', { class: 'chipline' }), h('div', { class: 'dots' }, '•••• •••• •••• ••••')),
          h('div', { class: 'stack-sm' },
            h('div', { class: 'cluster' }, h('h3', { style: { fontSize: '19px' } }, 'Credit & debit cards'), pill('Coming soon', 'primary', 'sparkle')),
            h('p', { class: 'text-2' }, 'Soon you’ll be able to link a card and top up your balance in a tap. We haven’t turned this on yet, so Nestly isn’t asking for any card details.'),
            h('p', { class: 'small muted' }, 'Until then, practice funds let you try everything — allowances, limits, goals — with play money.')))),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title', style: { marginBottom: '14px' } }, 'How money moves in Nestly'),
        h('ol', { class: 'how-list' },
          h('li', null, h('div', null, h('b', null, 'You fund your balance.'), h('div', { class: 'small muted' }, 'Add practice funds today; real cards later.'))),
          h('li', null, h('div', null, h('b', null, 'You decide what kids get.'), h('div', { class: 'small muted' }, 'Send money, set an allowance, or approve their requests.'))),
          h('li', null, h('div', null, h('b', null, 'Kids save and spend within your limits.'), h('div', { class: 'small muted' }, 'Weekly caps and pause controls keep you in charge.'))))),
    ),
});
