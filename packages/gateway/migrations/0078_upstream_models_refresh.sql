-- Execution cells coordinate in-flight work; D1 retains retry backoff beside
-- the catalog so completion can be fenced by one upstream-row update.
ALTER TABLE upstreams ADD COLUMN models_refresh_json TEXT NULL CHECK (
  models_refresh_json IS NULL OR coalesce((
    json_valid(models_refresh_json) = 1
    AND json_type(models_refresh_json, '$.failureCount') = 'integer'
    AND json_extract(models_refresh_json, '$.failureCount') >= 0
    AND json_type(models_refresh_json, '$.retryAt') = 'integer'
    AND json_extract(models_refresh_json, '$.retryAt') >= 0
  ), 0) = 1
);
