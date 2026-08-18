-- Protocol names are spelled in full everywhere, including the structured
-- `endpoints` capability map: `chatCompletions` becomes `openaiChatCompletions`,
-- `responses` becomes `openaiResponses`, and `messages` becomes
-- `anthropicMessages`.
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
-- `models_cache_json` is left alone: it is a derived catalog cache, and
-- `MODEL_CATALOG_REVISION` is bumped in the same change so older rows go cold.

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
        ELSE endpoint.key
      END,
      json(endpoint.value)
    )
    FROM json_each(json_extract(upstreams.config_json, '$.endpoints')) AS endpoint
  ))
)
WHERE json_type(config_json, '$.endpoints') = 'object';
