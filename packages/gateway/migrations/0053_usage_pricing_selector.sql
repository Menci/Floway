-- Replace the service-tier bucket column with one self-describing canonical
-- pricing selector. The historical `tier` field becomes the serviceTier axis;
-- NULL and the legacy empty string are the base selector. Every other open
-- string is preserved byte-for-byte so distinct historical buckets remain
-- distinct. Sorted canonical JSON keeps bucket identity stable and lets future
-- axes ship without schema changes.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, pricing_selector, dimension, tokens, unit_price)
SELECT key_id, model, upstream, model_key, hour,
  CASE WHEN tier IS NULL OR tier = '' THEN '{}' ELSE json_object('serviceTier', tier) END,
  dimension, tokens, unit_price
FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

CREATE TABLE usage_requests_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_new (key_id, model, upstream, model_key, hour, pricing_selector, requests)
SELECT key_id, model, upstream, model_key, hour,
  CASE WHEN tier IS NULL OR tier = '' THEN '{}' ELSE json_object('serviceTier', tier) END,
  requests
FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_new RENAME TO usage_requests;
CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector);
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
