-- Persist the newly explicit Claude `fable` alias override on every saved Agent
-- Setup configuration. JSON null is the canonical "Default" value, matching the
-- other model slots, so the strict application schema stays free of
-- historical-shape branches.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.claudeCode.defaultFableModel',
  NULL
)
WHERE json_type(configuration_json, '$.claudeCode.defaultFableModel') IS NULL;
