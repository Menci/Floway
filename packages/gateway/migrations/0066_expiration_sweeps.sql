CREATE TABLE expiration_sweeps (
  domain TEXT NOT NULL,
  key_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  claimed_at INTEGER,
  PRIMARY KEY (domain, key_id),
  CHECK ((claim_token IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX idx_expiration_sweeps_due
ON expiration_sweeps (due_at, key_id, domain);

CREATE UNIQUE INDEX idx_expiration_sweeps_claim
ON expiration_sweeps (claim_token)
WHERE claim_token IS NOT NULL;

CREATE INDEX idx_spilled_files_claim
ON spilled_files (claim_token)
WHERE claim_token IS NOT NULL;

CREATE TABLE cleanup_backfills (
  source TEXT PRIMARY KEY,
  next_rowid INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1))
);

INSERT INTO cleanup_backfills (source) VALUES
  ('responses_items'),
  ('responses_snapshots'),
  ('dump_records');

CREATE TRIGGER responses_items_schedule_expiration_insert
AFTER INSERT ON responses_items
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT iif(
        deleted_at IS NULL AND responses_retention_seconds > 0,
        NEW.refreshed_at + responses_retention_seconds * 1000 + 86400000 + 1,
        0
      )
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1
  WHERE expiration_sweeps.claim_token IS NOT NULL
    OR excluded.due_at < expiration_sweeps.due_at;
END;

CREATE TRIGGER responses_items_schedule_expiration_update
AFTER UPDATE OF refreshed_at ON responses_items
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT iif(
        deleted_at IS NULL AND responses_retention_seconds > 0,
        NEW.refreshed_at + responses_retention_seconds * 1000 + 86400000 + 1,
        0
      )
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1
  WHERE expiration_sweeps.claim_token IS NOT NULL
    OR excluded.due_at < expiration_sweeps.due_at;
END;

CREATE TRIGGER responses_snapshots_schedule_expiration_insert
AFTER INSERT ON responses_snapshots
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT iif(
        deleted_at IS NULL AND responses_retention_seconds > 0,
        NEW.refreshed_at + responses_retention_seconds * 1000 + 86400000 + 1,
        0
      )
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1
  WHERE expiration_sweeps.claim_token IS NOT NULL
    OR excluded.due_at < expiration_sweeps.due_at;
END;

CREATE TRIGGER responses_snapshots_schedule_expiration_update
AFTER UPDATE OF refreshed_at ON responses_snapshots
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  VALUES (
    'responses',
    NEW.api_key_id,
    COALESCE((
      SELECT iif(
        deleted_at IS NULL AND responses_retention_seconds > 0,
        NEW.refreshed_at + responses_retention_seconds * 1000 + 86400000 + 1,
        0
      )
      FROM api_keys WHERE id = NEW.api_key_id
    ), 0)
  )
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = MIN(expiration_sweeps.due_at, excluded.due_at),
    revision = expiration_sweeps.revision + 1
  WHERE expiration_sweeps.claim_token IS NOT NULL
    OR excluded.due_at < expiration_sweeps.due_at;
END;

CREATE TRIGGER dump_records_validate_spilled_files
BEFORE INSERT ON dump_records
BEGIN
  SELECT RAISE(ABORT, 'Dump request body file key must be text')
  WHERE NEW.request_body_descriptor IS NOT NULL
    AND json_type(NEW.request_body_descriptor, '$.key') IS NOT 'text';
  SELECT RAISE(ABORT, 'Dump response body file key must be text')
  WHERE NEW.response_body_descriptor IS NOT NULL
    AND json_type(NEW.response_body_descriptor, '$.key') IS NOT 'text';

  -- Migrations run before the new Worker is published, so an old writer may
  -- still insert its deterministic path without a staged registry row. Only
  -- the exact path derived from that row is accepted directly; per-write
  -- unique paths still require staging, and a collector claim always wins.
  SELECT RAISE(ABORT, 'Dump request body file was not staged')
  WHERE NEW.request_body_descriptor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
      AND owner_kind = 'dump-request'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  ) AND NOT (
    json_extract(NEW.request_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.req.gz'
    AND NOT EXISTS (
      SELECT 1 FROM spilled_files
      WHERE file_key = json_extract(NEW.request_body_descriptor, '$.key')
        AND claim_token IS NOT NULL
    )
  );
  SELECT RAISE(ABORT, 'Dump response body file was not staged')
  WHERE NEW.response_body_descriptor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
      AND owner_kind = 'dump-response'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  ) AND NOT (
    json_extract(NEW.response_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.resp.gz'
    AND NOT EXISTS (
      SELECT 1 FROM spilled_files
      WHERE file_key = json_extract(NEW.response_body_descriptor, '$.key')
        AND claim_token IS NOT NULL
    )
  );
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

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT
    json_extract(NEW.request_body_descriptor, '$.key'),
    'dump-request',
    json_array(NEW.key_id, NEW.id),
    'owned',
    NULL
  WHERE NEW.request_body_descriptor IS NOT NULL
    AND json_extract(NEW.request_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.req.gz'
  ON CONFLICT (file_key) DO UPDATE SET
    owner_kind = excluded.owner_kind,
    owner_key = excluded.owner_key,
    state = 'owned',
    collect_after = NULL
  WHERE spilled_files.claim_token IS NULL;

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT
    json_extract(NEW.response_body_descriptor, '$.key'),
    'dump-response',
    json_array(NEW.key_id, NEW.id),
    'owned',
    NULL
  WHERE NEW.response_body_descriptor IS NOT NULL
    AND json_extract(NEW.response_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.resp.gz'
  ON CONFLICT (file_key) DO UPDATE SET
    owner_kind = excluded.owner_kind,
    owner_key = excluded.owner_key,
    state = 'owned',
    collect_after = NULL
  WHERE spilled_files.claim_token IS NULL;
END;

CREATE TRIGGER dump_records_retire_spilled_files
AFTER DELETE ON dump_records
BEGIN
  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT json_extract(OLD.request_body_descriptor, '$.key'), 'dump-request', json_array(OLD.key_id, OLD.id), 'retired', 0
  WHERE OLD.request_body_descriptor IS NOT NULL
  ON CONFLICT (file_key) DO UPDATE SET
    state = 'retired', collect_after = 0;

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT json_extract(OLD.response_body_descriptor, '$.key'), 'dump-response', json_array(OLD.key_id, OLD.id), 'retired', 0
  WHERE OLD.response_body_descriptor IS NOT NULL
  ON CONFLICT (file_key) DO UPDATE SET
    state = 'retired', collect_after = 0;
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

CREATE TRIGGER api_keys_schedule_responses_expiration_update
AFTER UPDATE OF responses_retention_seconds, deleted_at ON api_keys
WHEN OLD.responses_retention_seconds IS NOT NEW.responses_retention_seconds
  OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  SELECT 'responses', NEW.id, 0
  WHERE EXISTS (SELECT 1 FROM responses_items WHERE api_key_id = NEW.id)
     OR EXISTS (SELECT 1 FROM responses_snapshots WHERE api_key_id = NEW.id)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_responses_expiration_delete
AFTER DELETE ON api_keys
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  SELECT 'responses', OLD.id, 0
  WHERE EXISTS (SELECT 1 FROM responses_items WHERE api_key_id = OLD.id)
     OR EXISTS (SELECT 1 FROM responses_snapshots WHERE api_key_id = OLD.id)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_dumps_expiration_update
AFTER UPDATE OF dump_retention_seconds, deleted_at ON api_keys
WHEN OLD.dump_retention_seconds IS NOT NEW.dump_retention_seconds
  OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  SELECT 'dumps', NEW.id, 0
  WHERE EXISTS (SELECT 1 FROM dump_records WHERE key_id = NEW.id)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;

CREATE TRIGGER api_keys_schedule_dumps_expiration_delete
AFTER DELETE ON api_keys
BEGIN
  INSERT INTO expiration_sweeps (domain, key_id, due_at)
  SELECT 'dumps', OLD.id, 0
  WHERE EXISTS (SELECT 1 FROM dump_records WHERE key_id = OLD.id)
  ON CONFLICT (domain, key_id) DO UPDATE SET
    due_at = 0,
    revision = expiration_sweeps.revision + 1;
END;
