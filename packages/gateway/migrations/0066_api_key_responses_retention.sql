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
  server_secret TEXT NOT NULL
    CHECK (length(server_secret) = 64 AND server_secret NOT GLOB '*[^0-9a-f]*'),
  responses_retention_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (responses_retention_seconds BETWEEN 0 AND 315360000),
  responses_state_epoch TEXT NOT NULL
    CHECK (length(responses_state_epoch) = 32 AND responses_state_epoch NOT GLOB '*[^0-9a-f]*')
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
  server_secret,
  responses_retention_seconds,
  responses_state_epoch
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
  server_secret,
  0,
  lower(hex(randomblob(16)))
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_user ON api_keys(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_api_keys_server_secret ON api_keys(server_secret);

DROP TABLE responses_snapshots;
DROP TABLE responses_items;

CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  state_epoch TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(state_epoch) = 32 AND state_epoch NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(payload_json) > 0),
  CHECK (length(content_hash) > 0),
  CHECK (expires_at > refreshed_at)
);

CREATE TABLE responses_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  state_epoch TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(state_epoch) = 32 AND state_epoch NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(item_ids_json) > 0),
  CHECK (expires_at > refreshed_at)
);

CREATE UNIQUE INDEX idx_responses_items_id_scope ON responses_items (id, api_key_id, state_epoch);
CREATE INDEX idx_responses_items_content_hash ON responses_items (api_key_id, state_epoch, content_hash, refreshed_at DESC);
CREATE INDEX idx_responses_items_expiry ON responses_items (expires_at);
CREATE UNIQUE INDEX idx_responses_snapshots_id_scope ON responses_snapshots (id, api_key_id, state_epoch);
CREATE INDEX idx_responses_snapshots_expiry ON responses_snapshots (expires_at);
