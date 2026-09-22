-- Reading an Ollama Cloud account's usage windows is now an explicit per-upstream
-- option rather than an inference from the base URL, because the cloud can be
-- reached through an operator's own domain and a private daemon can sit behind
-- one that looks like anything. Existing records answer for themselves: an
-- upstream pointed at ollama.com with a key is the cloud, which is exactly what
-- the inference recognized, so it carries the option forward turned on.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.cloudUsage',
  json(CASE
    WHEN json_extract(config_json, '$.baseUrl') LIKE 'http://ollama.com/%'
      OR json_extract(config_json, '$.baseUrl') LIKE 'https://ollama.com/%'
      OR json_extract(config_json, '$.baseUrl') IN ('http://ollama.com', 'https://ollama.com')
    THEN 'true'
    ELSE 'false'
  END)
)
WHERE provider = 'ollama'
  AND json_type(config_json, '$.cloudUsage') IS NULL;
