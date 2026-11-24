-- Strip `/embeddings` and `/v1/embeddings` from custom upstream
-- supportedEndpoints. The new shape only declares chat-protocol availability
-- (`/chat/completions`, `/responses`, `/v1/messages`); embeddings routing is
-- now per-model via the `kind` discriminator (Tier 1 reads upstream-published
-- `kind`; Tier 2 falls back to an id heuristic). The runtime validator in
-- apps/api/src/shared/upstream/custom.ts rejects rows that still carry the
-- legacy embedding paths, so leaving them in place would brick existing
-- custom upstreams.
--
-- For each custom upstream, rebuild config_json.supportedEndpoints by
-- filtering out the two embedding paths. We keep insertion order from the
-- source array.

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.supportedEndpoints',
  json(COALESCE(
    (
      SELECT json_group_array(endpoint.value)
      FROM json_each(json_extract(upstreams.config_json, '$.supportedEndpoints')) AS endpoint
      WHERE endpoint.value NOT IN ('/embeddings', '/v1/embeddings')
    ),
    json('[]')
  ))
)
WHERE provider = 'custom'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.supportedEndpoints')) AS endpoint
    WHERE endpoint.value IN ('/embeddings', '/v1/embeddings')
  );
