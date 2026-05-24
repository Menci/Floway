-- Consolidate the legacy `deepseek-reasoning-dialect` flag into
-- `vendor-deepseek`. The vendor refactor makes `vendor-deepseek` own ALL
-- DeepSeek wire-dialect translations on Chat Completions: the
-- reasoning_content / reasoning_text dialect that this legacy flag gated,
-- plus the canonical-reasoning-sentinel → thinking-disabled rewrite, the
-- prompt_cache_hit_tokens / prompt_cache_miss_tokens usage remap, and the
-- json_schema → json_object response_format downgrade. The legacy id is
-- dropped from the catalog (apps/api/src/data-plane/providers/flags.ts),
-- so any saved row that still carries it would be rejected at write time
-- by parseFlagOverridesWire's "Unknown flag_overrides ids" guard.
--
-- Two passes, mirroring the two locations the flag could live:
--   1. upstreams.flag_overrides (every provider kind)
--   2. upstreams.config_json.deployments[*].flagOverrides.values (Azure only)
--
-- Rewrite rule (same in both passes):
--   * `deepseek-reasoning-dialect: true` → also set `vendor-deepseek: true`
--     (preserves the user's intent that this is a DeepSeek upstream), then
--     remove the legacy key.
--   * `deepseek-reasoning-dialect: false` → remove the legacy key only.
--     Whatever `vendor-deepseek` was at remains.

-- Pass 1: upstream-level flag_overrides.
UPDATE upstreams
SET flag_overrides = json_set(
  json_remove(flag_overrides, '$."deepseek-reasoning-dialect"'),
  '$."vendor-deepseek"',
  json('true')
)
WHERE json_valid(flag_overrides)
  AND json_extract(flag_overrides, '$."deepseek-reasoning-dialect"') = 1;

UPDATE upstreams
SET flag_overrides = json_remove(flag_overrides, '$."deepseek-reasoning-dialect"')
WHERE json_valid(flag_overrides)
  AND json_extract(flag_overrides, '$."deepseek-reasoning-dialect"') IS NOT NULL;

-- Pass 2: Azure per-deployment overrides
-- (config_json.deployments[*].flagOverrides.values). Rebuild the deployments
-- array via json_group_array(CASE…) so each affected deployment's
-- `flagOverrides.values` dict is replaced in place; deployments without the
-- legacy flag fall through the ELSE branch and stay byte-for-byte unchanged.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.deployments',
  (
    SELECT json_group_array(
      CASE
        WHEN json_extract(deployment.value, '$.flagOverrides.values."deepseek-reasoning-dialect"') = 1
        THEN json_set(
          deployment.value,
          '$.flagOverrides.values',
          json_set(
            json_remove(
              json_extract(deployment.value, '$.flagOverrides.values'),
              '$."deepseek-reasoning-dialect"'
            ),
            '$."vendor-deepseek"',
            json('true')
          )
        )
        WHEN json_extract(deployment.value, '$.flagOverrides.values."deepseek-reasoning-dialect"') IS NOT NULL
        THEN json_set(
          deployment.value,
          '$.flagOverrides.values',
          json_remove(
            json_extract(deployment.value, '$.flagOverrides.values'),
            '$."deepseek-reasoning-dialect"'
          )
        )
        ELSE deployment.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.deployments')) AS deployment
  )
)
WHERE provider = 'azure'
  AND json_valid(config_json)
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.deployments')) AS deployment
    WHERE json_extract(deployment.value, '$.flagOverrides.values."deepseek-reasoning-dialect"') IS NOT NULL
  );
