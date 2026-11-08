import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { Db, SCHEMA } from '../server/lib/db.js';
import { MIGRATIONS } from '../server/lib/migrations.js';
import { LESSONS, streakOf } from '../server/lib/lessons.js';
import { makeHarness, Client, DAY } from './helpers.js';

let H;
before(async () => {
  H = await makeHarness();
});
after(() => H.close());
beforeEach(async () => {
  H.reset();
  for (const l of Object.values(H.app.limiters)) await l.clear();
});

const right = (key) => LESSONS.find((l) => l.key === key).questions.map((q) => q.answer);
const wrong = (key) => right(key).map((a) => (a + 1) % 3);
const nearly = (key) => right(key).map((a, i) => (i === 0 ? (a + 1) % 3 : a));
const submit = (kid, key, answers) => kid.c.post(`/api/kid/learn/${key}`, { answers });
const earnedBadges = async (kid) => (await kid.c.get('/api/kid/overview')).body.badges.filter((b) => b.earned).map((b) => b.key);

// ───────────────────────── Money Smarts lessons ─────────────────────────

test('lessons are listed, and the quiz never reveals its answers up front', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const list = (await kid.c.get('/api/kid/learn')).body;
  assert.equal(list.lessons.length, LESSONS.length);
  assert.equal(list.passedCount, 0);
  assert.equal(list.streak, 0);
  assert.equal(list.doneToday, false);

  const detail = await kid.c.get('/api/kid/learn/needs-wants');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.questions.length, 3);
  assert.ok(detail.body.learn.length >= 2);
  assert.ok(!/answer|why/i.test(JSON.stringify(detail.body.questions)), 'questions carry no answers');

  assert.equal((await kid.c.get('/api/kid/learn/not-a-lesson')).status, 404);
  assert.equal((await parent.c.get('/api/kid/learn')).status, 403);
});

test('submitting scores on the server: fail, pass, best score kept, and the right answers come back after', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const key = 'why-save';

  const bad = (await submit(kid, key, wrong(key))).body;
  assert.equal(bad.passed, false);
  assert.equal(bad.correct, 0);
  assert.deepEqual(bad.results.map((r) => r.answer), right(key));
  assert.ok(bad.results.every((r) => !r.correct && r.why));
  assert.deepEqual(await earnedBadges(kid), []);

  const ok = (await submit(kid, key, nearly(key))).body;
  assert.equal(ok.passed, true);
  assert.equal(ok.correct, 2);
  assert.deepEqual(ok.newBadges.map((b) => b.key), ['learner']);

  const perfect = (await submit(kid, key, right(key))).body;
  assert.equal(perfect.correct, 3);
  assert.deepEqual(perfect.newBadges, [], 'a badge is only announced once');

  const row = (await kid.c.get('/api/kid/learn')).body.lessons.find((l) => l.key === key);
  assert.deepEqual({ passed: row.passed, best: row.bestCorrect, attempts: row.attempts }, { passed: true, best: 3, attempts: 3 });
  assert.equal((await kid.c.get('/api/kid/learn')).body.passedCount, 1);

  const notes = (await kid.c.get('/api/notifications')).body.items.filter((n) => n.title.startsWith('New badge'));
  assert.equal(notes.length, 1);
});

test('malformed answers are rejected without recording an attempt', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  for (const answers of [undefined, 'abc', [], [0, 0], [0, 0, 0, 0], [0, 1, 'x'], [0, 1, 1.5], [0, 1, 3], [0, 1, -1], [null, 0, 0]]) {
    assert.equal((await submit(kid, 'goals', answers)).status, 400, JSON.stringify(answers));
  }
  assert.equal((await submit(kid, 'nope', [0, 0, 0])).status, 404);
  assert.equal((await H.app.db.get('SELECT COUNT(*) AS n FROM lesson_attempts WHERE kid_id = ?', [kid.id])).n, 0);
});

test('streaks count consecutive days (yesterday still counts), and three in a row earns a badge', async () => {
  assert.equal(streakOf([], '2026-10-11'), 0);
  assert.equal(streakOf(['2026-10-11', '2026-10-10', '2026-10-08'], '2026-10-11'), 2);
  assert.equal(streakOf(['2026-10-10', '2026-10-09'], '2026-10-11'), 2, 'not done today yet, streak still alive');
  assert.equal(streakOf(['2026-10-09'], '2026-10-11'), 0, 'two days missed');

  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const streak = async () => (await kid.c.get('/api/kid/learn')).body;
  await submit(kid, 'needs-wants', right('needs-wants'));
  assert.equal((await streak()).streak, 1);
  assert.equal((await streak()).doneToday, true);
  await submit(kid, 'why-save', right('why-save')); // same day: streak does not grow
  assert.equal((await streak()).streak, 1);

  H.advance(DAY);
  const second = (await submit(kid, 'goals', right('goals'))).body;
  assert.equal(second.streak, 2);
  assert.equal(second.streakGrew, true);
  assert.ok(!(await earnedBadges(kid)).includes('streak_3'));

  H.advance(DAY);
  const third = (await submit(kid, 'smart-spend', right('smart-spend'))).body;
  assert.equal(third.streak, 3);
  assert.ok(third.newBadges.some((b) => b.key === 'streak_3'));

  H.advance(DAY); // a day off: the streak is still alive until the day ends
  assert.deepEqual({ s: (await streak()).streak, d: (await streak()).doneToday }, { s: 3, d: false });
  H.advance(2 * DAY); // now it has lapsed
  assert.equal((await streak()).streak, 0);
});

test('passing every lesson earns Money Whiz; the parent can see progress', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  for (const l of LESSONS) await submit(kid, l.key, right(l.key));
  const badges = await earnedBadges(kid);
  assert.ok(badges.includes('whiz') && badges.includes('learner'));
  const detail = (await parent.c.get(`/api/kids/${kid.id}`)).body;
  assert.equal(detail.learning.passedCount, LESSONS.length);
  assert.equal(detail.learning.total, LESSONS.length);
  const other = await H.newParent('Other');
  assert.equal((await other.c.get(`/api/kids/${kid.id}`)).status, 404);
});

test('a lesson can only be retried so many times a day', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  for (let i = 0; i < 12; i++) assert.equal((await submit(kid, 'safe', wrong('safe'))).status, 200);
  const blocked = await submit(kid, 'safe', right('safe'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'enough_for_today');
  assert.equal((await submit(kid, 'planning', right('planning'))).status, 200, 'other lessons are unaffected');
  H.advance(DAY);
  assert.equal((await submit(kid, 'safe', right('safe'))).status, 200);
});

test('lessons never touch anyone’s money', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  await H.fund(parent, 1000);
  for (const l of LESSONS) await submit(kid, l.key, right(l.key));
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 0);
  assert.equal((await parent.c.get('/api/parent/overview')).body.balanceCents, 1000);
  await H.assertLedgerBalanced();
});

// ───────────────────────── cheers ─────────────────────────

test('cheers: a parent sends one, the kid sees it and thanks once, the parent hears about it', async () => {
  const parent = await H.newParent('Sam');
  const kid = await H.newKid(parent, 'Mia');
  const sent = await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '🏆', message: 'Great job on your spelling test!' });
  assert.equal(sent.status, 200);

  const view = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(view.cheers.length, 1);
  assert.deepEqual({ emoji: view.cheers[0].emoji, from: view.cheers[0].from, thanked: view.cheers[0].thanked }, { emoji: '🏆', from: 'Sam', thanked: false });
  const kidNote = (await kid.c.get('/api/notifications')).body.items.find((n) => n.title.includes('cheer'));
  assert.equal(kidNote.body, 'Great job on your spelling test!');

  const id = view.cheers[0].id;
  assert.equal((await kid.c.post(`/api/kid/cheers/${id}/thanks`)).status, 200);
  assert.equal((await kid.c.post(`/api/kid/cheers/${id}/thanks`)).status, 200, 'saying thanks twice is harmless');
  const thanks = (await parent.c.get('/api/notifications')).body.items.filter((n) => n.title.includes('said thanks'));
  assert.equal(thanks.length, 1, 'the parent is told once');
  assert.equal((await kid.c.get('/api/kid/overview')).body.cheers[0].thanked, true);
  assert.equal((await parent.c.get(`/api/kids/${kid.id}`)).body.cheers[0].thanked, true);
});

test('cheers are checked: ownership, validation and a daily limit', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const stranger = await H.newParent('Other');
  const strangerKid = await H.newKid(stranger, 'Zed');

  assert.equal((await stranger.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'hi' })).status, 404);
  assert.equal((await kid.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'hi' })).status, 403);
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '💣', message: 'hi' })).status, 400);
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: '   ' })).status, 400);
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'x'.repeat(121) })).status, 400);

  await stranger.c.post(`/api/kids/${strangerKid.id}/cheers`, { emoji: '⭐', message: 'for zed' });
  const zedCheer = (await strangerKid.c.get('/api/kid/overview')).body.cheers[0].id;
  assert.equal((await kid.c.post(`/api/kid/cheers/${zedCheer}/thanks`)).status, 404, "can't thank someone else's cheer");

  for (let i = 0; i < 10; i++) assert.equal((await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: `n${i}` })).status, 200);
  const over = await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'one too many' });
  assert.equal(over.status, 429);
  H.advance(DAY + 1000);
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'tomorrow' })).status, 200);
});

// ───────────────────────── house rules ─────────────────────────

test('house rules: parents write them, kids read them, kids are told only when they change', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const other = await H.newParent('Other');
  const otherKid = await H.newKid(other, 'Zed');
  const ruleNotes = async () => (await kid.c.get('/api/notifications')).body.items.filter((n) => n.title === 'House rules updated').length;

  assert.deepEqual((await parent.c.get('/api/rules')).body.rules, []);
  const put = await parent.c.put('/api/rules', { rules: ['Ask before spending over $20', '', '   ', 'Save a little every week'] });
  assert.deepEqual(put.body.rules, ['Ask before spending over $20', 'Save a little every week'], 'blank lines are dropped');
  assert.deepEqual((await kid.c.get('/api/kid/overview')).body.rules, put.body.rules);
  assert.equal(await ruleNotes(), 1);

  await parent.c.put('/api/rules', { rules: put.body.rules }); // unchanged
  assert.equal(await ruleNotes(), 1, 'no notification when nothing changed');
  await parent.c.put('/api/rules', { rules: ['Be kind'] });
  assert.equal(await ruleNotes(), 2);
  assert.deepEqual((await otherKid.c.get('/api/kid/overview')).body.rules, [], "another family's rules are separate");

  await parent.c.put('/api/rules', { rules: [] });
  assert.deepEqual((await kid.c.get('/api/kid/overview')).body.rules, []);
  assert.equal(await ruleNotes(), 2, 'clearing the list is quiet');
});

test('house rules reject bad input and the wrong role', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  assert.equal((await parent.c.put('/api/rules', { rules: 'be nice' })).status, 400);
  assert.equal((await parent.c.put('/api/rules', { rules: [42] })).status, 400);
  assert.equal((await parent.c.put('/api/rules', { rules: ['x'.repeat(91)] })).status, 400);
  assert.equal((await parent.c.put('/api/rules', { rules: Array.from({ length: 9 }, (_, i) => `rule ${i}`) })).status, 400);
  assert.equal((await parent.c.put('/api/rules', { rules: Array.from({ length: 8 }, (_, i) => `rule ${i}`) })).status, 200);
  assert.equal((await kid.c.put('/api/rules', { rules: ['mine'] })).status, 403);
  assert.equal((await kid.c.get('/api/rules')).status, 403);
});

// ───────────────────────── kid profile ─────────────────────────

test('a kid can change their own avatar and colour — and nothing else', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent, 'Mia');
  const r = await kid.c.patch('/api/kid/profile', { avatar: '🦄', color: 'pink', name: 'Hacker', balanceCents: 99999 });
  assert.equal(r.status, 200);
  assert.deepEqual({ avatar: r.body.user.avatar, color: r.body.user.color, name: r.body.user.name }, { avatar: '🦄', color: 'pink', name: 'Mia' });
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 0);
  assert.equal((await parent.c.get(`/api/kids/${kid.id}`)).body.kid.avatar, '🦄');
  assert.equal((await kid.c.patch('/api/kid/profile', { avatar: '💩', color: 'pink' })).status, 400);
  assert.equal((await kid.c.patch('/api/kid/profile', { avatar: '🦄', color: 'neon' })).status, 400);
  assert.equal((await parent.c.patch('/api/kid/profile', { avatar: '🦄', color: 'pink' })).status, 403);
});

// ───────────────────────── activity search ─────────────────────────

async function seedActivity() {
  const parent = await H.newParent();
  const kid = await H.newKid(parent, 'Mia');
  await H.fund(parent, 50000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1000, note: 'Pizza night' });
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 500, note: 'Save 100% please' });
  await parent.c.post(`/api/kids/${kid.id}/take`, { amountCents: 200, note: 'Oops' });
  await kid.c.post('/api/kid/spend', { amountCents: 300, category: 'food', note: 'Lunch' });
  return { parent, kid };
}
const notes = (r) => r.body.items.map((t) => t.note);

test('parent activity: search, direction and look-back window narrow the list', async () => {
  const { parent, kid } = await seedActivity();
  assert.deepEqual(notes(await parent.c.get('/api/activity?q=pizza')), ['Pizza night']);
  assert.equal((await parent.c.get(`/api/activity?kid=${kid.id}&q=PIZZA`)).body.items.length, 1, 'case-insensitive');
  assert.equal((await parent.c.get('/api/activity?q=mia')).body.items.length, 4, "matches the kid's name: money sent to Mia and what Mia spent");
  assert.equal((await parent.c.get('/api/activity?q=allowance')).body.items.length, 0);
  assert.equal((await parent.c.get('/api/activity?q=food')).body.items.length, 1, 'matches the category');

  const ins = (await parent.c.get('/api/activity?dir=in')).body.items;
  const outs = (await parent.c.get('/api/activity?dir=out')).body.items;
  assert.ok(ins.length && ins.every((t) => t.amountCents > 0));
  assert.ok(outs.length && outs.every((t) => t.amountCents < 0));

  H.advance(10 * DAY);
  await H.relogin(parent);
  assert.equal((await parent.c.get('/api/activity?days=7')).body.items.length, 0, 'everything is older than a week');
  assert.ok((await parent.c.get('/api/activity?days=30')).body.items.length > 0);
});

test('search treats % and _ as plain characters, and bad filters are rejected', async () => {
  const { parent, kid } = await seedActivity();
  const pct = (await parent.c.get(`/api/activity?kid=${kid.id}&q=${encodeURIComponent('100%')}`)).body.items;
  assert.deepEqual(pct.map((t) => t.note), ['Save 100% please']);
  assert.equal((await parent.c.get(`/api/activity?kid=${kid.id}&q=${encodeURIComponent('%')}`)).body.items.length, 1, '% is not a wildcard');
  assert.equal((await parent.c.get(`/api/activity?kid=${kid.id}&q=${encodeURIComponent('_')}`)).body.items.length, 0, '_ is not a wildcard (no note or name has one)');
  assert.equal((await parent.c.get(`/api/activity?q=${encodeURIComponent("'; DROP TABLE users; --")}`)).body.items.length, 0);
  assert.equal((await H.app.db.get('SELECT COUNT(*) AS n FROM users')).n > 0, true);
  assert.equal((await parent.c.get('/api/activity?dir=sideways')).status, 400);
  assert.equal((await parent.c.get('/api/activity?days=5')).status, 400);
  assert.equal((await parent.c.get(`/api/activity?q=${'x'.repeat(41)}`)).status, 400);
});

test('kid activity can be searched and filtered, paging still works, and CSV export honours the filters', async () => {
  const { parent, kid } = await seedActivity();
  assert.deepEqual(notes(await kid.c.get('/api/kid/activity?q=lunch')), ['Lunch']);
  assert.deepEqual((await kid.c.get('/api/kid/activity?dir=out')).body.items.map((t) => t.kind), ['spend', 'takeback_out']);
  const page1 = (await kid.c.get('/api/kid/activity?dir=in&limit=1')).body;
  assert.equal(page1.items.length, 1);
  assert.ok(page1.nextBefore);
  const page2 = (await kid.c.get(`/api/kid/activity?dir=in&limit=5&before=${page1.nextBefore}`)).body;
  assert.ok(page2.items.every((t) => t.amountCents > 0));
  assert.equal(page1.items.length + page2.items.length, 2);

  const csv = (await parent.c.get('/api/export.csv?q=pizza')).raw;
  assert.ok(csv.includes('Pizza night'));
  assert.ok(!csv.includes('Oops'));
});

// ───────────────────────── where I'm signed in ─────────────────────────

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function loginWith(account, userAgent) {
  const c = new Client(H.base);
  const r = await c.call('POST', '/api/auth/login', { role: account.role, identifier: account.identifier, password: account.password }, { 'user-agent': userAgent });
  assert.equal(r.status, 200);
  return c;
}

test('signed-in devices are listed with a readable name, and one can be signed out remotely', async () => {
  const parent = await H.newParent();
  const mac = await loginWith(parent, CHROME_MAC);
  const phone = await loginWith(parent, SAFARI_IPHONE);

  const list = (await mac.get('/api/auth/sessions')).body.items;
  const mine = list.filter((s) => s.current);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].device, 'Chrome on Mac');
  const theirs = list.find((s) => s.device === 'Safari on iPhone');
  assert.ok(theirs && !theirs.current);
  assert.ok(!JSON.stringify(list).match(/[0-9a-f]{40,}/), 'no full token hashes are exposed');

  assert.equal((await mac.del(`/api/auth/sessions/${mine[0].id}`)).status, 404, "can't sign out the device you're using from the list");
  assert.equal((await mac.del('/api/auth/sessions/not-a-real-id')).status, 404);
  assert.equal((await mac.del(`/api/auth/sessions/${theirs.id}`)).status, 200);
  assert.equal((await phone.get('/api/me')).status, 401, 'the phone is signed out');
  assert.equal((await mac.get('/api/me')).status, 200);
});

test('"sign out everywhere else" keeps only this device, and one account cannot touch another’s sessions', async () => {
  const parent = await H.newParent();
  const stranger = await H.newParent('Other');
  const a = await loginWith(parent, CHROME_MAC);
  const b = await loginWith(parent, SAFARI_IPHONE);
  const strangerList = (await stranger.c.get('/api/auth/sessions')).body.items;
  assert.equal((await a.del(`/api/auth/sessions/${strangerList[0].id}`)).status, 404);
  assert.equal((await stranger.c.get('/api/me')).status, 200);

  assert.equal((await a.post('/api/auth/sessions/revoke-others')).status, 200);
  assert.equal((await b.get('/api/me')).status, 401);
  assert.equal((await parent.c.get('/api/me')).status, 401, 'the registration session was another device too');
  assert.equal((await a.get('/api/me')).status, 200);
  assert.equal((await a.get('/api/auth/sessions')).body.items.length, 1);
});

test('kids can see their own devices too', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const r = await kid.c.get('/api/auth/sessions');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((s) => s.current));
});

// ───────────────────────── download my data ─────────────────────────

test('the data download has everything for this family, no secrets, and nothing from other families', async () => {
  const parent = await H.newParent('Sam');
  const kid = await H.newKid(parent, 'Mia');
  const stranger = await H.newParent('Other');
  await H.newKid(stranger, 'Zedekiah');
  await H.fund(parent, 5000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1500, note: 'Welcome' });
  await kid.c.post('/api/kid/goals', { name: 'Bike', emoji: '🚲', targetCents: 9000 });
  await parent.c.put('/api/rules', { rules: ['Be kind'] });
  await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'Nice work' });
  await submit(kid, 'goals', right('goals'));
  await parent.c.post('/api/chores', { kidId: kid.id, title: 'Dishes', emoji: '🍽️', rewardCents: 200, repeat: 'once' });

  const res = await parent.c.get('/api/export.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="nestly-data-2026-10-11\.json"$/);
  const data = JSON.parse(res.raw);
  assert.equal(data.parent.email, parent.identifier);
  assert.deepEqual(data.houseRules, ['Be kind']);
  assert.equal(data.kids.length, 1);
  const k = data.kids[0];
  assert.equal(k.name, 'Mia');
  assert.equal(k.goals[0].name, 'Bike');
  assert.equal(k.cheers[0].message, 'Nice work');
  assert.equal(k.lessonAttempts[0].lesson, 'goals');
  assert.equal(k.chores[0].title, 'Dishes');
  assert.ok(data.transactions.some((t) => t.note === 'Welcome'));
  assert.equal(data.transactionsTruncated, false);
  assert.ok(!/scrypt|password|token|Zedekiah|other@/i.test(res.raw.replace(/"email":\s*"[^"]*"/g, '')), 'no hashes, tokens or other families');

  assert.equal((await kid.c.get('/api/export.json')).status, 403);
  assert.equal((await H.client().get('/api/export.json')).status, 401);
});

// ───────────────────────── delete my account ─────────────────────────

test('deleting an account needs the password, removes the whole family, and leaves other families untouched', async () => {
  const parent = await H.newParent('Sam');
  const kid = await H.newKid(parent, 'Mia');
  const other = await H.newParent('Other');
  const otherKid = await H.newKid(other, 'Zed');
  for (const p of [parent, other]) await H.fund(p, 10000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 2000 });
  await other.c.post(`/api/kids/${otherKid.id}/send`, { amountCents: 3000 });
  await kid.c.post('/api/kid/goals', { name: 'Bike', emoji: '🚲', targetCents: 9000 });
  await kid.c.post('/api/kid/requests', { amountCents: 500, reason: 'Book' });
  await parent.c.put('/api/rules', { rules: ['Be kind'] });
  await parent.c.post(`/api/kids/${kid.id}/cheers`, { emoji: '⭐', message: 'Nice' });
  await parent.c.post('/api/chores', { kidId: kid.id, title: 'Dishes', emoji: '🍽️', rewardCents: 200, repeat: 'once' });
  await submit(kid, 'goals', right('goals'));

  assert.equal((await kid.c.del('/api/me', { password: '123456' })).status, 403, 'a kid cannot delete the account');
  const wrongTry = await parent.c.del('/api/me', { password: 'not-the-password' });
  assert.equal(wrongTry.status, 403);
  assert.equal((await parent.c.get('/api/me')).status, 200, 'still signed in, still exists');
  assert.equal((await parent.c.del('/api/me', {})).status, 403);

  const gone = await parent.c.del('/api/me', { password: parent.password });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.deletedKids, 1);
  assert.equal((await parent.c.get('/api/me')).status, 401);
  assert.equal((await kid.c.get('/api/me')).status, 401, "the kid's session is gone too");
  assert.equal((await H.client().post('/api/auth/login', { role: 'parent', identifier: parent.identifier, password: parent.password })).status, 401);

  const ids = [parent.user.id, kid.id];
  const mark = ids.map(() => '?').join(',');
  for (const [table, col] of [['users', 'id'], ['transactions', 'user_id'], ['goals', 'kid_id'], ['money_requests', 'kid_id'], ['notifications', 'user_id'], ['sessions', 'user_id'], ['chores', 'kid_id'], ['chores', 'parent_id'], ['kudos', 'kid_id'], ['kudos', 'parent_id'], ['lesson_attempts', 'kid_id'], ['badges', 'kid_id'], ['kid_controls', 'kid_id'], ['house_rules', 'parent_id']]) {
    assert.equal((await H.app.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IN (${mark})`, ids)).n, 0, `${table}.${col}`);
  }
  assert.equal((await H.app.db.get('SELECT COUNT(*) AS n FROM chore_claims WHERE chore_id NOT IN (SELECT id FROM chores)')).n, 0);

  assert.equal((await other.c.get('/api/parent/overview')).body.balanceCents, 7000, "another family's money is untouched");
  assert.equal((await otherKid.c.get('/api/kid/overview')).body.kid.balanceCents, 3000);
  await H.assertLedgerBalanced();
});

test('deleting an account is brute-force limited like any other password check', async () => {
  const parent = await H.newParent();
  for (let i = 0; i < 5; i++) assert.equal((await parent.c.del('/api/me', { password: 'guess' + i })).status, 403);
  const locked = await parent.c.del('/api/me', { password: parent.password });
  assert.equal(locked.status, 429);
  assert.equal((await parent.c.get('/api/me')).status, 200);
});

// ───────────────────────── onboarding ─────────────────────────

test('the onboarding checklist notices chores and house rules', async () => {
  const parent = await H.newParent();
  const kid = await H.newKid(parent);
  const check = async () => (await parent.c.get('/api/parent/overview')).body.onboarding;
  assert.deepEqual(await check(), { funds: false, kid: true, allowance: false, chore: false, rules: false });
  await parent.c.post('/api/chores', { kidId: kid.id, title: 'Dishes', emoji: '🍽️', rewardCents: 200, repeat: 'once' });
  await parent.c.put('/api/rules', { rules: ['Be kind'] });
  const after = await check();
  assert.equal(after.chore, true);
  assert.equal(after.rules, true);
});

// ───────────────────────── migrations ─────────────────────────

test('a version-2 database (as deployed before this update) upgrades to version 3 and keeps its data', async () => {
  const file = `file:${join(mkdtempSync(join(tmpdir(), 'nestly-v2-')), 'v2.db')}`;
  const legacy = createClient({ url: file });
  await legacy.executeMultiple(SCHEMA);
  await legacy.execute('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const sql of MIGRATIONS.find((m) => m.version === 2).statements) await legacy.execute(sql);
  await legacy.execute("INSERT INTO schema_migrations VALUES (2, 'v2', '2026-10-01T00:00:00Z')");
  await legacy.execute("INSERT INTO users (role, name, email, password_hash, created_at) VALUES ('parent', 'Old', 'old@example.com', 'x', '2026-01-01T00:00:00Z')");
  await legacy.execute("INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES ('abc', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z')");
  legacy.close();

  for (let round = 0; round < 2; round++) {
    const db = new Db(createClient({ url: file }));
    await db.ensureReady();
    assert.deepEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version), [2, 3]);
    assert.equal((await db.get('SELECT device FROM sessions WHERE token_hash = ?', ['abc'])).device, null, 'old sessions survive with no device name');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n, 1);
    for (const table of ['lesson_attempts', 'kudos', 'house_rules']) assert.ok(await db.get('SELECT 1 AS x FROM sqlite_master WHERE name = ?', [table]), table);
    await db.close();
  }
});
