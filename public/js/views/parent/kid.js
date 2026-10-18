import { h, setBusy } from '../../dom.js';
import { icon } from '../../icons.js';
import { api } from '../../api.js';
import { defineView } from '../../view.js';
import { avatar, pill, meter, moneyField, switchControl, activityList, spendChart, toast, banner, badgeShelf } from '../../ui.js';
import { money, moneyCompact, weekdayName, ordinal, formatDay, describeAllowance, ymdToDate } from '../../format.js';
import { moneyDialog, editKidDialog, resetPinDialog, removeKidDialog, requestItem, choreClaimItem } from './parts.js';

// Mirrors the server's schedule maths so the form can preview the first payment.
function firstDue(todayYmd, freq, day) {
  const [y, m, d] = todayYmd.split('-').map(Number);
  if (freq === 'monthly') {
    return d < day ? new Date(y, m - 1, day) : new Date(y, m, day);
  }
  const today = new Date(y, m - 1, d);
  let delta = (day - today.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(y, m - 1, d + delta);
}
const fmtDate = (date) => date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const FREQS = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Biweekly'],
  ['monthly', 'Monthly'],
];

function allowanceCard(d, refresh) {
  const kid = d.kid;
  const a = kid.allowance;
  let active = a.active;
  let freq = a.freq;
  let day = a.day;
  const amount = moneyField({ label: 'Amount each time', value: a.cents || 500, quick: [], autofocus: false });
  const body = h('div', { class: 'subpanel' });
  const error = h('div', { class: 'field' });

  const sw = switchControl({ checked: active, label: 'Allowance on', onChange: (v) => { active = v; draw(); } });

  function draw() {
    body.hidden = !active;
    if (!active) return;
    const seg = h('div', { class: 'seg seg-full', role: 'group', 'aria-label': 'How often' }, FREQS.map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(freq === key), onClick: () => { if (freq !== key) { freq = key; day = key === 'monthly' ? 1 : 5; draw(); } } }, label)));
    const select = h('select', { class: 'select', id: 'allow-day', onChange: (e) => { day = Number(e.target.value); draw(); } },
      freq === 'monthly'
        ? Array.from({ length: 28 }, (_, i) => h('option', { value: i + 1, selected: day === i + 1 }, ordinal(i + 1)))
        : Array.from({ length: 7 }, (_, i) => h('option', { value: i, selected: day === i }, weekdayName(i))));
    const changed = !a.active || a.freq !== freq || a.day !== day;
    const next = changed ? `First payment ${fmtDate(firstDue(d.today, freq, day))}` : `Next payment ${fmtDate(ymdToDate(a.next))}`;
    body.replaceChildren(
      amount.el,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'How often'), seg),
      h('div', { class: 'field' }, h('label', { for: 'allow-day' }, freq === 'monthly' ? 'Day of the month' : 'Day of the week'), select),
      h('div', { class: 'cluster small text-2' }, icon('calendar', 16), next),
    );
  }
  draw();

  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save allowance');
  save.addEventListener('click', async () => {
    const cents = amount.getCents();
    if (active && !(cents >= 100)) return toast('An allowance is at least $1.', { tone: 'error' });
    setBusy(save, true);
    try {
      await api.put(`/kids/${kid.id}/controls`, { allowance: { cents: cents >= 100 ? cents : a.cents || 500, freq, day, active } });
      toast(active ? `Allowance saved — ${kid.name} will love it` : 'Allowance turned off', { emoji: '🗓️' });
      refresh({ silent: true });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(save, false);
    }
  });

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Allowance'), h('div', { class: 'desc' }, 'Paid automatically from your balance.')), sw.el),
    body,
    error,
    h('div', { style: { marginTop: '16px' } }, save),
  );
}

function limitsCard(d, refresh) {
  const kid = d.kid;
  let limitOn = kid.weeklyLimitCents != null;
  let capOn = kid.maxRequestCents != null;
  const limit = moneyField({ label: 'Weekly spending limit', value: kid.weeklyLimitCents ?? 2000, quick: [], autofocus: false });
  const cap = moneyField({ label: 'Biggest request they can make', value: kid.maxRequestCents ?? 2000, quick: [], autofocus: false });
  const limitBox = h('div', { class: 'subpanel' });
  const capBox = h('div', { class: 'subpanel' });
  const sync = () => {
    limitBox.hidden = !limitOn;
    capBox.hidden = !capOn;
  };
  limitBox.append(limit.el, h('div', { class: 'tiny muted' }, `Counts everything ${kid.name} spends in any rolling 7 days. Savings-goal purchases don’t count, but you’ll be notified.`));
  capBox.append(cap.el);
  sync();
  const swLimit = switchControl({ checked: limitOn, label: 'Weekly spending limit', onChange: (v) => { limitOn = v; sync(); } });
  const swCap = switchControl({ checked: capOn, label: 'Request cap', onChange: (v) => { capOn = v; sync(); } });

  const save = h('button', { class: 'btn btn-primary', type: 'button' }, 'Save limits');
  save.addEventListener('click', async () => {
    const l = limit.getCents();
    const c = cap.getCents();
    if (limitOn && !(l >= 100)) return toast('The weekly limit is at least $1.', { tone: 'error' });
    if (capOn && !(c >= 100)) return toast('The request cap is at least $1.', { tone: 'error' });
    setBusy(save, true);
    try {
      await api.put(`/kids/${kid.id}/controls`, { weeklyLimitCents: limitOn ? l : null, maxRequestCents: capOn ? c : null });
      toast('Limits saved', { emoji: '🛡️' });
      refresh({ silent: true });
    } catch (e) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(save, false);
    }
  });

  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Weekly spending limit'), h('div', { class: 'desc' }, 'Stop purchases once they hit a total.')), swLimit.el),
    limitBox,
    h('hr', { class: 'divider' }),
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Cap on money requests'), h('div', { class: 'desc' }, 'Limit how much they can ask for at once.')), swCap.el),
    capBox,
    kid.weeklyLimitCents != null ? h('div', { style: { marginTop: '18px' } }, meter({ label: 'Spent in the last 7 days', value: kid.spent7dCents, max: kid.weeklyLimitCents, textRight: `${money(kid.spent7dCents)} of ${moneyCompact(kid.weeklyLimitCents)}` })) : null,
    h('div', { style: { marginTop: '16px' } }, save),
  );
}

function accountCard(d, refresh) {
  const kid = d.kid;
  const sw = switchControl({
    checked: kid.frozen,
    label: 'Pause spending',
    onChange: async (v) => {
      sw.input.disabled = true;
      try {
        await api.put(`/kids/${kid.id}/controls`, { frozen: v });
        toast(v ? `${kid.name}'s spending is paused` : `${kid.name} can spend again`, { emoji: v ? '⏸️' : '▶️' });
        refresh({ silent: true });
      } catch (e) {
        sw.input.checked = !v;
        sw.input.disabled = false;
        toast(e.message, { tone: 'error' });
      }
    },
  });
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'control' }, h('div', null, h('b', null, 'Pause spending'), h('div', { class: 'desc' }, 'They can still save, and ask for money.')), sw.el),
    h('hr', { class: 'divider' }),
    h(
      'div',
      { class: 'cluster' },
      h('button', { class: 'btn btn-sm', onClick: () => editKidDialog(kid, () => refresh({ silent: true })) }, icon('edit', 16), 'Edit profile'),
      h('button', { class: 'btn btn-sm', onClick: () => resetPinDialog(kid) }, icon('key', 16), 'Reset PIN'),
      h('button', { class: 'btn btn-sm btn-danger-soft', onClick: () => removeKidDialog(kid, () => (location.hash = '#/kids')) }, icon('trash', 16), 'Remove'),
    ),
  );
}

function goalsCard(d) {
  const goals = d.goals;
  return h(
    'section',
    { class: 'card card-flush' },
    h('div', { class: 'card-head', style: { padding: '20px 22px 0', marginBottom: '6px' } }, h('div', null, h('h2', { class: 'card-title' }, 'Savings goals'), h('p', { class: 'card-sub' }, `What ${d.kid.name} is saving for`))),
    goals.length
      ? h('div', { class: 'list' }, goals.map((g) => {
          const p = Math.min(1, g.savedCents / g.targetCents);
          return h('div', { class: 'row' },
            h('div', { class: 'row-icon', 'aria-hidden': 'true' }, g.emoji),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title ellipsis' }, g.name),
              g.status === 'purchased' ? h('div', { class: 'row-sub' }, 'Bought 🎉') : h('div', { class: 'progress', style: { marginTop: '6px', height: '6px' }, role: 'progressbar', 'aria-valuenow': Math.round(p * 100) }, h('span', { style: { '--p': p } }))),
            h('div', { class: 'row-amount' }, money(g.status === 'purchased' ? g.targetCents : g.savedCents), h('small', null, `of ${moneyCompact(g.targetCents)}`)));
        }))
      : h('p', { class: 'muted', style: { padding: '8px 22px 22px' } }, `No goals yet. ${d.kid.name} can start one from their own account.`),
  );
}

export const kidView = defineView({
  title: (d) => d.kid.name,
  load: ({ id }) => api.get(`/kids/${id}`),
  render: (d, { refresh }) => {
    const kid = d.kid;
    const soft = () => refresh({ silent: true });
    const pending = d.requests.filter((r) => r.status === 'pending').map((r) => ({ ...r, kid }));
    const total14 = d.spendByDay.reduce((s, x) => s + x.spentCents, 0);
    const dialog = (mode) => api.get('/parent/overview').then((o) => moneyDialog({ mode, kids: o.kids, kidId: kid.id, balanceCents: o.balanceCents, onDone: soft }));
    return h(
      'div',
      { class: 'stack-lg', dataset: { color: kid.color } },
      h('div', null,
        h('a', { class: 'back-link', href: '#/kids' }, icon('left', 16), 'All kids'),
        h('div', { class: 'kid-head' },
          avatar(kid, 'xl'),
          h('div', { class: 'grow' }, h('h1', null, kid.name), h('div', { class: 'muted' }, `@${kid.username}`), h('div', { class: 'cluster', style: { marginTop: '8px' } }, kid.frozen ? pill('Spending paused', 'warn', 'pause') : pill('Active', 'pos', 'check'), describeAllowance(kid.allowance) ? pill(`Allowance ${describeAllowance(kid.allowance)}`, 'primary', 'calendar') : null)),
          h('div', { class: 'cluster' },
            h('button', { class: 'btn btn-accent', onClick: () => dialog('send') }, icon('send', 18), 'Send money'),
            h('button', { class: 'btn', onClick: () => dialog('take') }, icon('undo', 18), 'Take back')))),
      kid.frozen ? banner('warn', 'pause', h('b', null, `${kid.name}'s spending is paused. `), 'They can still receive money, save to goals and send requests.') : null,
      pending.length || d.pendingChores.length ? h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you')), h('div', { class: 'card card-flush' }, [...d.pendingChores.map((c) => choreClaimItem(c, { onDone: soft })), ...pending.map((r) => requestItem(r, { onDone: soft }))])) : null,
      h('section', { class: 'grid grid-3 stats' },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('wallet', 17), 'Spending balance'), h('div', { class: 'value' }, money(kid.balanceCents)), h('div', { class: 'foot' }, 'ready to use')),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('target', 17), 'In savings goals'), h('div', { class: 'value' }, money(kid.savedCents)), h('div', { class: 'foot' }, `${kid.activeGoals} active goal${kid.activeGoals === 1 ? '' : 's'}`)),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, icon('trend', 17), 'Spent in 7 days'), h('div', { class: 'value' }, money(kid.spent7dCents)), h('div', { class: 'foot' }, kid.weeklyLimitCents != null ? `limit ${moneyCompact(kid.weeklyLimitCents)}` : 'no limit set'))),
      h('div', { class: 'two-col' },
        h('div', { class: 'stack-lg' },
          h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, 'Spending'), h('p', { class: 'card-sub' }, 'Last 14 days')), h('div', { style: { textAlign: 'right' } }, h('div', { style: { fontWeight: 800, fontSize: '20px' } }, money(total14)), h('div', { class: 'tiny muted' }, 'total'))), spendChart(d.spendByDay)),
          goalsCard(d),
          h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', { class: 'card-title' }, 'Badges'), h('p', { class: 'card-sub' }, `${d.badges.filter((b) => b.earned).length} of ${d.badges.length} earned`))), badgeShelf(d.badges, { compact: true })),
          h('section', null, h('div', { class: 'section-head' }, h('h2', null, 'Activity'), h('a', { class: 'link', href: `#/activity?kid=${kid.id}` }, 'See all', icon('right', 16))), activityList(d.recent, 'parent', { emptyText: `Nothing yet — send ${kid.name} some money to get started.` }))),
        h('div', { class: 'stack' }, allowanceCard(d, refresh), limitsCard(d, refresh), accountCard(d, refresh))),
    );
  },
});
