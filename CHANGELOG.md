# Deployment Notes

This file records user-facing breaking changes and recommended deployment operations by date. New entries go at the top, below this header. Each entry states its impact level and what users need to know or do.

Impact levels:

- **hard** — all users are affected; previously working functionality fails or behaves differently.
- **minor** — specific behaviors, fields, or integration patterns change; users who depend on them need to adapt, but the primary functionality continues to work.
- **advisory** — no behavior breaks, but an agent or operator should consider a concrete deployment-related follow-up action.

Hard and minor entries may include recommended actions; those actions do not need a separate advisory entry.

## 2026-07-30 · minor

### Translated Responses output items gain `status` and `annotations`

Assistant `message` output items produced by the Responses-via-Chat-Completions and Responses-via-Messages paths now carry `status` (`in_progress` on `response.output_item.added`, `completed` on `response.output_item.done` and in the terminal `output`), and their `output_text` content parts now carry `annotations`. Both keys are required by the Responses item schema and were already present on the native Responses path; clients that validate items strictly were rejecting the translated ones.

Responses item identity is hashed over the whole item JSON with no key filtering, so the two new keys change the hash of every translated-path assistant message. Conversations already in flight across the deploy miss their affinity / Stateful Responses item lookup for one turn and fall back to normal candidate resolution; the turn still succeeds, and new conversations are unaffected. No operator action is required.

## 2026-07-24 · advisory

### Audit dump files created before payload-file tracking

Before dump files were tracked in the shared `spilled_files` registry, an interrupted write could leave an unreferenced object under `dumps/v1/`. Runtime maintenance deliberately does not scan file prefixes. After the rolling deployment has settled and no request served by the pre-migration Worker remains in flight, an operator may reclaim that historical storage by listing `dumps/v1/` and deleting only exact keys that are neither referenced by a `dump_records` request/response body descriptor nor present in `spilled_files`. Do not delete the prefix or any other files. If an AI agent performs this audit, it must explain the safety conditions and ask the user before deleting anything.

## 2026-07-23 · hard

### Stateful Responses persistence reset and made opt-in

The migration drops every existing Responses item and snapshot. Old `previous_response_id` and stored `item_reference` chains no longer resolve; clients must start new chains after deployment.

New API keys and all migrated keys start with durable persistence disabled. Users who need cross-request Stateful Responses must configure a whole-day retention duration of at least one day for each API key. Reuse refreshes an item's lifetime at most once per UTC day; expiration allows one additional day so this write reduction never expires state early. Stored item IDs are now the exact IDs present on emitted items rather than a gateway namespace.

Immediately after deploying through this migration, the database contains no stored Responses items, and no new ones are persisted until an API key is manually opted in. We recommend manually deleting every object under the file-storage `responses-items/` namespace at that point; do not delete other stored files. The database can no longer reference these objects, so retaining them only consumes storage. This is an additional manual step after the automated deployment, not part of deploy automation. If an AI agent reads this entry, it must explain why this cleanup is recommended and ask the user whether to do it, without deleting the objects automatically.

## 2026-07-18 · hard

### Affinity and Responses state reset

The client-carried affinity mechanism was redesigned from scratch. Existing conversations that previously routed requests to a specific upstream model via affinity context lose that routing; subsequent messages may be dispatched to a different upstream than the one that produced the prior turns.

All Responses API items and snapshots stored before this date are discarded. References to old `previous_response_id` values no longer resolve; clients must start new response chains.
