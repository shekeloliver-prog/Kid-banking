import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './util.js';

const scryptRaw = promisify(scryptCb);

// scrypt runs on libuv's small thread pool, which static file serving shares. Cap how many hashes run at
// once (and how many may queue) so a flood of logins can't starve the whole server.
const MAX_HASHING = 2;
const MAX_WAITING = 64;
let hashing = 0;
const waiting = [];
async function scrypt(...args) {
  if (hashing >= MAX_HASHING) {
    if (waiting.length >= MAX_WAITING) throw new HttpError(503, 'busy', 'Nestly is busy right now. Please try again in a moment.');
    await new Promise((resolve) => waiting.push(resolve)); // the finishing job hands its slot straight to us
  } else {
    hashing++;
  }
  try {
    return await scryptRaw(...args);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else hashing--;
  }
}
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export const SESSION_COOKIE = 'nestly_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// Verified against when the account doesn't exist, so response time doesn't reveal which logins are real.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function createSession(db, userId, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)', [
    sha256(token),
    userId,
    now.toISOString(),
    now.toISOString(),
    expires,
  ]);
  return { token, expires };
}

export async function lookupSession(db, token, now = new Date()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha256(token);
  const row = await db.get(
    `SELECT u.*, s.last_seen AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [hash, now.toISOString()],
  );
  if (!row) return null;
  // Slide the expiry forward, but only write to the database about once an hour.
  if (now.getTime() - new Date(row.session_last_seen).getTime() > 60 * 60 * 1000) {
    await db.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?', [
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      hash,
    ]);
  }
  return row;
}

export async function destroySession(db, token) {
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export async function destroyUserSessions(db, userId, exceptToken) {
  if (exceptToken) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, sha256(exceptToken)]);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export async function purgeExpiredSessions(db, now = new Date()) {
  await db.run('DELETE FROM sessions WHERE expires_at <= ?', [now.toISOString()]);
  // Rate-limit rows are tiny but would otherwise pile up forever.
  await db.run('DELETE FROM rate_limits WHERE locked_until < ? AND updated_at < ?', [now.getTime(), now.getTime() - 24 * 60 * 60 * 1000]);
}

/**
 * Failure counter with a lockout, keyed by whatever string you give it. Stored in the database so it holds
 * across serverless instances and restarts.
 *
 * Use reserve() BEFORE the slow password check: it checks and counts the attempt in one transaction, so a burst
 * of parallel guesses can't all pass the check first. Then reset() on success (or release() for shared keys
 * like an IP address, to give the attempt back).
 */
export class AttemptLimiter {
  constructor(db, { name, max = 5, lockMs = 5 * 60 * 1000, windowMs = lockMs, now = () => Date.now() }) {
    Object.assign(this, { db, name, max, lockMs, windowMs, now });
  }

  #k(key) {
    return `${this.name}:${key}`;
  }

  /** Throws 429 if any of these (already-prefixed) keys is currently locked. A plain read: no transaction, no queue. */
  static async assertNotLocked(db, entries, now) {
    const rows = await db.all(
      `SELECT locked_until FROM rate_limits WHERE key IN (${entries.map(() => '?').join(',')}) AND locked_until > ?`,
      [...entries, now],
    );
    if (rows.length) {
      const until = Math.max(...rows.map((r) => r.locked_until));
      const mins = Math.max(1, Math.ceil((until - now) / 60000));
      throw new HttpError(429, 'too_many_attempts', `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  async reserve(key) {
    await AttemptLimiter.reserveMany(this.db, [[this, key]]);
  }

  /**
   * Check-and-count several (limiter, key) pairs together. Locked keys are rejected with a cheap read first, so a
   * flood of blocked requests never queues for a write transaction; admitted attempts are then re-checked and
   * counted inside one transaction so parallel guesses can't race past a limit.
   */
  static async reserveMany(db, pairs) {
    const now = pairs[0][0].now();
    await AttemptLimiter.assertNotLocked(db, pairs.map(([l, k]) => `${l.name}:${k}`), now);
    await db.atomic(async () => {
      for (const [limiter, key] of pairs) await limiter.#reserveInTx(key);
    });
  }

  async #reserveInTx(key) {
    const k = this.#k(key);
    const now = this.now();
    const row = await this.db.get('SELECT count, locked_until, updated_at FROM rate_limits WHERE key = ?', [k]);
    if (row && row.locked_until > now) {
      const mins = Math.max(1, Math.ceil((row.locked_until - now) / 60000));
      throw new HttpError(429, 'too_many_attempts', `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    // A finished lock, or a count that has sat idle past the window, starts over.
    const stale = row && ((row.locked_until && row.locked_until <= now) || now - row.updated_at > this.windowMs);
    const count = (row && !stale ? row.count : 0) + 1;
    await this.db.run(
      `INSERT INTO rate_limits (key, count, locked_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, updated_at = excluded.updated_at`,
      [k, count, count >= this.max ? now + this.lockMs : 0, now],
    );
  }

  async release(key) {
    await this.db.run(
      'UPDATE rate_limits SET count = MAX(0, count - 1) WHERE key = ? AND locked_until <= ?',
      [this.#k(key), this.now()],
    );
  }

  async reset(key) {
    await this.db.run('DELETE FROM rate_limits WHERE key = ?', [this.#k(key)]);
  }

  /** Forget everything this limiter knows (used by tests). */
  async clear() {
    await this.db.run('DELETE FROM rate_limits WHERE key LIKE ?', [`${this.name}:%`]);
  }
}

/**
 * Rate-limit key for a client address. IPv6 users usually control a whole /64, so every address in it shares one
 * bucket (otherwise one person has billions of buckets). IPv4 and IPv4-mapped addresses are used as-is.
 */
export function ipKey(ip) {
  const addr = String(ip).split('%')[0].toLowerCase();
  if (!addr.includes(':')) return addr;
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return addr;
  return 'v6:' + groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':');
}
