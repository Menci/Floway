UPDATE agent_setup
SET configuration_json = json_set(configuration_json,
  '$.pi', json('{"model":null,"provider":"","thinkingLevel":null,"retry":{"enabled":null,"maxRetries":null}}'),
  '$.omp', json('{"model":null,"provider":"","retry":{"enabled":null,"maxRetries":null}}'));
