UPDATE agent_setup
SET configuration_json = json_set(configuration_json,
  '$.pi', json('{"model":null,"provider":"floway","thinkingLevel":null,"retry":{"enabled":null,"maxRetries":null}}'),
  '$.omp', json('{"model":null,"provider":"floway","retry":{"enabled":null,"maxRetries":null}}'));
