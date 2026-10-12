import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// One async interface over libSQL (SQLite). The same code runs against a local file on your laptop or a
// server with a disk, and against a hosted Turso database on serverless/free hosts — the only difference is
// the URL. Money is always integer cents; `users.balance_cents` is the spendable balance and `transactions`
// is the append-only history shown in the UI.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE COLLATE NOCASE,
  username      TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  parent_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  avatar        TEXT NOT NULL DEFAULT '🦊',
  color         TEXT NOT NULL DEFAULT 'violet',
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at    TEXT NOT NULL,
  CHECK (
    (role = 'parent' AND email IS NOT NULL AND parent_id IS NULL) OR
    (role = 'kid' AND username IS NOT NULL AND parent_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS users_parent ON users(parent_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS kid_controls (
  kid_id                   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  frozen                   INTEGER NOT NULL DEFAULT 0,
  weekly_limit_cents       INTEGER,
  max_request_cents        INTEGER,
  allowance_cents          INTEGER NOT NULL DEFAULT 0,
  allowance_freq           TEXT NOT NULL DEFAULT 'weekly' CHECK (allowance_freq IN ('weekly', 'biweekly', 'monthly')),
  allowance_day            INTEGER NOT NULL DEFAULT 5,
  allowance_active         INTEGER NOT NULL DEFAULT 0,
  allowance_next           TEXT,
  allowance_fail_notified  TEXT
);
CREATE INDEX IF NOT EXISTS controls_due ON kid_controls(allowance_next) WHERE allowance_active = 1;

CREATE TABLE IF NOT EXISTS transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  counterparty_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  counterparty_name TEXT,
  note              TEXT,
  category          TEXT,
  goal_id           INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS tx_counterparty ON transactions(counterparty_id, id DESC);

CREATE TABLE IF NOT EXISTS goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  saved_cents  INTEGER NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'purchased', 'cancelled')),
  created_at   TEXT NOT NULL,
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS goals_kid ON goals(kid_id);

CREATE TABLE IF NOT EXISTS money_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  response_note TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS requests_kid ON money_requests(kid_id, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon       TEXT NOT NULL DEFAULT '🔔',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, id DESC);

-- Login throttling lives in the database (not memory) so it holds across serverless instances.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (err) => /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(String(err?.message ?? err));
const plain = (row) => ({ ...row });

export class Db {
  constructor(client) {
    this.client = client;
    this.als = new AsyncLocalStorage();
    this.chain = Promise.resolve();
    this.ready = client.executeMultiple(SCHEMA);
    this.ready.catch(() => {}); // surfaced when something awaits `ready`; this just prevents an unhandled-rejection crash
  }

  /** Statements run on the open transaction if there is one (tracked per async call chain), else on the connection. */
  #exec() {
    return this.als.getStore() ?? this.client;
  }

  async all(sql, args = []) {
    const rs = await this.#exec().execute({ sql, args });
    return rs.rows.map(plain);
  }

  async get(sql, args = []) {
    const rows = await this.all(sql, args);
    return rows[0] ?? null;
  }

  async run(sql, args = []) {
    const rs = await this.#exec().execute({ sql, args });
    return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
  }

  /**
   * Runs fn inside one write transaction: everything commits together or not at all. Nested calls join the
   * outer transaction. Write transactions are queued one at a time inside this process, and retried briefly if
   * another process or instance holds the database lock — fn may therefore run more than once, so it must only
   * touch the database.
   */
  atomic(fn) {
    if (this.als.getStore()) return fn();
    const run = this.chain.then(() => this.#attempt(fn));
    this.chain = run.catch(() => {});
    return run;
  }

  async #attempt(fn) {
    for (let attempt = 0; ; attempt++) {
      let tx;
      try {
        tx = await this.client.transaction('write');
        const result = await this.als.run(tx, fn);
        await tx.commit();
        return result;
      } catch (err) {
        if (tx) {
          try {
            await tx.rollback();
          } catch {
            /* already rolled back */
          }
        }
        if (isBusy(err) && attempt < 5) {
          await sleep(40 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        tx?.close();
      }
    }
  }

  async close() {
    this.client.close();
  }
}

/** `url` is a libSQL URL (libsql://… for Turso) or `file:path` for a local database file. */
export function openDb({ url, authToken }) {
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice(5)), { recursive: true });
  return new Db(createClient({ url, authToken: authToken || undefined }));
}
