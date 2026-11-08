// The family side of Nestly that isn't about money: parents cheering kids on, shared house rules, and kids
// personalising their own profile.

import { HttpError } from './util.js';

export const KUDOS_EMOJI = ['⭐', '🌟', '👏', '💪', '🎉', '🏆', '❤️', '🚀', '🧠', '🙌'];
export const MAX_RULES = 8;
const MAX_CHEERS_PER_KID_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createFamily(core) {
  const { q, atomic, notify, getUser, ownKid, nowIso, clock, notFound } = core;

  // ───────────── cheers ─────────────

  const kudosDto = (r) => ({
    id: r.id,
    emoji: r.emoji,
    message: r.message,
    createdAt: r.created_at,
    thanked: !!r.thanked_at,
    ...(r.parent_name ? { from: r.parent_name } : {}),
  });

  async function sendKudos(parentId, kidId, { emoji, message }) {
    return atomic(async () => {
      const kid = await ownKid(parentId, kidId);
      const parent = await getUser(parentId);
      const since = new Date(clock().getTime() - DAY_MS).toISOString();
      const recent = (await q('SELECT COUNT(*) AS n FROM kudos WHERE kid_id = ? AND created_at > ?').get(kidId, since)).n;
      if (recent >= MAX_CHEERS_PER_KID_PER_DAY) {
        throw new HttpError(429, 'enough_cheers', `${kid.name} has had a lot of cheers today. Save some for tomorrow!`);
      }
      const info = await q('INSERT INTO kudos (parent_id, kid_id, emoji, message, created_at) VALUES (?, ?, ?, ?, ?)').run(parentId, kidId, emoji, message, nowIso());
      await notify(kidId, { icon: emoji, title: `${parent.name} sent you a cheer!`, body: message, link: '#/' });
      return Number(info.lastInsertRowid);
    });
  }

  /** Newest first. Includes the sender's name because the kid sees these. */
  async function kudosForKid(kidId, limit = 5) {
    const rows = await q(
      `SELECT k.*, p.name AS parent_name FROM kudos k JOIN users p ON p.id = k.parent_id
       WHERE k.kid_id = ? ORDER BY k.id DESC LIMIT ?`,
    ).all(kidId, limit);
    return rows.map(kudosDto);
  }

  async function thankKudos(kidId, kudosId) {
    return atomic(async () => {
      const row = await q('SELECT * FROM kudos WHERE id = ? AND kid_id = ?').get(kudosId, kidId);
      if (!row) throw notFound('That cheer');
      if (row.thanked_at) return { ok: true }; // already said thanks: nothing to repeat
      await q('UPDATE kudos SET thanked_at = ? WHERE id = ? AND thanked_at IS NULL').run(nowIso(), kudosId);
      const kid = await getUser(kidId);
      await notify(row.parent_id, { icon: '💛', title: `${kid.name} said thanks!`, body: `For your cheer: “${row.message}”`, link: `#/kids/${kidId}` });
      return { ok: true };
    });
  }

  // ───────────── house rules ─────────────

  async function rulesFor(parentId) {
    const rows = await q('SELECT id, text FROM house_rules WHERE parent_id = ? ORDER BY position, id').all(parentId);
    return rows.map((r) => ({ id: r.id, text: r.text }));
  }

  /** Replaces the whole list. Kids are told only when something actually changed. */
  async function setRules(parentId, texts) {
    return atomic(async () => {
      const before = (await rulesFor(parentId)).map((r) => r.text);
      const changed = before.length !== texts.length || before.some((t, i) => t !== texts[i]);
      if (changed) {
        await q('DELETE FROM house_rules WHERE parent_id = ?').run(parentId);
        for (let i = 0; i < texts.length; i++) {
          await q('INSERT INTO house_rules (parent_id, position, text, created_at) VALUES (?, ?, ?, ?)').run(parentId, i, texts[i], nowIso());
        }
        if (texts.length) {
          const kids = await q("SELECT id FROM users WHERE parent_id = ? AND role = 'kid'").all(parentId);
          for (const k of kids) await notify(k.id, { icon: '📜', title: 'House rules updated', body: 'Take a look at the family rules.', link: '#/' });
        }
      }
      return rulesFor(parentId);
    });
  }

  // ───────────── a kid's own profile ─────────────

  async function updateOwnProfile(kidId, { avatar, color }) {
    await q('UPDATE users SET avatar = ?, color = ? WHERE id = ?').run(avatar, color, kidId);
  }

  return { sendKudos, kudosForKid, thankKudos, rulesFor, setRules, updateOwnProfile };
}
