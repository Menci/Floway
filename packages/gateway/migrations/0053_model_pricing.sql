UPDATE upstreams AS upstream
SET config_json = json_set(
  upstream.config_json,
  '$.models',
  (
    SELECT json_group_array(
      json(
        CASE
          WHEN json_type(model.value, '$.cost') IS NULL THEN model.value
          ELSE json_set(
            json_remove(model.value, '$.cost'),
            '$.pricing',
            json_object(
              'entries',
              json(
                COALESCE(
                  (
                    SELECT json_group_array(json(pricing_entry))
                    FROM (
                      SELECT
                        0 AS entry_order,
                        json_object(
                          'rates',
                          json(json_remove(json_extract(model.value, '$.cost'), '$.tiers'))
                        ) AS pricing_entry
                      WHERE EXISTS (
                        SELECT 1
                        FROM json_each(json_extract(model.value, '$.cost')) AS base_field
                        WHERE base_field.key <> 'tiers'
                      )

                      UNION ALL

                      SELECT
                        1 + tier.id AS entry_order,
                        json_object(
                          'selector', json_object('serviceTier', tier.key),
                          'rates', json_patch(
                            json_remove(json_extract(model.value, '$.cost'), '$.tiers'),
                            tier.value
                          )
                        ) AS pricing_entry
                      FROM json_each(json_extract(model.value, '$.cost'), '$.tiers') AS tier

                      ORDER BY entry_order
                    )
                  ),
                  '[]'
                )
              )
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
