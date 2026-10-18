// Read-only family analytics for the parent's Insights page, plus the activity export.

import { dateInZone, addDays } from './dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const INSIGHT_RANGES = [7, 30, 90];

const EARNED_KINDS = ['receive', 'allowance_in', 'chore_in', 'interest_in'];

export function createInsights({ q, clock, parentZone, ownKid }) {
  async function insights(parentId, { days = 30, kidId = null } = {}) {
    if (kidId) await ownKid(parentId, kidId);
    const now = clock();
    const since = new Date(now.getTime() - days * DAY_MS).toISOString();
    const filter = kidId ? 'AND t.user_id = ?' : '';
    const args = kidId ? [parentId, since, kidId] : [parentId, since];

    const [kids, groups, spends] = await Promise.all([
      q("SELECT id, name, avatar, color FROM users WHERE parent_id = ? AND role = 'kid' ORDER BY id").all(parentId),
      q(
        `SELECT t.user_id, t.kind, t.category, SUM(t.amount_cents) AS total
         FROM transactions t JOIN users u ON u.id = t.user_id
         WHERE u.parent_id = ? AND u.role = 'kid' AND t.created_at > ? ${filter}
         GROUP BY t.user_id, t.kind, t.category`,
      ).all(...args),
      q(
        `SELECT t.created_at, t.amount_cents
         FROM transactions t JOIN users u ON u.id = t.user_id
         WHERE u.parent_id = ? AND u.role = 'kid' AND t.kind IN ('spend', 'goal_purchase') AND t.created_at > ? ${filter}`,
      ).all(...args),
    ]);

    const empty = () => ({ spentCents: 0, earnedCents: 0, savedCents: 0 });
    const perKid = new Map(kids.map((k) => [k.id, { kid: k, ...empty() }]));
    const totals = { spentCents: 0, earnedCents: 0, savedCents: 0, interestCents: 0, choresCents: 0, allowanceCents: 0, giftsCents: 0 };
    const categories = new Map();

    for (const g of groups) {
      const bucket = perKid.get(g.user_id);
      if (!bucket) continue;
      if (g.kind === 'spend' || g.kind === 'goal_purchase') {
        const spent = -g.total;
        const cat = g.kind === 'goal_purchase' ? 'goals' : g.category || 'other';
        totals.spentCents += spent;
        bucket.spentCents += spent;
        categories.set(cat, (categories.get(cat) ?? 0) + spent);
      } else if (EARNED_KINDS.includes(g.kind)) {
        totals.earnedCents += g.total;
        bucket.earnedCents += g.total;
        if (g.kind === 'interest_in') totals.interestCents += g.total;
        if (g.kind === 'chore_in') totals.choresCents += g.total;
        if (g.kind === 'allowance_in') totals.allowanceCents += g.total;
        if (g.kind === 'receive') totals.giftsCents += g.total;
      } else if (g.kind === 'goal_save' || g.kind === 'goal_release') {
        // goal_save is negative on the spending balance, goal_release positive: net moved INTO goals is the negative of their sum
        totals.savedCents += -g.total;
        bucket.savedCents += -g.total;
      }
    }

    // Spending per rolling 7-day window, oldest first, so the newest bar is "the last 7 days".
    const weeks = Math.max(1, Math.min(13, Math.ceil(days / 7)));
    const zone = kids.length ? await parentZone({ parent_id: parentId }) : 'UTC';
    const weekly = Array.from({ length: weeks }, (_, i) => {
      const end = new Date(now.getTime() - (weeks - 1 - i) * 7 * DAY_MS);
      return { start: addDays(dateInZone(end, zone), -6), end: end.getTime(), spentCents: 0 };
    });
    for (const s of spends) {
      const age = now.getTime() - new Date(s.created_at).getTime();
      const idx = weeks - 1 - Math.floor(age / (7 * DAY_MS));
      if (idx >= 0 && idx < weeks) weekly[idx].spentCents += -s.amount_cents;
    }

    return {
      days,
      totals,
      categories: [...categories].map(([category, spentCents]) => ({ category, spentCents })).sort((a, b) => b.spentCents - a.spentCents),
      perKid: [...perKid.values()].map(({ kid, spentCents, earnedCents, savedCents }) => ({ kid, spentCents, earnedCents, savedCents })),
      weekly: weekly.map(({ start, spentCents }) => ({ start, spentCents })),
    };
  }

  return { insights };
}

// ───────────── CSV ─────────────

/** One CSV cell. Quotes when needed, and defuses spreadsheet formulas (=, +, -, @) typed into notes or names. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const KIND_LABEL = {
  deposit: 'Added practice funds',
  send: 'Sent money',
  receive: 'Received money',
  allowance_out: 'Allowance paid',
  allowance_in: 'Allowance received',
  takeback_in: 'Money taken back',
  takeback_out: 'Money returned',
  closed_in: 'Account closed',
  spend: 'Purchase',
  goal_save: 'Saved to goal',
  goal_release: 'Taken out of goal',
  goal_purchase: 'Goal purchase',
  chore_out: 'Chore reward paid',
  chore_in: 'Chore reward earned',
  interest_out: 'Interest paid',
  interest_in: 'Interest earned',
};

export function activityCsv(items) {
  const header = ['Date (UTC)', 'Who', 'Type', 'With', 'Amount (USD)', 'Category', 'Note'];
  const lines = [header.map(csvCell).join(',')];
  for (const t of items) {
    lines.push(
      [t.createdAt, t.owner?.name ?? '', KIND_LABEL[t.kind] ?? t.kind, t.counterparty ?? '', (t.amountCents / 100).toFixed(2), t.category ?? '', t.note ?? '']
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
