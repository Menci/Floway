-- Persist the newly explicit Claude Artifact opt-out on every saved Agent Setup
-- configuration. False omits the managed Artifact keys, so the strict
-- application schema stays free of historical-shape branches.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.disableArtifact',
  json('false')
)
WHERE json_type(configuration_json, '$.claudeCode.disableArtifact') IS NULL;
