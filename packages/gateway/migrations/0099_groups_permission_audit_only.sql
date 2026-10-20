DELETE FROM access_records
WHERE scope_key = 'groups'
  AND json_type(values_json, '$."Permission.Audit"') IS NULL;

UPDATE access_records
SET values_json = json_object(
  'Permission.Audit',
  json(CASE json_extract(values_json, '$."Permission.Audit"') WHEN 1 THEN 'true' ELSE 'false' END)
)
WHERE scope_key = 'groups';
