-- Pre-0058 rows keep their complete payload and fully backed snapshot graph,
-- but their upstream_id/upstream_item_id affinity cannot be converted into the
-- new client-carried data: the old schema never stored canonical model or
-- alias rules, and SQL cannot perform the per-key AEAD transform. Preserved
-- history therefore resumes through normal routing with no legacy affinity.
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
  CASE WHEN item_type = 'compaction_summary' THEN 'compaction' ELSE item_type END,
  payload_json,
  content_hash,
  CASE
    -- SQL cannot move an existing spilled payload into a later expiry bucket.
    -- Keep its original file-backed horizon; inline rows can retain the latest
    -- reference time directly.
    WHEN json_extract(payload_json, '$.storage') = 'file' THEN created_at
    ELSE MAX(created_at, refreshed_at)
  END
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
  MIN(
    MAX(snapshot.created_at, snapshot.refreshed_at),
    (
      SELECT MIN(item.created_at)
      FROM json_each(CASE WHEN json_valid(snapshot.item_ids_json) THEN snapshot.item_ids_json ELSE '[]' END) AS ref
      JOIN responses_items_new AS item
        ON item.api_key_id = snapshot.api_key_id
        AND item.id = ref.value
    )
  )
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
