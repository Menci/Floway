-- Persist the newly explicit optional Claude cleanup setting on every saved
-- Agent Setup configuration. JSON null is the canonical "Default" value and
-- keeps the strict application schema free of historical-shape branches.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.cleanupPeriodDays',
  NULL
)
WHERE json_type(configuration_json, '$.claudeCode.cleanupPeriodDays') IS NULL;
