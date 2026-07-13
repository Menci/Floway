UPDATE upstreams AS upstream
SET config_json = json_set(
  upstream.config_json,
  '$.models',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(model.value, '$.cost') IS NULL THEN model.value
          ELSE (
            WITH
              dimensions(dimension_order, dimension) AS (
                VALUES
                  (0, 'input'),
                  (1, 'input_cache_read'),
                  (2, 'input_cache_write'),
                  (3, 'input_cache_write_1h'),
                  (4, 'input_image'),
                  (5, 'output'),
                  (6, 'output_image')
              ),
              ecmascript_whitespace(chars) AS (
                VALUES (char(
                  9, 10, 11, 12, 13, 32, 160, 5760,
                  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
                  8232, 8233, 8239, 8287, 12288, 65279
                ))
              ),
              base AS (
                SELECT json_remove(json_extract(model.value, '$.cost'), '$.tiers') AS rates
              ),
              coordinates(entry_order, service_tier, effective_rates) AS (
                SELECT 0, NULL, rates
                FROM base

                UNION ALL

                SELECT 1 + tier.id, tier.key, json_patch(base.rates, tier.value)
                FROM base, ecmascript_whitespace, json_each(json_extract(model.value, '$.cost'), '$.tiers') AS tier
                WHERE lower(trim(tier.key, ecmascript_whitespace.chars)) NOT IN ('', 'default', 'standard')
              ),
              rates AS (
                SELECT
                  coordinates.entry_order,
                  coordinates.service_tier,
                  dimensions.dimension_order,
                  dimensions.dimension,
                  CASE dimensions.dimension
                    WHEN 'input' THEN json_extract(coordinates.effective_rates, '$.input')
                    WHEN 'input_cache_read' THEN COALESCE(
                      json_extract(coordinates.effective_rates, '$.input_cache_read'),
                      json_extract(coordinates.effective_rates, '$.input')
                    )
                    WHEN 'input_cache_write' THEN COALESCE(
                      json_extract(coordinates.effective_rates, '$.input_cache_write'),
                      json_extract(coordinates.effective_rates, '$.input')
                    )
                    WHEN 'input_cache_write_1h' THEN COALESCE(
                      json_extract(coordinates.effective_rates, '$.input_cache_write_1h'),
                      json_extract(coordinates.effective_rates, '$.input_cache_write'),
                      json_extract(coordinates.effective_rates, '$.input')
                    )
                    WHEN 'input_image' THEN COALESCE(
                      json_extract(coordinates.effective_rates, '$.input_image'),
                      json_extract(coordinates.effective_rates, '$.input')
                    )
                    WHEN 'output' THEN json_extract(coordinates.effective_rates, '$.output')
                    WHEN 'output_image' THEN COALESCE(
                      json_extract(coordinates.effective_rates, '$.output_image'),
                      json_extract(coordinates.effective_rates, '$.output')
                    )
                  END AS rate
                FROM coordinates, dimensions
              ),
              priced_dimensions(dimension_order, dimension) AS (
                SELECT dimension_order, dimension
                FROM rates
                GROUP BY dimension_order, dimension
                HAVING COUNT(rate) > 0
              ),
              coordinate_entries(entry_order, pricing_entry) AS (
                SELECT
                  coordinates.entry_order,
                  CASE
                    WHEN coordinates.service_tier IS NULL THEN json_object(
                      'rates',
                      json((
                        SELECT json_group_object(dimension, rate)
                        FROM (
                          SELECT
                            priced_dimensions.dimension,
                            COALESCE(rates.rate, 0) AS rate
                          FROM priced_dimensions
                          LEFT JOIN rates
                            ON rates.entry_order = coordinates.entry_order
                            AND rates.dimension = priced_dimensions.dimension
                          ORDER BY priced_dimensions.dimension_order
                        )
                      ))
                    )
                    ELSE json_object(
                      'selector', json_object('serviceTier', coordinates.service_tier),
                      'rates',
                      json((
                        SELECT json_group_object(dimension, rate)
                        FROM (
                          SELECT
                            priced_dimensions.dimension,
                            COALESCE(rates.rate, 0) AS rate
                          FROM priced_dimensions
                          LEFT JOIN rates
                            ON rates.entry_order = coordinates.entry_order
                            AND rates.dimension = priced_dimensions.dimension
                          ORDER BY priced_dimensions.dimension_order
                        )
                      ))
                    )
                  END
                FROM coordinates
              )
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM priced_dimensions) THEN json_remove(model.value, '$.cost')
              ELSE json_set(
                json_remove(model.value, '$.cost'),
                '$.pricing',
                json_object(
                  'entries',
                  json((
                    SELECT json_group_array(json(pricing_entry))
                    FROM (
                      SELECT pricing_entry
                      FROM coordinate_entries
                      ORDER BY entry_order
                    )
                  ))
                )
              )
            END
          )
        END
      )
    )
    FROM json_each(json_extract(upstream.config_json, '$.models')) AS model
  )
)
WHERE json_type(upstream.config_json, '$.models') = 'array';
