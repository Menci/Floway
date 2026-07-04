-- Simplify's 59a6e66d removed the always-null `quotaSnapshot` field from
-- CursorAccountCredential and dropped `quotaSnapshot: true` from the state
-- assertion's allowed-key allowlist. Any pre-existing cursor rows carry the
-- key with value null (initial import path in auth/import.ts wrote it
-- unconditionally). Post-cleanup, `assertCursorUpstreamState` rejects the
-- key and every cursor request fails with `unexpected key 'quotaSnapshot'`.
--
-- Scrub the key from every cursor account's state_json. Idempotent — rows
-- without the key are left unchanged. SQLite's json_remove treats a missing
-- path as a no-op.

UPDATE upstreams
SET state_json = json_replace(
  state_json,
  '$.accounts[0]',
  json_remove(json_extract(state_json, '$.accounts[0]'), '$.quotaSnapshot')
)
WHERE provider = 'cursor'
  AND state_json IS NOT NULL
  AND json_type(state_json, '$.accounts[0].quotaSnapshot') IS NOT NULL;
