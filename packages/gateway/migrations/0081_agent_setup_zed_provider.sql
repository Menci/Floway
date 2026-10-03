-- Persist the Zed provider name on every saved Agent Setup configuration. The
-- strict application schema parses stored rows as well as request bodies, so a
-- configuration written before Zed existed would throw on the next acquire —
-- and permanently, since the latest-record lookup ignores expiry and the failing
-- parse happens before any replacement row can be inserted. "Floway" is the
-- same first-use value defaultAgentSetupConfiguration writes.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.zed',
  json('{"providerName":"Floway"}')
)
WHERE json_type(configuration_json, '$.zed') IS NULL;
