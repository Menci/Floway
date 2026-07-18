ALTER TABLE responses_snapshots RENAME TO responses_snapshots_pre_0058;
ALTER TABLE responses_items RENAME TO responses_items_pre_0058;

CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(item_type) > 0),
  CHECK (length(payload_json) > 0),
  CHECK (content_hash IS NULL OR length(content_hash) > 0)
);

CREATE TABLE responses_snapshots (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(item_ids_json) > 0)
);

CREATE UNIQUE INDEX idx_responses_items_v2_id_scope ON responses_items (id, api_key_id);
CREATE INDEX idx_responses_items_v2_content_hash ON responses_items (api_key_id, content_hash);
CREATE INDEX idx_responses_items_v2_created_at ON responses_items (created_at);
CREATE UNIQUE INDEX idx_responses_snapshots_v2_id_scope ON responses_snapshots (id, api_key_id);
CREATE INDEX idx_responses_snapshots_v2_created_at ON responses_snapshots (created_at);
