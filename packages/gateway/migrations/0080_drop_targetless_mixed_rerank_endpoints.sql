-- Earlier model validation projected a mixed endpoint map to one primary
-- kind. Embedding or image endpoints could therefore hide an unusable rerank
-- endpoint with no target. Preserve every callable endpoint and model field,
-- removing only that targetless rerank declaration.

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
WHERE provider IN ('custom', 'azure')
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

-- Ollama never routed image or rerank protocols. Older rows could still store
-- either family, including mixed maps whose primary kind hid it. Remove every
-- unsupported endpoint and target, then derive the current primary kind from
-- the remaining callable map.
UPDATE upstreams
SET config_json = json_set(
      config_json,
      '$.models',
      (
        SELECT json_group_array(
          json_set(
            json_remove(
              model.value,
              '$.endpoints.imagesGenerations',
              '$.endpoints.imagesEdits',
              '$.endpoints.rerank',
              '$.rerankTarget'
            ),
            '$.kind',
            CASE
              WHEN json_type(model.value, '$.endpoints.embeddings') = 'object' THEN 'embedding'
              WHEN json_type(model.value, '$.endpoints.audioTranscriptions') = 'object' THEN 'transcription'
              ELSE 'chat'
            END
          )
        )
        FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
      )
    ),
    models_cache_json = NULL
WHERE provider = 'ollama'
  AND json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
      OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
      OR json_type(model.value, '$.endpoints.rerank') = 'object'
  );

-- Models containing only unsupported Ollama endpoints now have an empty map.
-- Drop those rows; Ollama can still discover its native catalog with no manual
-- rows configured.
UPDATE upstreams
SET config_json = json_set(
      config_json,
      '$.models',
      (
        SELECT json_group_array(model.value)
        FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
        WHERE EXISTS (
          SELECT 1
          FROM json_each(json_extract(model.value, '$.endpoints'))
        )
      )
    )
WHERE provider = 'ollama'
  AND json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE NOT EXISTS (
      SELECT 1
      FROM json_each(json_extract(model.value, '$.endpoints'))
    )
  );

-- The same invalid projection can exist only in the cache. Clear it
-- independently of config.models so repository hydration never reaches a
-- stale ProviderModel before the provider can refresh it.
UPDATE upstreams
SET models_cache_json = NULL
WHERE models_cache_json IS NOT NULL
  AND json_valid(models_cache_json)
  AND json_type(models_cache_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.models_cache_json, '$.models')) AS model
    WHERE (
      upstreams.provider IN ('custom', 'azure')
      AND json_type(model.value, '$.rerankTarget') IS NULL
      AND json_type(model.value, '$.endpoints.rerank') = 'object'
      AND (
        json_type(model.value, '$.endpoints.embeddings') = 'object'
        OR json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
        OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
      )
    ) OR (
      upstreams.provider = 'ollama'
      AND (
        json_type(model.value, '$.endpoints.imagesGenerations') = 'object'
        OR json_type(model.value, '$.endpoints.imagesEdits') = 'object'
        OR json_type(model.value, '$.endpoints.rerank') = 'object'
      )
    )
  );
