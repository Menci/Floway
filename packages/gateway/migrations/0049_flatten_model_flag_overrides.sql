-- Flatten UpstreamModelConfig.flagOverrides. The prior wire shape was
-- `{ enabled: boolean, values: Record<string, boolean> }`; the new shape is
-- `Record<string, boolean>` directly. `enabled: false` had the same layer-3
-- effect as an absent field (skip the per-model layer entirely), so it
-- collapses to unset — the presence of the field is now the sole toggle.
--
-- Rewrite per config.models[] entry:
--   * `flagOverrides.enabled: true`  → replace flagOverrides with its
--     inner `values` dict.
--   * `flagOverrides.enabled: false` → drop flagOverrides entirely.
--   * entries with no `.enabled` subkey (already-flat or absent) are
--     passed through byte-for-byte.
--
-- Rebuild config.models via json_group_array(CASE …) so untouched entries
-- fall through the ELSE branch unchanged. The outer EXISTS gate is a
-- perf hedge, not a correctness gate — rows that hold zero wrapped
-- entries would just rewrite themselves to the same JSON, but skipping
-- the rebuild avoids that write on every re-run. Idempotent: on a
-- second pass every row lands in the ELSE branch, EXISTS returns false,
-- nothing is written.

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(
      CASE
        WHEN json_extract(model.value, '$.flagOverrides.enabled') = 1
        THEN json_set(
          model.value,
          '$.flagOverrides',
          json_extract(model.value, '$.flagOverrides.values')
        )
        WHEN json_extract(model.value, '$.flagOverrides.enabled') = 0
        THEN json_remove(model.value, '$.flagOverrides')
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
    WHERE json_type(model.value, '$.flagOverrides.enabled') IS NOT NULL
  );
