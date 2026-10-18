import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

export const DAY = 24 * 60 * 60 * 1000;

/** Minimal cookie-keeping JSON client. */
export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
  }
  async call(method, path, body, headers = {}) {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set[0].split(';')[0].endsWith('=') ? null : set[0].split(';')[0];
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, body: json, headers: res.headers, raw };
  }
  get = (p) => this.call('GET', p);
  post = (p, b = {}) => this.call('POST', p, b);
  put = (p, b = {}) => this.call('PUT', p, b);
  patch = (p, b = {}) => this.call('PATCH', p, b);
  del = (p, b = {}) => this.call('DELETE', p, b);
}

/** A running app on a fresh database file with a controllable clock, plus the usual account helpers. */
export async function makeHarness({ dbUrl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nestly-feat-'));
  const url = dbUrl ?? `file:${join(dir, 'db.sqlite')}`;
  const START = new Date('2026-10-11T12:00:00Z'); // a Sunday
  let now = START;
  const clock = () => now;
  const app = createApp({ dbUrl: url, clock });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let seq = 0;

  const h = {
    app,
    base,
    url,
    clock,
    advance: (ms) => (now = new Date(now.getTime() + ms)),
    setNow: (d) => (now = new Date(d)),
    reset: () => (now = START),
    client: () => new Client(base),
    close: () => app.close(),
    async newParent(name = 'Sam') {
      const c = new Client(base);
      const email = `p${++seq}-${Math.random().toString(36).slice(2)}@example.com`;
      const r = await c.post('/api/auth/register', { name, email, password: 'correct-horse-battery', timezone: 'UTC' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { c, user: r.body.user, role: 'parent', identifier: email, password: 'correct-horse-battery' };
    },
    async newKid(parent, name = 'Mia') {
      const username = `kid${++seq}x${Math.random().toString(36).slice(2, 6)}`;
      const r = await parent.c.post('/api/kids', { name, username, password: '123456', avatar: '🦊', color: 'blue' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const kc = new Client(base);
      const login = await kc.post('/api/auth/login', { role: 'kid', identifier: username, password: '123456' });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      return { id: r.body.id, c: kc, username, name, role: 'kid', identifier: username, password: '123456' };
    },
    /** Sessions last 7 days, so after a big clock jump an account has to sign in again. */
    async relogin(...accounts) {
      for (const a of accounts) {
        a.c = new Client(base);
        const r = await a.c.post('/api/auth/login', { role: a.role, identifier: a.identifier, password: a.password });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
    },
    fund: (parent, cents) => parent.c.post('/api/parent/funds', { amountCents: cents }),
    /** Every balance equals the sum of the ledger rows that touch it (goal purchases don't move the balance). */
    async assertLedgerBalanced() {
      const rows = await app.db.all(
        `SELECT u.id, u.balance_cents AS bal,
           COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.user_id = u.id AND t.kind != 'goal_purchase'), 0) AS ledger
         FROM users u`,
      );
      for (const r of rows) assert.equal(r.bal, r.ledger, `user ${r.id}: balance ${r.bal} != ledger ${r.ledger}`);
    },
  };
  return h;
}
