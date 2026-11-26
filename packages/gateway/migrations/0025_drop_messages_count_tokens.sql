-- Strip the now-removed `endpoints.messages.countTokens` sub-field from stored
-- upstream configs. `messages` presence alone implies count_tokens (mirroring
-- the way `responses` presence implies the compact sub-path), so the boolean
-- sub-field is dead weight. The runtime validator already discards unknown
-- sub-fields on load, so this is cosmetic: it keeps stored data aligned with
-- the type definition.

-- Per-model (azure + custom): walk $.models[*].endpoints.messages and drop
-- countTokens. json_group_array over json_each rebuilds the array in place.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  json((
    SELECT json_group_array(
      CASE
        WHEN json_type(model.value, '$.endpoints.messages') = 'object'
          THEN json_set(model.value, '$.endpoints.messages', json_remove(json_extract(model.value, '$.endpoints.messages'), '$.countTokens'))
        ELSE model.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  ))
)
WHERE provider IN ('azure', 'custom')
  AND json_type(config_json, '$.models') = 'array'
  AND json_array_length(json_extract(config_json, '$.models')) > 0;

-- Custom upstream-level fallback: $.endpoints.messages.countTokens.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.endpoints.messages',
  json_remove(json_extract(config_json, '$.endpoints.messages'), '$.countTokens')
)
WHERE provider = 'custom'
  AND json_type(config_json, '$.endpoints.messages') = 'object';
