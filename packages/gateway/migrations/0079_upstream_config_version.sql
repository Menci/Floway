-- Catalog publication is fenced by provider configuration, independently of
-- runtime state and operator metadata updates.
ALTER TABLE upstreams ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(config_version) = 'integer' AND config_version >= 1);
