-- Alias targets live in the JSON `targets` column. The per-target routing
-- switch is represented by an optional `enabled` boolean; absent means
-- enabled. This migration makes the default explicit for any target that
-- predates the field, while preserving targets that already carry a value.

UPDATE model_aliases
SET targets = (
  SELECT json_group_array(
    json_set(
      json(target.value),
      '$.enabled',
      CASE json_type(target.value, '$.enabled')
        WHEN 'true' THEN json('true')
        WHEN 'false' THEN json('false')
        ELSE json('true')
      END
    )
  )
  FROM json_each(model_aliases.targets) AS target
)
WHERE EXISTS (
  SELECT 1
  FROM json_each(model_aliases.targets) AS target
  WHERE json_type(target.value, '$.enabled') IS NULL
);
