CREATE TABLE access_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_type, principal_id, scope_json)
);
CREATE INDEX idx_access_records_principal ON access_records(principal_type, principal_id);

-- Preserve the user-level upstream whitelist exactly: NULL meant every
-- upstream, an array meant those upstreams, and an empty array meant none.
INSERT INTO access_records (
  principal_type, principal_id, scope_json, sort_order, values_json, created_at, updated_at
)
SELECT
  'user', id, json_object('kind', 'upstreams'), 0,
  json_object('Model.Use', json('true')), created_at, created_at
FROM users
WHERE upstream_ids IS NULL AND deleted_at IS NULL;

INSERT INTO access_records (
  principal_type, principal_id, scope_json, sort_order, values_json, created_at, updated_at
)
SELECT
  'user', users.id,
  json_object('kind', 'upstream', 'upstreamId', CAST(entry.value AS TEXT)),
  CAST(entry.key AS INTEGER), json_object('Model.Use', json('true')),
  users.created_at, users.created_at
FROM users, json_each(users.upstream_ids) AS entry
WHERE users.upstream_ids IS NOT NULL AND users.deleted_at IS NULL;

-- Self telemetry remains available without an implicit resolver exception.
INSERT INTO access_records (
  principal_type, principal_id, scope_json, sort_order, values_json, created_at, updated_at
)
SELECT
  'user', id, json_object('kind', 'user', 'userId', id), 0,
  json_object('User.Audit', json('true')), created_at, created_at
FROM users
WHERE deleted_at IS NULL;

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

INSERT INTO users_new (id, username, password_hash, is_admin, created_at, deleted_at)
  SELECT id, username, password_hash, is_admin, created_at, deleted_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX idx_users_username_active ON users(username) WHERE deleted_at IS NULL;
