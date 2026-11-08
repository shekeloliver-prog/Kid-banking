import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { meter, pill, toast } from '../../ui.js';
import { timeAgo } from '../../format.js';

/** Cheers from a parent, with a one-tap thank-you. Shows nothing when there are none. */
export function cheersSection(d, onChange) {
  const shown = [...d.cheers].sort((a, b) => Number(a.thanked) - Number(b.thanked)).slice(0, 2);
  if (!shown.length) return null;
  return h(
    'section',
    null,
    h('div', { class: 'section-head' }, h('h2', null, 'Cheers 🎉')),
    h('div', { class: 'stack-sm' }, shown.map((c) => {
      const thanks = h('button', { class: 'btn btn-sm btn-accent', type: 'button' }, icon('heart', 15), 'Say thanks');
      thanks.addEventListener('click', async () => {
        setBusy(thanks, true);
        try {
          await api.post(`/kid/cheers/${c.id}/thanks`);
          toast(`${c.from} will love that`, { emoji: '💛' });
          onChange();
        } catch (e) {
          toast(e.message, { tone: 'error' });
          setBusy(thanks, false);
        }
      });
      return h('div', { class: 'card cheer-card' },
        h('span', { class: 'cheer-emoji', 'aria-hidden': 'true' }, c.emoji),
        h('div', { class: 'grow' }, h('div', { class: 'row-title' }, `“${c.message}”`), h('div', { class: 'row-sub' }, `From ${c.from} · ${timeAgo(c.createdAt)}`)),
        c.thanked ? pill('Thanked 💛', 'pos') : thanks);
    })),
  );
}

/** A nudge toward today's lesson, with progress and the learning streak. */
export function learningCard(d) {
  const l = d.learning;
  return h(
    'section',
    { class: 'card learn-mini' },
    h('div', { class: 'spread', style: { gap: '12px', alignItems: 'flex-start' } },
      h('div', { class: 'row-title' }, '💡 Money Smarts'),
      l.streak ? pill(`🔥 ${l.streak}-day streak`, 'warn') : null),
    h('p', { class: 'small muted', style: { margin: '6px 0 12px' } }, l.passedCount === l.total ? 'You passed every lesson. Amazing!' : l.doneToday ? 'Nice work today! Want to try another?' : 'Learn something new in two minutes.'),
    meter({ label: `${l.passedCount} of ${l.total} lessons`, value: l.passedCount, max: l.total, textRight: '', tone: 'pos' }),
    h('a', { class: 'btn btn-sm', href: '#/learn', style: { marginTop: '14px' } }, l.passedCount === l.total ? 'Review lessons' : l.doneToday ? 'More lessons' : 'Start a lesson', icon('right', 15)),
  );
}

/** The family's house rules, tucked into a disclosure so they're there when you need them. */
export function rulesCard(d) {
  if (!d.rules.length) return null;
  return h(
    'details',
    { class: 'card rules-card' },
    h('summary', null, h('span', { 'aria-hidden': 'true' }, '📜'), h('b', null, `House rules (${d.rules.length})`), icon('right', 16)),
    h('ol', { class: 'rules-list' }, d.rules.map((r) => h('li', null, r))),
    h('p', { class: 'tiny muted' }, `Set by ${d.parentName}`),
  );
}
