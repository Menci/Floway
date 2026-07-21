CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  pricing_selector TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(pricing_selector) AND json_type(pricing_selector) = 'object'),
  metric TEXT NOT NULL CHECK (length(metric) > 0),
  quantity TEXT NOT NULL CHECK (length(quantity) > 0),
  unit_price TEXT
);

INSERT INTO usage_new (
  key_id, model, upstream, model_key, hour, pricing_selector,
  metric, quantity, unit_price
)
SELECT
  key_id,
  model,
  upstream,
  model_key,
  hour,
  pricing_selector,
  CASE dimension
    WHEN 'input' THEN 'input_tokens'
    WHEN 'input_cache_read' THEN 'input_cache_read_tokens'
    WHEN 'input_cache_write' THEN 'input_cache_write_tokens'
    WHEN 'input_cache_write_1h' THEN 'input_cache_write_1h_tokens'
    WHEN 'input_image' THEN 'input_image_tokens'
    WHEN 'output' THEN 'output_tokens'
    WHEN 'output_image' THEN 'output_image_tokens'
  END,
  CAST(tokens AS TEXT),
  CASE WHEN unit_price IS NULL THEN NULL ELSE printf('%.17g', unit_price / 1000000.0) END
FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE INDEX idx_usage_metric_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, metric);
CREATE INDEX idx_usage_metric_hour ON usage (hour);

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
            '$.pricing',
            json_object(
              'entries',
              json((
                SELECT json_group_array(
                  json(json_set(
                    entry.value,
                    '$.rates',
                    json((
                      SELECT json_group_object(
                        CASE rate.key
                          WHEN 'input' THEN 'input_tokens'
                          WHEN 'input_cache_read' THEN 'input_cache_read_tokens'
                          WHEN 'input_cache_write' THEN 'input_cache_write_tokens'
                          WHEN 'input_cache_write_1h' THEN 'input_cache_write_1h_tokens'
                          WHEN 'input_image' THEN 'input_image_tokens'
                          WHEN 'output' THEN 'output_tokens'
                          WHEN 'output_image' THEN 'output_image_tokens'
                        END,
                        printf('%.17g', CAST(rate.value AS REAL) / 1000000.0)
                      )
                      FROM json_each(json_extract(entry.value, '$.rates')) AS rate
                    ))
                  )))
                FROM json_each(json_extract(model.value, '$.pricing.entries')) AS entry
              ))
            )
          )
        END
      )
    )
    FROM json_each(json_extract(upstream.config_json, '$.models')) AS model
  )
)
WHERE json_type(upstream.config_json, '$.models') = 'array';

DELETE FROM models_cache;
