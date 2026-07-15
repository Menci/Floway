-- The former direct sentinel meant runtime-native fetch. Name that transport
-- explicitly so direct TCP can coexist in the same ordered fallback list.
UPDATE upstreams
SET proxy_fallback_list_json = (
  SELECT json_group_array(json(
    CASE
      WHEN json_extract(entry.value, '$.id') = 'direct'
        THEN json_set(entry.value, '$.id', 'direct_fetch')
      ELSE entry.value
    END
  ))
  FROM json_each(upstreams.proxy_fallback_list_json) AS entry
)
WHERE EXISTS (
  SELECT 1
  FROM json_each(upstreams.proxy_fallback_list_json) AS entry
  WHERE json_extract(entry.value, '$.id') = 'direct'
);
