-- Persist newly explicit optional Claude settings on every saved Agent Setup
-- configuration. JSON null is the canonical cleanup "Default" value; false
-- leaves AI attribution untouched. Strict application schemas can then remain
-- free of historical-shape branches.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.cleanupPeriodDays',
  NULL
)
WHERE json_type(configuration_json, '$.claudeCode.cleanupPeriodDays') IS NULL;

UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.optOutAiAttribution',
  json('false')
)
WHERE json_type(configuration_json, '$.claudeCode.optOutAiAttribution') IS NULL;
