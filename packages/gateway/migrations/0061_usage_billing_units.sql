CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  dimension TEXT NOT NULL CHECK (length(dimension) > 0),
  unit TEXT NOT NULL CHECK (length(unit) > 0),
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_price REAL
);

INSERT INTO usage_new (
  key_id, model, upstream, model_key, hour, pricing_selector,
  dimension, unit, quantity, unit_price
)
SELECT
  key_id, model, upstream, model_key, hour, pricing_selector,
  dimension, 'tokens_1m', tokens, unit_price
FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, dimension, unit);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

UPDATE upstreams AS upstream
SET config_json = json_set(
  upstream.config_json,
  '$.models',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(model.value, '$.pricing') IS NULL THEN model.value
          ELSE json_set(
            model.value,
            '$.pricing.units',
            json((
              SELECT json_group_object(rate.key, 'tokens_1m')
              FROM json_each(json_extract(model.value, '$.pricing.entries[0].rates')) AS rate
            ))
          )
        END
      )
    )
    FROM json_each(json_extract(upstream.config_json, '$.models')) AS model
  )
)
WHERE json_type(upstream.config_json, '$.models') = 'array';

DELETE FROM models_cache;
