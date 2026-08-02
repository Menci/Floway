-- New tables --------------------------------------------------------------

CREATE TABLE models_cache (
  upstream_id      TEXT PRIMARY KEY REFERENCES upstreams(id) ON DELETE CASCADE,
  fetched_at       INTEGER NOT NULL,
  models_json      TEXT    NOT NULL,
  last_error_json  TEXT    NULL
);

CREATE TABLE codex_pkce_pending (
  state       TEXT PRIMARY KEY,
  verifier    TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE search_config (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  provider                        TEXT NOT NULL,
  tavily_api_key                  TEXT NOT NULL DEFAULT '',
  microsoft_grounding_api_key     TEXT NOT NULL DEFAULT '',
  updated_at                      TEXT NOT NULL
);

CREATE TABLE image_cache (
  key         TEXT PRIMARY KEY,
  value       BLOB NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Drop the legacy Copilot known-models ledger ----------------------------
-- The pre-rework `models_store:<id>` rows in `config` cannot be lifted into
-- `upstreams.state_json` from SQL: serializeStoredState canonicalizes by
-- recursively sorting object keys, but SQLite's JSON1 (`json_object`,
-- `json()`) only minify and preserve input order. Under the CAS as it stood
-- at this migration, which bound the canonicalized form, any in-SQL lift
-- would have written a blob the runtime could never match again, so token
-- mints and 24h known-models updates would silently drop until something
-- else rewrote the row. The runtime re-derives the ledger from `/models` on
-- first request after deploy, so dropping the legacy data is a one-fetch
-- cost with no correctness loss.

-- Lift search-config singleton -------------------------------------------

INSERT INTO search_config (id, provider, tavily_api_key, microsoft_grounding_api_key, updated_at)
SELECT
  1,
  json_extract(value, '$.provider'),
  json_extract(value, '$.tavily.apiKey'),
  json_extract(value, '$.microsoftGrounding.apiKey'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM config
WHERE key = 'search_config';

INSERT OR IGNORE INTO search_config (id, provider, updated_at)
VALUES (1, 'disabled', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Drop the legacy table --------------------------------------------------

DROP TABLE config;
