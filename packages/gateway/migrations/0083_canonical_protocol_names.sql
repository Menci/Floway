-- Protocol names are spelled in full everywhere, and two pieces of stored
-- operator configuration name them. Both live on `upstreams`, so both are
-- rewritten here rather than in two migrations over one table.
--
-- ## The endpoint capability map
--
-- `chatCompletions` becomes `openaiChatCompletions`, `responses` becomes
-- `openaiResponses`, `messages` becomes `anthropicMessages`, and the five
-- non-chat keys gain their vendor too — `completions`, `embeddings`,
-- `imagesGenerations`, `imagesEdits` and `audioTranscriptions` become
-- `openaiCompletions`, `openaiEmbeddings`, `openaiImagesGenerations`,
-- `openaiImagesEdits` and `openaiAudioTranscriptions`. `rerank` keeps its
-- spelling: it is a model kind that fans out to six vendor wire protocols, so
-- no vendor owns it.
--
-- The map is authoritative operator configuration for azure and custom
-- upstreams, stored per model in `config_json.models[].endpoints` and, for
-- custom, once more at `config_json.endpoints`. It is not a cache, so nothing
-- refetches it.
--
-- The stale shape survives the repository boundary and then fails past it.
-- `endpointsSchema` is a passthrough object of optional keys, so a row carrying
-- `{"chatCompletions": {}}` still decodes; `endpointsField` in
-- `packages/provider` then rejects the unknown key outright, which takes the
-- whole azure or custom upstream down rather than costing it one capability.
-- This rewrites the keys in place, the same way
-- `0024_structured_model_endpoints.sql` rewrote the path array they replaced.
--
-- ## The flag ids
--
-- Four of the fourteen named a protocol: `messages-web-search-shim` becomes
-- `anthropic-messages-web-search-shim`, and `responses-web-search-shim`,
-- `responses-image-generation-shim` and `responses-compact-shim` gain their
-- vendor as `openai-responses-*`. The other ten name a vendor dialect
-- (`vendor-deepseek`), a rewrite (`rewrite-developer-to-system`) or a usage
-- convention (`usage-exclusive-cached-tokens`) rather than a protocol, and keep
-- their spellings.
--
-- A flag id keys two places, and neither is a cache: `upstreams.flag_overrides`,
-- the per-upstream object, and `config_json.models[].flagOverrides`, the
-- per-model delta. A stale key fails in two directions and neither is loud.
-- Reading, `flagOverridesRecordSchema` accepts any string key, so the override
-- survives and simply never matches a check again — the toggle the operator set
-- silently stops applying. Writing, `parseFlagOverridesWire` rejects unknown ids
-- outright, so the next save of that upstream from the dashboard fails on a key
-- the operator never typed.
--
-- One difference from the endpoint rewrite is worth naming, because getting it
-- wrong is production-breaking rather than cosmetic. An override's value is a
-- boolean, and `json_each` hands JSON `true` back as the integer 1, so rebuilding
-- the object with a bare `json(value)` writes `{"flag": 1}` — which
-- `normalizeFlagOverrides` throws on, taking every upstream with overrides down
-- at load. The value is rebuilt from `json_each.type` instead. The endpoint map
-- is not exposed to this: its values are objects, and objects round-trip through
-- `json()` unchanged.
--
-- `json_group_object` over zero rows yields `{}` rather than NULL, so an upstream
-- with an empty override object stays empty rather than being nulled.
--
-- `models_cache_json` is left alone throughout: it is a derived catalog cache,
-- and `MODEL_CATALOG_REVISION` is bumped in the same change so older rows go
-- cold.

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(json(
      CASE WHEN json_type(model.value, '$.endpoints') = 'object'
        THEN json_set(
          json_remove(model.value, '$.endpoints'),
          '$.endpoints',
          json((
            SELECT json_group_object(
              CASE endpoint.key
                WHEN 'chatCompletions' THEN 'openaiChatCompletions'
                WHEN 'responses' THEN 'openaiResponses'
                WHEN 'messages' THEN 'anthropicMessages'
                WHEN 'completions' THEN 'openaiCompletions'
                WHEN 'embeddings' THEN 'openaiEmbeddings'
                WHEN 'imagesGenerations' THEN 'openaiImagesGenerations'
                WHEN 'imagesEdits' THEN 'openaiImagesEdits'
                WHEN 'audioTranscriptions' THEN 'openaiAudioTranscriptions'
                ELSE endpoint.key
              END,
              json(endpoint.value)
            )
            FROM json_each(json_extract(model.value, '$.endpoints')) AS endpoint
          ))
        )
        ELSE model.value
      END
    ))
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_type(config_json, '$.models') = 'array'
  AND json_array_length(json_extract(config_json, '$.models')) > 0;

UPDATE upstreams
SET config_json = json_set(
  json_remove(config_json, '$.endpoints'),
  '$.endpoints',
  json((
    SELECT json_group_object(
      CASE endpoint.key
        WHEN 'chatCompletions' THEN 'openaiChatCompletions'
        WHEN 'responses' THEN 'openaiResponses'
        WHEN 'messages' THEN 'anthropicMessages'
        WHEN 'completions' THEN 'openaiCompletions'
        WHEN 'embeddings' THEN 'openaiEmbeddings'
        WHEN 'imagesGenerations' THEN 'openaiImagesGenerations'
        WHEN 'imagesEdits' THEN 'openaiImagesEdits'
        WHEN 'audioTranscriptions' THEN 'openaiAudioTranscriptions'
        ELSE endpoint.key
      END,
      json(endpoint.value)
    )
    FROM json_each(json_extract(upstreams.config_json, '$.endpoints')) AS endpoint
  ))
)
WHERE json_type(config_json, '$.endpoints') = 'object';

UPDATE upstreams
SET flag_overrides = (
  SELECT json_group_object(
    CASE flag.key
      WHEN 'messages-web-search-shim' THEN 'anthropic-messages-web-search-shim'
      WHEN 'responses-web-search-shim' THEN 'openai-responses-web-search-shim'
      WHEN 'responses-image-generation-shim' THEN 'openai-responses-image-generation-shim'
      WHEN 'responses-compact-shim' THEN 'openai-responses-compact-shim'
      ELSE flag.key
    END,
    CASE flag.type
      WHEN 'true' THEN json('true')
      WHEN 'false' THEN json('false')
      ELSE json(flag.value)
    END
  )
  FROM json_each(upstreams.flag_overrides) AS flag
)
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides) = 'object';

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(json(
      CASE WHEN json_type(model.value, '$.flagOverrides') = 'object'
        THEN json_set(
          json_remove(model.value, '$.flagOverrides'),
          '$.flagOverrides',
          json((
            SELECT json_group_object(
              CASE flag.key
                WHEN 'messages-web-search-shim' THEN 'anthropic-messages-web-search-shim'
                WHEN 'responses-web-search-shim' THEN 'openai-responses-web-search-shim'
                WHEN 'responses-image-generation-shim' THEN 'openai-responses-image-generation-shim'
                WHEN 'responses-compact-shim' THEN 'openai-responses-compact-shim'
                ELSE flag.key
              END,
              CASE flag.type
                WHEN 'true' THEN json('true')
                WHEN 'false' THEN json('false')
                ELSE json(flag.value)
              END
            )
            FROM json_each(json_extract(model.value, '$.flagOverrides')) AS flag
          ))
        )
        ELSE model.value
      END
    ))
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_type(config_json, '$.models') = 'array'
  AND json_array_length(json_extract(config_json, '$.models')) > 0;
