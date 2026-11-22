-- Dump v2 stores one gzipped pipeline trace per request. Retire every v1
-- artifact before replacing the table so the 0084 trigger records all three
-- legacy file descriptors in spilled_files.
DELETE FROM dump_records;
DELETE FROM expiration_sweeps WHERE domain = 'dumps';

UPDATE cleanup_backfills
SET next_rowid = 0, complete = 1
WHERE source = 'dump_records';

DROP TABLE dump_records;

CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upstream_id TEXT,
  meta_json TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  PRIMARY KEY (key_id, id)
);

CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC, id DESC);

CREATE TRIGGER dump_records_validate_spilled_files
BEFORE INSERT ON dump_records
BEGIN
  SELECT RAISE(ABORT, 'Dump artifact file key must use the v2 prefix')
  WHERE substr(NEW.artifact_key, 1, 9) != 'dumps/v2/';

  SELECT RAISE(ABORT, 'Dump artifact file was not staged')
  WHERE NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = NEW.artifact_key
      AND owner_kind = 'dump-artifact'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  );
END;

CREATE TRIGGER dump_records_adopt_spilled_files
AFTER INSERT ON dump_records
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = NEW.artifact_key
    AND owner_kind = 'dump-artifact'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL;
END;

CREATE TRIGGER dump_records_retire_spilled_files
AFTER DELETE ON dump_records
BEGIN
  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  VALUES (OLD.artifact_key, 'dump-artifact', json_array(OLD.key_id, OLD.id), 'retired', 0)
  ON CONFLICT (file_key) DO UPDATE SET state = 'retired', collect_after = 0;
END;

CREATE TRIGGER dump_records_schedule_expiration
AFTER INSERT ON dump_records
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'dumps',
    NEW.key_id,
    COALESCE((
      SELECT iif(
        deleted_at IS NULL AND dump_retention_seconds IS NOT NULL,
        NEW.created_at + dump_retention_seconds * 1000 + 1,
        0
      )
      FROM api_keys WHERE id = NEW.key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1
  WHERE expiration_sweeps.claim_token IS NOT NULL
    OR excluded.due_at < expiration_sweeps.due_at;
END;
