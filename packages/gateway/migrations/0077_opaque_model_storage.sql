-- Model identifiers are JSON string scalars at rest. The representation keeps
-- every JavaScript string reversible through SQLite-family drivers, including
-- strings containing embedded NUL, and the column names make that contract
-- visible to every future query.
-- https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/util/sqlite.c%2B%2B#L1591-L1600
-- https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/util/sqlite.c%2B%2B#L1738-L1743
-- https://github.com/sqlite/sqlite/blob/a790e273e2a10573e8d4c5267d494b451044fb23/src/sqlite.h.in#L4957-L4972
-- https://tc39.es/ecma262/multipage/structured-data.html#sec-quotejsonstring

CREATE TABLE usage_with_model_json (
  key_id TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK (json_valid(model_json) AND json_type(model_json) = 'text'),
  upstream TEXT,
  model_key_json TEXT NOT NULL CHECK (json_valid(model_key_json) AND json_type(model_key_json) = 'text'),
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  metric TEXT NOT NULL CHECK (length(metric) > 0),
  quantity TEXT NOT NULL CHECK (length(quantity) > 0),
  unit_price TEXT
);

INSERT INTO usage_with_model_json (
  key_id, model_json, upstream, model_key_json, hour,
  pricing_selector, metric, quantity, unit_price
)
SELECT
  key_id, json_quote(model), upstream, json_quote(model_key), hour,
  pricing_selector, metric, quantity, unit_price
FROM usage;

DROP TABLE usage;
ALTER TABLE usage_with_model_json RENAME TO usage;
CREATE UNIQUE INDEX idx_usage_metric_identity
  ON usage (key_id, model_json, COALESCE(upstream, ''), model_key_json, hour, pricing_selector, metric);
CREATE INDEX idx_usage_metric_hour ON usage (hour);

CREATE TABLE usage_requests_with_model_json (
  key_id TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK (json_valid(model_json) AND json_type(model_json) = 'text'),
  upstream TEXT,
  model_key_json TEXT NOT NULL CHECK (json_valid(model_key_json) AND json_type(model_key_json) = 'text'),
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_with_model_json (
  key_id, model_json, upstream, model_key_json, hour, pricing_selector, requests
)
SELECT
  key_id, json_quote(model), upstream, json_quote(model_key), hour, pricing_selector, requests
FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_with_model_json RENAME TO usage_requests;
CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model_json, COALESCE(upstream, ''), model_key_json, hour, pricing_selector);
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);

CREATE TABLE performance_summary_with_model_json (
  hour               TEXT    NOT NULL,
  key_id             TEXT    NOT NULL,
  model_json         TEXT    NOT NULL CHECK (json_valid(model_json) AND json_type(model_json) = 'text'),
  upstream           TEXT    NOT NULL,
  operation          TEXT    NOT NULL CHECK (length(operation) > 0),
  runtime_location   TEXT    NOT NULL DEFAULT 'unknown',
  requests           INTEGER NOT NULL DEFAULT 0,
  ttft_samples_ok    INTEGER NOT NULL DEFAULT 0,
  errors_with_output INTEGER NOT NULL DEFAULT 0,
  errors_no_output   INTEGER NOT NULL DEFAULT 0,
  neutral            INTEGER NOT NULL DEFAULT 0,
  tpot_samples       INTEGER NOT NULL DEFAULT 0,
  ttft_ms_sum        INTEGER NOT NULL DEFAULT 0,
  tpot_us_sum        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model_json, upstream, operation, runtime_location)
);

INSERT INTO performance_summary_with_model_json (
  hour, key_id, model_json, upstream, operation, runtime_location,
  requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
  tpot_samples, ttft_ms_sum, tpot_us_sum
)
SELECT
  hour, key_id, json_quote(model), upstream, operation, runtime_location,
  requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral,
  tpot_samples, ttft_ms_sum, tpot_us_sum
FROM performance_summary;

DROP TABLE performance_summary;
ALTER TABLE performance_summary_with_model_json RENAME TO performance_summary;
CREATE INDEX idx_performance_summary_hour ON performance_summary (hour);

CREATE TABLE performance_buckets_with_model_json (
  hour             TEXT    NOT NULL,
  key_id           TEXT    NOT NULL,
  model_json       TEXT    NOT NULL CHECK (json_valid(model_json) AND json_type(model_json) = 'text'),
  upstream         TEXT    NOT NULL,
  operation        TEXT    NOT NULL CHECK (length(operation) > 0),
  runtime_location TEXT    NOT NULL DEFAULT 'unknown',
  metric           TEXT    NOT NULL CHECK (metric IN ('ttft_ms', 'tpot_us')),
  lower            INTEGER NOT NULL,
  upper            INTEGER,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, key_id, model_json, upstream, operation, runtime_location, metric, lower)
);

INSERT INTO performance_buckets_with_model_json (
  hour, key_id, model_json, upstream, operation, runtime_location,
  metric, lower, upper, count
)
SELECT
  hour, key_id, json_quote(model), upstream, operation, runtime_location,
  metric, lower, upper, count
FROM performance_buckets;

DROP TABLE performance_buckets;
ALTER TABLE performance_buckets_with_model_json RENAME TO performance_buckets;
CREATE INDEX idx_performance_buckets_hour ON performance_buckets (hour);

CREATE TABLE search_config_with_model_json (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  tavily_api_key TEXT NOT NULL DEFAULT '',
  microsoft_web_iq_api_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  jina_api_key TEXT NOT NULL DEFAULT '',
  passthrough_openai_search INTEGER NOT NULL DEFAULT 0 CHECK (passthrough_openai_search IN (0, 1)),
  alpha_search_upstream_id TEXT NOT NULL DEFAULT '',
  alpha_search_model_json TEXT NOT NULL DEFAULT '""'
    CHECK (json_valid(alpha_search_model_json) AND json_type(alpha_search_model_json) = 'text')
);

INSERT INTO search_config_with_model_json (
  id, provider, tavily_api_key, microsoft_web_iq_api_key, updated_at,
  jina_api_key, passthrough_openai_search, alpha_search_upstream_id,
  alpha_search_model_json
)
SELECT
  id, provider, tavily_api_key, microsoft_web_iq_api_key, updated_at,
  jina_api_key, passthrough_openai_search, alpha_search_upstream_id,
  json_quote(alpha_search_model)
FROM search_config;

DROP TABLE search_config;
ALTER TABLE search_config_with_model_json RENAME TO search_config;
