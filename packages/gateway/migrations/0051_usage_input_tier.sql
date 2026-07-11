-- Add the per-request input-length pricing tier column to `usage` +
-- `usage_requests`.
--
-- `input_tier` is the `minInputTokens` threshold the request's total input
-- crossed (OpenAI's long-context pricing charges a higher full-request rate
-- past 272k for the GPT-5.6 family). It is orthogonal to `tier` (the upstream-
-- stamped service tier) and is selected before persistence from the prompt
-- size, so requests of different prompt sizes bucket separately and resolve
-- distinct unit prices. Recording writes NULL for the base tier and a positive
-- threshold otherwise; the unique index uses COALESCE(input_tier, 0) because
-- SQLite treats NULLs as distinct under UNIQUE and no real tier uses 0.
--
-- SQLite cannot add a column to the middle of a UNIQUE INDEX in place, so both
-- tables are recreated. Existing rows backfill `input_tier = NULL`, which the
-- aggregator treats as base pricing — historical buckets compute identically.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  input_tier INTEGER,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, tier, input_tier, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model_key, hour, tier, NULL, dimension, tokens, unit_price FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), COALESCE(input_tier, 0), dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

CREATE TABLE usage_requests_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  input_tier INTEGER,
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_new (key_id, model, upstream, model_key, hour, tier, input_tier, requests)
  SELECT key_id, model, upstream, model_key, hour, tier, NULL, requests FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_new RENAME TO usage_requests;

CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), COALESCE(input_tier, 0));
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
