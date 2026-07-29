-- Rename the Microsoft web-search provider and preserve every stored
-- credential and usage bucket. The configuration table has no provider CHECK,
-- while search_usage does, so the latter needs the standard SQLite table swap.

ALTER TABLE search_config RENAME COLUMN microsoft_grounding_api_key TO microsoft_web_iq_api_key;

UPDATE search_config
SET provider = 'microsoft-web-iq'
WHERE provider = 'microsoft-grounding';

CREATE TABLE search_usage_new (
  provider TEXT NOT NULL CHECK (provider IN ('tavily', 'microsoft-web-iq', 'jina')),
  key_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'search' CHECK (action IN ('search', 'fetch_page')),
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, action, hour)
);

INSERT INTO search_usage_new (provider, key_id, action, hour, requests)
SELECT
  CASE provider
    WHEN 'microsoft-grounding' THEN 'microsoft-web-iq'
    ELSE provider
  END,
  key_id,
  action,
  hour,
  requests
FROM search_usage;

DROP INDEX IF EXISTS idx_search_usage_hour;
DROP TABLE search_usage;
ALTER TABLE search_usage_new RENAME TO search_usage;
CREATE INDEX idx_search_usage_hour ON search_usage (hour);
