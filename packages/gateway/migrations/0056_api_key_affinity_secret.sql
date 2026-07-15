CREATE TABLE api_keys_new (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  upstream_ids TEXT,
  deleted_at TEXT,
  dump_retention_seconds INTEGER,
  affinity_secret TEXT NOT NULL
    CHECK (length(affinity_secret) = 64 AND affinity_secret NOT GLOB '*[^0-9a-f]*')
);

INSERT INTO api_keys_new (
  id,
  user_id,
  name,
  key,
  created_at,
  last_used_at,
  upstream_ids,
  deleted_at,
  dump_retention_seconds,
  affinity_secret
)
SELECT
  id,
  user_id,
  name,
  key,
  created_at,
  last_used_at,
  upstream_ids,
  deleted_at,
  dump_retention_seconds,
  lower(hex(randomblob(32)))
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_user ON api_keys(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_api_keys_affinity_secret ON api_keys(affinity_secret);
