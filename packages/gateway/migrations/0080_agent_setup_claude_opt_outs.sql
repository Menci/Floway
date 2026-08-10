-- Persist the newly explicit Claude auto-memory and agent-view opt-outs on
-- every saved Agent Setup configuration. False leaves Claude's own defaults in
-- force, so the strict application schema stays free of historical-shape
-- branches.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.disableAutoMemory',
  json('false')
)
WHERE json_type(configuration_json, '$.claudeCode.disableAutoMemory') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.disableAgentView',
  json('false')
)
WHERE json_type(configuration_json, '$.claudeCode.disableAgentView') IS NULL;
