import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nestly-test-'));
let dbCount = 0;
const freshDb = () => `file:${join(dir, `t${++dbCount}.db`)}`;
let app;
let base;
let now;
const clock = () => now;
const advance = (ms) => (now = new Date(now.getTime() + ms));
const DAY = 24 * 60 * 60 * 1000;

class Client {
  constructor() {
    this.cookie = null;
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      const pair = setCookie[0].split(';')[0];
      this.cookie = pair.endsWith('=') ? null : pair;
    }
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* html etc. */
    }
    return { status: res.status, body: json, headers: res.headers, raw };
  }
  get = (p) => this.call('GET', p);
  post = (p, b = {}) => this.call('POST', p, b);
  put = (p, b = {}) => this.call('PUT', p, b);
  patch = (p, b = {}) => this.call('PATCH', p, b);
  del = (p, b = {}) => this.call('DELETE', p, b);
}

let seq = 0;
async function newParent(name = 'Sam') {
  const c = new Client();
  const r = await c.post('/api/auth/register', {
    name,
    email: `parent${++seq}@example.com`,
    password: 'correct-horse-battery',
    timezone: 'UTC',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { c, user: r.body.user };
}

async function newKid(parent, name = 'Mia', username = `kid${++seq}`) {
  const r = await parent.c.post('/api/kids', { name, username, password: '123456', avatar: '🦊', color: 'blue' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const kc = new Client();
  const login = await kc.post('/api/auth/login', { role: 'kid', identifier: username, password: '123456' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { id: r.body.id, c: kc, username };
}

const fund = (parent, amountCents) => parent.c.post('/api/parent/funds', { amountCents });

// The database is shared between tests, so only look at payouts for the kid under test.
const payOut = async (kid) => (await app.bank.runAllowances()).filter((p) => p.kidId === kid.id);
// Sessions last 7 days, so after a big time jump a kid has to log in again.
async function relogin(kid) {
  kid.c = new Client();
  const r = await kid.c.post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '123456' });
  assert.equal(r.status, 200);
}

before(async () => {
  now = new Date('2026-10-11T12:00:00Z'); // a Sunday
  app = createApp({ dbUrl: freshDb(), clock });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());
beforeEach(async () => {
  now = new Date('2026-10-11T12:00:00Z');
  for (const l of Object.values(app.limiters)) await l.clear();
});

/** Every balance must equal the sum of the ledger rows that touch it. */
async function assertLedgerBalanced() {
  const rows = await app.db.all(
    `SELECT u.id, u.balance_cents AS bal,
       COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.user_id = u.id AND t.kind != 'goal_purchase'), 0) AS ledger
     FROM users u`,
  );
  for (const r of rows) assert.equal(r.bal, r.ledger, `user ${r.id} balance ${r.bal} != ledger ${r.ledger}`);
}

// ───────────────────────── auth ─────────────────────────

test('parents can register, log out, and log back in', async () => {
  const { c, user } = await newParent();
  assert.equal(user.role, 'parent');
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
  const again = await c.post('/api/auth/login', { role: 'parent', identifier: `parent${seq}@example.com`.toUpperCase(), password: 'correct-horse-battery' });
  assert.equal(again.status, 200);
});

test('the session probe is public and reports who is signed in', async () => {
  const anon = new Client();
  const none = await anon.get('/api/session');
  assert.equal(none.status, 200);
  assert.equal(none.body.user, null);
  const { c, user } = await newParent();
  const me = await c.get('/api/session');
  assert.equal(me.body.user.id, user.id);
  assert.equal(me.body.pending, 0);
});

test('names with markup are stored as plain text and never executed server-side', async () => {
  const parent = await newParent('<img src=x onerror=alert(1)>');
  const kid = await newKid(parent, '<script>alert(1)</script>');
  const detail = (await parent.c.get(`/api/kids/${kid.id}`)).body;
  assert.equal(detail.kid.name, '<script>alert(1)</script>'); // returned as data; the client renders text nodes only
  const res = await parent.c.get('/api/me');
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('registration validates input and rejects duplicate emails', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/register', { name: 'A', email: 'nope', password: 'longenough1' })).status, 400);
  assert.equal((await c.post('/api/auth/register', { name: 'A', email: 'a@b.co', password: 'short' })).status, 400);
  const first = await c.post('/api/auth/register', { name: 'A', email: 'dupe@example.com', password: 'longenough1' });
  assert.equal(first.status, 200);
  const second = await new Client().post('/api/auth/register', { name: 'B', email: 'DUPE@example.com', password: 'longenough1' });
  assert.equal(second.status, 409);
});

test('session cookie is HttpOnly + SameSite and no password hash leaks', async () => {
  const c = new Client();
  const r = await c.post('/api/auth/register', { name: 'Cookie', email: 'cookie@example.com', password: 'longenough1' });
  const header = r.headers.getSetCookie()[0];
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.doesNotMatch(r.raw, /scrypt|password_hash/);
});

test('wrong passwords fail generically, and repeated failures lock the account', async () => {
  const { c } = await newParent();
  const email = `parent${seq}@example.com`;
  const fresh = new Client();
  for (let i = 0; i < 5; i++) {
    const r = await fresh.post('/api/auth/login', { role: 'parent', identifier: email, password: 'wrong-password' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.message, 'Incorrect email or password.');
  }
  const locked = await fresh.post('/api/auth/login', { role: 'parent', identifier: email, password: 'correct-horse-battery' });
  assert.equal(locked.status, 429);
  const unknown = await new Client().post('/api/auth/login', { role: 'parent', identifier: 'ghost@example.com', password: 'whatever12' });
  assert.equal(unknown.body.error.message, 'Incorrect email or password.');
  void c;
});

test('kids log in with their own role and cannot use parent routes', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  assert.equal((await kid.c.get('/api/kid/overview')).status, 200);
  assert.equal((await kid.c.get('/api/parent/overview')).status, 403);
  assert.equal((await kid.c.post('/api/parent/funds', { amountCents: 1000 })).status, 403);
  assert.equal((await kid.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1000 })).status, 403);
  assert.equal((await parent.c.get('/api/kid/overview')).status, 403);
  // A kid username can't be used on the parent login and vice versa.
  const wrongTab = await new Client().post('/api/auth/login', { role: 'parent', identifier: kid.username, password: '123456' });
  assert.equal(wrongTab.status, 401);
});

test('changing a password signs out other sessions', async () => {
  const { c } = await newParent();
  const email = `parent${seq}@example.com`;
  const other = new Client();
  await other.post('/api/auth/login', { role: 'parent', identifier: email, password: 'correct-horse-battery' });
  assert.equal((await c.post('/api/auth/password', { current: 'wrong-one-here', next: 'a-brand-new-pass' })).status, 403);
  assert.equal((await c.post('/api/auth/password', { current: 'correct-horse-battery', next: 'a-brand-new-pass' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
});

// ───────────────────────── security ─────────────────────────

test('cross-origin writes and non-JSON bodies are rejected', async () => {
  const { c } = await newParent();
  const cross = await c.call('POST', '/api/parent/funds', { amountCents: 1000 }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const siteHeader = await c.call('POST', '/api/parent/funds', { amountCents: 1000 }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(siteHeader.status, 403);
  const form = await fetch(base + '/api/parent/funds', {
    method: 'POST',
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'amountCents=1000',
  });
  assert.equal(form.status, 415);
  assert.equal((await c.get('/api/parent/overview')).body.balanceCents, 0);
});

test('static files are served with security headers and cannot escape the public dir', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(traversal.status, 200);
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ createConnection }) => {
      const s = createConnection(app.server.address().port, '127.0.0.1');
      let data = '';
      s.on('data', (d) => (data += d));
      s.on('close', () => resolve(data));
      s.write('GET /../../package.json HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
  });
  assert.doesNotMatch(raw, /"name": "nestly"/);
});

// ───────────────────────── money ─────────────────────────

test('parent funds, sends and takes back money; the books balance', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  assert.equal((await fund(parent, 20000)).body.balanceCents, 20000);
  const sent = await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 7500, note: 'For the book fair' });
  assert.deepEqual([sent.body.balanceCents, sent.body.kidBalanceCents], [12500, 7500]);
  const back = await parent.c.post(`/api/kids/${kid.id}/take`, { amountCents: 2500 });
  assert.deepEqual([back.body.balanceCents, back.body.kidBalanceCents], [15000, 5000]);
  await assertLedgerBalanced();
  const kidView = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(kidView.kid.balanceCents, 5000);
  assert.equal(kidView.recent[0].kind, 'takeback_out');
  assert.equal(kidView.recent[1].kind, 'receive');
  assert.equal(kidView.recent[1].note, 'For the book fair');
});

test('amounts are validated and overdrafts are refused', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 1000);
  for (const bad of [0, -5, 1.5, '10', null, 1e9, NaN]) {
    const r = await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: bad });
    assert.equal(r.status, 400, `amount ${bad}`);
  }
  const over = await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1001 });
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, 'insufficient_funds');
  assert.equal((await fund(parent, 50001)).status, 400); // above the per-deposit practice cap
  const takeTooMuch = await parent.c.post(`/api/kids/${kid.id}/take`, { amountCents: 100 });
  assert.equal(takeTooMuch.body.error.code, 'insufficient_funds');
  await assertLedgerBalanced();
});

test("a parent can never touch another family's kid", async () => {
  const a = await newParent('A');
  const b = await newParent('B');
  const kidB = await newKid(b);
  await fund(a, 5000);
  for (const [method, path, body] of [
    ['GET', `/api/kids/${kidB.id}`],
    ['POST', `/api/kids/${kidB.id}/send`, { amountCents: 100 }],
    ['POST', `/api/kids/${kidB.id}/take`, { amountCents: 100 }],
    ['PUT', `/api/kids/${kidB.id}/controls`, { frozen: true }],
    ['PATCH', `/api/kids/${kidB.id}`, { name: 'Hacked', avatar: '🦊', color: 'red' }],
    ['POST', `/api/kids/${kidB.id}/password`, { password: 'hacked1' }],
    ['DELETE', `/api/kids/${kidB.id}`, { password: 'correct-horse-battery' }],
    ['GET', `/api/activity?kid=${kidB.id}`],
  ]) {
    const r = await a.c.call(method, path, body);
    assert.equal(r.status, 404, `${method} ${path} -> ${r.status}`);
  }
  // …and B's kid is untouched.
  assert.equal((await kidB.c.get('/api/kid/overview')).body.kid.name, 'Mia');
});

test('concurrent sends cannot overdraw the parent', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 10000);
  const results = await Promise.all(Array.from({ length: 12 }, () => parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 2000 })));
  assert.equal(results.filter((r) => r.status === 200).length, 5);
  assert.equal((await parent.c.get('/api/parent/overview')).body.balanceCents, 0);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 10000);
  await assertLedgerBalanced();
});

// ───────────────────────── parental controls ─────────────────────────

test('weekly spending limit blocks overspending and rolls off after 7 days', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 20000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 10000 });
  const set = await parent.c.put(`/api/kids/${kid.id}/controls`, { weeklyLimitCents: 2000 });
  assert.equal(set.body.weeklyLimitCents, 2000);

  assert.equal((await kid.c.post('/api/kid/spend', { amountCents: 1500, category: 'toys' })).status, 200);
  const over = await kid.c.post('/api/kid/spend', { amountCents: 600, category: 'food' });
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, 'over_limit');
  assert.equal(over.body.error.remainingCents, 500);
  assert.equal((await kid.c.post('/api/kid/spend', { amountCents: 500, category: 'food' })).status, 200);
  assert.equal((await kid.c.post('/api/kid/spend', { amountCents: 1, category: 'food' })).body.error.code, 'over_limit');

  const view = (await kid.c.get('/api/kid/overview')).body.kid;
  assert.equal(view.spent7dCents, 2000);
  assert.ok(view.freesUpAt);

  advance(7 * DAY + 60_000);
  await relogin(kid);
  assert.equal((await kid.c.post('/api/kid/spend', { amountCents: 1000, category: 'games' })).status, 200);
  await assertLedgerBalanced();
});

test('freezing an account blocks spending but not saving or asking', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 5000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 3000 });
  await parent.c.put(`/api/kids/${kid.id}/controls`, { frozen: true });
  const blocked = await kid.c.post('/api/kid/spend', { amountCents: 100, category: 'toys' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'frozen');
  const goal = await kid.c.post('/api/kid/goals', { name: 'Skateboard', emoji: '🛹', targetCents: 2000 });
  assert.equal((await kid.c.post(`/api/kid/goals/${goal.body.id}/save`, { amountCents: 2000 })).status, 200);
  assert.equal((await kid.c.post(`/api/kid/goals/${goal.body.id}/purchase`)).body.error.code, 'frozen');
  assert.equal((await kid.c.post('/api/kid/requests', { amountCents: 500, reason: 'Snack' })).status, 200);
  await parent.c.put(`/api/kids/${kid.id}/controls`, { frozen: false });
  assert.equal((await kid.c.post(`/api/kid/goals/${goal.body.id}/purchase`)).status, 200);
  await assertLedgerBalanced();
});

test('control input is validated', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  const url = `/api/kids/${kid.id}/controls`;
  assert.equal((await parent.c.put(url, { weeklyLimitCents: 5 })).status, 400);
  assert.equal((await parent.c.put(url, { frozen: 'yes' })).status, 400);
  assert.equal((await parent.c.put(url, { allowance: { cents: 500, freq: 'daily', day: 1, active: true } })).status, 400);
  assert.equal((await parent.c.put(url, { allowance: { cents: 500, freq: 'monthly', day: 31, active: true } })).status, 400);
  assert.equal((await parent.c.put(url, { allowance: { cents: 500, freq: 'weekly', day: 7, active: true } })).status, 400);
  assert.equal((await parent.c.put(url, { allowance: { cents: 10, freq: 'weekly', day: 1, active: true } })).status, 400);
  assert.equal((await parent.c.put(url, { weeklyLimitCents: null })).status, 200);
});

// ───────────────────────── requests ─────────────────────────

test('kids can ask for money; parents approve or decline within the cap', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 5000);
  await parent.c.put(`/api/kids/${kid.id}/controls`, { maxRequestCents: 1500 });

  assert.equal((await kid.c.post('/api/kid/requests', { amountCents: 2000, reason: 'Too much' })).body.error.code, 'over_cap');
  const r1 = await kid.c.post('/api/kid/requests', { amountCents: 1000, reason: 'Movie night' });
  const r2 = await kid.c.post('/api/kid/requests', { amountCents: 500, reason: 'Candy' });
  assert.equal((await parent.c.get('/api/parent/overview')).body.pendingRequests.length, 2);

  const ok = await parent.c.post(`/api/requests/${r1.body.id}/approve`, { note: 'Have fun!' });
  assert.equal(ok.body.balanceCents, 4000);
  assert.equal((await parent.c.post(`/api/requests/${r1.body.id}/approve`)).status, 409); // no double pay
  assert.equal((await parent.c.post(`/api/requests/${r2.body.id}/decline`, { note: 'Not before dinner' })).status, 200);
  assert.equal((await parent.c.post(`/api/requests/${r2.body.id}/approve`)).status, 409);

  const view = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(view.kid.balanceCents, 1000);
  assert.deepEqual(view.requests.map((r) => r.status).sort(), ['approved', 'declined']);
  await assertLedgerBalanced();
});

test('approving a request needs enough funds and leaves the request pending', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  const req = await kid.c.post('/api/kid/requests', { amountCents: 1000, reason: 'Lego' });
  const r = await parent.c.post(`/api/requests/${req.body.id}/approve`);
  assert.equal(r.body.error.code, 'insufficient_funds');
  assert.equal((await parent.c.get('/api/parent/overview')).body.pendingRequests.length, 1);
  const stranger = await newParent('Stranger');
  assert.equal((await stranger.c.post(`/api/requests/${req.body.id}/decline`)).status, 404);
});

// ───────────────────────── allowance ─────────────────────────

test('allowance pays on schedule, exactly once per period', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 30000);
  // "now" is Sunday 2026-10-11. Pay every Friday.
  const set = await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 1000, freq: 'weekly', day: 5, active: true } });
  assert.equal(set.body.allowance.next, '2026-10-16');

  assert.deepEqual(await payOut(kid), []);
  advance(4 * DAY); // Thursday
  assert.deepEqual(await payOut(kid), []);
  advance(1 * DAY); // Friday
  assert.equal((await payOut(kid)).length, 1);
  assert.equal((await payOut(kid)).length, 0); // running again is a no-op
  await relogin(kid);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 1000);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.allowance.next, '2026-10-23');

  advance(7 * DAY);
  assert.equal((await payOut(kid)).length, 1);
  await relogin(kid);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 2000);
  await assertLedgerBalanced();
});

test('a long outage pays one allowance, not a backlog', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 30000);
  await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 500, freq: 'weekly', day: 5, active: true } });
  advance(30 * DAY);
  assert.equal((await payOut(kid)).length, 1);
  assert.equal((await payOut(kid)).length, 0);
  await relogin(kid);
  const next = (await kid.c.get('/api/kid/overview')).body.kid.allowance.next;
  assert.ok(next > '2026-11-10', next);
});

test('allowance waits for funds, warns the parent once, then pays', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 1000, freq: 'weekly', day: 5, active: true } });
  advance(5 * DAY);
  assert.equal((await payOut(kid)).length, 0);
  await payOut(kid);
  await payOut(kid);
  const warnings = (await parent.c.get('/api/notifications')).body.items.filter((n) => n.title.includes('allowance is waiting'));
  assert.equal(warnings.length, 1);
  await fund(parent, 5000);
  assert.equal((await payOut(kid)).length, 1);
  assert.equal((await kid.c.get('/api/kid/overview')).body.kid.balanceCents, 1000);
  await assertLedgerBalanced();
});

test('monthly and biweekly schedules are computed correctly', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  const monthly = await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 2000, freq: 'monthly', day: 1, active: true } });
  assert.equal(monthly.body.allowance.next, '2026-11-01');
  const biweekly = await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 2000, freq: 'biweekly', day: 1, active: true } });
  assert.equal(biweekly.body.allowance.next, '2026-10-12');
  const off = await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 2000, freq: 'biweekly', day: 1, active: false } });
  assert.equal(off.body.allowance.next, null);
});

// ───────────────────────── goals ─────────────────────────

test('savings goals: save, withdraw, hit the target, buy it', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 20000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 8000 });
  const goal = (await kid.c.post('/api/kid/goals', { name: 'New bike', emoji: '🚲', targetCents: 6000 })).body.id;

  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 7000 })).body.error.code, 'over_target');
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/purchase`)).body.error.code, 'not_funded');
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 4000 })).body.reached, false);
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/withdraw`, { amountCents: 1000 })).status, 200);
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/withdraw`, { amountCents: 9999 })).body.error.code, 'insufficient_funds');
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 3000 })).body.reached, true);

  let view = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(view.kid.balanceCents, 2000);
  assert.equal(view.kid.savedCents, 6000);
  assert.equal((await parent.c.get(`/api/kids/${kid.id}`)).body.kid.savedCents, 6000);

  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/purchase`)).status, 200);
  view = (await kid.c.get('/api/kid/overview')).body;
  assert.equal(view.kid.savedCents, 0);
  assert.equal(view.kid.balanceCents, 2000);
  assert.equal(view.goals[0].status, 'purchased');
  assert.equal((await kid.c.post(`/api/kid/goals/${goal}/purchase`)).status, 400); // can't buy twice
  const note = (await parent.c.get('/api/notifications')).body.items.find((n) => n.title.includes('bought'));
  assert.ok(note);
  await assertLedgerBalanced();
});

test("kids can't touch each other's goals", async () => {
  const parent = await newParent();
  const mia = await newKid(parent, 'Mia');
  const leo = await newKid(parent, 'Leo');
  const goal = (await mia.c.post('/api/kid/goals', { name: 'Secret', emoji: '🎯', targetCents: 1000 })).body.id;
  assert.equal((await leo.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 100 })).status, 404);
  assert.equal((await leo.c.del(`/api/kid/goals/${goal}`)).status, 404);
});

// ───────────────────────── account management ─────────────────────────

test('removing a kid needs the parent password and returns all their money', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 10000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 6000 });
  const goal = (await kid.c.post('/api/kid/goals', { name: 'Drone', emoji: '🎯', targetCents: 5000 })).body.id;
  await kid.c.post(`/api/kid/goals/${goal}/save`, { amountCents: 2000 });

  assert.equal((await parent.c.del(`/api/kids/${kid.id}`, { password: 'nope-nope-nope' })).status, 403);
  const removed = await parent.c.del(`/api/kids/${kid.id}`, { password: 'correct-horse-battery' });
  assert.equal(removed.body.returnedCents, 6000);
  const overview = (await parent.c.get('/api/parent/overview')).body;
  assert.equal(overview.balanceCents, 10000);
  assert.equal(overview.kids.length, 0);
  assert.equal((await kid.c.get('/api/kid/overview')).status, 401); // their session is gone
  assert.equal((await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '123456' })).status, 401);
  await assertLedgerBalanced();
});

test('resetting a PIN signs the kid out and the new PIN works', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/password`, { password: '12345' })).status, 400); // PINs are at least 6 characters
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/password`, { password: '987654' })).status, 200);
  assert.equal((await kid.c.get('/api/kid/overview')).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '123456' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '987654' })).status, 200);
});

test('usernames are unique and validated', async () => {
  const a = await newParent();
  const b = await newParent();
  await newKid(a, 'Mia', 'sparkle_mia');
  const dupe = await b.c.post('/api/kids', { name: 'Other', username: 'SPARKLE_MIA', password: '123456' });
  assert.equal(dupe.status, 409);
  assert.equal((await b.c.post('/api/kids', { name: 'X', username: 'a b', password: '123456' })).status, 400);
  assert.equal((await b.c.post('/api/kids', { name: 'X', username: 'okname', password: '12345' })).status, 400);
  assert.equal((await b.c.post('/api/kids', { name: 'X', username: 'okname', password: '123456', avatar: '<script>' })).status, 400);
});

// ───────────────────────── activity + notifications ─────────────────────────

test('family activity lists each event once and paginates', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 20000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 5000 });
  for (let i = 0; i < 4; i++) await kid.c.post('/api/kid/spend', { amountCents: 100, category: 'food' });

  const all = (await parent.c.get('/api/activity?limit=100')).body;
  assert.deepEqual(
    all.items.map((t) => t.kind),
    ['spend', 'spend', 'spend', 'spend', 'send', 'deposit'],
  );
  const page1 = (await parent.c.get('/api/activity?limit=2')).body;
  assert.equal(page1.items.length, 2);
  const page2 = (await parent.c.get(`/api/activity?limit=100&before=${page1.nextBefore}`)).body;
  assert.equal(page2.items.length, 4);
  const forKid = (await parent.c.get(`/api/activity?kid=${kid.id}&limit=100`)).body;
  assert.equal(forKid.items.length, 5); // 4 spends + the transfer
});

test('notifications reach the right person and can be marked read', async () => {
  const parent = await newParent();
  const kid = await newKid(parent);
  await fund(parent, 5000);
  await parent.c.post(`/api/kids/${kid.id}/send`, { amountCents: 1200, note: 'Good job!' });
  await kid.c.post('/api/kid/requests', { amountCents: 300, reason: 'Stickers' });

  const kidN = (await kid.c.get('/api/notifications')).body;
  assert.ok(kidN.items.some((n) => n.title.includes('sent you $12.00')));
  assert.ok(kidN.unread >= 2);
  const parentN = (await parent.c.get('/api/notifications')).body;
  assert.ok(parentN.items.some((n) => n.title.includes('asked for $3.00')));
  assert.ok(!parentN.items.some((n) => n.title.includes('sent you')));

  await kid.c.post('/api/notifications/read');
  assert.equal((await kid.c.get('/api/notifications')).body.unread, 0);
  assert.ok((await parent.c.get('/api/notifications')).body.unread > 0);
});

// ───────────────────────── behind a proxy (e.g. Render) ─────────────────────────

test('behind a TLS proxy: cookies are Secure, and rotating X-Forwarded-For cannot dodge login lockout', async () => {
  const proxied = createApp({ dbUrl: freshDb(), clock, trustProxy: true });
  await new Promise((r) => proxied.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxied.server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const reg = await post('/api/auth/register', { name: 'P', email: 'proxy@example.com', password: 'correct-horse-battery' }, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.1' });
    assert.equal(reg.status, 200);
    assert.match(reg.headers.getSetCookie()[0], /; Secure/);
    // Plain HTTP (no proxy header) must not get a Secure cookie it could never send back.
    const plain = await post('/api/auth/login', { role: 'parent', identifier: 'proxy@example.com', password: 'correct-horse-battery' }, { 'x-forwarded-for': '203.0.113.2' });
    assert.doesNotMatch(plain.headers.getSetCookie()[0], /Secure/);

    let locked = false;
    for (let i = 0; i < 14; i++) {
      const r = await post('/api/auth/login', { role: 'parent', identifier: 'proxy@example.com', password: 'wrong-wrong-wrong' }, { 'x-forwarded-for': `198.51.100.${i}` });
      if (r.status === 429) locked = true;
    }
    assert.ok(locked, 'account locked despite a different client IP on every attempt');
    const right = await post('/api/auth/login', { role: 'parent', identifier: 'proxy@example.com', password: 'correct-horse-battery' }, { 'x-forwarded-for': '198.51.100.250' });
    assert.equal(right.status, 429);
  } finally {
    await proxied.close();
  }
});

// ───────────────────────── hardening from the pre-deploy review ─────────────────────────

test('a burst of parallel guesses cannot slip past the lockout', async () => {
  const parent = await newParent();
  const kid = await newKid(parent, 'Mia', `racer${++seq}`);
  await app.bank.getUser(kid.id);
  // The real PIN is 123456; fire 400 guesses at once, with the correct one buried deep in the list.
  const guesses = Array.from({ length: 400 }, (_, i) => String(100000 + i));
  guesses[300] = '123456';
  const results = await Promise.all(
    guesses.map((pin) => new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: pin })),
  );
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  assert.ok((tally[401] ?? 0) <= 5, `only the per-account/IP allowance may be evaluated, got ${JSON.stringify(tally)}`);
  assert.equal(tally[200] ?? 0, 0, 'the buried correct PIN must not get through');
  assert.ok((tally[429] ?? 0) >= 390);
});

test('a successful login gives its attempt back, so normal use never trips the limits', async () => {
  const parent = await newParent();
  const kid = await newKid(parent, 'Zed', `zed${++seq}`);
  for (let i = 0; i < 30; i++) {
    const r = await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '123456' });
    assert.equal(r.status, 200);
  }
});

test('resetting a PIN clears a lockout so a parent can recover a locked-out kid', async () => {
  const parent = await newParent();
  const kid = await newKid(parent, 'Lia', `lia${++seq}`);
  for (let i = 0; i < 10; i++) await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: 'nope-nope' });
  assert.equal((await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '123456' })).status, 429);
  for (const l of Object.values(app.limiters)) if (l !== app.limiters.loginAccount) await l.clear(); // isolate the per-account lock
  assert.equal((await parent.c.post(`/api/kids/${kid.id}/password`, { password: '654321' })).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { role: 'kid', identifier: kid.username, password: '654321' })).status, 200);
});

test('malformed percent-escapes are a clean 4xx, not a 500', async () => {
  const bad = await fetch(base + '/api/session', { headers: { cookie: 'nestly_session=%E0%A4%A' } });
  assert.equal(bad.status, 200);
  assert.equal((await bad.json()).user, null);
  const parent = await newParent();
  const r = await parent.c.get('/api/kids/%E0%A4%A');
  assert.equal(r.status, 400);
});

test('two sign-ups racing for one email produce one account and one clean 409', async () => {
  const body = { name: 'Racer', email: `race${++seq}@example.com`, password: 'correct-horse-battery' };
  const results = await Promise.all([new Client().post('/api/auth/register', body), new Client().post('/api/auth/register', body)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test('only allowances that can be due are loaded each tick', async () => {
  const parent = await newParent();
  const kid = await newKid(parent, 'Dee', `dee${++seq}`);
  await fund(parent, 30000);
  await parent.c.put(`/api/kids/${kid.id}/controls`, { allowance: { cents: 500, freq: 'monthly', day: 1, active: true } });
  const plan = await app.db.all('EXPLAIN QUERY PLAN SELECT * FROM kid_controls c WHERE c.allowance_active = 1 AND c.allowance_next IS NOT NULL AND c.allowance_next <= ?', ['2026-10-12']);
  assert.match(JSON.stringify(plan), /controls_due/);
  assert.equal((await payOut(kid)).length, 0);
});

test('behind a proxy only the entry the proxy added is trusted; client-supplied entries to the left are ignored', async () => {
  const proxied = createApp({ dbUrl: freshDb(), clock, trustProxy: 1 });
  await new Promise((r) => proxied.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${proxied.server.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      // The attacker rotates the leftmost value; the proxy appends the true peer (198.51.100.77) on the right.
      const r = await fetch(url + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}, 198.51.100.77` },
        body: JSON.stringify({ name: 'S', email: `spam${i}@example.com`, password: 'correct-horse-battery' }),
      });
      statuses.push(r.status);
    }
    assert.equal(statuses.filter((s) => s === 200).length, 15);
    assert.equal(statuses.filter((s) => s === 429).length, 5);
  } finally {
    await proxied.close();
  }
});
