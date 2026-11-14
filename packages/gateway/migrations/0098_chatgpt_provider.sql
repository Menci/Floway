CREATE TABLE upstreams_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'chatgpt', 'claude-code', 'ollama')),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  config_json TEXT NOT NULL,
  state_json TEXT NULL,
  flag_overrides TEXT NOT NULL DEFAULT '[]',
  disabled_public_model_ids TEXT NOT NULL DEFAULT '[]',
  proxy_fallback_list_json TEXT NOT NULL DEFAULT '[]',
  model_prefix_json TEXT NULL,
  models_cache_json TEXT NULL,
  hue INTEGER NOT NULL CHECK (hue >= 0 AND hue < 360),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(config_version) = 'integer' AND config_version >= 1),
  usage_refresh_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (usage_refresh_interval_minutes >= 0)
);

INSERT INTO upstreams_new
SELECT id, CASE provider WHEN 'codex' THEN 'chatgpt' ELSE provider END, name, enabled, sort_order,
  created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids,
  proxy_fallback_list_json, model_prefix_json, models_cache_json, hue, config_version, usage_refresh_interval_minutes
FROM upstreams;

DROP TABLE upstreams;
ALTER TABLE upstreams_new RENAME TO upstreams;
CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort ON upstreams (provider, enabled, sort_order, created_at);
