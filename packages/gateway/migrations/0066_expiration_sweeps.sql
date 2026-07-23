CREATE TABLE expiration_sweeps (
  domain TEXT NOT NULL,
  key_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at INTEGER,
  PRIMARY KEY (domain, key_id),
  CHECK (domain IN ('responses', 'dumps')),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX idx_expiration_sweeps_due
ON expiration_sweeps (due_at, domain, key_id);

INSERT INTO expiration_sweeps (domain, key_id, due_at)
SELECT domain, api_keys.id, 0
FROM api_keys
CROSS JOIN (SELECT 'responses' AS domain UNION ALL SELECT 'dumps');

CREATE TRIGGER responses_items_schedule_expiration_insert
AFTER INSERT ON responses_items
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN deleted_at IS NULL AND responses_retention_seconds > 0
          THEN NEW.refreshed_at + responses_retention_seconds * 1000 + 1
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER responses_items_schedule_expiration_update
AFTER UPDATE OF refreshed_at ON responses_items
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN deleted_at IS NULL AND responses_retention_seconds > 0
          THEN NEW.refreshed_at + responses_retention_seconds * 1000 + 1
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER responses_snapshots_schedule_expiration_insert
AFTER INSERT ON responses_snapshots
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN deleted_at IS NULL AND responses_retention_seconds > 0
          THEN NEW.refreshed_at + responses_retention_seconds * 1000 + 1
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER responses_snapshots_schedule_expiration_update
AFTER UPDATE OF refreshed_at ON responses_snapshots
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT CASE
        WHEN deleted_at IS NULL AND responses_retention_seconds > 0
          THEN NEW.refreshed_at + responses_retention_seconds * 1000 + 1
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER dump_records_validate_spilled_files
BEFORE INSERT ON dump_records
BEGIN
  SELECT CASE WHEN NEW.request_body_descriptor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
      AND owner_kind = 'dump-request'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  ) THEN RAISE(ABORT, 'Dump request body file was not staged') END;
  SELECT CASE WHEN NEW.response_body_descriptor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
      AND owner_kind = 'dump-response'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  ) THEN RAISE(ABORT, 'Dump response body file was not staged') END;
END;

CREATE TRIGGER dump_records_adopt_spilled_files
AFTER INSERT ON dump_records
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE state = 'staged'
    AND claim_token IS NULL
    AND file_key IN (
      json_extract(NEW.request_body_descriptor, '$.key'),
      json_extract(NEW.response_body_descriptor, '$.key')
    );
END;

CREATE TRIGGER dump_records_retire_spilled_files
AFTER DELETE ON dump_records
BEGIN
  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT json_extract(OLD.request_body_descriptor, '$.key'), 'dump-request', json_array(OLD.key_id, OLD.id), 'retired', 0
  WHERE OLD.request_body_descriptor IS NOT NULL
  ON CONFLICT (file_key) DO UPDATE SET
    state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL;

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT json_extract(OLD.response_body_descriptor, '$.key'), 'dump-response', json_array(OLD.key_id, OLD.id), 'retired', 0
  WHERE OLD.response_body_descriptor IS NOT NULL
  ON CONFLICT (file_key) DO UPDATE SET
    state = 'retired', collect_after = 0, claim_token = NULL, claimed_at = NULL;
END;

CREATE TRIGGER dump_records_schedule_expiration
AFTER INSERT ON dump_records
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'dumps',
    NEW.key_id,
    COALESCE((
      SELECT CASE
        WHEN deleted_at IS NULL AND dump_retention_seconds IS NOT NULL
          THEN NEW.created_at + dump_retention_seconds * 1000 + 1
        ELSE 0
      END
      FROM api_keys WHERE id = NEW.key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_expiration_update
AFTER UPDATE OF responses_retention_seconds, dump_retention_seconds, deleted_at ON api_keys
WHEN OLD.responses_retention_seconds IS NOT NEW.responses_retention_seconds
  OR OLD.dump_retention_seconds IS NOT NEW.dump_retention_seconds
  OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES ('responses', NEW.id, 0), ('dumps', NEW.id, 0)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_expiration_delete
AFTER DELETE ON api_keys
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES ('responses', OLD.id, 0), ('dumps', OLD.id, 0)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;
