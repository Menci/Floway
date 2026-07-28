-- Rename the Microsoft web search provider to the product's public name.
--
-- The endpoints this provider has always called — api.microsoft.ai/v3/search/web
-- and /v3/browse, authenticated with `x-apikey` — belong to Microsoft Web IQ,
-- which was still unreleased and documented only internally when the provider
-- landed. "Microsoft Grounding" was never a public name, and the name it most
-- resembles, Grounding with Bing Search, is a different product that is still
-- generally available on api.bing.microsoft.com behind an Azure
-- Microsoft.Bing/accounts resource. Operators reading the old name would
-- provision the wrong resource and get a key this provider cannot use.
--
-- https://webiq.microsoft.ai/
-- https://github.com/Azure/azure-rest-api-specs/pull/43848
--
-- Stored credentials carry over untouched: the same key keeps working, only the
-- column and the provider identifier change.

ALTER TABLE search_config RENAME COLUMN microsoft_grounding_api_key TO web_iq_api_key;

UPDATE search_config SET provider = 'web-iq' WHERE provider = 'microsoft-grounding';

-- `search_usage.provider` carries a CHECK constraint listing the allowed names;
-- D1/SQLite cannot alter a CHECK constraint in place, so we rebuild the table
-- via swap (same pattern as 0043 — see the comment there). Recorded usage rows
-- are rewritten so per-provider history stays continuous across the rename.

CREATE TABLE search_usage_new (
  provider TEXT NOT NULL CHECK (provider IN ('tavily', 'web-iq', 'jina')),
  key_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'search' CHECK (action IN ('search', 'fetch_page')),
  hour TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_id, action, hour)
);

INSERT INTO search_usage_new (provider, key_id, action, hour, requests)
SELECT
  CASE provider WHEN 'microsoft-grounding' THEN 'web-iq' ELSE provider END,
  key_id,
  action,
  hour,
  requests
FROM search_usage;

DROP INDEX IF EXISTS idx_search_usage_hour;
DROP TABLE search_usage;
ALTER TABLE search_usage_new RENAME TO search_usage;
CREATE INDEX idx_search_usage_hour ON search_usage (hour);
