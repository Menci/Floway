-- Drop the `retry-cyber-policy` flag. The Responses interceptor it gated is
-- gone, so the id no longer exists in the flag catalog
-- (packages/provider/src/flags.ts) and a saved row that still carries it
-- would be rejected at write time by parseFlagOverridesWire's "Unknown
-- flag_overrides ids" guard, and at read time by the per-model
-- flagOverridesField validator.
--
-- Two passes, mirroring the two locations the flag could live:
--   1. upstreams.flag_overrides (every provider kind)
--   2. upstreams.config_json.models[*].flagOverrides (manual model rows)
--
-- Both passes only remove the key; no other flag changes meaning.

-- Pass 1: upstream-level flag_overrides.
UPDATE upstreams
SET flag_overrides = json_remove(flag_overrides, '$."retry-cyber-policy"')
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides, '$."retry-cyber-policy"') IS NOT NULL;

-- Pass 2: per-model overrides (config_json.models[*].flagOverrides). Rebuild
-- the models array via json_group_array(CASE …) so entries without the flag
-- fall through the ELSE branch byte-for-byte unchanged. The outer EXISTS gate
-- keeps the rewrite off rows that hold no affected entry, which also makes a
-- re-run a no-op.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type(model.value, '$.flagOverrides."retry-cyber-policy"') IS NOT NULL
        THEN json_set(
          model.value,
          '$.flagOverrides',
          json_remove(
            json_extract(model.value, '$.flagOverrides'),
            '$."retry-cyber-policy"'
          )
        )
        ELSE model.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.flagOverrides."retry-cyber-policy"') IS NOT NULL
  );
