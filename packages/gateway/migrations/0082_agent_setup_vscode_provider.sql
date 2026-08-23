-- Persist the VS Code provider settings on every saved Agent Setup
-- configuration, for the same reason 0081 did so for Zed: the strict
-- application schema parses stored rows as well as request bodies, so a
-- configuration written before VS Code existed would throw on the next
-- acquire — and permanently, since the latest-record lookup ignores expiry and
-- the failing parse happens before any replacement row can be inserted. The
-- values are the ones defaultAgentSetupConfiguration writes for a new lease.
UPDATE agent_setup
SET configuration_json = json_set(
  configuration_json,
  '$.vscode',
  json('{"providerName":"Floway","apiType":"messages"}')
)
WHERE json_type(configuration_json, '$.vscode') IS NULL;
