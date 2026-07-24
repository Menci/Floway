-- Drop the per-user global-telemetry grant. Performance telemetry is readable
-- by every user, and attributing rows to individual users — like every
-- cross-user usage view — follows `is_admin`, so the column has no reader left.
--
-- Rebuilt rather than ALTER TABLE ... DROP COLUMN because D1 rejects that
-- statement on tables in the older on-disk format (see migration 0051); the
-- rebuild works regardless. Column definitions and the partial unique index are
-- carried over verbatim from migration 0028, minus the dropped column. No table
-- declares a foreign key to `users`, so replacing it strands nothing.

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  -- NOCASE so usernames are matched case-insensitively everywhere: the
  -- `WHERE username = ?` login lookup and the active-username unique index
  -- below both inherit this collation, so "Admin" and "admin" are the same
  -- account and cannot coexist.
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  upstream_ids TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO users_new (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
  SELECT id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX idx_users_username_active ON users(username) WHERE deleted_at IS NULL;
