-- Migrate the per-model `supportedEndpoints` path array and the custom
-- upstream-level `supportedEndpoints` path array into the structured `endpoints`
-- capability map used by the current code.
--
-- The capability model is now a single concept: a present key means the model
-- (or upstream) serves that endpoint. Public paths (`/chat/completions`,
-- `/v1/responses`, ...) become structured keys (`chatCompletions`, `responses`,
-- ...). The runtime parser rejects the old array shape, so unmigrated rows would
-- brick their upstream; this rewrites them in place.

-- Per-model: rebuild config_json.models[], turning each model's
-- supportedEndpoints path array into endpoints, for azure and custom.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  json((
    SELECT json_group_array(
      json_set(
        json_remove(model.value, '$.supportedEndpoints'),
        '$.endpoints',
        json((
          SELECT json_group_object(k, json_object())
          FROM (
            SELECT DISTINCT
              CASE endpoint.value
                WHEN '/chat/completions' THEN 'chatCompletions'
                WHEN '/v1/chat/completions' THEN 'chatCompletions'
                WHEN '/responses' THEN 'responses'
                WHEN '/v1/responses' THEN 'responses'
                WHEN '/v1/messages' THEN 'messages'
                WHEN '/messages' THEN 'messages'
                WHEN '/embeddings' THEN 'embeddings'
                WHEN '/v1/embeddings' THEN 'embeddings'
                WHEN '/images/generations' THEN 'imagesGenerations'
                WHEN '/v1/images/generations' THEN 'imagesGenerations'
                WHEN '/images/edits' THEN 'imagesEdits'
                WHEN '/v1/images/edits' THEN 'imagesEdits'
              END AS k
            FROM json_each(json_extract(model.value, '$.supportedEndpoints')) AS endpoint
          )
        ))
      )
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  ))
)
WHERE provider IN ('azure', 'custom')
  AND json_type(config_json, '$.models') = 'array'
  AND json_array_length(json_extract(config_json, '$.models')) > 0;

-- Custom upstream-level: rebuild the top-level supportedEndpoints path array
-- into the structured endpoints map (chat protocols only).
UPDATE upstreams
SET config_json = json_set(
  json_remove(config_json, '$.supportedEndpoints'),
  '$.endpoints',
  json((
    SELECT json_group_object(k, json_object())
    FROM (
      SELECT DISTINCT
        CASE endpoint.value
          WHEN '/chat/completions' THEN 'chatCompletions'
          WHEN '/v1/chat/completions' THEN 'chatCompletions'
          WHEN '/responses' THEN 'responses'
          WHEN '/v1/responses' THEN 'responses'
          WHEN '/v1/messages' THEN 'messages'
          WHEN '/messages' THEN 'messages'
        END AS k
      FROM json_each(json_extract(upstreams.config_json, '$.supportedEndpoints')) AS endpoint
    )
  ))
)
WHERE provider = 'custom'
  AND json_type(config_json, '$.supportedEndpoints') = 'array';
