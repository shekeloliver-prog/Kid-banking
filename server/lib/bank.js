// The banking engine. Any operation that moves money runs inside a single database
// transaction, so a failure part-way through can never leave the books out of balance.
//
// Ledger conventions (transactions table):
//   amount_cents  signed effect on the owner's money, in cents
//   kind          what happened (see KINDS below)
//   counterparty  who is on the other side; for goal rows it holds the goal's name
//
// Kinds that only exist on the kid's side of the ledger (never mirrored to a parent row):
//   spend, goal_save, goal_release, goal_purchase
// A goal_purchase does not touch the spendable balance: that money already left it
// when it was saved to the goal.

import { HttpError, cents, oneOf, FREQUENCIES, CATEGORIES, money, MAX_CENTS } from './util.js';
import { dateInZone, firstDue, advance, addDays } from './dates.js';
import { createBadges } from './badges.js';
import { createChores } from './chores.js';
import { createInterest, MAX_INTEREST_BPS, ratePercent } from './interest.js';
import { createInsights } from './insights.js';

export const KID_ONLY_KINDS = ['spend', 'goal_save', 'goal_release', 'goal_purchase'];
export const MAX_DEPOSIT_CENTS = 50_000; // $500 of practice money at a time
const MAX_KIDS = 12;
const MAX_ACTIVE_GOALS = 10;
const MAX_PENDING_REQUESTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const CATEGORY_EMOJI = { food: '🍕', games: '🎮', toys: '🧸', books: '📚', fun: '🎬', gifts: '🎁', other: '✨' };

const notFound = (what = 'That') => new HttpError(404, 'not_found', `${what} wasn't found.`);

export function createBank(db, clock = () => new Date()) {
  const q = (sql) => ({
    get: (...args) => db.get(sql, args),
    all: (...args) => db.all(sql, args),
    run: (...args) => db.run(sql, args),
  });
  const nowIso = () => clock().toISOString();
  const atomic = (fn) => db.atomic(fn);

  // ───────────────────────── low-level ledger ─────────────────────────

  async function post(userId, { kind, amount, delta = amount, counterparty = null, note = null, category = null, goalId = null }) {
    const u = await q('SELECT balance_cents FROM users WHERE id = ?').get(userId);
    if (!u) throw notFound('Account');
    if (u.balance_cents + delta < 0) throw new HttpError(400, 'insufficient_funds', 'Not enough money for that.');
    if (delta !== 0) await q('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(delta, userId);
    const info = await q(
      `INSERT INTO transactions (user_id, kind, amount_cents, counterparty_id, counterparty_name, note, category, goal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, kind, amount, counterparty?.id ?? null, counterparty?.name ?? null, note, category, goalId, nowIso());
    return Number(info.lastInsertRowid);
  }

  async function transfer(from, to, amount, { fromKind, toKind, note = null }) {
    await post(from.id, { kind: fromKind, amount: -amount, counterparty: to, note });
    await post(to.id, { kind: toKind, amount, counterparty: from, note });
  }

  async function notify(userId, { icon = '🔔', title, body = null, link = null }) {
    await q('INSERT INTO notifications (user_id, icon, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId,
      icon,
      title,
      body,
      link,
      nowIso(),
    );
  }

  const getUser = (id) => q('SELECT * FROM users WHERE id = ?').get(id);

  async function ownKid(parentId, kidId) {
    const kid = await q("SELECT * FROM users WHERE id = ? AND role = 'kid' AND parent_id = ?").get(kidId, parentId);
    if (!kid) throw notFound('That kid');
    return kid;
  }

  // ───────────────────────── controls ─────────────────────────

  async function controlsRow(kidId) {
    return await q('SELECT * FROM kid_controls WHERE kid_id = ?').get(kidId);
  }

  function controlsDto(row) {
    return {
      frozen: !!row.frozen,
      weeklyLimitCents: row.weekly_limit_cents,
      maxRequestCents: row.max_request_cents,
      interestBps: row.interest_bps,
      interestNext: row.interest_bps > 0 ? row.interest_next : null,
      allowance: {
        cents: row.allowance_cents,
        freq: row.allowance_freq,
        day: row.allowance_day,
        active: !!row.allowance_active,
        next: row.allowance_active ? row.allowance_next : null,
      },
    };
  }

  async function parentZone(kid) {
    return (await q('SELECT timezone FROM users WHERE id = ?').get(kid.parent_id))?.timezone ?? 'UTC';
  }

  async function updateControls(parentId, kidId, input) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const cur = await controlsRow(kidId);
      const next = { ...cur };
      const notes = [];

      if ('frozen' in input) {
        if (typeof input.frozen !== 'boolean') throw new HttpError(400, 'invalid', 'Frozen must be true or false.');
        if (input.frozen !== !!cur.frozen) {
          notes.push(
            input.frozen
              ? { icon: '⏸️', title: 'Spending is paused', body: 'Your parent paused spending. You can still save and ask for money.' }
              : { icon: '▶️', title: 'Spending is back on', body: 'Your parent turned spending back on.' },
          );
        }
        next.frozen = input.frozen ? 1 : 0;
      }
      if ('weeklyLimitCents' in input) {
        next.weekly_limit_cents =
          input.weeklyLimitCents === null
            ? null
            : cents(input.weeklyLimitCents, { field: 'Weekly limit', min: 100, max: MAX_CENTS });
      }
      if ('maxRequestCents' in input) {
        next.max_request_cents =
          input.maxRequestCents === null
            ? null
            : cents(input.maxRequestCents, { field: 'Request cap', min: 100, max: MAX_CENTS });
      }
      if ('interestBps' in input) {
        const bps = input.interestBps;
        if (!Number.isInteger(bps) || bps < 0 || bps > MAX_INTEREST_BPS) {
          throw new HttpError(400, 'invalid', `Interest must be between 0% and ${MAX_INTEREST_BPS / 100}% a year.`);
        }
        next.interest_bps = bps;
        if (bps === 0) next.interest_next = null;
        else if (!cur.interest_bps || !cur.interest_next) next.interest_next = firstDue(dateInZone(clock(), await parentZone(kid)), 'weekly', 0); // next Sunday
        if (bps > 0 && bps !== cur.interest_bps) {
          notes.push({ icon: '📈', title: 'Your savings now earn interest!', body: `${ratePercent(bps)} a year on what you save in goals, paid every week.` });
        }
      }
      if ('allowance' in input) {
        const a = input.allowance ?? {};
        const freq = oneOf(a.freq, FREQUENCIES, { field: 'Frequency' });
        const day = a.day;
        const dayOk = freq === 'monthly' ? Number.isInteger(day) && day >= 1 && day <= 28 : Number.isInteger(day) && day >= 0 && day <= 6;
        if (!dayOk) throw new HttpError(400, 'invalid', 'Pick a valid day for the allowance.');
        if (typeof a.active !== 'boolean') throw new HttpError(400, 'invalid', 'Allowance on/off must be true or false.');
        const amount = cents(a.cents, { field: 'Allowance', min: 100, max: 100_000 });

        const scheduleChanged = freq !== cur.allowance_freq || day !== cur.allowance_day;
        next.allowance_cents = amount;
        next.allowance_freq = freq;
        next.allowance_day = day;
        next.allowance_active = a.active ? 1 : 0;
        if (!a.active) {
          next.allowance_next = null;
        } else if (!cur.allowance_active || scheduleChanged || !cur.allowance_next) {
          next.allowance_next = firstDue(dateInZone(clock(), await parentZone(kid)), freq, day);
        }
        next.allowance_fail_notified = null;
        if (a.active && (!cur.allowance_active || amount !== cur.allowance_cents || scheduleChanged)) {
          notes.push({
            icon: '🗓️',
            title: 'Your allowance is set',
            body: `${money(amount)} ${freq === 'weekly' ? 'every week' : freq === 'biweekly' ? 'every other week' : 'every month'}.`,
          });
        }
      }

      await q(
        `UPDATE kid_controls SET frozen = ?, weekly_limit_cents = ?, max_request_cents = ?, allowance_cents = ?,
           allowance_freq = ?, allowance_day = ?, allowance_active = ?, allowance_next = ?, allowance_fail_notified = ?,
           interest_bps = ?, interest_next = ?
         WHERE kid_id = ?`,
      ).run(
        next.frozen,
        next.weekly_limit_cents,
        next.max_request_cents,
        next.allowance_cents,
        next.allowance_freq,
        next.allowance_day,
        next.allowance_active,
        next.allowance_next,
        next.allowance_fail_notified,
        next.interest_bps,
        next.interest_next,
        kidId,
      );
      for (const n of notes) await notify(kidId, { ...n, link: '#/' });
      return controlsDto(await controlsRow(kidId));
    });
  }

  // ───────────────────────── spending window ─────────────────────────

  /** Spending in the last 7 days and when the oldest purchase rolls out of the window. */
  async function spendWindow(kidId) {
    const since = new Date(clock().getTime() - 7 * DAY_MS).toISOString();
    const row = await q(
      `SELECT COALESCE(-SUM(amount_cents), 0) AS spent, MIN(created_at) AS oldest
       FROM transactions WHERE user_id = ? AND kind = 'spend' AND created_at > ?`,
    ).get(kidId, since);
    return {
      spentCents: row.spent,
      freesUpAt: row.oldest ? new Date(new Date(row.oldest).getTime() + 7 * DAY_MS).toISOString() : null,
    };
  }

  // ───────────────────────── parent actions ─────────────────────────

  async function addFunds(parentId, amount) {
    cents(amount, { field: 'Amount', max: MAX_DEPOSIT_CENTS });
    return atomic(async () => {
      await post(parentId, { kind: 'deposit', amount, note: 'Practice funds' });
      return (await getUser(parentId)).balance_cents;
    });
  }

  async function sendMoney(parentId, kidId, amount, note) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const parent = await getUser(parentId);
      if (parent.balance_cents < amount) {
        throw new HttpError(400, 'insufficient_funds', `You have ${money(parent.balance_cents)} available. Add funds to send ${money(amount)}.`);
      }
      await transfer(parent, kid, amount, { fromKind: 'send', toKind: 'receive', note });
      await notify(kid.id, {
        icon: '💸',
        title: `${parent.name} sent you ${money(amount)}`,
        body: note,
        link: '#/',
      });
      return { balanceCents: (await getUser(parentId)).balance_cents, kidBalanceCents: (await getUser(kidId)).balance_cents };
    });
  }

  async function takeBack(parentId, kidId, amount, note) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const parent = await getUser(parentId);
      if (kid.balance_cents < amount) {
        throw new HttpError(400, 'insufficient_funds', `${kid.name} only has ${money(kid.balance_cents)} available to take back.`);
      }
      await transfer(kid, parent, amount, { fromKind: 'takeback_out', toKind: 'takeback_in', note });
      await notify(kid.id, {
        icon: '↩️',
        title: `${parent.name} took back ${money(amount)}`,
        body: note,
        link: '#/activity',
      });
      return { balanceCents: (await getUser(parentId)).balance_cents, kidBalanceCents: (await getUser(kidId)).balance_cents };
    });
  }

  async function createKid(parent, { name, username, passwordHash, avatar, color }) {
    return atomic(async () => {
      const count = (await q("SELECT COUNT(*) AS n FROM users WHERE parent_id = ? AND role = 'kid'").get(parent.id)).n;
      if (count >= MAX_KIDS) throw new HttpError(400, 'limit', `You can have up to ${MAX_KIDS} kids on one account.`);
      if (await q('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw new HttpError(409, 'username_taken', 'That username is taken. Try another.');
      }
      const info = await q(
        `INSERT INTO users (role, name, username, password_hash, parent_id, avatar, color, timezone, created_at)
         VALUES ('kid', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(name, username, passwordHash, parent.id, avatar, color, parent.timezone, nowIso());
      const kidId = Number(info.lastInsertRowid);
      await q('INSERT INTO kid_controls (kid_id) VALUES (?)').run(kidId);
      await notify(kidId, { icon: '👋', title: `Welcome to Nestly, ${name}!`, body: `${parent.name} set up your account.`, link: '#/' });
      return kidId;
    });
  }

  async function updateKid(parentId, kidId, { name, avatar, color }) {
    await ownKid(parentId, kidId);
    await q('UPDATE users SET name = ?, avatar = ?, color = ? WHERE id = ?').run(name, avatar, color, kidId);
  }

  /** Closes a kid's account; anything they still hold goes back to the parent. */
  async function removeKid(parentId, kidId) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const saved = (await q("SELECT COALESCE(SUM(saved_cents), 0) AS s FROM goals WHERE kid_id = ? AND status = 'active'").get(kidId)).s;
      const returned = kid.balance_cents + saved;
      if (returned > 0) {
        await post(parentId, { kind: 'closed_in', amount: returned, counterparty: kid, note: `Closed ${kid.name}'s account` });
      }
      // Explicit deletes (children first) so correctness never depends on the database enforcing ON DELETE rules.
      await q('UPDATE transactions SET counterparty_id = NULL WHERE counterparty_id = ?').run(kidId);
      await q('DELETE FROM chore_claims WHERE kid_id = ?').run(kidId);
      await q('DELETE FROM chores WHERE kid_id = ?').run(kidId);
      await q('DELETE FROM badges WHERE kid_id = ?').run(kidId);
      for (const [table, column] of [['transactions', 'user_id'], ['goals', 'kid_id'], ['money_requests', 'kid_id'], ['notifications', 'user_id'], ['sessions', 'user_id']]) {
        await q(`DELETE FROM ${table} WHERE ${column} = ?`).run(kidId);
      }
      await q('DELETE FROM kid_controls WHERE kid_id = ?').run(kidId);
      await q('DELETE FROM users WHERE id = ?').run(kidId);
      return { returnedCents: returned };
    });
  }

  // ───────────────────────── requests ─────────────────────────

  async function createRequest(kidId, amount, reason) {
    return atomic(async () => {
      const kid = await getUser(kidId);
      const controls = await controlsRow(kidId);
      if (controls.max_request_cents != null && amount > controls.max_request_cents) {
        throw new HttpError(400, 'over_cap', `Your parent lets you ask for up to ${money(controls.max_request_cents)} at a time.`);
      }
      const pending = (await q("SELECT COUNT(*) AS n FROM money_requests WHERE kid_id = ? AND status = 'pending'").get(kidId)).n;
      if (pending >= MAX_PENDING_REQUESTS) {
        throw new HttpError(400, 'too_many_requests', 'You already have a few requests waiting. Hang tight!');
      }
      const info = await q('INSERT INTO money_requests (kid_id, amount_cents, reason, created_at) VALUES (?, ?, ?, ?)').run(kidId, amount, reason, nowIso());
      await notify(kid.parent_id, {
        icon: '🙋',
        title: `${kid.name} asked for ${money(amount)}`,
        body: reason,
        link: '#/requests',
      });
      return Number(info.lastInsertRowid);
    });
  }

  async function cancelRequest(kidId, requestId) {
    const info = await q("UPDATE money_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND kid_id = ? AND status = 'pending'").run(
      nowIso(),
      requestId,
      kidId,
    );
    if (!info.changes) throw notFound('That request');
  }

  async function decideRequest(parentId, requestId, approve, responseNote) {
    return atomic(async () => {
      const req = await q(
        `SELECT r.*, k.name AS kid_name FROM money_requests r JOIN users k ON k.id = r.kid_id
         WHERE r.id = ? AND k.parent_id = ?`,
      ).get(requestId, parentId);
      if (!req) throw notFound('That request');
      if (req.status !== 'pending') throw new HttpError(409, 'already_decided', 'That request was already answered.');
      const parent = await getUser(parentId);
      if (approve) {
        if (parent.balance_cents < req.amount_cents) {
          throw new HttpError(400, 'insufficient_funds', `You have ${money(parent.balance_cents)} available. Add funds to approve ${money(req.amount_cents)}.`);
        }
        await transfer(parent, await getUser(req.kid_id), req.amount_cents, {
          fromKind: 'send',
          toKind: 'receive',
          note: `Request: ${req.reason}`,
        });
      }
      await q('UPDATE money_requests SET status = ?, response_note = ?, decided_at = ? WHERE id = ?').run(
        approve ? 'approved' : 'declined',
        responseNote,
        nowIso(),
        requestId,
      );
      await notify(req.kid_id, {
        icon: approve ? '✅' : '🙅',
        title: approve ? `${parent.name} said yes to ${money(req.amount_cents)}!` : `${parent.name} said not this time`,
        body: responseNote || req.reason,
        link: '#/ask',
      });
      return { balanceCents: (await getUser(parentId)).balance_cents };
    });
  }

  // ───────────────────────── allowance engine ─────────────────────────

  /** Pays every allowance that is due. Safe to call as often as you like, from any number of processes. */
  async function runAllowances() {
    const now = clock();
    // A calendar date in any time zone is within a day of the UTC date, so anything later than that can't be due yet.
    const horizon = addDays(dateInZone(now, 'UTC'), 1);
    const rows = await q(
      `SELECT c.kid_id, k.name AS kid_name, k.parent_id, p.name AS parent_name, p.timezone
       FROM kid_controls c JOIN users k ON k.id = c.kid_id JOIN users p ON p.id = k.parent_id
       WHERE c.allowance_active = 1 AND c.allowance_next IS NOT NULL AND c.allowance_next <= ?`,
    ).all(horizon);
    const paid = [];
    for (const r of rows) {
      const today = dateInZone(now, r.timezone);
      try {
        await atomic(async () => {
          // Re-read inside the transaction: another process may have paid (or the parent may have changed) this
          // allowance since the list above was fetched, and paying twice must be impossible.
          const c = await controlsRow(r.kid_id);
          if (!c || !c.allowance_active || !c.allowance_next || c.allowance_next > today) return;
          const parent = await getUser(r.parent_id);
          if (parent.balance_cents < c.allowance_cents) {
            // Retry on the next tick, but only tell the parent once per missed date.
            if (c.allowance_fail_notified !== c.allowance_next) {
              await notify(r.parent_id, {
                icon: '⚠️',
                title: `${r.kid_name}'s allowance is waiting`,
                body: `You need ${money(c.allowance_cents)} in your balance to pay it. Add funds and it will go out automatically.`,
                link: '#/funding',
              });
              await q('UPDATE kid_controls SET allowance_fail_notified = ? WHERE kid_id = ?').run(c.allowance_next, r.kid_id);
            }
            return;
          }
          const kid = await getUser(r.kid_id);
          await transfer(parent, kid, c.allowance_cents, {
            fromKind: 'allowance_out',
            toKind: 'allowance_in',
            note: c.allowance_freq === 'monthly' ? 'Monthly allowance' : c.allowance_freq === 'biweekly' ? 'Biweekly allowance' : 'Weekly allowance',
          });
          // Missed periods (e.g. nobody visited for a while) are not paid retroactively.
          let next = advance(c.allowance_next, c.allowance_freq, c.allowance_day);
          while (next <= today) next = advance(next, c.allowance_freq, c.allowance_day);
          await q('UPDATE kid_controls SET allowance_next = ?, allowance_fail_notified = NULL WHERE kid_id = ?').run(next, r.kid_id);
          await notify(r.kid_id, { icon: '🎉', title: `Allowance day! ${money(c.allowance_cents)} arrived`, body: `From ${parent.name}`, link: '#/' });
          paid.push({ kidId: r.kid_id, cents: c.allowance_cents });
        });
      } catch (err) {
        console.error('Allowance payment failed for kid', r.kid_id, err);
      }
    }
    return paid;
  }

  // ───────────────────────── kid actions ─────────────────────────

  async function spend(kidId, amount, category, note) {
    oneOf(category, CATEGORIES, { field: 'Category' });
    return atomic(async () => {
      const kid = await getUser(kidId);
      const controls = await controlsRow(kidId);
      if (controls.frozen) {
        throw new HttpError(403, 'frozen', 'Spending is paused by your parent right now.');
      }
      if (kid.balance_cents < amount) {
        throw new HttpError(400, 'insufficient_funds', `You only have ${money(kid.balance_cents)} to spend.`);
      }
      if (controls.weekly_limit_cents != null) {
        const { spentCents } = await spendWindow(kidId);
        const remaining = Math.max(0, controls.weekly_limit_cents - spentCents);
        if (amount > remaining) {
          throw new HttpError(
            400,
            'over_limit',
            remaining === 0
              ? `You've reached your weekly spending limit of ${money(controls.weekly_limit_cents)}.`
              : `That's over your weekly limit. You can spend ${money(remaining)} more this week.`,
            { remainingCents: remaining },
          );
        }
      }
      await post(kidId, { kind: 'spend', amount: -amount, category, note });
      await notify(kid.parent_id, {
        icon: CATEGORY_EMOJI[category],
        title: `${kid.name} spent ${money(amount)}`,
        body: note || category[0].toUpperCase() + category.slice(1),
        link: `#/kids/${kidId}`,
      });
      return { balanceCents: (await getUser(kidId)).balance_cents };
    });
  }

  async function goalRow(kidId, goalId) {
    const g = await q('SELECT * FROM goals WHERE id = ? AND kid_id = ?').get(goalId, kidId);
    if (!g) throw notFound('That goal');
    return g;
  }

  async function createGoal(kidId, { name, emoji, targetCents }) {
    return atomic(async () => {
      const n = (await q("SELECT COUNT(*) AS n FROM goals WHERE kid_id = ? AND status = 'active'").get(kidId)).n;
      if (n >= MAX_ACTIVE_GOALS) throw new HttpError(400, 'limit', `You can chase up to ${MAX_ACTIVE_GOALS} goals at once.`);
      const info = await q('INSERT INTO goals (kid_id, name, emoji, target_cents, created_at) VALUES (?, ?, ?, ?, ?)').run(
        kidId,
        name,
        emoji,
        targetCents,
        nowIso(),
      );
      await core.awardBadges(kidId);
      return Number(info.lastInsertRowid);
    });
  }

  async function saveToGoal(kidId, goalId, amount) {
    return atomic(async () => {
      const kid = await getUser(kidId);
      const goal = await goalRow(kidId, goalId);
      if (goal.status !== 'active') throw new HttpError(400, 'goal_closed', 'That goal is already finished.');
      const room = goal.target_cents - goal.saved_cents;
      if (amount > room) {
        throw new HttpError(400, 'over_target', room === 0 ? 'This goal is already fully funded!' : `You only need ${money(room)} more for this goal.`);
      }
      if (kid.balance_cents < amount) {
        throw new HttpError(400, 'insufficient_funds', `You only have ${money(kid.balance_cents)} to save.`);
      }
      await q('UPDATE goals SET saved_cents = saved_cents + ? WHERE id = ?').run(amount, goalId);
      await post(kidId, { kind: 'goal_save', amount: -amount, counterparty: { id: null, name: goal.name }, goalId });
      const now = await goalRow(kidId, goalId);
      await core.awardBadges(kidId);
      return { reached: now.saved_cents >= now.target_cents };
    });
  }

  async function withdrawFromGoal(kidId, goalId, amount) {
    return atomic(async () => {
      const goal = await goalRow(kidId, goalId);
      if (goal.status !== 'active') throw new HttpError(400, 'goal_closed', 'That goal is already finished.');
      if (goal.saved_cents < amount) {
        throw new HttpError(400, 'insufficient_funds', `Only ${money(goal.saved_cents)} is saved in this goal.`);
      }
      await q('UPDATE goals SET saved_cents = saved_cents - ? WHERE id = ?').run(amount, goalId);
      await post(kidId, { kind: 'goal_release', amount, counterparty: { id: null, name: goal.name }, goalId });
    });
  }

  async function purchaseGoal(kidId, goalId) {
    return atomic(async () => {
      const kid = await getUser(kidId);
      const goal = await goalRow(kidId, goalId);
      if (goal.status !== 'active') throw new HttpError(400, 'goal_closed', 'That goal is already finished.');
      if ((await controlsRow(kidId)).frozen) throw new HttpError(403, 'frozen', 'Spending is paused by your parent right now.');
      if (goal.saved_cents < goal.target_cents) {
        throw new HttpError(400, 'not_funded', `Save ${money(goal.target_cents - goal.saved_cents)} more first.`);
      }
      await q("UPDATE goals SET status = 'purchased', closed_at = ? WHERE id = ?").run(nowIso(), goalId);
      await post(kidId, {
        kind: 'goal_purchase',
        amount: -goal.saved_cents,
        delta: 0,
        counterparty: { id: null, name: goal.name },
        goalId,
      });
      await notify(kid.parent_id, {
        icon: goal.emoji,
        title: `${kid.name} bought "${goal.name}"`,
        body: `They saved up ${money(goal.saved_cents)} for it. 🎉`,
        link: `#/kids/${kidId}`,
      });
      await core.awardBadges(kidId);
    });
  }

  async function cancelGoal(kidId, goalId) {
    return atomic(async () => {
      const goal = await goalRow(kidId, goalId);
      if (goal.status !== 'active') throw new HttpError(400, 'goal_closed', 'That goal is already finished.');
      if (goal.saved_cents > 0) {
        await post(kidId, { kind: 'goal_release', amount: goal.saved_cents, counterparty: { id: null, name: goal.name }, goalId });
      }
      await q("UPDATE goals SET status = 'cancelled', saved_cents = 0, closed_at = ? WHERE id = ?").run(nowIso(), goalId);
    });
  }

  // ───────────────────────── read models ─────────────────────────

  const goalDto = (g) => ({
    id: g.id,
    name: g.name,
    emoji: g.emoji,
    targetCents: g.target_cents,
    savedCents: g.saved_cents,
    status: g.status,
    createdAt: g.created_at,
    closedAt: g.closed_at,
  });

  const countOf = async (sql, ...args) => (await q(sql).get(...args)).n;

  async function goalsFor(kidId) {
    const rows = await q(
      `SELECT * FROM goals WHERE kid_id = ? AND status != 'cancelled'
       ORDER BY (status = 'active') DESC, COALESCE(closed_at, created_at) DESC, id DESC LIMIT 40`,
    ).all(kidId);
    return rows.map(goalDto);
  }

  async function kidSummary(kid) {
    const [controlsRowData, window, goals, pending] = await Promise.all([
      controlsRow(kid.id),
      spendWindow(kid.id),
      q("SELECT COALESCE(SUM(saved_cents), 0) AS s, COUNT(*) AS n FROM goals WHERE kid_id = ? AND status = 'active'").get(kid.id),
      countOf("SELECT COUNT(*) AS n FROM money_requests WHERE kid_id = ? AND status = 'pending'", kid.id),
    ]);
    return {
      id: kid.id,
      name: kid.name,
      username: kid.username,
      avatar: kid.avatar,
      color: kid.color,
      balanceCents: kid.balance_cents,
      savedCents: goals.s,
      activeGoals: goals.n,
      spent7dCents: window.spentCents,
      freesUpAt: window.freesUpAt,
      pendingRequests: pending,
      ...controlsDto(controlsRowData),
    };
  }

  function txDto(r) {
    return {
      id: r.id,
      kind: r.kind,
      amountCents: r.amount_cents,
      counterparty: r.counterparty_name,
      counterpartyId: r.counterparty_id,
      note: r.note,
      category: r.category,
      goalId: r.goal_id,
      createdAt: r.created_at,
      ...(r.owner_id ? { owner: { id: r.owner_id, name: r.owner_name, avatar: r.owner_avatar, color: r.owner_color, role: r.owner_role } } : {}),
    };
  }

  /** The parent's view of everything happening in the family, newest first. */
  async function familyActivity(parentId, { kidId = null, before = null, limit = 30 } = {}) {
    const kindList = KID_ONLY_KINDS.map(() => '?').join(',');
    const where = [];
    const args = [];
    if (kidId) {
      where.push(`((t.user_id = ? AND t.kind IN (${kindList})) OR (t.user_id = ? AND t.counterparty_id = ?))`);
      args.push(kidId, ...KID_ONLY_KINDS, parentId, kidId);
    } else {
      where.push(`(t.user_id = ? OR (u.parent_id = ? AND t.kind IN (${kindList})))`);
      args.push(parentId, parentId, ...KID_ONLY_KINDS);
    }
    if (before) {
      where.push('t.id < ?');
      args.push(before);
    }
    const rows = await q(
      `SELECT t.*, u.id AS owner_id, u.name AS owner_name, u.avatar AS owner_avatar, u.color AS owner_color, u.role AS owner_role
       FROM transactions t JOIN users u ON u.id = t.user_id
       WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`,
    ).all(...args, limit + 1);
    const items = rows.slice(0, limit).map(txDto);
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
  }

  async function kidActivity(kidId, { before = null, limit = 30 } = {}) {
    const rows = await q(
      `SELECT * FROM transactions WHERE user_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`,
    ).all(...(before ? [kidId, before, limit + 1] : [kidId, limit + 1]));
    const items = rows.slice(0, limit).map(txDto);
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
  }

  function requestDto(r) {
    return {
      id: r.id,
      amountCents: r.amount_cents,
      reason: r.reason,
      status: r.status,
      responseNote: r.response_note,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      ...(r.kid_name ? { kid: { id: r.kid_id, name: r.kid_name, avatar: r.kid_avatar, color: r.kid_color } } : {}),
    };
  }

  async function requestsForParent(parentId, { status = null, limit = 50 } = {}) {
    const rows = await q(
      `SELECT r.*, k.name AS kid_name, k.avatar AS kid_avatar, k.color AS kid_color
       FROM money_requests r JOIN users k ON k.id = r.kid_id
       WHERE k.parent_id = ? ${status ? 'AND r.status = ?' : ''}
       ORDER BY (r.status = 'pending') DESC, r.id DESC LIMIT ?`,
    ).all(...(status ? [parentId, status, limit] : [parentId, limit]));
    return rows.map(requestDto);
  }

  async function requestsForKid(kidId, limit = 20) {
    const rows = await q("SELECT * FROM money_requests WHERE kid_id = ? ORDER BY (status = 'pending') DESC, id DESC LIMIT ?").all(kidId, limit);
    return rows.map(requestDto);
  }

  async function parentOverview(parentId) {
    const [parent, kidRows, depositRow, pendingRequests, recent, pendingChores] = await Promise.all([
      getUser(parentId),
      q("SELECT * FROM users WHERE parent_id = ? AND role = 'kid' ORDER BY id").all(parentId),
      q("SELECT 1 AS x FROM transactions WHERE user_id = ? AND kind = 'deposit' LIMIT 1").get(parentId),
      requestsForParent(parentId, { status: 'pending' }),
      familyActivity(parentId, { limit: 8 }),
      core.chores.pendingClaimsForParent(parentId, 20),
    ]);
    const kids = await Promise.all(kidRows.map(kidSummary));
    return {
      balanceCents: parent.balance_cents,
      kids,
      totals: {
        kidsBalanceCents: kids.reduce((s, k) => s + k.balanceCents, 0),
        kidsSavedCents: kids.reduce((s, k) => s + k.savedCents, 0),
        spent7dCents: kids.reduce((s, k) => s + k.spent7dCents, 0),
      },
      pendingRequests,
      pendingChores,
      recent: recent.items,
      onboarding: {
        funds: !!depositRow || parent.balance_cents > 0,
        kid: kids.length > 0,
        allowance: kids.some((k) => k.allowance.active),
      },
    };
  }

  async function kidDetail(parentId, kidId) {
    const kid = await ownKid(parentId, kidId);
    const zone = await parentZone(kid);
    const days = 14;
    const today = dateInZone(clock(), zone);
    const buckets = new Map();
    for (let i = days - 1; i >= 0; i--) buckets.set(addDays(today, -i), 0);
    const since = new Date(clock().getTime() - (days + 1) * DAY_MS).toISOString();
    const [spends, summary, goals, recent, requests, badges, allPendingChores] = await Promise.all([
      q("SELECT amount_cents, created_at FROM transactions WHERE user_id = ? AND kind = 'spend' AND created_at > ?").all(kidId, since),
      kidSummary(kid),
      goalsFor(kidId),
      familyActivity(parentId, { kidId, limit: 10 }),
      requestsForKid(kidId, 5),
      core.badges.badgesFor(kidId),
      core.chores.pendingClaimsForParent(parentId, 100),
    ]);
    for (const r of spends) {
      const d = dateInZone(new Date(r.created_at), zone);
      if (buckets.has(d)) buckets.set(d, buckets.get(d) - r.amount_cents);
    }
    return {
      kid: summary,
      goals,
      spendByDay: [...buckets].map(([date, spentCents]) => ({ date, spentCents })),
      recent: recent.items,
      requests,
      badges,
      pendingChores: allPendingChores.filter((c) => c.kid.id === kidId),
      today,
    };
  }

  async function kidOverview(kidId) {
    const kid = await getUser(kidId);
    const parent = await getUser(kid.parent_id);
    const [summary, goals, recent, requests, badges, chores] = await Promise.all([
      kidSummary(kid),
      goalsFor(kidId),
      kidActivity(kidId, { limit: 6 }),
      requestsForKid(kidId, 10),
      core.badges.badgesFor(kidId),
      core.chores.choresForKid(kidId),
    ]);
    return {
      kid: summary,
      parentName: parent.name,
      goals,
      recent: recent.items,
      requests,
      badges,
      chores,
      today: dateInZone(clock(), parent.timezone),
    };
  }

  async function listNotifications(userId, limit = 30) {
    const [rows, unread] = await Promise.all([
      q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit),
      countOf('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', userId),
    ]);
    const items = rows.map((n) => ({ id: n.id, icon: n.icon, title: n.title, body: n.body, link: n.link, read: !!n.read, createdAt: n.created_at }));
    return { items, unread };
  }

  async function markNotificationsRead(userId) {
    await q('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  }

  async function pendingRequestCount(parentId) {
    const [requests, chores] = await Promise.all([
      countOf("SELECT COUNT(*) AS n FROM money_requests r JOIN users k ON k.id = r.kid_id WHERE k.parent_id = ? AND r.status = 'pending'", parentId),
      countOf("SELECT COUNT(*) AS n FROM chore_claims cc JOIN chores c ON c.id = cc.chore_id WHERE c.parent_id = ? AND cc.status = 'pending'", parentId),
    ]);
    return requests + chores;
  }

  function unreadCount(userId) {
    return countOf('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', userId);
  }

  // ───────────────────────── feature modules ─────────────────────────
  // Each module gets the same small toolbox: the transaction wrapper, ledger helpers and lookups.
  const core = { db, q, atomic, clock, nowIso, post, transfer, notify, getUser, ownKid, controlsRow, parentZone, notFound };
  core.badges = createBadges(core);
  core.awardBadges = core.badges.awardBadges;
  core.chores = createChores(core);
  const interest = createInterest(core);
  const insights = createInsights(core);

  /** Everything that should happen "on a schedule": allowances and savings interest. */
  async function runScheduled() {
    const allowances = await runAllowances();
    const interestPaid = await interest.runInterest();
    return { allowances, interest: interestPaid };
  }

  return {
    ...core.chores,
    ...core.badges,
    ...insights,
    runInterest: interest.runInterest,
    runScheduled,
    atomic,
    getUser,
    ownKid,
    addFunds,
    sendMoney,
    takeBack,
    createKid,
    updateKid,
    removeKid,
    updateControls,
    createRequest,
    cancelRequest,
    decideRequest,
    runAllowances,
    spend,
    createGoal,
    saveToGoal,
    withdrawFromGoal,
    purchaseGoal,
    cancelGoal,
    parentOverview,
    kidDetail,
    kidOverview,
    kidActivity,
    familyActivity,
    requestsForParent,
    listNotifications,
    markNotificationsRead,
    unreadCount,
    pendingRequestCount,
  };
}
