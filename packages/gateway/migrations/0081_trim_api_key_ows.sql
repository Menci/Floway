-- Transport-field validation now requires non-empty HTTP field values to
-- begin and end with visible bytes. Earlier readers accepted surrounding SP
-- and HTAB and then let Headers normalize them at dispatch. Canonicalize those
-- persisted credentials before strict provider parsing; an optional Ollama key
-- containing only OWS is equivalent to no credential.

UPDATE upstreams
SET config_json = CASE
      WHEN provider = 'ollama'
        AND trim(json_extract(config_json, '$.apiKey'), char(9) || ' ') = ''
      THEN json_remove(config_json, '$.apiKey')
      ELSE json_set(
        config_json,
        '$.apiKey',
        trim(json_extract(config_json, '$.apiKey'), char(9) || ' ')
      )
    END
WHERE provider IN ('custom', 'azure', 'ollama')
  AND json_valid(config_json)
  AND json_type(config_json, '$.apiKey') = 'text'
  AND json_extract(config_json, '$.apiKey')
    <> trim(json_extract(config_json, '$.apiKey'), char(9) || ' ')
  AND (
    provider = 'ollama'
    OR trim(json_extract(config_json, '$.apiKey'), char(9) || ' ') <> ''
  );

-- Custom ingress replacements passed through Headers on every read, which
-- trimmed their surrounding OWS. Persist that canonical form now so strict
-- validation observes the same value without a runtime compatibility path.
UPDATE upstreams
SET config_json = json_set(
      config_json,
      '$.ingressHeadersRules',
      (
        SELECT json_group_array(
          CASE
            WHEN json_type(rule.value, '$.value') = 'text'
            THEN json_set(
              rule.value,
              '$.value',
              trim(json_extract(rule.value, '$.value'), char(9) || ' ')
            )
            ELSE rule.value
          END
        )
        FROM json_each(json_extract(upstreams.config_json, '$.ingressHeadersRules')) AS rule
      )
    )
WHERE provider = 'custom'
  AND json_valid(config_json)
  AND json_type(config_json, '$.ingressHeadersRules') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.ingressHeadersRules')) AS rule
    WHERE json_type(rule.value, '$.value') = 'text'
      AND json_extract(rule.value, '$.value')
        <> trim(json_extract(rule.value, '$.value'), char(9) || ' ')
  );
