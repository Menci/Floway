UPDATE upstreams
SET state_json = json_set(state_json, '$.usageProbe', json('null'))
WHERE provider = 'ollama' AND state_json IS NOT NULL;
