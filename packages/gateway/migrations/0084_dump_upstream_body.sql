-- Per-request dumps gain an optional second spilled body holding the
-- pre-translation (target-protocol) view of what the upstream returned,
-- captured by `traverseTranslation` before Floway translates it into the
-- source protocol. NULL for records written before this migration and for
-- turns that did not traverse a translation (native target). The descriptor
-- shape — `{key, type}` — is the same as the downstream
-- `response_body_descriptor`, so the spilled-files sweep reuses it; the file
-- lives under a `resp.up` side suffix so its lifecycle is owned independently.
ALTER TABLE dump_records ADD COLUMN response_upstream_body_descriptor TEXT;

-- The three spilled-files triggers from 0066 reference only
-- `request_body_descriptor` and `response_body_descriptor`. The new
-- `response_upstream_body_descriptor` needs the same validate / adopt / retire
-- treatment or its file would never leave `staged` and would never be
-- collected on row delete. Rebuild all three with the upstream descriptor
-- appended.
DROP TRIGGER dump_records_validate_spilled_files;
CREATE TRIGGER dump_records_validate_spilled_files
BEFORE INSERT ON dump_records
BEGIN
  SELECT RAISE(ABORT, 'Dump request body file key must be text')
  WHERE NEW.request_body_descriptor IS NOT NULL
    AND json_type(NEW.request_body_descriptor, '$.key') IS NOT 'text';
  SELECT RAISE(ABORT, 'Dump response body file key must be text')
  WHERE NEW.response_body_descriptor IS NOT NULL
    AND json_type(NEW.response_body_descriptor, '$.key') IS NOT 'text';
  SELECT RAISE(ABORT, 'Dump upstream response body file key must be text')
  WHERE NEW.response_upstream_body_descriptor IS NOT NULL
    AND json_type(NEW.response_upstream_body_descriptor, '$.key') IS NOT 'text';

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
  SELECT RAISE(ABORT, 'Dump upstream response body file was not staged')
  WHERE NEW.response_upstream_body_descriptor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM spilled_files
    WHERE file_key = json_extract(NEW.response_upstream_body_descriptor, '$.key')
      AND owner_kind = 'dump-response-upstream'
      AND owner_key = json_array(NEW.key_id, NEW.id)
      AND state = 'staged'
      AND claim_token IS NULL
  ) AND NOT (
    json_extract(NEW.response_upstream_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.resp.up.gz'
    AND NOT EXISTS (
      SELECT 1 FROM spilled_files
      WHERE file_key = json_extract(NEW.response_upstream_body_descriptor, '$.key')
        AND claim_token IS NOT NULL
    )
  );
END;

DROP TRIGGER dump_records_adopt_spilled_files;
CREATE TRIGGER dump_records_adopt_spilled_files
AFTER INSERT ON dump_records
BEGIN
  UPDATE spilled_files
  SET state = 'owned', collect_after = NULL
  WHERE state = 'staged'
    AND claim_token IS NULL
    AND file_key IN (
      json_extract(NEW.request_body_descriptor, '$.key'),
      json_extract(NEW.response_body_descriptor, '$.key'),
      json_extract(NEW.response_upstream_body_descriptor, '$.key')
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

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT
    json_extract(NEW.response_upstream_body_descriptor, '$.key'),
    'dump-response-upstream',
    json_array(NEW.key_id, NEW.id),
    'owned',
    NULL
  WHERE NEW.response_upstream_body_descriptor IS NOT NULL
    AND json_extract(NEW.response_upstream_body_descriptor, '$.key') =
      'dumps/v1/' || NEW.key_id || '/' || strftime('%Y%m%d%H', NEW.created_at / 1000, 'unixepoch') || '/' || NEW.id || '.resp.up.gz'
  ON CONFLICT (file_key) DO UPDATE SET
    owner_kind = excluded.owner_kind,
    owner_key = excluded.owner_key,
    state = 'owned',
    collect_after = NULL
  WHERE spilled_files.claim_token IS NULL;
END;

DROP TRIGGER dump_records_retire_spilled_files;
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

  INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
  SELECT json_extract(OLD.response_upstream_body_descriptor, '$.key'), 'dump-response-upstream', json_array(OLD.key_id, OLD.id), 'retired', 0
  WHERE OLD.response_upstream_body_descriptor IS NOT NULL
  ON CONFLICT (file_key) DO UPDATE SET
    state = 'retired', collect_after = 0;
END;
