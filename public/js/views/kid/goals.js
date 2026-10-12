import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { money } from '../../format.js';
import { emptyState } from '../../ui.js';
import { goalCard, newGoalDialog } from './parts.js';

export const goalsView = defineView({
  title: 'Goals',
  load: () => api.get('/kid/overview'),
  render: (d, { refresh }) => {
    const soft = () => refresh({ silent: true });
    const active = d.goals.filter((g) => g.status === 'active');
    const done = d.goals.filter((g) => g.status === 'purchased');
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } },
        h('div', null, h('h1', null, 'My goals'), h('p', null, d.kid.savedCents ? `${money(d.kid.savedCents)} saved so far` : 'Save up for something awesome.')),
        h('button', { class: 'btn btn-accent', onClick: () => newGoalDialog({ kid: d.kid, onDone: soft }) }, icon('plus', 18), 'New goal')),
      active.length
        ? h('div', { class: 'grid grid-2' }, active.map((g) => goalCard(g, d.kid, { onChange: soft })))
        : h('div', { class: 'card' }, emptyState({ emoji: '🎯', title: 'No goals yet', text: 'Pick something you want, set a target, and start saving.', action: h('button', { class: 'btn btn-accent btn-lg', onClick: () => newGoalDialog({ kid: d.kid, onDone: soft }) }, icon('plus', 20), 'Make a goal') })),
      done.length
        ? h('section', null,
            h('div', { class: 'section-head' }, h('h2', null, 'Goals I reached 🏆')),
            h('div', { class: 'card card-flush' }, done.map((g) => h('div', { class: 'row' }, h('div', { class: 'row-icon', style: { background: 'var(--pos-soft)' }, 'aria-hidden': 'true' }, g.emoji), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, g.name), h('div', { class: 'row-sub' }, 'Bought 🎉')), h('div', { class: 'row-amount' }, money(g.targetCents))))))
        : null,
    );
  },
});
