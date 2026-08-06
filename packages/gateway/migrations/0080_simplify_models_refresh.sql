-- Execution cells own in-flight coordination. D1 retains only retry backoff;
-- dropping the old column also removes its claim/lease shape constraint.
ALTER TABLE upstreams DROP COLUMN models_refresh_json;
ALTER TABLE upstreams ADD COLUMN models_refresh_json TEXT NULL CHECK (
  models_refresh_json IS NULL OR coalesce((
    json_valid(models_refresh_json) = 1
    AND json_type(models_refresh_json, '$.failureCount') = 'integer'
    AND json_extract(models_refresh_json, '$.failureCount') >= 0
    AND json_type(models_refresh_json, '$.retryAt') = 'integer'
    AND json_extract(models_refresh_json, '$.retryAt') >= 0
  ), 0) = 1
);
