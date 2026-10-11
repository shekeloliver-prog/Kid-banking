import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './util.js';

const scrypt = promisify(scryptCb);
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

export function createSession(db, userId, now = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now.toISOString(),
    now.toISOString(),
    expires,
  );
  return { token, expires };
}

export function lookupSession(db, token, now = new Date()) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha256(token);
  const row = db
    .prepare(
      `SELECT u.*, s.last_seen AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hash, now.toISOString());
  if (!row) return null;
  // Slide the expiry forward, but only write to the database about once an hour.
  if (now.getTime() - new Date(row.session_last_seen).getTime() > 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(
      now.toISOString(),
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      hash,
    );
  }
  return row;
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function destroyUserSessions(db, userId, exceptToken) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function purgeExpiredSessions(db, now = new Date()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
}

/** Fixed-window failure counter with a lockout, keyed by whatever string you give it. */
export class AttemptLimiter {
  constructor({ max = 5, lockMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.lockMs = lockMs;
    this.now = now;
    this.entries = new Map();
  }

  assertAllowed(key) {
    const e = this.entries.get(key);
    if (e && e.lockedUntil > this.now()) {
      const mins = Math.max(1, Math.ceil((e.lockedUntil - this.now()) / 60000));
      throw new HttpError(429, 'too_many_attempts', `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  fail(key) {
    if (this.entries.size > 5000) this.prune();
    const e = this.entries.get(key) ?? { count: 0, lockedUntil: 0 };
    if (e.lockedUntil && e.lockedUntil <= this.now()) {
      e.count = 0;
      e.lockedUntil = 0;
    }
    e.count += 1;
    if (e.count >= this.max) e.lockedUntil = this.now() + this.lockMs;
    this.entries.set(key, e);
  }

  reset(key) {
    this.entries.delete(key);
  }

  prune() {
    for (const [k, e] of this.entries) if (e.lockedUntil <= this.now()) this.entries.delete(k);
  }
}
