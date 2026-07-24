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
    CHECK (
      responses_retention_seconds = 0
      OR (
        responses_retention_seconds BETWEEN 86400 AND 315360000
        AND responses_retention_seconds % 86400 = 0
      )
    )
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
  responses_retention_seconds
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
  0
FROM api_keys;

DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;

CREATE INDEX idx_api_keys_user ON api_keys(user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_api_keys_server_secret ON api_keys(server_secret);

DROP TABLE responses_snapshots;
DROP TABLE responses_items;

CREATE TABLE spilled_files (
  file_key TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('staged', 'owned', 'retired')),
  collect_after INTEGER,
  claim_token TEXT,
  claimed_at INTEGER,
  CHECK (length(file_key) > 0),
  CHECK (length(owner_kind) > 0),
  CHECK (length(owner_key) > 0),
  CHECK ((state = 'owned') = (collect_after IS NULL)),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL)),
  CHECK (state != 'owned' OR claim_token IS NULL)
);

CREATE UNIQUE INDEX idx_spilled_files_owned_owner
ON spilled_files (owner_kind, owner_key)
WHERE state = 'owned';

CREATE INDEX idx_spilled_files_collectible
ON spilled_files (collect_after, file_key)
WHERE state != 'owned';

CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  item_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_file_key TEXT,
  refreshed_at INTEGER NOT NULL CHECK (refreshed_at >= 0 AND refreshed_at % 86400000 = 0),
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(payload_json) > 0),
  CHECK (length(item_hash) > 0),
  CHECK (length(payload_hash) > 0)
);

CREATE TABLE responses_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL CHECK (refreshed_at >= 0 AND refreshed_at % 86400000 = 0),
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(item_ids_json) > 0)
);

CREATE UNIQUE INDEX idx_responses_items_id_scope ON responses_items (id, api_key_id);
CREATE INDEX idx_responses_items_item_hash ON responses_items (api_key_id, item_hash, refreshed_at DESC);
CREATE INDEX idx_responses_items_key_refresh ON responses_items (api_key_id, refreshed_at);
CREATE UNIQUE INDEX idx_responses_items_payload_file ON responses_items (payload_file_key) WHERE payload_file_key IS NOT NULL;
CREATE UNIQUE INDEX idx_responses_snapshots_id_scope ON responses_snapshots (id, api_key_id);
CREATE INDEX idx_responses_snapshots_key_refresh ON responses_snapshots (api_key_id, refreshed_at);

CREATE TRIGGER responses_items_validate_payload_insert
BEFORE INSERT ON responses_items
WHEN NEW.payload_file_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Responses payload file was not staged for this item')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = NEW.payload_file_key
      AND owner_kind = 'responses-item'
      AND owner_key = json_array(NEW.api_key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  );
END;

CREATE TRIGGER responses_items_adopt_payload_insert
AFTER INSERT ON responses_items
WHEN NEW.payload_file_key IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = NEW.payload_file_key
    AND owner_kind = 'responses-item'
    AND owner_key = json_array(NEW.api_key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER responses_items_validate_payload_update
BEFORE UPDATE OF payload_file_key ON responses_items
WHEN OLD.payload_file_key IS NOT NEW.payload_file_key
BEGIN
  SELECT RAISE(ABORT, 'Owned Responses payload file is missing')
  WHERE OLD.payload_file_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = OLD.payload_file_key
      AND owner_kind = 'responses-item'
      AND owner_key = json_array(OLD.api_key_id, OLD.id)
      AND state = 'owned'
  );
  SELECT RAISE(ABORT, 'Replacement Responses payload file was not staged for this item')
  WHERE NEW.payload_file_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = NEW.payload_file_key
      AND owner_kind = 'responses-item'
      AND owner_key = json_array(NEW.api_key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  );
END;

CREATE TRIGGER responses_items_replace_payload
AFTER UPDATE OF payload_file_key ON responses_items
WHEN OLD.payload_file_key IS NOT NEW.payload_file_key
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = OLD.payload_file_key AND state = 'owned';
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = NEW.payload_file_key
    AND owner_kind = 'responses-item'
    AND owner_key = json_array(NEW.api_key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER responses_items_validate_payload_delete
BEFORE DELETE ON responses_items
WHEN OLD.payload_file_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Owned Responses payload file is missing')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = OLD.payload_file_key
      AND owner_kind = 'responses-item'
      AND owner_key = json_array(OLD.api_key_id, OLD.id)
      AND state = 'owned'
  );
END;

CREATE TRIGGER responses_items_retire_payload
AFTER DELETE ON responses_items
WHEN OLD.payload_file_key IS NOT NULL
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = OLD.payload_file_key AND state = 'owned';
END;
