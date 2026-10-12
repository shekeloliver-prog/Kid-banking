import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Money is always stored as integer cents. `users.balance_cents` is the spendable
// balance; `transactions` is the append-only history shown in the UI.
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
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
