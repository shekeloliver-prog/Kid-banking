// Savings interest: the "Bank of Mom" pays a parent-chosen yearly rate on the money a kid has saved in goals.
// It's paid weekly from the parent's balance (so money is never created out of thin air), and — like allowances —
// re-checked inside its own transaction so running it from several places can never pay twice.

import { money } from './util.js';
import { dateInZone, addDays } from './dates.js';

export const MAX_INTEREST_BPS = 2000; // 20% a year
const WEEKS_PER_YEAR = 52;

export const weeklyInterestCents = (savedCents, bps) => Math.floor((savedCents * bps) / 10_000 / WEEKS_PER_YEAR);
export const ratePercent = (bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2).replace(/(\.\d)0$/, '$1')}%`;

export function createInterest(core) {
  const { q, atomic, notify, transfer, getUser, controlsRow, clock } = core;

  /** Pays interest for every kid whose weekly date has arrived. Returns the payouts made. */
  async function runInterest() {
    const now = clock();
    const horizon = addDays(dateInZone(now, 'UTC'), 1);
    const rows = await q(
      `SELECT c.kid_id, k.name AS kid_name, k.parent_id, p.timezone
       FROM kid_controls c JOIN users k ON k.id = c.kid_id JOIN users p ON p.id = k.parent_id
       WHERE c.interest_bps > 0 AND c.interest_next IS NOT NULL AND c.interest_next <= ?`,
    ).all(horizon);
    const paid = [];
    for (const r of rows) {
      const today = dateInZone(now, r.timezone);
      try {
        await atomic(async () => {
          const c = await controlsRow(r.kid_id);
          if (!c || c.interest_bps <= 0 || !c.interest_next || c.interest_next > today) return; // paid or changed elsewhere
          const saved = (await q("SELECT COALESCE(SUM(saved_cents), 0) AS s FROM goals WHERE kid_id = ? AND status = 'active'").get(r.kid_id)).s;
          const interest = weeklyInterestCents(saved, c.interest_bps);
          // One payment per run; weeks missed while nobody was around are skipped, not paid retroactively.
          let next = addDays(c.interest_next, 7);
          while (next <= today) next = addDays(next, 7);
          await q('UPDATE kid_controls SET interest_next = ? WHERE kid_id = ?').run(next, r.kid_id);
          if (interest < 1) return;
          const parent = await getUser(r.parent_id);
          if (parent.balance_cents < interest) {
            await notify(r.parent_id, {
              icon: '⚠️',
              title: `${r.kid_name}'s interest wasn't paid`,
              body: `You needed ${money(interest)} in your balance this week. It will try again next week.`,
              link: '#/funding',
            });
            return;
          }
          await transfer(parent, await getUser(r.kid_id), interest, {
            fromKind: 'interest_out',
            toKind: 'interest_in',
            note: `Interest on ${money(saved)} saved (${ratePercent(c.interest_bps)} a year)`,
          });
          await notify(r.kid_id, { icon: '📈', title: `Your savings earned ${money(interest)}!`, body: `${ratePercent(c.interest_bps)} a year on ${money(saved)}`, link: '#/' });
          await core.awardBadges(r.kid_id);
          paid.push({ kidId: r.kid_id, cents: interest });
        });
      } catch (err) {
        console.error('Interest payment failed for kid', r.kid_id, err);
      }
    }
    return paid;
  }

  return { runInterest };
}
