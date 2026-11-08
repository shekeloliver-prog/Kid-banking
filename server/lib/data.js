// Owning your data: download everything a family has put into Nestly, and delete it all.
// Deletes are written out table by table (children first) so they never depend on the database enforcing
// ON DELETE rules.

const EXPORT_TX_LIMIT = 20_000;

export function createData(core) {
  const { q, atomic, getUser, nowIso } = core;

  const likeEscape = (v) => String(v).replace(/[\\%_]/g, (c) => '\\' + c);

  /**
   * Removes kids and every row that belongs to them (one pass for any number of kids, so closing a whole family stays a
   * short transaction). Includes their login-throttle rows, so a deleted username or email leaves nothing behind.
   * Money handling is the caller's job.
   */
  async function purgeKids(kids) {
    if (!kids.length) return;
    const ids = kids.map((k) => k.id);
    const marks = ids.map(() => '?').join(',');
    await q(`UPDATE transactions SET counterparty_id = NULL WHERE counterparty_id IN (${marks})`).run(...ids);
    for (const [table, column] of [
      ['chore_claims', 'kid_id'],
      ['chores', 'kid_id'],
      ['badges', 'kid_id'],
      ['lesson_attempts', 'kid_id'],
      ['kudos', 'kid_id'],
      ['transactions', 'user_id'],
      ['goals', 'kid_id'],
      ['money_requests', 'kid_id'],
      ['notifications', 'user_id'],
      ['sessions', 'user_id'],
      ['kid_controls', 'kid_id'],
    ]) {
      await q(`DELETE FROM ${table} WHERE ${column} IN (${marks})`).run(...ids);
    }
    await forgetAttempts([...ids.map((id) => ({ exact: `confirm:${id}` })), ...kids.map((k) => ({ role: 'kid', who: k.username }))]);
    await q(`DELETE FROM users WHERE id IN (${marks})`).run(...ids);
  }

  /** Clears failed-login counters for these accounts (see the key shapes in app.js and routes.js). */
  async function forgetAttempts(entries) {
    const clauses = [];
    const args = [];
    for (const e of entries) {
      if (e.exact) {
        clauses.push('key = ?');
        args.push(e.exact);
      } else {
        clauses.push('key = ?', "key LIKE ? ESCAPE '\\'");
        args.push(`login-acct:${e.role}:${e.who}`, `login:%:${likeEscape(`${e.role}:${e.who}`)}`);
      }
    }
    await q(`DELETE FROM rate_limits WHERE ${clauses.join(' OR ')}`).run(...args);
  }

  /** Deletes a parent account together with all of its kids and everything they own. */
  async function deleteParent(parentId) {
    return atomic(async () => {
      const parent = await getUser(parentId);
      const kids = await q("SELECT id, username FROM users WHERE parent_id = ? AND role = 'kid'").all(parentId);
      await purgeKids(kids);
      await q('DELETE FROM chore_claims WHERE chore_id IN (SELECT id FROM chores WHERE parent_id = ?)').run(parentId);
      for (const [table, column] of [
        ['chores', 'parent_id'],
        ['kudos', 'parent_id'],
        ['house_rules', 'parent_id'],
        ['transactions', 'user_id'],
        ['notifications', 'user_id'],
        ['sessions', 'user_id'],
      ]) {
        await q(`DELETE FROM ${table} WHERE ${column} = ?`).run(parentId);
      }
      if (parent) await forgetAttempts([{ role: 'parent', who: parent.email }, { exact: `confirm:${parentId}` }]);
      await q("DELETE FROM users WHERE id = ? AND role = 'parent'").run(parentId);
      return { deletedKids: kids.length };
    });
  }

  /** Everything the family has, in a readable shape. Never includes passwords, PINs or sign-in tokens. */
  async function exportFamily(parentId) {
    const parent = await getUser(parentId);
    const kidRows = await q("SELECT * FROM users WHERE parent_id = ? AND role = 'kid' ORDER BY id").all(parentId);
    const ids = [parentId, ...kidRows.map((k) => k.id)];
    const marks = ids.map(() => '?').join(',');
    const names = new Map([[parent.id, parent.name], ...kidRows.map((k) => [k.id, k.name])]);

    const [rules, txRows] = await Promise.all([
      q('SELECT text FROM house_rules WHERE parent_id = ? ORDER BY position, id').all(parentId),
      q(`SELECT * FROM transactions WHERE user_id IN (${marks}) ORDER BY id DESC LIMIT ?`).all(...ids, EXPORT_TX_LIMIT + 1),
    ]);
    const truncated = txRows.length > EXPORT_TX_LIMIT;

    const kids = [];
    for (const k of kidRows) {
      const [controls, goals, requests, chores, claims, badges, lessons, cheers] = await Promise.all([
        q('SELECT * FROM kid_controls WHERE kid_id = ?').get(k.id),
        q('SELECT * FROM goals WHERE kid_id = ? ORDER BY id').all(k.id),
        q('SELECT * FROM money_requests WHERE kid_id = ? ORDER BY id').all(k.id),
        q('SELECT * FROM chores WHERE kid_id = ? ORDER BY id').all(k.id),
        q('SELECT * FROM chore_claims WHERE kid_id = ? ORDER BY id').all(k.id),
        q('SELECT key, earned_at FROM badges WHERE kid_id = ? ORDER BY earned_at').all(k.id),
        q('SELECT * FROM lesson_attempts WHERE kid_id = ? ORDER BY id').all(k.id),
        q('SELECT * FROM kudos WHERE kid_id = ? ORDER BY id').all(k.id),
      ]);
      kids.push({
        name: k.name,
        username: k.username,
        avatar: k.avatar,
        color: k.color,
        createdAt: k.created_at,
        balanceCents: k.balance_cents,
        controls: {
          frozen: !!controls.frozen,
          weeklyLimitCents: controls.weekly_limit_cents,
          maxRequestCents: controls.max_request_cents,
          allowanceCents: controls.allowance_cents,
          allowanceFrequency: controls.allowance_freq,
          allowanceActive: !!controls.allowance_active,
        },
        goals: goals.map((g) => ({ name: g.name, emoji: g.emoji, targetCents: g.target_cents, savedCents: g.saved_cents, status: g.status, createdAt: g.created_at, closedAt: g.closed_at })),
        moneyRequests: requests.map((r) => ({ amountCents: r.amount_cents, reason: r.reason, status: r.status, responseNote: r.response_note, createdAt: r.created_at, decidedAt: r.decided_at })),
        chores: chores.map((c) => ({
          title: c.title,
          emoji: c.emoji,
          rewardCents: c.reward_cents,
          repeat: c.repeat,
          status: c.status,
          createdAt: c.created_at,
          claims: claims.filter((x) => x.chore_id === c.id).map((x) => ({ status: x.status, rewardCents: x.reward_cents, createdAt: x.created_at, decidedAt: x.decided_at })),
        })),
        badges: badges.map((b) => ({ key: b.key, earnedAt: b.earned_at })),
        lessonAttempts: lessons.map((a) => ({ lesson: a.lesson_key, correct: a.correct, total: a.total, passed: !!a.passed, day: a.day })),
        cheers: cheers.map((c) => ({ emoji: c.emoji, message: c.message, sentAt: c.created_at, thankedAt: c.thanked_at })),
      });
    }

    return {
      app: 'Nestly',
      note: 'Practice money only. Amounts are in cents.',
      exportedAt: nowIso(),
      parent: { name: parent.name, email: parent.email, timezone: parent.timezone, createdAt: parent.created_at, balanceCents: parent.balance_cents },
      houseRules: rules.map((r) => r.text),
      kids,
      transactions: txRows.slice(0, EXPORT_TX_LIMIT).map((t) => ({
        account: names.get(t.user_id),
        kind: t.kind,
        amountCents: t.amount_cents,
        counterparty: t.counterparty_name,
        note: t.note,
        category: t.category,
        createdAt: t.created_at,
      })),
      transactionsTruncated: truncated,
    };
  }

  return { purgeKids, deleteParent, exportFamily };
}
