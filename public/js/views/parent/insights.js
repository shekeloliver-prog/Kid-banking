import { h } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { avatar, emptyState, categoryBars, spendChart } from '../../ui.js';
import { money, formatDay } from '../../format.js';

const RANGES = [7, 30, 90];
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');

export const insightsView = defineView({
  title: 'Insights',
  autoRefresh: true,
  load: async () => {
    const params = hashParams();
    const days = RANGES.includes(Number(params.get('days'))) ? Number(params.get('days')) : 30;
    const kid = params.get('kid');
    const [data, overview] = await Promise.all([api.get(`/insights?days=${days}${kid ? `&kid=${encodeURIComponent(kid)}` : ''}`), api.get('/parent/overview')]);
    return { ...data, kids: overview.kids, kidId: kid ? Number(kid) : null };
  },
  render: (d) => {
    const go = (days, kidId) => (location.hash = `#/insights?days=${days}${kidId ? `&kid=${kidId}` : ''}`);
    const t = d.totals;
    const stat = (ic, label, value, foot) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon(ic, 17), label), h('div', { class: 'value' }, money(value)), h('div', { class: 'foot' }, foot));
    const empty = !t.spentCents && !t.earnedCents && !t.savedCents;
    return h(
      'div',
      { class: 'stack-lg' },
      h('header', { class: 'page-head', style: { marginBottom: '0' } }, h('div', null, h('h1', null, 'Insights'), h('p', null, 'Where your family’s money goes, and how your kids are doing.'))),
      h(
        'div',
        { class: 'cluster', style: { justifyContent: 'space-between' } },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' }, RANGES.map((r) => h('button', { 'aria-pressed': String(d.days === r), onClick: () => go(r, d.kidId) }, `${r} days`))),
        d.kids.length > 1
          ? h('div', { class: 'chips' }, [h('button', { class: 'chip', 'aria-pressed': String(!d.kidId), onClick: () => go(d.days, null) }, 'Everyone'), ...d.kids.map((k) => h('button', { class: 'chip', 'aria-pressed': String(d.kidId === k.id), onClick: () => go(d.days, k.id) }, avatar(k, 'xs'), k.name))])
          : null,
      ),
      h(
        'section',
        { class: 'grid stats-4 stats' },
        stat('bag', 'Spent', t.spentCents, `in the last ${d.days} days`),
        stat('receive', 'Earned & received', t.earnedCents, `allowance ${money(t.allowanceCents)} · chores ${money(t.choresCents)}`),
        stat('target', 'Moved into goals', Math.max(0, t.savedCents), 'net of withdrawals'),
        stat('check', 'Chore rewards', t.choresCents, 'earned by doing chores'),
      ),
      empty
        ? h('div', { class: 'card' }, emptyState({ emoji: '📊', title: 'Nothing to chart yet', text: 'Once your kids start spending, saving and earning, you’ll see it here.' }))
        : h(
            'div',
            { class: 'two-col' },
            h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, 'Where the money goes'), h('p', { class: 'card-sub' }, `Spending by category · last ${d.days} days`))), d.categories.length ? categoryBars(d.categories) : h('p', { class: 'muted' }, 'No spending in this period.')),
            h(
              'section',
              { class: 'card' },
              h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, 'Week by week'), h('p', { class: 'card-sub' }, 'Spending in 7-day blocks'))),
              spendChart(d.weekly.map((w) => ({ date: w.start, spentCents: w.spentCents })), { tipTitle: (w) => `Week of ${formatDay(w.date, { month: 'short', day: 'numeric' })}`, axisLabel: (w) => formatDay(w.date, { month: 'numeric', day: 'numeric' }) }),
            ),
          ),
      !d.kidId && d.perKid.length
        ? h(
            'section',
            { class: 'card card-flush' },
            h('div', { class: 'card-head', style: { padding: '20px 22px 0', marginBottom: '6px' } }, h('div', null, h('h2', { class: 'card-title' }, 'By kid'))),
            h(
              'div',
              { style: { overflowX: 'auto', padding: '0 10px 14px' } },
              h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Kid', 'Spent', 'Earned', 'Saved'].map((x) => h('th', null, x)))), h('tbody', null, d.perKid.map((k) => h('tr', null, h('td', null, h('span', { class: 'cluster', style: { gap: '8px', flexWrap: 'nowrap', minWidth: 0 } }, avatar(k.kid, 'xs'), h('span', { class: 'ellipsis' }, k.kid.name))), h('td', null, money(k.spentCents)), h('td', null, money(k.earnedCents)), h('td', null, money(Math.max(0, k.savedCents))))))),
            ),
          )
        : null,
    );
  },
});
