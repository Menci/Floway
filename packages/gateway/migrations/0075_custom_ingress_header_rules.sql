-- Custom upstream ingress header rules are required by the runtime parser.
-- Existing Custom rows forwarded no client headers, represented by an empty
-- rule list.

UPDATE upstreams
SET config_json = json_set(config_json, '$.ingressHeadersRules', json('[]'))
WHERE provider = 'custom'
  AND json_type(config_json, '$.ingressHeadersRules') IS NULL;
