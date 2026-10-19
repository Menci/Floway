ALTER TABLE api_keys
ADD COLUMN randomize_upstreams INTEGER NOT NULL DEFAULT 0
CHECK (randomize_upstreams IN (0, 1));
