-- Refresh coordination stays on the upstream row beside the catalog it
-- protects. Stale catalog reads need one atomic claim before upstream I/O;
-- keeping that claim inline avoids restoring the serial side-table read that
-- migration 0072 removed from every catalog access.
ALTER TABLE upstreams ADD COLUMN models_refresh_json TEXT NULL;
