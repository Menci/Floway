-- Mixed endpoint maps were previously validated through their primary kind.
-- An embedding or image endpoint therefore hid a simultaneous rerank endpoint,
-- allowing a row with no rerankTarget to persist even though rerank dispatch
-- cannot select an outbound protocol. Preserve every callable endpoint and
-- model field, removing only that unusable rerank declaration. Cached catalogs
-- repeat the old endpoint map, so affected rows must fetch them again.

UPDATE upstreams
SET config_json = json_set(
      config_json,
      '$.models',
      (
        SELECT json_group_array(
          CASE
            WHEN json_type(model.value, '$.rerankTarget') IS NULL
              AND json_type(model.value, '$.endpoints.rerank') = 'object'
              AND (
                json_type(model.value, '$.endpoints.embeddings') = 'object'
                OR json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
                OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
              )
            THEN json_remove(model.value, '$.endpoints.rerank')
            ELSE model.value
          END
        )
        FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
      )
    ),
    models_cache_json = NULL
WHERE provider IN ('custom', 'azure', 'ollama')
  AND json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.rerankTarget') IS NULL
      AND json_type(model.value, '$.endpoints.rerank') = 'object'
      AND (
        json_type(model.value, '$.endpoints.embeddings') = 'object'
        OR json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
        OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
      )
  );

-- The same invalid projection can exist only in the cache when a Custom
-- upstream inherits a mixed upstream-level endpoint map into auto rows. Clear
-- it independently of config.models so the repository never hydrates the stale
-- targetless ProviderModel before the provider has a chance to refresh it.
UPDATE upstreams
SET models_cache_json = NULL
WHERE provider IN ('custom', 'azure', 'ollama')
  AND models_cache_json IS NOT NULL
  AND json_valid(models_cache_json)
  AND json_type(models_cache_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.models_cache_json, '$.models')) AS model
    WHERE json_type(model.value, '$.rerankTarget') IS NULL
      AND json_type(model.value, '$.endpoints.rerank') = 'object'
      AND (
        json_type(model.value, '$.endpoints.embeddings') = 'object'
        OR json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
        OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
      )
  );
