-- Custom inference calls derive authentication from the protocol each call
-- uses. The `/models` catalog endpoint has no such protocol, so its fetch
-- configuration carries a separate auth style. An empty apiKey means the
-- shared credential is unset, replacing the removed upstream-wide `none` mode.
--
-- Move the old upstream-wide authStyle into modelsFetch before removing the
-- top-level field. Rows without modelsFetch default to bearer catalog fetches,
-- matching the pre-toggle behavior. `config_version` moves so any in-flight
-- model refresh cannot overwrite a catalog derived from the old configuration.
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
      END,
      '$.modelsFetch',
      json_object(
        'enabled',
        json(CASE
          WHEN json_type(config_json, '$.modelsFetch.enabled') = 'true' THEN 'true'
          ELSE 'false'
        END),
        'authStyle',
        json_quote(CASE
          WHEN json_extract(config_json, '$.modelsFetch.authStyle') = 'x-api-key' THEN 'x-api-key'
          WHEN json_extract(config_json, '$.modelsFetch.authStyle') = 'anthropic' THEN 'x-api-key'
          WHEN json_extract(config_json, '$.authStyle') = 'anthropic' THEN 'x-api-key'
          ELSE 'bearer'
        END),
        'endpoint',
        json_extract(config_json, '$.modelsFetch.endpoint')
      )
    ),
    '$.authStyle'
  ),
  config_version = config_version + 1
WHERE provider = 'custom'
  AND (
    json_type(config_json, '$.authStyle') IS NOT NULL
    OR json_type(config_json, '$.apiKey') IS NULL
    OR json_type(config_json, '$.modelsFetch') IS NULL
    OR json_type(config_json, '$.modelsFetch.authStyle') IS NULL
  );
