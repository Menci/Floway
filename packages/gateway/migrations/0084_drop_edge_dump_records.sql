-- Delete the dump records written as a turn's two edges.
--
-- Every route opens its run through the prologue now, so nothing produces that shape any more:
-- a record is the whole run, every stage and both directions, as one NDJSON event stream. What
-- is left of the old shape is stored rows, and they are deleted rather than kept readable. An
-- edge record holds what the client sent and what it got back and nothing about what happened
-- between, so there is no run to rebuild it into — and a dump record is diagnostic and already
-- expires under its key's own `dump_retention_seconds`, so what this brings forward is a
-- deletion that was coming anyway.
--
-- Which rows: the reader told the two shapes apart by the response body descriptor's own type,
-- because a run is one more body file under the same contract and says so. Anything that is not
-- a run is an edge record, including a row that stored no response body at all.
--
-- The files go with them. `dump_records_retire_spilled_files` fires on delete and marks both
-- descriptors' keys retired with `collect_after = 0`, so the collector picks them up on its next
-- pass rather than leaving orphans in the file store.
DELETE FROM dump_records
WHERE response_body_descriptor IS NULL
   OR json_extract(response_body_descriptor, '$.type') IS NOT 'run';
