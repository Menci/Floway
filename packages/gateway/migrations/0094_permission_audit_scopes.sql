INSERT INTO access_records (
  principal_type, principal_id, scope_json, scope_key, sort_order, values_json, created_at, updated_at
)
SELECT
  principal_type, principal_id, json_object('kind', 'groups'), 'groups', sort_order,
  values_json, created_at, updated_at
FROM access_records
WHERE json_extract(scope_json, '$.kind') = 'users';
