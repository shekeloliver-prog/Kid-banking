import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { money, moneyCompact, describeAllowance, formatDay, ymdToDate, inDays, ratePercent, weeklyInterest } from '../../format.js';
import { activityList, meter, banner, countUp, emptyState, badgeShelf } from '../../ui.js';
import { choreCard } from './chores.js';
import { spendDialog, askDialog, newGoalDialog, goalMoneyDialog, goalMini } from './parts.js';

let counted = false;

export const kidHome = defineView({
  title: 'Home',
  autoRefresh: true,
  load: () => api.get('/kid/overview'),
  render: (d, { refresh }) => {
    const kid = d.kid;
    const soft = () => refresh({ silent: true });
    const activeGoals = d.goals.filter((g) => g.status === 'active');
    const amount = h('div', { class: 'amount', 'aria-live': 'polite' }, money(kid.balanceCents));
    if (!counted) {
      counted = true;
      countUp(amount, kid.balanceCents);
    }
    const remaining = kid.weeklyLimitCents != null ? Math.max(0, kid.weeklyLimitCents - kid.spent7dCents) : null;
    const allowance = describeAllowance(kid.allowance);
    const pending = d.requests.filter((r) => r.status === 'pending');
    const choresToDo = d.chores.chores.filter((c) => c.state !== 'cooldown');

    const save = () => {
      if (!activeGoals.length) return newGoalDialog({ kid, onDone: soft });
      if (activeGoals.length === 1) return goalMoneyDialog({ mode: 'save', goal: activeGoals[0], kid, onDone: soft });
      location.hash = '#/goals';
    };

    return h(
      'div',
      { class: 'stack-lg' },
      h('div', { class: 'page-head', style: { marginBottom: '-6px' } }, h('div', null, h('h1', null, `Hi ${kid.name}! 👋`))),
      h('section', { class: 'bubble' },
        h('div', { class: 'hello' }, 'You have'),
        amount,
        h('div', { class: 'sub' }, kid.savedCents ? `+ ${money(kid.savedCents)} saved in your goals 🐷` : 'to spend or save')),
      kid.frozen ? banner('warn', 'pause', h('b', null, 'Spending is paused. '), `${d.parentName} turned spending off for now. You can still save and ask for money.`) : null,
      h('section', { class: 'actions-3' },
        h('button', { class: 'action-tile', disabled: kid.frozen || kid.balanceCents <= 0, onClick: () => spendDialog({ kid, onDone: soft }) }, h('span', { class: 'e', 'aria-hidden': 'true' }, '🛍️'), 'Spend'),
        h('button', { class: 'action-tile', onClick: save }, h('span', { class: 'e', 'aria-hidden': 'true' }, '🐷'), 'Save up'),
        h('button', { class: 'action-tile', onClick: () => askDialog({ kid, onDone: soft }) }, h('span', { class: 'e', 'aria-hidden': 'true' }, '🙋'), 'Ask')),
      h('div', { class: 'grid grid-2' },
        remaining != null
          ? h('section', { class: 'card' }, h('div', { class: 'row-title', style: { marginBottom: '10px' } }, '🛡️ This week’s spending'), meter({ label: `${money(kid.spent7dCents)} spent`, value: kid.spent7dCents, max: kid.weeklyLimitCents, textRight: remaining > 0 ? `${money(remaining)} left` : 'limit reached' }), kid.freesUpAt && remaining < kid.weeklyLimitCents ? h('p', { class: 'tiny muted', style: { marginTop: '10px' } }, `Your oldest purchase rolls off ${inDays(kid.freesUpAt)}.`) : null)
          : null,
        allowance
          ? h('section', { class: 'card' }, h('div', { class: 'row-title', style: { marginBottom: '6px' } }, '🗓️ Allowance'), h('div', { style: { fontSize: '22px', fontWeight: 800, letterSpacing: '-0.02em' } }, allowance), kid.allowance.next ? h('p', { class: 'small muted', style: { marginTop: '4px' } }, `Next one: ${formatDay(kid.allowance.next, { weekday: 'long', month: 'short', day: 'numeric' })}`) : null)
          : null),
      choresToDo.length
        ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Chores to do'), h('a', { class: 'link', href: '#/chores' }, 'See all', icon('right', 16))), h('div', { class: 'stack-sm' }, choresToDo.slice(0, 3).map((c) => choreCard(c, { parentName: d.parentName, onChange: soft }))))
        : null,
      pending.length
        ? h('section', { class: 'card' }, h('div', { class: 'row-title', style: { marginBottom: '8px' } }, '⏳ Waiting on your parent'), pending.map((r) => h('div', { class: 'spread small', style: { padding: '6px 0' } }, h('span', null, `“${r.reason}”`), h('b', null, money(r.amountCents)))))
        : null,
      h('section', null,
        h('div', { class: 'section-head' }, h('h2', null, 'My goals'), h('a', { class: 'link', href: '#/goals' }, activeGoals.length ? 'See all' : 'Start one', icon('right', 16))),
        activeGoals.length
          ? h('div', { class: 'card card-flush' }, activeGoals.slice(0, 3).map(goalMini))
          : h('div', { class: 'card' }, emptyState({ emoji: '🎯', title: 'What are you saving for?', text: 'Pick something you want, set a target, and watch it fill up.', action: h('button', { class: 'btn btn-accent btn-lg', onClick: () => newGoalDialog({ kid, onDone: soft }) }, icon('plus', 20), 'Make a goal') }))),
      kid.interestBps > 0
        ? h('div', { class: 'card interest-note' }, icon('trend', 18), kid.savedCents > 0 ? `Your savings earn ${ratePercent(kid.interestBps)} a year — about ${money(weeklyInterest(kid.savedCents, kid.interestBps))} every week!` : `Save money in a goal and it will earn ${ratePercent(kid.interestBps)} a year.`)
        : null,
      h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'My badges'), h('span', { class: 'small muted' }, `${d.badges.filter((b) => b.earned).length} of ${d.badges.length}`)), h('div', { class: 'card' }, badgeShelf(d.badges, { compact: true }))),
      d.recent.length
        ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Recent'), h('a', { class: 'link', href: '#/activity' }, 'See all', icon('right', 16))), activityList(d.recent, 'kid'))
        : null,
    );
  },
});

void ymdToDate;
void moneyCompact;
