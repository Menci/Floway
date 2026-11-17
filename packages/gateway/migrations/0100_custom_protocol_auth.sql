-- `custom` upstreams no longer carry an authentication mode. The protocol used
-- by each outbound call decides where the credential goes, and an empty
-- credential marks an anonymous upstream.
--
-- Before this change `authStyle = 'none'` rows had no apiKey and every other
-- row had a non-empty one. Persist the former as an empty string, give an
-- otherwise missing key the same value, then remove the obsolete selector.
-- `config_version` moves in the same write so any in-flight model refresh
-- cannot overwrite a catalog derived from the old configuration.
UPDATE upstreams
SET
  config_json = json_remove(
    json_set(
      config_json,
      '$.apiKey',
      CASE
        WHEN json_type(config_json, '$.authStyle') = 'none' THEN ''
        WHEN json_type(config_json, '$.apiKey') = 'null' THEN ''
        WHEN json_type(config_json, '$.apiKey') IS NULL THEN ''
        ELSE json_extract(config_json, '$.apiKey')
      END
    ),
    '$.authStyle'
  ),
  config_version = config_version + 1
WHERE provider = 'custom'
  AND (
    json_type(config_json, '$.authStyle') IS NOT NULL
    OR json_type(config_json, '$.apiKey') IS NULL
  );
