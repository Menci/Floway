CREATE TRIGGER expiration_sweeps_reject_nonempty_delete
BEFORE DELETE ON expiration_sweeps
WHEN (
  OLD.domain = 'dumps'
  AND EXISTS (
    SELECT 1 FROM dump_records
    WHERE key_id = OLD.key_id
  )
) OR (
  OLD.domain = 'responses'
  AND (
    EXISTS (
      SELECT 1 FROM responses_items
      WHERE api_key_id = OLD.key_id
    )
    OR EXISTS (
      SELECT 1 FROM responses_snapshots
      WHERE api_key_id = OLD.key_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'expiration sweep cannot be removed while stored rows remain');
END;

CREATE TRIGGER expiration_sweeps_reject_nonempty_identity_update
BEFORE UPDATE OF domain, key_id ON expiration_sweeps
WHEN (
  OLD.domain != NEW.domain
  OR OLD.key_id != NEW.key_id
)
AND (
  (
    OLD.domain = 'dumps'
    AND EXISTS (
      SELECT 1 FROM dump_records
      WHERE key_id = OLD.key_id
    )
  )
  OR (
    OLD.domain = 'responses'
    AND (
      EXISTS (
        SELECT 1 FROM responses_items
        WHERE api_key_id = OLD.key_id
      )
      OR EXISTS (
        SELECT 1 FROM responses_snapshots
        WHERE api_key_id = OLD.key_id
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'expiration sweep cannot be reassigned while stored rows remain');
END;

INSERT INTO expiration_sweeps (domain, key_id, due_at)
SELECT 'dumps', key_id, 0
FROM dump_records
WHERE true
GROUP BY key_id
ON CONFLICT (domain, key_id) DO NOTHING;

INSERT INTO expiration_sweeps (domain, key_id, due_at)
SELECT 'responses', api_key_id, 0
FROM (
  SELECT api_key_id FROM responses_items
  UNION
  SELECT api_key_id FROM responses_snapshots
)
WHERE true
ON CONFLICT (domain, key_id) DO NOTHING;
