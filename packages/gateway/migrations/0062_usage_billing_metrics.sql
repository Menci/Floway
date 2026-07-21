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

WITH formatted_usage AS (
  SELECT
    key_id, model, upstream, model_key, hour, pricing_selector,
    dimension, tokens, typeof(tokens) AS quantity_type, unit_price,
    typeof(unit_price) AS decimal_type,
    CASE
      WHEN unit_price IS NULL THEN NULL
      WHEN typeof(unit_price) = 'integer' THEN CAST(unit_price AS TEXT)
      WHEN typeof(unit_price) != 'real' THEN NULL
      ELSE (
        WITH RECURSIVE precisions(digit_count) AS (
          VALUES (1)
          UNION ALL
          SELECT digit_count + 1 FROM precisions WHERE digit_count < 17
        )
        SELECT printf('%!.*g', digit_count, unit_price)
        FROM precisions
        WHERE CAST(printf('%!.*g', digit_count, unit_price) AS REAL) = unit_price
        ORDER BY digit_count
        LIMIT 1
      )
    END AS decimal_text
  FROM usage
), usage_mantissas AS (
  SELECT
    *,
    CASE
      WHEN instr(lower(decimal_text), 'e') > 0 THEN substr(decimal_text, 1, instr(lower(decimal_text), 'e') - 1)
      ELSE decimal_text
    END AS mantissa,
    CASE
      WHEN instr(lower(decimal_text), 'e') > 0 THEN CAST(substr(decimal_text, instr(lower(decimal_text), 'e') + 1) AS INTEGER)
      ELSE 0
    END AS source_exponent
  FROM formatted_usage
), usage_decimal_parts AS (
  SELECT
    *,
    CASE WHEN substr(mantissa, 1, 1) = '-' THEN '-' ELSE '' END AS sign,
    CASE WHEN substr(mantissa, 1, 1) = '-' THEN substr(mantissa, 2) ELSE mantissa END AS unsigned_mantissa
  FROM usage_mantissas
), shifted_usage AS (
  SELECT
    *,
    rtrim(replace(unsigned_mantissa, '.', ''), '0') AS digits,
    (CASE
      WHEN instr(unsigned_mantissa, '.') > 0 THEN instr(unsigned_mantissa, '.') - 1
      ELSE length(unsigned_mantissa)
    END) + source_exponent - 6 AS decimal_position
  FROM usage_decimal_parts
)
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
  CASE
    WHEN quantity_type = 'integer' AND tokens >= 0 THEN CAST(tokens AS TEXT)
    ELSE json('invalid legacy usage quantity')
  END,
  CASE
    WHEN unit_price IS NULL THEN NULL
    WHEN decimal_type NOT IN ('integer', 'real') OR unit_price < 0 OR decimal_text IS NULL THEN json('invalid legacy usage unit price')
    WHEN unit_price = 0 THEN '0'
    WHEN decimal_position <= 0 THEN sign || '0.' || printf('%0*d', -decimal_position, 0) || digits
    WHEN decimal_position >= length(digits) THEN sign || digits || printf('%0*d', decimal_position - length(digits), 0)
    ELSE sign || substr(digits, 1, decimal_position) || '.' || substr(digits, decimal_position + 1)
  END
FROM shifted_usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
CREATE UNIQUE INDEX idx_usage_metric_identity
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
                      WITH formatted_rates AS (
                        SELECT
                          rate.key,
                          rate.type AS decimal_type,
                          CAST(rate.value AS REAL) AS decimal_value,
                          json_extract(entry.value, '$.rates') -> rate.key AS decimal_text
                        FROM json_each(json_extract(entry.value, '$.rates')) AS rate
                      ), rate_mantissas AS (
                        SELECT
                          *,
                          CASE
                            WHEN instr(lower(decimal_text), 'e') > 0 THEN substr(decimal_text, 1, instr(lower(decimal_text), 'e') - 1)
                            ELSE decimal_text
                          END AS mantissa,
                          CASE
                            WHEN instr(lower(decimal_text), 'e') > 0 THEN CAST(substr(decimal_text, instr(lower(decimal_text), 'e') + 1) AS INTEGER)
                            ELSE 0
                          END AS source_exponent
                        FROM formatted_rates
                      ), rate_decimal_parts AS (
                        SELECT
                          *,
                          CASE WHEN substr(mantissa, 1, 1) = '-' THEN '-' ELSE '' END AS sign,
                          CASE WHEN substr(mantissa, 1, 1) = '-' THEN substr(mantissa, 2) ELSE mantissa END AS unsigned_mantissa
                        FROM rate_mantissas
                      ), shifted_rates AS (
                        SELECT
                          *,
                          rtrim(replace(unsigned_mantissa, '.', ''), '0') AS digits,
                          (CASE
                            WHEN instr(unsigned_mantissa, '.') > 0 THEN instr(unsigned_mantissa, '.') - 1
                            ELSE length(unsigned_mantissa)
                          END) + source_exponent - 6 AS decimal_position
                        FROM rate_decimal_parts
                      )
                      SELECT json_group_object(
                        CASE shifted_rate.key
                          WHEN 'input' THEN 'input_tokens'
                          WHEN 'input_cache_read' THEN 'input_cache_read_tokens'
                          WHEN 'input_cache_write' THEN 'input_cache_write_tokens'
                          WHEN 'input_cache_write_1h' THEN 'input_cache_write_1h_tokens'
                          WHEN 'input_image' THEN 'input_image_tokens'
                          WHEN 'output' THEN 'output_tokens'
                          WHEN 'output_image' THEN 'output_image_tokens'
                        END,
                        -- Reject any legacy rate the runtime DecimalString
                        -- parser would later refuse, so every migrated value is
                        -- a canonical, re-parseable decimal that cannot bloat a
                        -- D1 row. The caps mirror PUBLIC_LIMITS in
                        -- packages/protocols/src/common/decimal.ts (512-char
                        -- input, 100 significant digits, |exponent| 400, 400
                        -- integer and fractional digits, 512-char output).
                        -- Explicit caps are needed here because a model rate is
                        -- read as a raw JSON lexeme of arbitrary length; the
                        -- usage unit_price path needs none, as it reads a REAL
                        -- already bounded by IEEE-754.
                        CASE
                          WHEN decimal_type NOT IN ('integer', 'real')
                            OR decimal_value < 0
                            OR decimal_value > 1.7976931348623157e308
                            OR length(decimal_text) > 512
                            OR abs(source_exponent) > 400
                            OR length(ltrim(digits, '0')) > 100
                            OR max(0, length(digits) - decimal_position) > 400
                            OR max(1, decimal_position) > 400
                            OR (CASE
                              WHEN decimal_position <= 0 THEN length(sign) + 2 - decimal_position + length(digits)
                              WHEN decimal_position >= length(digits) THEN length(sign) + decimal_position
                              ELSE length(sign) + length(digits) + 1
                            END) > 512
                            THEN json('invalid legacy model price')
                          WHEN digits = '' THEN '0'
                          WHEN decimal_position <= 0 THEN sign || '0.' || printf('%0*d', -decimal_position, 0) || digits
                          WHEN decimal_position >= length(digits) THEN sign || digits || printf('%0*d', decimal_position - length(digits), 0)
                          ELSE sign || substr(digits, 1, decimal_position) || '.' || substr(digits, decimal_position + 1)
                        END
                      )
                      FROM shifted_rates AS shifted_rate
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
