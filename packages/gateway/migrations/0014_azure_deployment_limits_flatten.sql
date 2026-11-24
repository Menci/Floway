-- Flatten Azure deployment `capabilities.{limits, supports}` into top-level
-- `limits` to match the post-a21a4af AzureDeploymentConfig schema.
--
-- Commit a21a4af ("refactor(providers): slim public model DTO") dropped the
-- `capabilities` wrapper from AzureDeploymentConfig: `limits` moved to the
-- top level, and `supports.*` plus `max_non_streaming_output_tokens` were
-- removed entirely. The runtime parser at apps/api/src/shared/upstream/azure.ts
-- now reads only `value.limits`, so existing rows with `capabilities.limits`
-- silently lose their limits — the dashboard form shows blank fields and
-- /models renders no context-limit badges.
--
-- For each azure upstream, rebuild `config_json.deployments` so that every
-- entry has `capabilities` stripped and `limits` rewritten at the top level.
-- COALESCE prefers the legacy `capabilities.limits.*` source but falls back
-- to any existing top-level `limits.*` so a partially-migrated row is not
-- clobbered. Missing per-field values stay omitted via json_patch's RFC 7396
-- null-removal semantics, which the schema accepts (every limits field is
-- optional). Deployments without any limits data resolve to `limits: {}`,
-- also accepted.

UPDATE upstreams
SET config_json = (
  SELECT json_set(
    config_json,
    '$.deployments',
    json((
      SELECT json_group_array(
        json_patch(
          json_remove(deployment.value, '$.capabilities'),
          json_object(
            'limits', json_object(
              'max_context_window_tokens', COALESCE(
                json_extract(deployment.value, '$.capabilities.limits.max_context_window_tokens'),
                json_extract(deployment.value, '$.limits.max_context_window_tokens')
              ),
              'max_prompt_tokens', COALESCE(
                json_extract(deployment.value, '$.capabilities.limits.max_prompt_tokens'),
                json_extract(deployment.value, '$.limits.max_prompt_tokens')
              ),
              'max_output_tokens', COALESCE(
                json_extract(deployment.value, '$.capabilities.limits.max_output_tokens'),
                json_extract(deployment.value, '$.limits.max_output_tokens')
              )
            )
          )
        )
      )
      FROM json_each(json_extract(upstreams.config_json, '$.deployments')) AS deployment
    ))
  )
)
WHERE provider = 'azure';
