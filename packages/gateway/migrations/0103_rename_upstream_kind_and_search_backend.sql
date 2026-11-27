-- Rename AI upstream column `upstreams.provider` -> `upstreams.kind` (and its
-- index), migrate cached `upstream_models.model_json` key `$.providerData` ->
-- `$.upstreamData`, and rename web search columns `search_config.provider` and
-- `search_usage.provider` -> `backend`.

DROP INDEX idx_upstreams_provider_enabled_sort;
ALTER TABLE upstreams RENAME COLUMN provider TO kind;
CREATE INDEX idx_upstreams_kind_enabled_sort ON upstreams (kind, enabled, sort_order, created_at);

UPDATE upstream_models
SET model_json = json_set(
  json_remove(model_json, '$.providerData'),
  '$.upstreamData',
  model_json -> '$.providerData'
)
WHERE json_type(model_json, '$.providerData') IS NOT NULL;

ALTER TABLE search_config RENAME COLUMN provider TO backend;
ALTER TABLE search_usage RENAME COLUMN provider TO backend;
