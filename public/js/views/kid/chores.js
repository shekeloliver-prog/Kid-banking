import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { money, REPEAT_LABEL, timeAgo } from '../../format.js';
import { pill, emptyState, toast } from '../../ui.js';

/** One chore as a big friendly card with the right action for where it's at. */
export function choreCard(c, { parentName, onChange }) {
  const claim = h('button', { class: 'btn btn-accent' }, icon('check', 18), 'I did it!');
  claim.addEventListener('click', async () => {
    setBusy(claim, true);
    try {
      await api.post(`/kid/chores/${c.id}/claim`);
      toast(`Nice work! ${parentName} will check it.`, { emoji: '🙌' });
      onChange();
    } catch (e) {
      toast(e.message, { tone: 'error' });
      setBusy(claim, false);
    }
  });
  const undo = h('button', { class: 'btn btn-ghost btn-sm' }, 'Take back');
  undo.addEventListener('click', async () => {
    setBusy(undo, true);
    try {
      await api.del(`/kid/chore-claims/${c.claimId}`);
      toast('Okay — not done yet');
      onChange();
    } catch (e) {
      toast(e.message, { tone: 'error' });
      setBusy(undo, false);
    }
  });
  return h(
    'article',
    { class: `chore-card is-${c.state}` },
    h('div', { class: 'e', 'aria-hidden': 'true' }, c.emoji),
    h('div', { class: 'grow' }, h('div', { class: 'row-title', style: { fontSize: '17px', fontWeight: 800 } }, c.title), h('div', { class: 'row-sub' }, `${money(c.rewardCents)} · ${REPEAT_LABEL[c.repeat]}`), c.state !== 'available' ? h('div', { class: 'small', style: { marginTop: '4px', fontWeight: 600 } }, c.reason) : null),
    c.state === 'available' ? claim : c.state === 'pending' ? undo : pill('Done', 'pos', 'check'),
  );
}

export const kidChoresView = defineView({
  title: 'Chores',
  autoRefresh: true,
  load: async () => {
    const [chores, overview] = await Promise.all([api.get('/kid/chores'), api.get('/kid/overview')]);
    return { ...chores, parentName: overview.parentName };
  },
  render: (d, { refresh }) => {
    const soft = () => refresh({ silent: true });
    const onChange = () => {
      soft();
    };
    const open = d.chores.filter((c) => c.state !== 'cooldown');
    const done = d.chores.filter((c) => c.state === 'cooldown');
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'My chores'), h('p', null, d.earnedCents ? `You’ve earned ${money(d.earnedCents)} so far 💪` : 'Do a chore, tap the button, get paid.'))),
      d.chores.length
        ? h('div', { class: 'stack-sm' }, [...open, ...done].map((c) => choreCard(c, { parentName: d.parentName, onChange })))
        : h('div', { class: 'card' }, emptyState({ emoji: '🧹', title: 'No chores right now', text: `When ${d.parentName} adds a chore you can earn money for, it shows up here.` })),
      d.recent.length
        ? h(
            'section',
            null,
            h('div', { class: 'section-head' }, h('h2', null, 'Recently checked')),
            h('div', { class: 'card card-flush' }, d.recent.map((r) => h('div', { class: 'row' }, h('div', { class: 'row-icon', 'aria-hidden': 'true' }, r.emoji), h('div', { class: 'row-main' }, h('div', { class: 'row-title ellipsis' }, r.title), h('div', { class: 'row-sub' }, r.status === 'approved' ? timeAgo(r.decidedAt) : `Try again${r.responseNote ? ` — “${r.responseNote}”` : ''}`)), h('div', { class: `row-amount ${r.status === 'approved' ? 'pos' : 'muted'}` }, r.status === 'approved' ? `+${money(r.rewardCents)}` : '—')))),
          )
        : null,
    );
  },
});

