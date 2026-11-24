-- Unify Azure and Custom upstream model configuration onto a single
-- `config.models[]` list of UpstreamModelConfig entries.
--
-- The runtime parsers in apps/api/src/shared/upstream/{azure,custom}.ts now
-- read models from `config.models[]`, where each entry keys its upstream id
-- as `upstreamModelId`. Two stored shapes predate this and would brick on
-- load:
--
--   * Azure stored its model list under `config.deployments[]`, with the
--     upstream id keyed as `deployment`. `assertAzureUpstreamRecord` no
--     longer looks at `deployments` and requires a non-empty `models[]`, so
--     an unmigrated azure row resolves to zero models and throws.
--   * Custom stored the `/models` fetch path under
--     `config.pathOverrides.models`. The fetch toggle moved to
--     `config.modelsFetch = { enabled, endpoint }`; `pathOverridesField`
--     rejects a `models` key outright, so an unmigrated custom row throws.
--
-- Azure: rebuild `config.models` from `config.deployments`, renaming each
-- entry's `deployment` to `upstreamModelId` and dropping `deployment`. All
-- other per-entry keys (publicModelId, supportedEndpoints, display_name,
-- limits, cost, flagOverrides) carry over untouched. The old `deployments`
-- key is removed. The guard skips rows that have no `deployments` (already
-- migrated or never azure-with-deployments). An empty `deployments: []` was
-- already invalid before this migration (azure requires a non-empty list),
-- so it is not special-cased: it maps to an equally-invalid `models: []`.
UPDATE upstreams
SET config_json = json_set(
  json_remove(config_json, '$.deployments'),
  '$.models',
  json((
    SELECT json_group_array(
      json_set(
        json_remove(d.value, '$.deployment'),
        '$.upstreamModelId', json_extract(d.value, '$.deployment')
      )
    )
    FROM json_each(json_extract(upstreams.config_json, '$.deployments')) AS d
  ))
)
WHERE provider = 'azure'
  AND json_extract(config_json, '$.deployments') IS NOT NULL;

-- Custom: move the `/models` path off `pathOverrides` onto the new fetch
-- toggle and seed an empty manual model list. Existing custom upstreams
-- fetched their model list unconditionally, so `enabled: true` preserves
-- that behavior. `endpoint` carries the old `pathOverrides.models` value, or
-- JSON null when there was no override — `modelsFetchField` treats a null,
-- empty, or absent endpoint as "use the default /models path". The
-- `pathOverrides.models` key is removed; other path overrides stay.
-- `config.models` is seeded to `[]` when absent so the manual list is always
-- present.
--
-- The value expressions read the original `config_json` column (not the
-- intermediate `json_remove` result): SQLite resolves each json_set value
-- argument against the row's stored column value, so removing
-- `pathOverrides.models` in the first argument does not affect the
-- `json_extract` that recovers the endpoint here.
UPDATE upstreams
SET config_json = json_set(
  json_remove(config_json, '$.pathOverrides.models'),
  '$.modelsFetch', json_object('enabled', json('true'), 'endpoint', json_extract(config_json, '$.pathOverrides.models')),
  '$.models', COALESCE(json_extract(config_json, '$.models'), json('[]'))
)
WHERE provider = 'custom';
