-- Catalog publication is fenced by provider configuration, independently of
-- runtime state and operator metadata updates.
ALTER TABLE upstreams ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(config_version) = 'integer' AND config_version >= 1);

-- Existing catalog errors predate the retry counter. Keep their models and
-- treat the recorded error as the first failure in the new backoff sequence.
UPDATE upstreams SET models_cache_json = json_set(models_cache_json, '$.lastError.failureCount', 1)
  WHERE json_extract(models_cache_json, '$.revision') = 12
    AND json_type(models_cache_json, '$.lastError') = 'object';
