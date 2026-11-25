DELETE FROM dump_records;
UPDATE spilled_files
SET state = 'retired', collect_after = 0
WHERE file_key GLOB 'dumps/v1/*';
DELETE FROM expiration_sweeps WHERE domain = 'dumps';
DELETE FROM cleanup_backfills WHERE source = 'dump_records';

DROP TABLE dump_records;
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upstream_id TEXT,
  meta_json TEXT NOT NULL,
  archive_file_key TEXT NOT NULL,
  PRIMARY KEY (key_id, id)
);

CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC, id DESC);

CREATE TRIGGER dump_records_validate_archive
BEFORE INSERT ON dump_records
WHEN NOT EXISTS (
  SELECT 1 FROM spilled_files
  WHERE file_key = NEW.archive_file_key
    AND owner_kind = 'dump-archive'
    AND owner_key = json_array(NEW.key_id, NEW.id)
    AND state = 'staged'
    AND claim_token IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'dump archive requires an unclaimed staged file');
END;

CREATE TRIGGER dump_records_adopt_archive
AFTER INSERT ON dump_records
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE file_key = NEW.archive_file_key;
END;

CREATE TRIGGER dump_records_retire_archive
AFTER DELETE ON dump_records
BEGIN
  UPDATE spilled_files
  SET state = 'retired', collect_after = 0
  WHERE file_key = OLD.archive_file_key;
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
