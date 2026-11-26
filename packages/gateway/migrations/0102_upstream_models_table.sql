-- Split upstream model catalogs and operator-authored manual models out of
-- `upstreams` into dedicated tables, and normalize `model_prefix_json` and
-- catalog refresh metadata into scalar columns on `upstreams`.
--
-- D1 rejects `ALTER TABLE ... DROP COLUMN` on older tables, and
-- `proxy_upstream_backoffs` references `upstreams(id) ON DELETE CASCADE` under
-- `PRAGMA foreign_keys = ON`. Snapshot both `proxy_upstream_backoffs` and the
-- source columns we need before rebuilding `upstreams`, then recreate and
-- repopulate the dependent tables inside the same migration transaction.

CREATE TABLE _migration_0102_proxy_upstream_backoffs AS
SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at
FROM proxy_upstream_backoffs;

CREATE TABLE _migration_0102_upstream_sources AS
SELECT id, provider, config_json, disabled_public_model_ids, models_cache_json
FROM upstreams;

DROP TABLE proxy_upstream_backoffs;

CREATE TABLE upstreams_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'chatgpt', 'claude-code', 'kimi-code', 'ollama')),
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
  model_prefix TEXT NULL,
  model_prefix_addressable TEXT NULL CHECK (model_prefix_addressable IN ('unprefixed', 'prefixed', 'both')),
  model_prefix_listed TEXT NULL CHECK (model_prefix_listed IN ('none', 'unprefixed', 'prefixed', 'both')),
  models_cache_revision INTEGER NULL,
  models_cache_fetched_at INTEGER NULL CHECK (models_cache_fetched_at IS NULL OR models_cache_fetched_at > 0),
  models_cache_error_message TEXT NULL,
  models_cache_error_at INTEGER NULL,
  models_cache_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(models_cache_failure_count) = 'integer' AND models_cache_failure_count >= 0),
  hue INTEGER NOT NULL CHECK (hue >= 0 AND hue < 360),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  usage_refresh_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (usage_refresh_interval_minutes >= 0),
  CHECK (
    (model_prefix IS NULL AND model_prefix_addressable IS NULL AND model_prefix_listed IS NULL)
    OR (
      model_prefix IS NOT NULL
      AND model_prefix_addressable IS NOT NULL
      AND model_prefix_listed IS NOT NULL
      AND (
        model_prefix_listed = 'none'
        OR model_prefix_addressable = 'both'
        OR model_prefix_listed = model_prefix_addressable
      )
    )
  ),
  CHECK (
    (models_cache_error_message IS NULL AND models_cache_error_at IS NULL AND models_cache_failure_count = 0)
    OR (models_cache_error_message IS NOT NULL AND models_cache_error_at IS NOT NULL AND models_cache_failure_count > 0)
  )
);

INSERT INTO upstreams_new (
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  model_prefix,
  model_prefix_addressable,
  model_prefix_listed,
  models_cache_revision,
  models_cache_fetched_at,
  models_cache_error_message,
  models_cache_error_at,
  models_cache_failure_count,
  hue,
  version,
  usage_refresh_interval_minutes
)
SELECT
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  CASE
    WHEN provider IN ('custom', 'azure', 'ollama') AND json_valid(config_json)
      THEN json_remove(config_json, '$.models')
    ELSE config_json
  END,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  CASE
    WHEN model_prefix_json IS NOT NULL THEN json_extract(model_prefix_json, '$.prefix')
    ELSE NULL
  END,
  CASE
    WHEN model_prefix_json IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.addressable') WHERE value = 'unprefixed')
      AND EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.addressable') WHERE value = 'prefixed')
      THEN 'both'
    WHEN EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.addressable') WHERE value = 'prefixed')
      THEN 'prefixed'
    ELSE 'unprefixed'
  END,
  CASE
    WHEN model_prefix_json IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.listed') WHERE value = 'unprefixed')
      AND EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.listed') WHERE value = 'prefixed')
      THEN 'both'
    WHEN EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.listed') WHERE value = 'prefixed')
      THEN 'prefixed'
    WHEN EXISTS (SELECT 1 FROM json_each(model_prefix_json, '$.listed') WHERE value = 'unprefixed')
      THEN 'unprefixed'
    ELSE 'none'
  END,
  CASE
    WHEN models_cache_json IS NOT NULL
      AND json_valid(models_cache_json)
      AND json_type(models_cache_json, '$.revision') = 'integer'
      THEN CAST(json_extract(models_cache_json, '$.revision') AS INTEGER)
    ELSE NULL
  END,
  CASE
    WHEN models_cache_json IS NOT NULL
      AND json_valid(models_cache_json)
      AND json_type(models_cache_json, '$.fetchedAt') IN ('integer', 'real')
      AND json_extract(models_cache_json, '$.fetchedAt') > 0
      THEN CAST(json_extract(models_cache_json, '$.fetchedAt') AS INTEGER)
    ELSE NULL
  END,
  CASE
    WHEN models_cache_json IS NOT NULL
      AND json_valid(models_cache_json)
      AND json_type(models_cache_json, '$.lastError') = 'object'
      AND json_type(models_cache_json, '$.lastError.message') = 'text'
      AND json_type(models_cache_json, '$.lastError.at') IN ('integer', 'real')
      THEN json_extract(models_cache_json, '$.lastError.message')
    ELSE NULL
  END,
  CASE
    WHEN models_cache_json IS NOT NULL
      AND json_valid(models_cache_json)
      AND json_type(models_cache_json, '$.lastError') = 'object'
      AND json_type(models_cache_json, '$.lastError.message') = 'text'
      AND json_type(models_cache_json, '$.lastError.at') IN ('integer', 'real')
      THEN CAST(json_extract(models_cache_json, '$.lastError.at') AS INTEGER)
    ELSE NULL
  END,
  CASE
    WHEN models_cache_json IS NOT NULL
      AND json_valid(models_cache_json)
      AND json_type(models_cache_json, '$.lastError') = 'object'
      AND json_type(models_cache_json, '$.lastError.message') = 'text'
      AND json_type(models_cache_json, '$.lastError.at') IN ('integer', 'real')
      THEN max(1, CAST(coalesce(json_extract(models_cache_json, '$.lastError.failureCount'), 1) AS INTEGER))
    ELSE 0
  END,
  hue,
  config_version,
  usage_refresh_interval_minutes
FROM upstreams;

DROP TABLE upstreams;
ALTER TABLE upstreams_new RENAME TO upstreams;

CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort ON upstreams (provider, enabled, sort_order, created_at);
CREATE INDEX idx_upstreams_model_prefix ON upstreams (model_prefix) WHERE model_prefix IS NOT NULL;

CREATE TABLE proxy_upstream_backoffs (
  proxy_id      TEXT NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  upstream_id   TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  last_error    TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);

INSERT INTO proxy_upstream_backoffs (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at
FROM _migration_0102_proxy_upstream_backoffs;

CREATE INDEX idx_proxy_upstream_backoffs_upstream ON proxy_upstream_backoffs (upstream_id);

DROP TABLE _migration_0102_proxy_upstream_backoffs;

CREATE TABLE upstream_models (
  upstream_id       TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  upstream_model_id TEXT NOT NULL,
  kind              TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
  disabled          INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  model_json        TEXT NOT NULL,
  PRIMARY KEY (upstream_id, model_id, kind)
);

CREATE INDEX idx_upstream_models_model_id ON upstream_models (model_id, disabled, kind);
CREATE INDEX idx_upstream_models_upstream_active ON upstream_models (upstream_id, disabled, model_id);

CREATE TABLE upstream_manual_models (
  upstream_id       TEXT NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0),
  upstream_model_id TEXT NOT NULL,
  public_model_id   TEXT NOT NULL,
  kind              TEXT NOT NULL,
  config_json       TEXT NOT NULL,
  PRIMARY KEY (upstream_id, position)
);

-- Expand persisted routable models from the legacy models_cache_json snapshot
-- so existing deployments come up warm without a cold-start refresh burst.
INSERT OR IGNORE INTO upstream_models (
  upstream_id,
  model_id,
  upstream_model_id,
  kind,
  source,
  disabled,
  model_json
)
SELECT
  s.id,
  json_extract(m.value, '$.id'),
  json_extract(m.value, '$.upstreamModelId'),
  json_extract(m.value, '$.kind'),
  CASE
    WHEN s.provider = 'azure' THEN 'manual'
    WHEN s.provider IN ('custom', 'ollama')
      AND json_valid(s.config_json)
      AND json_type(s.config_json, '$.models') = 'array'
      AND EXISTS (
        SELECT 1
        FROM json_each(s.config_json, '$.models') cm
        WHERE json_extract(cm.value, '$.upstreamModelId') = json_extract(m.value, '$.upstreamModelId')
      )
      THEN 'manual'
    ELSE 'auto'
  END,
  CASE
    WHEN json_valid(s.disabled_public_model_ids)
      AND json_type(s.disabled_public_model_ids) = 'array'
      AND EXISTS (
        SELECT 1
        FROM json_each(s.disabled_public_model_ids) d
        WHERE d.value = json_extract(m.value, '$.id')
      )
      THEN 1
    ELSE 0
  END,
  m.value
FROM _migration_0102_upstream_sources s,
  json_each(s.models_cache_json, '$.models') m
WHERE s.models_cache_json IS NOT NULL
  AND json_valid(s.models_cache_json)
  AND json_type(s.models_cache_json, '$.fetchedAt') IN ('integer', 'real')
  AND json_extract(s.models_cache_json, '$.fetchedAt') > 0
  AND json_type(s.models_cache_json, '$.models') = 'array'
  AND json_type(m.value, '$.id') = 'text'
  AND json_extract(m.value, '$.id') != ''
  AND json_type(m.value, '$.upstreamModelId') = 'text'
  AND json_type(m.value, '$.kind') = 'text'
ORDER BY s.id, CAST(m.key AS INTEGER);

-- Extract operator-authored manual models out of config_json.
INSERT INTO upstream_manual_models (
  upstream_id,
  position,
  upstream_model_id,
  public_model_id,
  kind,
  config_json
)
SELECT
  s.id,
  CAST(m.key AS INTEGER),
  json_extract(m.value, '$.upstreamModelId'),
  CASE
    WHEN json_type(m.value, '$.publicModelId') = 'text'
      AND trim(json_extract(m.value, '$.publicModelId')) != ''
      THEN trim(json_extract(m.value, '$.publicModelId'))
    ELSE json_extract(m.value, '$.upstreamModelId')
  END,
  coalesce(json_extract(m.value, '$.kind'), 'chat'),
  m.value
FROM _migration_0102_upstream_sources s,
  json_each(s.config_json, '$.models') m
WHERE s.provider IN ('custom', 'azure', 'ollama')
  AND json_valid(s.config_json)
  AND json_type(s.config_json, '$.models') = 'array'
  AND json_type(m.value, '$.upstreamModelId') = 'text';

DROP TABLE _migration_0102_upstream_sources;
