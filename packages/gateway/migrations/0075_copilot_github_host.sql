-- Copilot management-plane requests previously targeted github.com implicitly.
-- Materialize that host so every stored record has the shape the provider now
-- requires before code starts deriving GitHub and GHE.com endpoints from it.
UPDATE upstreams
SET config_json = json_set(config_json, '$.githubHost', 'github.com')
WHERE provider = 'copilot'
  AND json_type(config_json, '$.githubHost') IS NULL;
