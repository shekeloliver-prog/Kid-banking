// Chores: a parent assigns a chore to a kid with a reward; the kid says "I did it"; the parent approves and the
// reward moves from the parent's balance to the kid's. Approval is one transaction, so a chore can't pay twice.

import { HttpError, money } from './util.js';
import { dateInZone } from './dates.js';

export const CHORE_EMOJI = ['🧹', '🍽️', '🗑️', '🛏️', '🐕', '🌱', '🚗', '📚', '👕', '🧺', '🪥', '🧽'];
export const REPEATS = ['once', 'daily', 'weekly'];
export const MIN_REWARD_CENTS = 25;
export const MAX_REWARD_CENTS = 10_000;
const MAX_ACTIVE_CHORES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createChores(core) {
  const { q, atomic, notify, transfer, getUser, ownKid, nowIso, clock, parentZone, notFound } = core;

  const choreDto = (c) => ({
    id: c.id,
    kidId: c.kid_id,
    title: c.title,
    emoji: c.emoji,
    rewardCents: c.reward_cents,
    repeat: c.repeat,
  });

  /** Single source of truth for "can this kid claim it right now?" — used by both the list and the claim. */
  function availability(chore, latest, zone) {
    if (latest?.status === 'pending') return { state: 'pending', reason: 'Waiting for your parent to check' };
    if (latest?.status === 'approved') {
      const now = clock();
      if (chore.repeat === 'daily' && dateInZone(new Date(latest.created_at), zone) === dateInZone(now, zone)) {
        return { state: 'cooldown', reason: 'Done for today — back tomorrow!' };
      }
      if (chore.repeat === 'weekly' && now.getTime() - new Date(latest.created_at).getTime() < 7 * DAY_MS) {
        return { state: 'cooldown', reason: 'Done for this week' };
      }
    }
    return { state: 'available', reason: null };
  }

  const latestClaim = (choreId) =>
    q("SELECT * FROM chore_claims WHERE chore_id = ? AND status IN ('pending', 'approved') ORDER BY id DESC LIMIT 1").get(choreId);

  async function ownChore(parentId, choreId) {
    const c = await q("SELECT * FROM chores WHERE id = ? AND parent_id = ? AND status = 'active'").get(choreId, parentId);
    if (!c) throw notFound('That chore');
    return c;
  }

  async function createChore(parentId, kidId, { title, emoji, rewardCents, repeat }) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const n = (await q("SELECT COUNT(*) AS n FROM chores WHERE kid_id = ? AND status = 'active'").get(kidId)).n;
      if (n >= MAX_ACTIVE_CHORES) throw new HttpError(400, 'limit', `${kid.name} already has ${MAX_ACTIVE_CHORES} chores. Remove one first.`);
      const info = await q('INSERT INTO chores (parent_id, kid_id, title, emoji, reward_cents, repeat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        parentId,
        kidId,
        title,
        emoji,
        rewardCents,
        repeat,
        nowIso(),
      );
      await notify(kidId, { icon: emoji, title: `New chore: ${title}`, body: `Earn ${money(rewardCents)}${repeat === 'once' ? '' : repeat === 'daily' ? ' every day' : ' every week'}`, link: '#/chores' });
      return info.lastInsertRowid;
    });
  }

  async function updateChore(parentId, choreId, { title, emoji, rewardCents, repeat }) {
    await ownChore(parentId, choreId);
    await q('UPDATE chores SET title = ?, emoji = ?, reward_cents = ?, repeat = ? WHERE id = ?').run(title, emoji, rewardCents, repeat, choreId);
  }

  /** Removes a chore (history is kept). Anything still waiting on it is closed without payment. */
  async function archiveChore(parentId, choreId) {
    return atomic(async () => {
      await ownChore(parentId, choreId);
      await q("UPDATE chore_claims SET status = 'rejected', response_note = 'This chore was removed', decided_at = ? WHERE chore_id = ? AND status = 'pending'").run(nowIso(), choreId);
      await q("UPDATE chores SET status = 'archived' WHERE id = ?").run(choreId);
    });
  }

  async function claimChore(kidId, choreId) {
    return atomic(async () => {
      const kid = await getUser(kidId);
      const chore = await q("SELECT * FROM chores WHERE id = ? AND kid_id = ? AND status = 'active'").get(choreId, kidId);
      if (!chore) throw notFound('That chore');
      const a = availability(chore, await latestClaim(choreId), await parentZone(kid));
      if (a.state === 'pending') throw new HttpError(409, 'already_claimed', 'You already told your parent about this one!');
      if (a.state === 'cooldown') throw new HttpError(400, 'not_yet', a.reason);
      const info = await q('INSERT INTO chore_claims (chore_id, kid_id, reward_cents, created_at) VALUES (?, ?, ?, ?)').run(choreId, kidId, chore.reward_cents, nowIso());
      await notify(kid.parent_id, { icon: chore.emoji, title: `${kid.name} finished “${chore.title}”`, body: `Approve to pay ${money(chore.reward_cents)}`, link: '#/requests' });
      return info.lastInsertRowid;
    });
  }

  async function cancelClaim(kidId, claimId) {
    const info = await q("UPDATE chore_claims SET status = 'cancelled', decided_at = ? WHERE id = ? AND kid_id = ? AND status = 'pending'").run(nowIso(), claimId, kidId);
    if (!info.changes) throw notFound('That chore');
  }

  async function decideClaim(parentId, claimId, approve, responseNote) {
    return atomic(async () => {
      const claim = await q(
        `SELECT cc.*, c.title, c.emoji, c.repeat, c.id AS the_chore_id, k.name AS kid_name
         FROM chore_claims cc JOIN chores c ON c.id = cc.chore_id JOIN users k ON k.id = cc.kid_id
         WHERE cc.id = ? AND c.parent_id = ?`,
      ).get(claimId, parentId);
      if (!claim) throw notFound('That chore');
      if (claim.status !== 'pending') throw new HttpError(409, 'already_decided', 'That one was already checked.');
      const parent = await getUser(parentId);
      if (approve) {
        if (parent.balance_cents < claim.reward_cents) {
          throw new HttpError(400, 'insufficient_funds', `You have ${money(parent.balance_cents)} available. Add funds to pay ${money(claim.reward_cents)}.`);
        }
        await transfer(parent, await getUser(claim.kid_id), claim.reward_cents, { fromKind: 'chore_out', toKind: 'chore_in', note: `Chore: ${claim.title}` });
        if (claim.repeat === 'once') await q("UPDATE chores SET status = 'archived' WHERE id = ?").run(claim.the_chore_id);
      }
      await q('UPDATE chore_claims SET status = ?, response_note = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', responseNote, nowIso(), claimId);
      await notify(claim.kid_id, {
        icon: approve ? '🎉' : '🔁',
        title: approve ? `${parent.name} paid you ${money(claim.reward_cents)} for “${claim.title}”` : `“${claim.title}” needs another look`,
        body: responseNote || (approve ? 'Nice work!' : 'Give it another try.'),
        link: '#/chores',
      });
      if (approve) await core.awardBadges(claim.kid_id);
      return { balanceCents: (await getUser(parentId)).balance_cents };
    });
  }

  const claimDto = (r) => ({
    id: r.id,
    choreId: r.chore_id,
    title: r.title,
    emoji: r.emoji,
    rewardCents: r.reward_cents,
    status: r.status,
    responseNote: r.response_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    kid: { id: r.kid_id, name: r.kid_name, avatar: r.kid_avatar, color: r.kid_color },
  });

  const CLAIM_SELECT = `SELECT cc.*, c.title, c.emoji, k.name AS kid_name, k.avatar AS kid_avatar, k.color AS kid_color
    FROM chore_claims cc JOIN chores c ON c.id = cc.chore_id JOIN users k ON k.id = cc.kid_id`;

  async function pendingClaimsForParent(parentId, limit = 50) {
    return (await q(`${CLAIM_SELECT} WHERE c.parent_id = ? AND cc.status = 'pending' ORDER BY cc.id DESC LIMIT ?`).all(parentId, limit)).map(claimDto);
  }

  async function choresForParent(parentId) {
    const [rows, claims, recent] = await Promise.all([
      q(
        `SELECT c.*, k.name AS kid_name, k.avatar AS kid_avatar, k.color AS kid_color,
           (SELECT COUNT(*) FROM chore_claims cc WHERE cc.chore_id = c.id AND cc.status = 'approved') AS done_count
         FROM chores c JOIN users k ON k.id = c.kid_id
         WHERE c.parent_id = ? AND c.status = 'active' ORDER BY k.id, c.id`,
      ).all(parentId),
      pendingClaimsForParent(parentId),
      q(`${CLAIM_SELECT} WHERE c.parent_id = ? AND cc.status IN ('approved', 'rejected') ORDER BY cc.id DESC LIMIT 12`).all(parentId),
    ]);
    const pendingByChore = new Map(claims.map((c) => [c.choreId, c.id]));
    return {
      chores: rows.map((c) => ({
        ...choreDto(c),
        kid: { id: c.kid_id, name: c.kid_name, avatar: c.kid_avatar, color: c.kid_color },
        doneCount: c.done_count,
        pendingClaimId: pendingByChore.get(c.id) ?? null,
      })),
      claims,
      recent: recent.map(claimDto),
    };
  }

  async function choresForKid(kidId) {
    const kid = await getUser(kidId);
    const zone = await parentZone(kid);
    const rows = await q("SELECT * FROM chores WHERE kid_id = ? AND status = 'active' ORDER BY id").all(kidId);
    const withState = [];
    for (const c of rows) {
      const latest = await latestClaim(c.id);
      withState.push({ ...choreDto(c), ...availability(c, latest, zone), claimId: latest?.status === 'pending' ? latest.id : null });
    }
    const recent = await q(
      `SELECT cc.*, c.title, c.emoji FROM chore_claims cc JOIN chores c ON c.id = cc.chore_id
       WHERE cc.kid_id = ? AND cc.status IN ('approved', 'rejected') ORDER BY cc.id DESC LIMIT 8`,
    ).all(kidId);
    const earned = (await q("SELECT COALESCE(SUM(reward_cents), 0) AS s FROM chore_claims WHERE kid_id = ? AND status = 'approved'").get(kidId)).s;
    return {
      chores: withState,
      earnedCents: earned,
      recent: recent.map((r) => ({ id: r.id, title: r.title, emoji: r.emoji, rewardCents: r.reward_cents, status: r.status, responseNote: r.response_note, decidedAt: r.decided_at })),
    };
  }

  return { createChore, updateChore, archiveChore, claimChore, cancelClaim, decideClaim, choresForParent, choresForKid, pendingClaimsForParent };
}
