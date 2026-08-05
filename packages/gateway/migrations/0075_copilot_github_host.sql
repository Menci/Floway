-- Copilot records require an explicit GitHub management-plane host. Existing
-- records represent github.com because that was their only possible host.
UPDATE upstreams
SET config_json = json_set(config_json, '$.githubHost', 'github.com')
WHERE provider = 'copilot'
  AND json_type(config_json, '$.githubHost') IS NULL;
