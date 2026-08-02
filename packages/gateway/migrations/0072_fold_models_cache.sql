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
-- One column rather than a field per attribute: the entry is read as a unit,
-- and splitting it would let a row hold a catalog with no fetch stamp — a
-- state the reader would have to reject at runtime and the schema cannot
-- express. A column also keeps each write to its own column, so a catalog
-- refresh and a credential write to the same row do not contend:
-- saveState's CAS predicate reads state_json alone.

ALTER TABLE upstreams ADD COLUMN models_cache_json TEXT NULL;

-- The cached catalog is carried over rather than dropped: re-deriving it costs
-- a live upstream fetch per upstream on the first request after deploy, and
-- unlike a credential this text is a verbatim JSON document the runtime reads
-- back with a reviver — nothing here depends on the encoding the runtime would
-- have produced, so composing it in SQL is safe.
--
-- `json(...)` embeds the stored text as JSON rather than as a quoted string;
-- an absent error becomes JSON null so the document always carries all four
-- keys.
UPDATE upstreams SET models_cache_json = (
  SELECT json_object(
    'revision', c.revision,
    'fetchedAt', c.fetched_at,
    'models', json(c.models_json),
    'lastError', CASE WHEN c.last_error_json IS NULL THEN json('null') ELSE json(c.last_error_json) END
  )
  FROM models_cache c WHERE c.upstream_id = upstreams.id
)
WHERE EXISTS (SELECT 1 FROM models_cache c WHERE c.upstream_id = upstreams.id);

DROP TABLE models_cache;
