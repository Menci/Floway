CREATE TABLE access_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  values_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_type, principal_id, scope_key)
);

-- Preserve the user-level upstream whitelist exactly: NULL meant every
-- upstream, an array meant those upstreams, and an empty array meant none.
INSERT INTO access_records (
  principal_type, principal_id, scope_json, scope_key, sort_order, values_json, created_at, updated_at
)
SELECT
  'user', id, json_object('kind', 'upstreams'), 'upstreams', 0,
  json_object('Model.Use', json('true')), created_at, created_at
FROM users
WHERE upstream_ids IS NULL AND deleted_at IS NULL;

INSERT INTO access_records (
  principal_type, principal_id, scope_json, scope_key, sort_order, values_json, created_at, updated_at
)
SELECT
  'user', users.id,
  json_object('kind', 'upstream', 'upstreamId', CAST(entry.value AS TEXT)),
  json_array('upstream', CAST(entry.value AS TEXT)),
  0, json_object('Model.Use', json('true')),
  users.created_at, users.created_at
FROM users, json_each(users.upstream_ids) AS entry
WHERE users.upstream_ids IS NOT NULL AND users.deleted_at IS NULL;

-- User-level upstream order only applied when a key inherited its list. Move
-- that fallback order to every inheriting key before dropping the user column;
-- explicit key lists already own their order.
UPDATE api_keys
SET upstream_ids = (
  SELECT json_group_array(CAST(value AS TEXT))
  FROM users
  JOIN json_each(users.upstream_ids)
  WHERE users.id = api_keys.user_id
)
WHERE upstream_ids IS NULL
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE users.id = api_keys.user_id
      AND users.upstream_ids IS NOT NULL
  );

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
