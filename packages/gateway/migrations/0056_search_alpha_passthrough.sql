ALTER TABLE search_config ADD COLUMN passthrough_openai_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_config ADD COLUMN alpha_search_upstream_id TEXT NOT NULL DEFAULT '';
ALTER TABLE search_config ADD COLUMN alpha_search_model TEXT NOT NULL DEFAULT '';
