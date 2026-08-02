-- Fold the models cache into the upstream row.
--
-- The cache was a 1:1 side table keyed on upstream_id, so every data-plane
-- request paid two serial round trips to D1: one to list the upstreams, then —
-- once that told it which upstreams exist — one per candidate to read its
-- catalog. Production telemetry over seven days put the second query at 4.59M
-- executions, the most-run statement in the database and the second most
-- expensive by total time. A single D1 database processes queries one at a
-- time, so removing the query returns that slot to everything else.
--
-- Columns rather than a table means each write still touches only its own
-- column: a catalog refresh and a credential write to the same row do not
-- contend, because the credential CAS predicate reads `state_json` alone.

ALTER TABLE upstreams ADD COLUMN models_json TEXT NULL;
ALTER TABLE upstreams ADD COLUMN models_fetched_at INTEGER NULL;
ALTER TABLE upstreams ADD COLUMN models_revision INTEGER NULL;
ALTER TABLE upstreams ADD COLUMN models_last_error_json TEXT NULL;

-- The cached catalog is carried over rather than dropped: re-deriving it costs
-- a live upstream fetch per upstream on the first request after deploy, and
-- unlike a credential or an observation this text is a verbatim JSON document
-- the runtime reads back with a reviver — nothing here depends on the encoding
-- the runtime would have produced.
UPDATE upstreams SET
  models_json = (SELECT models_json FROM models_cache WHERE models_cache.upstream_id = upstreams.id),
  models_fetched_at = (SELECT fetched_at FROM models_cache WHERE models_cache.upstream_id = upstreams.id),
  models_revision = (SELECT revision FROM models_cache WHERE models_cache.upstream_id = upstreams.id),
  models_last_error_json = (SELECT last_error_json FROM models_cache WHERE models_cache.upstream_id = upstreams.id)
WHERE EXISTS (SELECT 1 FROM models_cache WHERE models_cache.upstream_id = upstreams.id);

DROP TABLE models_cache;
