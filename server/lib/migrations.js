// Versioned schema changes, applied in order, each in its own transaction and recorded in schema_migrations.
// The base tables (version 1) live in db.js and are created with IF NOT EXISTS; everything after that goes here.
//
// Rules for adding one: append, never edit an existing entry; keep statements idempotent where SQLite allows
// (CREATE ... IF NOT EXISTS); ALTER TABLE ... ADD COLUMN is safe because a migration runs at most once per database
// and the check-and-apply happens inside one write transaction, so two instances starting together can't both run it.

export const MIGRATIONS = [
  {
    version: 2,
    name: 'chores, savings interest, badges',
    statements: [
      `CREATE TABLE IF NOT EXISTS chores (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         parent_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         kid_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         title        TEXT NOT NULL,
         emoji        TEXT NOT NULL DEFAULT '🧹',
         reward_cents INTEGER NOT NULL CHECK (reward_cents > 0),
         repeat       TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'daily', 'weekly')),
         status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
         created_at   TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS chores_kid ON chores(kid_id, status)`,
      `CREATE INDEX IF NOT EXISTS chores_parent ON chores(parent_id, status)`,
      `CREATE TABLE IF NOT EXISTS chore_claims (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         chore_id      INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
         kid_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         reward_cents  INTEGER NOT NULL,
         status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
         response_note TEXT,
         created_at    TEXT NOT NULL,
         decided_at    TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS claims_chore ON chore_claims(chore_id, id DESC)`,
      `CREATE INDEX IF NOT EXISTS claims_kid ON chore_claims(kid_id, status)`,
      // interest_bps / interest_next were part of a feature that was removed before release. They are unused and harmless;
      // a migration is never edited after it may have run, so the columns stay.
      `ALTER TABLE kid_controls ADD COLUMN interest_bps INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE kid_controls ADD COLUMN interest_next TEXT`,
      `CREATE TABLE IF NOT EXISTS badges (
         kid_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         key       TEXT NOT NULL,
         earned_at TEXT NOT NULL,
         PRIMARY KEY (kid_id, key)
       )`,
    ],
  },
];
