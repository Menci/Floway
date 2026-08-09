-- The seat's plan is read from /copilot_internal/user's `copilot_plan` rather
-- than from the token exchange's `sku`.
--
-- `sku` was captured because it rides on the exchange the data plane already
-- runs, but no first-party client maps a SKU to a plan: VS Code tests it for two
-- booleans and names the plan from `copilot_plan`, a separate namespace that
-- never travels on the token. Naming a plan from the SKU therefore meant
-- guessing at identifiers no source attests, and the guess covered fewer plans
-- than the field it was standing in for.
--
-- state_json.copilotToken is a closed key set, so entries minted while `sku` was
-- persisted have to lose it here rather than be tolerated in the reader.
UPDATE upstreams
SET state_json = json_remove(state_json, '$.copilotToken.sku')
WHERE provider = 'copilot'
  AND json_extract(state_json, '$.copilotToken.sku') IS NOT NULL;
