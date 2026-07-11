-- Add the per-request input-length pricing coordinate to `usage` +
-- `usage_requests`.
--
-- `input_above_tokens` is the `inputAboveTokens` selector the request's total
-- input crossed (OpenAI charges a higher full-request rate past 272k input tokens for
-- the GPT-5.6 family). It is orthogonal to `tier` (the upstream-stamped service
-- tier): the two are the coordinates of a (service tier × input length) pricing
-- grid, and each usage bucket is one grid cell. The band is selected before
-- persistence from the prompt size, so requests of different prompt sizes bucket
-- separately and resolve distinct unit prices. Recording writes NULL for the
-- base band and a positive threshold otherwise; the CHECK rejects 0 and
-- negatives because the unique index folds NULL under COALESCE(input_above_tokens,
-- 0) — a real band is always a positive threshold that SQLite would otherwise
-- treat as distinct-from-NULL under UNIQUE.
--
-- SQLite cannot add a column to the middle of a UNIQUE INDEX in place, so both
-- tables are recreated. Existing rows backfill `input_above_tokens = NULL`,
-- which the aggregator treats as base-band pricing — historical buckets compute
-- identically.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  input_above_tokens INTEGER CHECK (input_above_tokens IS NULL OR input_above_tokens > 0),
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, tier, input_above_tokens, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model_key, hour, tier, NULL, dimension, tokens, unit_price FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), COALESCE(input_above_tokens, 0), dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

CREATE TABLE usage_requests_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  input_above_tokens INTEGER CHECK (input_above_tokens IS NULL OR input_above_tokens > 0),
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_new (key_id, model, upstream, model_key, hour, tier, input_above_tokens, requests)
  SELECT key_id, model, upstream, model_key, hour, tier, NULL, requests FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_new RENAME TO usage_requests;

CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), COALESCE(input_above_tokens, 0));
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
