UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi', json('{"model":null,"provider":"floway","thinkingLevel":null,"retry":{"enabled":null,"maxRetries":null}}'))
WHERE json_type(configuration_json, '$.pi') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi.provider', 'floway')
WHERE json_type(configuration_json, '$.pi.provider') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi.thinkingLevel', NULL)
WHERE json_type(configuration_json, '$.pi.thinkingLevel') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi.retry', json('{"enabled":null,"maxRetries":null}'))
WHERE json_type(configuration_json, '$.pi.retry') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi.retry.enabled', NULL)
WHERE json_type(configuration_json, '$.pi.retry.enabled') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.pi.retry.maxRetries', NULL)
WHERE json_type(configuration_json, '$.pi.retry.maxRetries') IS NULL;
