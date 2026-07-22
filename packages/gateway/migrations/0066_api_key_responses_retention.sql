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
    CHECK (responses_retention_seconds = 0 OR responses_retention_seconds BETWEEN 3600 AND 315360000),
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

CREATE TABLE responses_state_items (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  state_epoch TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_file_key TEXT,
  refreshed_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(state_epoch) = 32 AND state_epoch NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(payload_json) > 0),
  CHECK (length(content_hash) > 0),
  CHECK (length(payload_hash) > 0)
);

CREATE TABLE responses_state_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  state_epoch TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(state_epoch) = 32 AND state_epoch NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(item_ids_json) > 0)
);

CREATE UNIQUE INDEX idx_responses_state_items_id_scope ON responses_state_items (id, api_key_id, state_epoch);
CREATE INDEX idx_responses_state_items_content_hash ON responses_state_items (api_key_id, state_epoch, content_hash, refreshed_at DESC);
CREATE INDEX idx_responses_state_items_key_refresh ON responses_state_items (api_key_id, refreshed_at);
CREATE UNIQUE INDEX idx_responses_state_items_payload_file ON responses_state_items (payload_file_key) WHERE payload_file_key IS NOT NULL;
CREATE UNIQUE INDEX idx_responses_state_snapshots_id_scope ON responses_state_snapshots (id, api_key_id, state_epoch);
CREATE INDEX idx_responses_state_snapshots_key_refresh ON responses_state_snapshots (api_key_id, refreshed_at);

CREATE TABLE responses_state_payload_gc (
  file_key TEXT PRIMARY KEY,
  eligible_at INTEGER NOT NULL,
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX idx_responses_state_payload_gc_eligible ON responses_state_payload_gc (eligible_at, file_key);

CREATE TRIGGER responses_state_items_validate_payload_insert
BEFORE INSERT ON responses_state_items
WHEN NEW.payload_file_key IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM responses_state_payload_gc
    WHERE file_key = NEW.payload_file_key AND claim_token IS NULL
  ) THEN RAISE(ABORT, 'Responses payload file was not staged') END;
END;

CREATE TRIGGER responses_state_items_adopt_payload_insert
AFTER INSERT ON responses_state_items
WHEN NEW.payload_file_key IS NOT NULL
BEGIN
  DELETE FROM responses_state_payload_gc WHERE file_key = NEW.payload_file_key AND claim_token IS NULL;
END;

CREATE TRIGGER responses_state_items_validate_payload_update
BEFORE UPDATE OF payload_file_key ON responses_state_items
WHEN NEW.payload_file_key IS NOT NULL AND OLD.payload_file_key IS NOT NEW.payload_file_key
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM responses_state_payload_gc
    WHERE file_key = NEW.payload_file_key AND claim_token IS NULL
  ) THEN RAISE(ABORT, 'Responses payload file was not staged') END;
END;

CREATE TRIGGER responses_state_items_replace_payload
AFTER UPDATE OF payload_file_key ON responses_state_items
WHEN OLD.payload_file_key IS NOT NEW.payload_file_key
BEGIN
  INSERT OR IGNORE INTO responses_state_payload_gc (file_key, eligible_at)
  SELECT OLD.payload_file_key, 0 WHERE OLD.payload_file_key IS NOT NULL;
  DELETE FROM responses_state_payload_gc
  WHERE file_key = NEW.payload_file_key AND claim_token IS NULL;
END;

CREATE TRIGGER responses_state_items_retire_payload
AFTER DELETE ON responses_state_items
WHEN OLD.payload_file_key IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO responses_state_payload_gc (file_key, eligible_at)
  VALUES (OLD.payload_file_key, 0);
END;

CREATE TABLE responses_state_sweeps (
  api_key_id TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX idx_responses_state_sweeps_due ON responses_state_sweeps (due_at, api_key_id);

CREATE TRIGGER responses_state_snapshots_schedule_insert
AFTER INSERT ON responses_state_snapshots
BEGIN
  INSERT INTO responses_state_sweeps (api_key_id, due_at)
  VALUES (
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN responses_retention_seconds > 0 AND responses_state_epoch = NEW.state_epoch
          THEN NEW.refreshed_at + responses_retention_seconds * 1000
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (api_key_id) DO UPDATE SET
    due_at = MIN(responses_state_sweeps.due_at, excluded.due_at),
    revision = responses_state_sweeps.revision + 1;
END;

CREATE TRIGGER responses_state_snapshots_schedule_update
AFTER UPDATE OF refreshed_at, state_epoch ON responses_state_snapshots
BEGIN
  INSERT INTO responses_state_sweeps (api_key_id, due_at)
  VALUES (
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN responses_retention_seconds > 0 AND responses_state_epoch = NEW.state_epoch
          THEN NEW.refreshed_at + responses_retention_seconds * 1000
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (api_key_id) DO UPDATE SET
    due_at = MIN(responses_state_sweeps.due_at, excluded.due_at),
    revision = responses_state_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_responses_state_update
AFTER UPDATE OF responses_retention_seconds, responses_state_epoch ON api_keys
WHEN OLD.responses_retention_seconds IS NOT NEW.responses_retention_seconds
  OR OLD.responses_state_epoch IS NOT NEW.responses_state_epoch
BEGIN
  INSERT INTO responses_state_sweeps (api_key_id, due_at)
  VALUES (NEW.id, 0)
  ON CONFLICT (api_key_id) DO UPDATE SET
    due_at = 0,
    revision = responses_state_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_responses_state_delete
AFTER DELETE ON api_keys
BEGIN
  INSERT INTO responses_state_sweeps (api_key_id, due_at)
  VALUES (OLD.id, 0)
  ON CONFLICT (api_key_id) DO UPDATE SET
    due_at = 0,
    revision = responses_state_sweeps.revision + 1;
END;

CREATE TABLE responses_state_maintenance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  v1_next_expiry_hour INTEGER NOT NULL,
  v1_cleanup_after INTEGER NOT NULL,
  v1_complete INTEGER NOT NULL DEFAULT 0 CHECK (v1_complete IN (0, 1))
);

INSERT INTO responses_state_maintenance (id, v1_next_expiry_hour, v1_cleanup_after)
VALUES (
  1,
  CAST(strftime('%s', '2026-06-01 00:00:00') AS INTEGER) * 1000,
  (CAST(strftime('%s', 'now') AS INTEGER) + 2595600) * 1000
);
