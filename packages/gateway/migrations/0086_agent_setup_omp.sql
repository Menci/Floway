UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.omp', json('{"model":null,"provider":"floway","retry":{"enabled":null,"maxRetries":null}}'))
WHERE json_type(configuration_json, '$.omp') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.omp.provider', 'floway')
WHERE json_type(configuration_json, '$.omp.provider') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.omp.retry', json('{"enabled":null,"maxRetries":null}'))
WHERE json_type(configuration_json, '$.omp.retry') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.omp.retry.enabled', NULL)
WHERE json_type(configuration_json, '$.omp.retry.enabled') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(configuration_json, '$.omp.retry.maxRetries', NULL)
WHERE json_type(configuration_json, '$.omp.retry.maxRetries') IS NULL;
