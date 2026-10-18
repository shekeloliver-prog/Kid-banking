import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { avatar, pill, emptyState, toast, confirmModal } from '../../ui.js';
import { money, REPEAT_LABEL, timeAgo } from '../../format.js';
import { choreDialog, choreClaimItem } from './parts.js';

export const choresView = defineView({
  title: 'Chores',
  autoRefresh: true,
  load: async () => {
    const [data, overview] = await Promise.all([api.get('/chores'), api.get('/parent/overview')]);
    return { ...data, kids: overview.kids };
  },
  render: ({ chores, claims, recent, kids }, { refresh }) => {
    const soft = () => refresh({ silent: true });
    const add = (kidId) => (kids.length ? choreDialog({ kids, kidId, onDone: soft }) : (location.hash = '#/kids'));
    const remove = (c) =>
      confirmModal({
        title: `Remove “${c.title}”?`,
        text: c.pendingClaimId ? `${c.kid.name} already said they finished it. It will be closed without a payment.` : 'It disappears from their list. Past rewards stay in the history.',
        confirmLabel: 'Remove chore',
        onConfirm: async () => {
          await api.del(`/chores/${c.id}`);
          toast('Chore removed');
          soft();
        },
      });

    const byKid = new Map(kids.map((k) => [k.id, []]));
    for (const c of chores) byKid.get(c.kid.id)?.push(c);

    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Chores'), h('p', null, 'Assign jobs, check them off, and pay the reward.')), h('button', { class: 'btn btn-primary', onClick: () => add(null), disabled: !kids.length }, icon('plus', 18), 'Add chore')),
      claims.length ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Ready to check')), h('div', { class: 'card card-flush' }, claims.map((c) => choreClaimItem(c, { onDone: soft })))) : null,
      !kids.length
        ? h('div', { class: 'card' }, emptyState({ emoji: '🧒', title: 'Add a kid first', text: 'Chores are assigned to a kid.', action: h('a', { class: 'btn btn-primary btn-lg', href: '#/kids' }, 'Go to Kids') }))
        : !chores.length
          ? h('div', { class: 'card' }, emptyState({ emoji: '🧹', title: 'No chores yet', text: 'Give your kids a way to earn: a one-time job, or something daily or weekly.', action: h('button', { class: 'btn btn-primary btn-lg', onClick: () => add(null) }, icon('plus', 20), 'Add the first chore') }))
          : h(
              'section',
              null,
              h('div', { class: 'section-head' }, h('h2', null, 'All chores')),
              h(
                'div',
                { class: 'card card-flush' },
                kids.flatMap((k) => {
                  const mine = byKid.get(k.id) ?? [];
                  return [
                    h('div', { class: 'kid-group', dataset: { color: k.color } }, avatar(k, 'xs'), h('span', { class: 'ellipsis' }, k.name), h('span', { class: 'grow' }), h('button', { class: 'btn btn-ghost btn-sm', onClick: () => add(k.id) }, icon('plus', 16), 'Add')),
                    ...(mine.length
                      ? mine.map((c) =>
                          h(
                            'div',
                            { class: 'chore-row' },
                            h('div', { class: 'row-icon', 'aria-hidden': 'true' }, c.emoji),
                            h('div', { class: 'row-main' }, h('div', { class: 'row-title ellipsis' }, c.title), h('div', { class: 'row-sub' }, [REPEAT_LABEL[c.repeat], c.doneCount ? `done ${c.doneCount}×` : null].filter(Boolean).join(' · '), c.pendingClaimId ? h('div', null, pill('Waiting for you', 'warn')) : null)),
                            h(
                              'div',
                              { class: 'chore-actions' },
                              h('div', { class: 'reward', style: { marginRight: '4px' } }, money(c.rewardCents)),
                              h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': `Edit ${c.title}`, onClick: () => choreDialog({ kids, chore: c, onDone: soft }) }, icon('edit', 17)),
                              h('button', { class: 'btn btn-ghost btn-icon btn-sm', 'aria-label': `Remove ${c.title}`, onClick: () => remove(c) }, icon('trash', 17)),
                            ),
                          ),
                        )
                      : [h('div', { class: 'chore-row muted small' }, 'No chores for this kid yet.')]),
                  ];
                }),
              ),
            ),
      recent.length
        ? h(
            'section',
            null,
            h('div', { class: 'section-head' }, h('h2', null, 'Recently checked')),
            h(
              'div',
              { class: 'card card-flush' },
              recent.map((c) =>
                h(
                  'div',
                  { class: 'row' },
                  avatar(c.kid, 'sm'),
                  h('div', { class: 'row-main' }, h('div', { class: 'row-title ellipsis' }, `${c.kid.name} · ${c.emoji} ${c.title}`), h('div', { class: 'row-sub ellipsis' }, `${c.responseNote ? `“${c.responseNote}” · ` : ''}${timeAgo(c.decidedAt ?? c.createdAt)}`)),
                  h('div', { style: { textAlign: 'right' } }, pill(c.status === 'approved' ? `Paid ${money(c.rewardCents)}` : 'Sent back', c.status === 'approved' ? 'pos' : ''), null),
                ),
              ),
            ),
          )
        : null,
    );
  },
});
