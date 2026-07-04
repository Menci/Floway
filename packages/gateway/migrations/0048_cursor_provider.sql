-- SQLite CHECK constraints on `upstreams.provider` are immutable; the standard
-- pattern in this repo is to rebuild the table (see 0027_codex_provider.sql,
-- 0034_ollama_provider.sql, 0038_claude_code_provider.sql). The new value
-- 'cursor' joins the existing six kinds; no row data changes.

CREATE TABLE upstreams_new (
  id                         TEXT PRIMARY KEY,
  provider                   TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'codex', 'ollama', 'claude-code', 'cursor')),
  name                       TEXT NOT NULL,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  config_json                TEXT NOT NULL,
  state_json                 TEXT NULL,
  flag_overrides             TEXT NOT NULL DEFAULT '[]',
  disabled_public_model_ids  TEXT NOT NULL DEFAULT '[]',
  proxy_fallback_list_json   TEXT NOT NULL DEFAULT '[]',
  model_prefix_json          TEXT NULL
);

INSERT INTO upstreams_new
  (id, provider, name, enabled, sort_order, created_at, updated_at,
   config_json, state_json, flag_overrides, disabled_public_model_ids,
   proxy_fallback_list_json, model_prefix_json)
SELECT
   id, provider, name, enabled, sort_order, created_at, updated_at,
   config_json, state_json, flag_overrides, disabled_public_model_ids,
   proxy_fallback_list_json, model_prefix_json
FROM upstreams;

DROP TABLE upstreams;
ALTER TABLE upstreams_new RENAME TO upstreams;

CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);