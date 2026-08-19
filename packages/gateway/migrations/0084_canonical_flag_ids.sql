-- Protocol names are spelled in full everywhere, and four flag ids still
-- abbreviated one: `messages-web-search-shim` becomes
-- `anthropic-messages-web-search-shim`, and `responses-web-search-shim`,
-- `responses-image-generation-shim` and `responses-compact-shim` gain their
-- vendor as `openai-responses-*`. The other ten ids name a vendor dialect
-- (`vendor-deepseek`), a rewrite (`rewrite-developer-to-system`) or a usage
-- convention (`usage-exclusive-cached-tokens`) rather than a protocol, and keep
-- their spellings.
--
-- A flag id is authoritative operator configuration in two places, and both are
-- keyed by it: `upstreams.flag_overrides`, the per-upstream object, and
-- `config_json.models[].flagOverrides`, the per-model delta. Neither is a cache,
-- so nothing refetches them, and a stale key fails in two directions. Reading,
-- `flagOverridesRecordSchema` accepts any string key, so the override survives
-- and simply never matches a check again — the toggle the operator set silently
-- stops applying. Writing, `parseFlagOverridesWire` rejects unknown ids outright,
-- so the next save of that upstream from the dashboard fails on a key the
-- operator never typed.
--
-- This follows `0083_canonical_endpoint_keys.sql`, which performed the same
-- class of rewrite on the endpoint capability map in the same column. It differs
-- in one way that matters: an override's value is a *boolean*, and `json_each`
-- hands a JSON `true` back as the integer 1, so rebuilding the object with a
-- bare `json(value)` would rewrite `{"flag": true}` to `{"flag": 1}` and turn
-- every operator's toggles into numbers the schema rejects. The value is
-- therefore reconstructed from `json_each.type`, which still names it `true` or
-- `false`. `0083` was not exposed to this: its values are objects, and objects
-- round-trip through `json()` unchanged.
--
-- `json_group_object` over zero rows yields `{}` rather than NULL, so an upstream
-- with an empty override object stays empty rather than being nulled.

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
