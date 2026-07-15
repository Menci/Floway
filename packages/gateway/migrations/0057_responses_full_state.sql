CREATE TABLE responses_items_new (
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

INSERT INTO responses_items_new (
  id,
  api_key_id,
  item_type,
  payload_json,
  content_hash,
  created_at
)
SELECT
  id,
  api_key_id,
  item_type,
  payload_json,
  content_hash,
  created_at
FROM responses_items
WHERE api_key_id IS NOT NULL
  AND length(api_key_id) > 0
  AND payload_json IS NOT NULL
  AND length(payload_json) > 0;

CREATE TABLE responses_snapshots_new (
  id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  item_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(api_key_id) > 0),
  CHECK (length(item_ids_json) > 0)
);

INSERT INTO responses_snapshots_new (
  id,
  api_key_id,
  item_ids_json,
  created_at
)
SELECT
  snapshot.id,
  snapshot.api_key_id,
  snapshot.item_ids_json,
  snapshot.created_at
FROM responses_snapshots AS snapshot
WHERE snapshot.api_key_id IS NOT NULL
  AND length(snapshot.api_key_id) > 0
  AND json_valid(snapshot.item_ids_json)
  AND json_type(CASE WHEN json_valid(snapshot.item_ids_json) THEN snapshot.item_ids_json ELSE 'null' END) = 'array'
  AND json_array_length(CASE WHEN json_valid(snapshot.item_ids_json) THEN snapshot.item_ids_json ELSE '[]' END) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(CASE WHEN json_valid(snapshot.item_ids_json) THEN snapshot.item_ids_json ELSE '[]' END) AS ref
    LEFT JOIN responses_items_new AS item
      ON item.api_key_id = snapshot.api_key_id
      AND item.id = ref.value
    WHERE ref.type <> 'text' OR item.id IS NULL
  );

DROP TABLE responses_snapshots;
DROP TABLE responses_items;
ALTER TABLE responses_items_new RENAME TO responses_items;
ALTER TABLE responses_snapshots_new RENAME TO responses_snapshots;

CREATE UNIQUE INDEX idx_responses_items_id_scope ON responses_items (id, api_key_id);
CREATE INDEX idx_responses_items_content_hash ON responses_items (api_key_id, content_hash);
CREATE INDEX idx_responses_items_created_at ON responses_items (created_at);
CREATE UNIQUE INDEX idx_responses_snapshots_id_scope ON responses_snapshots (id, api_key_id);
CREATE INDEX idx_responses_snapshots_created_at ON responses_snapshots (created_at);
