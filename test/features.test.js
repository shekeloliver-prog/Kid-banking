import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Db, SCHEMA } from '../server/lib/db.js';
import { createApp } from '../server/app.js';
import { activityCsv, csvCell } from '../server/lib/insights.js';
import { weeklyInterestCents, ratePercent } from '../server/lib/interest.js';
import { makeHarness, Client, DAY } from './helpers.js';

let H;
before(async () => {
  H = await makeHarness();
});
after(() => H.close());
beforeEach(() => H.reset());

// ───────────────────────── migrations ─────────────────────────

test('a fresh database ends up fully migrated, exactly once', async () => {
  const versions = await H.app.db.all('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(versions.map((v) => v.version), [2]);
  for (const table of ['chores', 'chore_claims', 'badges']) assert.ok(await H.app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`, [table]), table);
  const cols = (await H.app.db.all('PRAGMA table_info(kid_controls)')).map((c) => c.name);
  assert.ok(cols.includes('interest_bps') && cols.includes('interest_next'));
});

test('an existing version-1 database upgrades in place without losing data, and twice is a no-op', async () => {
  const file = `file:${join(mkdtempSync(join(tmpdir(), 'nestly-mig-')), 'old.db')}`;
  const legacy = createClient({ url: file });
  await legacy.executeMultiple(SCHEMA); // exactly what production had before this update
  await legacy.execute({ sql: "INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('parent', 'Old Parent', 'old@example.com', 'x', '2026-01-01T00:00:00Z')", args: [] });
  await legacy.execute({ sql: "INSERT INTO users (role, name, username, password_hash, parent_id, balance_cents, created_at) VALUES ('kid', 'Old Kid', 'oldkid', 'x', 1, 1234, '2026-01-01T00:00:00Z')", args: [] });
  await legacy.execute({ sql: 'INSERT INTO kid_controls (kid_id, weekly_limit_cents, allowance_cents, allowance_active, allowance_next) VALUES (2, 2500, 500, 1, ?)', args: ['2026-10-16'] });
  legacy.close();

  for (let round = 0; round < 2; round++) {
    const db = new Db(createClient({ url: file }));
    await db.ensureReady();
    const kid = await db.get('SELECT balance_cents FROM users WHERE id = 2');
    const c = await db.get('SELECT * FROM kid_controls WHERE kid_id = 2');
    assert.equal(kid.balance_cents, 1234);
    assert.equal(c.weekly_limit_cents, 2500);
    assert.equal(c.allowance_next, '2026-10-16');
    assert.equal(c.interest_bps, 0); // new column defaults safely
    assert.equal((await db.all('SELECT version FROM schema_migrations')).length, 1);
    await db.close();
  }
});

test('two instances starting at the same moment on one database both come up cleanly', async () => {
  const file = `file:${join(mkdtempSync(join(tmpdir(), 'nestly-race-')), 'race.db')}`;
  const dbs = Array.from({ length: 4 }, () => new Db(createClient({ url: file })));
  await Promise.all(dbs.map((d) => d.ensureReady()));
  assert.equal((await dbs[0].all('SELECT version FROM schema_migrations')).length, 1);
  await Promise.all(dbs.map((d) => d.close()));
});

// ───────────────────────── chores ─────────────────────────

const chore = (kidId, extra = {}) => ({ kidId, title: 'Take out the trash', emoji: '🗑️', rewardCents: 300, repeat: 'once', ...extra });

test('chore lifecycle: assign → kid claims → parent approves → reward is paid exactly once', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 5000);

  assert.equal((await parent.c.post('/api/chores', chore(kid.id))).status, 200);
  const list = (await kid.c.get('/api/kid/chores')).body;
  assert.equal(list.chores.length, 1);
  assert.equal(list.chores[0].state, 'available');

  const claim = await kid.c.post(`/api/kid/chores/${list.chores[0].id}/claim`);
  assert.equal(claim.status, 200);
  assert.equal((await kid.c.post(`/api/kid/chores/${list.chores[0].id}/claim`)).status, 409); // can't spam the same one
  assert.equal((await parent.c.get('/api/me')).body.pending, 1); // badge counts chores waiting
  const overview = (await parent.c.get('/api/parent/overview')).body;
  assert.equal(overview.pendingChores.length, 1);
  assert.equal(overview.pendingChores[0].kid.name, 'Mia');

  assert.equal((await parent.c.get(`/api/kids/${kid.id}`)).body.pendingChores.length, 1); // visible on the kid's own page too
  const claimId = claim.body.id;
  const approved = await parent.c.post(`/api/chore-claims/${claimId}/approve`, { note: 'Thanks!' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.balanceCents, 4700);
  assert.equal((await parent.c.post(`/api/chore-claims/${claimId}/approve`)).status, 409); // no double pay
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 300);
  assert.equal((await kid.c.get('/api/kid/chores')).body.chores.length, 0); // a one-time chore is done for good
  assert.equal((await kid.c.get('/api/kid/chores')).body.earnedCents, 300);
  assert.equal((await parent.c.get('/api/me')).body.pending, 0);
  const note = (await kid.c.get('/api/notifications')).body.items.map((n) => n.title).join('|');
  assert.match(note, /paid you \$3\.00/);
  assert.match(note, /New badge: Helping Hand/);
  await H.assertLedgerBalanced();
});

test('chore input is validated and parents only reach their own kids', async () => {
  const a = await H.newParent('A');
  const b = await H.newParent('B');
  const kidA = await H.newKid(a);
  const kidB = await H.newKid(b);
  for (const bad of [{ title: '' }, { rewardCents: 5 }, { rewardCents: 2_000_000 }, { rewardCents: 3.5 }, { emoji: '💣' }, { repeat: 'hourly' }]) {
    assert.equal((await a.c.post('/api/chores', chore(kidA.id, bad))).status, 400, JSON.stringify(bad));
  }
  assert.equal((await a.c.post('/api/chores', chore(kidB.id))).status, 404); // someone else's kid
  const mine = (await a.c.post('/api/chores', chore(kidA.id))).body.id;
  assert.equal((await b.c.patch(`/api/chores/${mine}`, chore(kidB.id))).status, 404);
  assert.equal((await b.c.del(`/api/chores/${mine}`)).status, 404);
  assert.equal((await kidB.c.post(`/api/kid/chores/${mine}/claim`)).status, 404); // another family's kid can't claim it
  const claim = await kidA.c.post(`/api/kid/chores/${mine}/claim`);
  assert.equal((await b.c.post(`/api/chore-claims/${claim.body.id}/approve`)).status, 404);
  assert.equal((await kidA.c.post(`/api/chore-claims/${claim.body.id}/approve`)).status, 403); // kids can't approve their own
  assert.equal((await kidA.c.post('/api/chores', chore(kidA.id))).status, 403);
});

test('approving needs funds: the claim stays pending, then pays once funded', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const id = (await parent.c.post('/api/chores', chore(kid.id, { rewardCents: 500 }))).body.id;
  const claim = (await kid.c.post(`/api/kid/chores/${id}/claim`)).body.id;
  const refused = await parent.c.post(`/api/chore-claims/${claim}/approve`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'insufficient_funds');
  assert.equal((await parent.c.get('/api/parent/overview')).body.pendingChores.length, 1);
  await H.fund(parent, 1000);
  assert.equal((await parent.c.post(`/api/chore-claims/${claim}/approve`)).status, 200);
  await H.assertLedgerBalanced();
});

test('rejecting leaves the chore claimable; the kid can also take a claim back', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 2000);
  const id = (await parent.c.post('/api/chores', chore(kid.id))).body.id;
  const c1 = (await kid.c.post(`/api/kid/chores/${id}/claim`)).body.id;
  assert.equal((await parent.c.post(`/api/chore-claims/${c1}/reject`, { note: 'Bin is still full' })).status, 200);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 0);
  assert.equal((await kid.c.get('/api/kid/chores')).body.chores[0].state, 'available');
  const c2 = (await kid.c.post(`/api/kid/chores/${id}/claim`)).body.id;
  assert.equal((await kid.c.del(`/api/kid/chore-claims/${c2}`)).status, 200);
  assert.equal((await parent.c.get('/api/me')).body.pending, 0);
  assert.equal((await kid.c.del(`/api/kid/chore-claims/${c2}`)).status, 404);
});

test('daily and weekly chores have a cooldown; removing a chore closes pending claims without paying', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 5000);
  const daily = (await parent.c.post('/api/chores', chore(kid.id, { title: 'Feed the dog', repeat: 'daily', rewardCents: 100 }))).body.id;
  const weekly = (await parent.c.post('/api/chores', chore(kid.id, { title: 'Mow the lawn', repeat: 'weekly', rewardCents: 500 }))).body.id;
  for (const id of [daily, weekly]) {
    const claim = (await kid.c.post(`/api/kid/chores/${id}/claim`)).body.id;
    await parent.c.post(`/api/chore-claims/${claim}/approve`);
  }
  const states = Object.fromEntries((await kid.c.get('/api/kid/chores')).body.chores.map((c) => [c.title, c.state]));
  assert.deepEqual(states, { 'Feed the dog': 'cooldown', 'Mow the lawn': 'cooldown' });
  assert.equal((await kid.c.post(`/api/kid/chores/${daily}/claim`)).body.error.code, 'not_yet');

  H.advance(DAY); // next day
  await H.relogin(kid, parent);
  const after = Object.fromEntries((await kid.c.get('/api/kid/chores')).body.chores.map((c) => [c.title, c.state]));
  assert.equal(after['Feed the dog'], 'available');
  assert.equal(after['Mow the lawn'], 'cooldown');
  H.advance(7 * DAY);
  await H.relogin(kid, parent);
  assert.equal(Object.fromEntries((await kid.c.get('/api/kid/chores')).body.chores.map((c) => [c.title, c.state]))['Mow the lawn'], 'available');

  const pending = (await kid.c.post(`/api/kid/chores/${weekly}/claim`)).body.id;
  const before = (await parent.c.get('/api/parent/overview')).body.balanceCents;
  assert.equal((await parent.c.del(`/api/chores/${weekly}`)).status, 200);
  assert.equal((await parent.c.post(`/api/chore-claims/${pending}/approve`)).status, 409); // closed
  assert.equal((await parent.c.get('/api/parent/overview')).body.balanceCents, before);
  await H.assertLedgerBalanced();
});

// ───────────────────────── interest ─────────────────────────

test('interest maths and formatting', () => {
  assert.equal(weeklyInterestCents(10000, 520), 10); // $100 at 5.2% → ~10¢ a week
  assert.equal(weeklyInterestCents(100, 500), 0); // too small to round up to a cent
  assert.equal(weeklyInterestCents(1_000_000, 2000), 3846);
  assert.equal(ratePercent(500), '5%');
  assert.equal(ratePercent(525), '5.25%');
  assert.equal(ratePercent(550), '5.5%');
});

async function kidWithSavings(parentCents = 5000, saved = 10000, bps = 520) {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 50000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: saved });
  const goal = (await kid.c.post('/api/kid/goals', { name: 'Bike', emoji: '🚲', targetCents: 50000 })).body.id;
  await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: saved });
  const set = await parent.c.put(`/api/kids/${kid.id}/controls`, { interestBps: bps });
  void parentCents;
  return { parent, kid, set };
}

test('interest: validated, scheduled for the next Sunday, paid weekly from the parent, never twice', async () => {
  const { parent, kid, set } = await kidWithSavings();
  assert.equal(set.status, 200);
  assert.equal(set.body.interestBps, 520);
  assert.equal(set.body.interestNext, '2026-10-18'); // today is Sunday 11th → the next Sunday
  for (const bad of [-1, 2001, 1.5, '5', null]) assert.equal((await parent.c.put(`/api/kids/${kid.id}/controls`, { interestBps: bad })).status, 400, String(bad));

  const parentBefore = (await parent.c.get('/api/parent/overview')).body.balanceCents;
  const idsOf = async () => (await H.app.bank.runScheduled()).interest.filter((p) => p.kidId === kid.id);
  assert.equal((await idsOf()).length, 0); // not Sunday yet
  H.advance(7 * DAY);
  assert.equal((await idsOf()).length, 1);
  assert.equal((await idsOf()).length, 0); // already paid this week
  await H.relogin(kid, parent);
  assert.equal((await parent.c.get('/api/parent/overview')).body.balanceCents, parentBefore - 10);
  const view = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(view.kid.balanceCents, 10);
  assert.equal(view.kid.interestNext, '2026-10-25');
  assert.ok(view.badges.find((b) => b.key === 'interest').earned);
  await H.assertLedgerBalanced();
});

test('interest: parent too low on funds → not paid, parent told, schedule moves on; zero savings pays nothing', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 10000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 10000 }); // parent now has $0
  const goal = (await kid.c.post('/api/kid/goals', { name: 'Bike', emoji: '🚲', targetCents: 50000 })).body.id;
  await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 10000 });
  await parent.c.put(`/api/kids/${kid.id}/controls`, { interestBps: 2000 });
  H.advance(8 * DAY);
  const paid = (await H.app.bank.runScheduled()).interest.filter((p) => p.kidId === kid.id);
  assert.equal(paid.length, 0);
  await H.relogin(parent);
  const titles = (await parent.c.get('/api/notifications')).body.items.map((n) => n.title).join('|');
  assert.match(titles, /interest wasn't paid/);
  assert.equal((await H.app.db.get('SELECT interest_next FROM kid_controls WHERE kid_id = ?', [kid.id])).interest_next, '2026-10-25');

  const empty = await H.newKid(parent, 'Empty');
  await parent.c.put(`/api/kids/${empty.id}/controls`, { interestBps: 1000 });
  H.advance(8 * DAY);
  assert.equal((await H.app.bank.runScheduled()).interest.filter((p) => p.kidId === empty.id).length, 0);
  await H.assertLedgerBalanced();
});

test('interest: two app instances on one database racing never pay the same week twice', async () => {
  const file = `file:${join(mkdtempSync(join(tmpdir(), 'nestly-two-')), 'two.db')}`;
  const one = await makeHarness({ dbUrl: file });
  const two = createApp({ dbUrl: file, clock: one.clock });
  try {
    const parent = await one.newParent();
    const kid = await one.newKid(parent);
    await one.fund(parent, 50000);
    await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 10000 });
    const goal = (await kid.c.post('/api/kid/goals', { name: 'Bike', emoji: '🚲', targetCents: 50000 })).body.id;
    await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 10000 });
    await parent.c.put(`/api/kids/${kid.id}/controls`, { interestBps: 520 });
    await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 500, freq: 'weekly', day: 0, active: true } });
    one.advance(8 * DAY);
    const runs = await Promise.all([one.app.bank.runScheduled(), two.bank.runScheduled(), one.app.bank.runScheduled(), two.bank.runScheduled()]);
    const interest = runs.flatMap((r) => r.interest).filter((p) => p.kidId === kid.id);
    const allowance = runs.flatMap((r) => r.allowances).filter((p) => p.kidId === kid.id);
    assert.equal(interest.length, 1, 'interest paid exactly once');
    assert.equal(allowance.length, 1, 'allowance paid exactly once');
    await one.assertLedgerBalanced();
  } finally {
    await two.close();
    await one.close();
  }
});

// ───────────────────────── badges ─────────────────────────

test('badges unlock from real actions, once, and show on both the kid and parent views', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 50000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 12000 });
  const earned = async () => (await kid.c.get('/api/kid/overview')).body.badges.filter((b) => b.earned).map((b) => b.key).sort();
  assert.deepEqual(await earned(), []);
  const goal = (await kid.c.post('/api/kid/goals', { name: 'Drone', emoji: '🚀', targetCents: 11000 })).body.id;
  assert.deepEqual(await earned(), ['first_goal']);
  await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 3000 });
  assert.deepEqual(await earned(), ['first_goal', 'saver_25']);
  await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 8000 });
  assert.deepEqual(await earned(), ['first_goal', 'saver_100', 'saver_25']);
  await kid.c.post(`/api/kid/goals/${goal}/purchase`);
  assert.ok((await earned()).includes('goal_getter'));
  const titles = (await kid.c.get('/api/notifications')).body.items.map((n) => n.title).filter((t) => t.startsWith('New badge'));
  assert.equal(new Set(titles).size, titles.length, 'no badge is announced twice');
  const asParent = (await parent.c.get(`/api/kids/${kid.id}`)).body.badges;
  assert.equal(asParent.length, 7);
  assert.equal(asParent.filter((b) => b.earned).length, (await earned()).length);
});

// ───────────────────────── insights + export ─────────────────────────

test('insights add up spending by category, per kid and per week', async () => {
  const parent = await H.newParent();
  const mia = await H.newKid(parent, 'Mia');
  const leo = await H.newKid(parent, 'Leo');
  await H.fund(parent, 50000);
  await parent.c.post(`/api/kids/${mia.id}/send`, { amountCents: 10000 });
  await parent.c.post(`/api/kids/${leo.id}/send`, { amountCents: 5000 });
  await mia.c.post('/api/kid/spend', { amountCents: 400, category: 'food' });
  await mia.c.post('/api/kid/spend', { amountCents: 600, category: 'food' });
  await mia.c.post('/api/kid/spend', { amountCents: 900, category: 'toys' });
  await leo.c.post('/api/kid/spend', { amountCents: 250, category: 'games' });
  const goal = (await mia.c.post('/api/kid/goals', { name: 'Lego', emoji: '🧸', targetCents: 2000 })).body.id;
  await mia.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 2000 });
  await mia.c.post(`/api/kid/goals/${goal}/purchase`);

  const all = (await parent.c.get('/api/insights?days=30')).body;
  assert.equal(all.totals.spentCents, 400 + 600 + 900 + 250 + 2000);
  assert.equal(all.totals.earnedCents, 15000);
  assert.equal(all.totals.savedCents, 2000);
  assert.deepEqual(all.categories.map((c) => [c.category, c.spentCents]), [['goals', 2000], ['food', 1000], ['toys', 900], ['games', 250]]);
  assert.equal(all.perKid.find((k) => k.kid.name === 'Leo').spentCents, 250);
  assert.equal(all.weekly.at(-1).spentCents, all.totals.spentCents);
  assert.equal(all.weekly.length, 5);

  const justLeo = (await parent.c.get(`/api/insights?days=7&kid=${leo.id}`)).body;
  assert.equal(justLeo.totals.spentCents, 250);
  assert.equal((await parent.c.get('/api/insights?days=12')).status, 400);
  const other = await H.newParent('Other');
  assert.equal((await other.c.get(`/api/insights?days=7&kid=${leo.id}`)).status, 404);
  assert.equal((await mia.c.get('/api/insights?days=7')).status, 403);
});

test('CSV export: correct columns, quoting, formula-injection defused, and access-controlled', async () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://evil")'), `"'=HYPERLINK(""http://evil"")"`);
  for (const lead of ['+1', '-1', '@x']) assert.ok(csvCell(lead).startsWith("'"));
  assert.equal(activityCsv([]).trim(), 'Date (UTC),Who,Type,With,Amount (USD),Category,Note');

  const parent = await H.newParent();
  const kid = await H.newKid(parent, '=Evil Kid');
  await H.fund(parent, 5000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1234, note: 'Lunch, snacks' });
  await kid.c.post('/api/kid/spend', { amountCents: 100, category: 'food', note: '=1+1' });
  const r = await parent.c.get('/api/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="nestly-activity-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.raw.trim().split('\r\n');
  assert.equal(lines.length, 4); // header + deposit + send + spend
  assert.ok(lines.some((l) => l.includes('-12.34') && l.includes('"Lunch, snacks"')));
  assert.ok(lines.some((l) => l.includes("'=1+1")), 'formula in a note is neutralised');
  assert.ok(lines.some((l) => l.includes("'=Evil Kid")), 'formula in a name is neutralised');

  const other = await H.newParent('Other');
  assert.equal((await other.c.get(`/api/export.csv?kid=${kid.id}`)).status, 404);
  assert.equal((await kid.c.get('/api/export.csv')).status, 403);
  assert.equal((await new Client(H.base).get('/api/export.csv')).status, 401);
});

test('removing a kid also removes their chores, claims and badges', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 5000);
  const id = (await parent.c.post('/api/chores', chore(kid.id))).body.id;
  const claim = (await kid.c.post(`/api/kid/chores/${id}/claim`)).body.id;
  await parent.c.post(`/api/chore-claims/${claim}/approve`);
  assert.equal((await parent.c.del(`/api/kids/${kid.id}`, { password: 'correct-horse-battery' })).status, 200);
  for (const [table, col] of [['chores', 'kid_id'], ['chore_claims', 'kid_id'], ['badges', 'kid_id'], ['transactions', 'user_id']]) {
    assert.equal((await H.app.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, [kid.id])).n, 0, table);
  }
  await H.assertLedgerBalanced();
});

// ───────────────────────── installable app ─────────────────────────

test('the web manifest is valid and every file it points to is really served', async () => {
  const res = await fetch(H.base + '/manifest.webmanifest');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /manifest\+json|application\/json/);
  const manifest = await res.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192') && manifest.icons.some((i) => i.sizes === '512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const r = await fetch(H.base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.match(r.headers.get('content-type'), icon.type === 'image/svg+xml' ? /svg/ : /png/);
  }
  assert.equal((await fetch(H.base + '/icons/apple-touch-icon.png')).status, 200);
});

test('the service worker is served as JavaScript and never handles API traffic', async () => {
  const res = await fetch(H.base + '/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const code = await res.text();
  assert.match(code, /startsWith\('\/api\/'\)\) return/); // API requests are left alone
  assert.doesNotMatch(code, /caches\.(open|put)\([^)]*api/);
});

test('the early theme script is a plain classic script allowed by the CSP', async () => {
  const html = await (await fetch(H.base + '/')).text();
  assert.match(html, /<script src="\/js\/theme-init\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>[^<]/); // no inline scripts (the CSP forbids them)
  assert.equal((await fetch(H.base + '/js/theme-init.js')).status, 200);
});
