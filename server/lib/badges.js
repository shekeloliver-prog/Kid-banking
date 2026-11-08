// Achievement badges. Nothing is stored until it's earned; rules are evaluated from the ledger after the actions
// that can unlock them, inside the same transaction, so a badge is never awarded for something that rolled back.

import { LESSONS } from './lessons.js';

export const BADGES = [
  { key: 'first_goal', emoji: '🎯', title: 'Goal Setter', text: 'Created a first savings goal' },
  { key: 'saver_25', emoji: '🐷', title: 'Piggy Saver', text: 'Saved $25 toward goals' },
  { key: 'saver_100', emoji: '💰', title: 'Super Saver', text: 'Saved $100 toward goals' },
  { key: 'goal_getter', emoji: '🏆', title: 'Goal Getter', text: 'Saved up for a goal and bought it' },
  { key: 'helper', emoji: '🧹', title: 'Helping Hand', text: 'Finished a first chore' },
  { key: 'chore_10', emoji: '🌟', title: 'Chore Champ', text: 'Finished 10 chores' },
  { key: 'learner', emoji: '💡', title: 'Curious Mind', text: 'Passed a first Money Smarts lesson' },
  { key: 'streak_3', emoji: '🔥', title: 'On a Roll', text: 'Learned something 3 days in a row' },
  { key: 'whiz', emoji: '🎓', title: 'Money Whiz', text: 'Passed every Money Smarts lesson' },
];

const RULES = {
  first_goal: (s) => s.goals >= 1,
  saver_25: (s) => s.saved >= 2500,
  saver_100: (s) => s.saved >= 10000,
  goal_getter: (s) => s.bought >= 1,
  helper: (s) => s.chores >= 1,
  chore_10: (s) => s.chores >= 10,
  learner: (s) => s.lessons >= 1,
  streak_3: (s) => s.streak >= 3,
  whiz: (s) => s.lessons >= LESSONS.length,
};

export function createBadges(core) {
  const { q, notify, nowIso } = core;

  async function stats(kidId) {
    const base = await q(
      `SELECT
         (SELECT COUNT(*) FROM goals WHERE kid_id = ?) AS goals,
         (SELECT COUNT(*) FROM goals WHERE kid_id = ? AND status = 'purchased') AS bought,
         (SELECT COALESCE(SUM(-amount_cents), 0) FROM transactions WHERE user_id = ? AND kind IN ('goal_save', 'goal_release')) AS saved,
         (SELECT COUNT(*) FROM chore_claims WHERE kid_id = ? AND status = 'approved') AS chores,
         (SELECT COUNT(DISTINCT lesson_key) FROM lesson_attempts WHERE kid_id = ? AND passed = 1) AS lessons`,
    ).get(kidId, kidId, kidId, kidId, kidId);
    return { ...base, streak: await core.lessons.streakFor(kidId) };
  }

  /** Awards anything newly earned and tells the kid. Call inside the transaction that caused it. Returns what was just earned. */
  async function awardBadges(kidId) {
    const s = await stats(kidId);
    const have = new Set((await q('SELECT key FROM badges WHERE kid_id = ?').all(kidId)).map((r) => r.key));
    const earned = [];
    for (const b of BADGES) {
      if (have.has(b.key) || !RULES[b.key](s)) continue;
      const info = await q('INSERT OR IGNORE INTO badges (kid_id, key, earned_at) VALUES (?, ?, ?)').run(kidId, b.key, nowIso());
      if (info.changes) {
        await notify(kidId, { icon: b.emoji, title: `New badge: ${b.title}!`, body: b.text, link: '#/' });
        earned.push({ key: b.key, emoji: b.emoji, title: b.title, text: b.text });
      }
    }
    return earned;
  }

  /** Every badge with whether it's earned, for display. */
  async function badgesFor(kidId) {
    const rows = await q('SELECT key, earned_at FROM badges WHERE kid_id = ?').all(kidId);
    const at = new Map(rows.map((r) => [r.key, r.earned_at]));
    return BADGES.map((b) => ({ key: b.key, emoji: b.emoji, title: b.title, text: b.text, earned: at.has(b.key), earnedAt: at.get(b.key) ?? null }));
  }

  return { awardBadges, badgesFor };
}
