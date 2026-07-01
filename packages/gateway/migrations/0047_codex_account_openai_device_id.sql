-- Backfill openaiDeviceId for Codex accounts imported before the field was
-- minted at OAuth import time. The Codex provider's CodexAccountCredential
-- requires the field; without backfill, the assertion at the state boundary
-- would reject legacy rows. Generate a UUIDv4-shaped device id per row using
-- SQLite primitives — the format matches what `crypto.randomUUID()` would
-- emit, and the value is opaque to the upstream beyond shape.
--
-- The v1 invariant for CodexUpstreamConfig is exactly one account per row, so
-- `$.accounts[0]` is the only slot to populate. Rows that already carry an
-- openaiDeviceId (accounts imported on the new code path) are skipped.

UPDATE upstreams
SET state_json = json_set(
  state_json,
  '$.accounts[0].openaiDeviceId',
  lower(hex(randomblob(4))) || '-'
    || lower(hex(randomblob(2))) || '-4'
    || substr(lower(hex(randomblob(2))), 2) || '-'
    || substr('89ab', (abs(random()) % 4) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-'
    || lower(hex(randomblob(6)))
)
WHERE provider = 'codex'
  AND state_json IS NOT NULL
  AND json_extract(state_json, '$.accounts[0].openaiDeviceId') IS NULL;
