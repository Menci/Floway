ALTER TABLE upstreams ADD COLUMN usage_refresh_interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (usage_refresh_interval_minutes >= 0);
