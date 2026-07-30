# Deployment Notes

This file records user-facing breaking changes and recommended deployment operations by date. New entries go at the top, below this header. Each entry states its impact level and what users need to know or do.

Impact levels:

- **hard** — all users are affected; previously working functionality fails or behaves differently.
- **minor** — specific behaviors, fields, or integration patterns change; users who depend on them need to adapt, but the primary functionality continues to work.
- **advisory** — no behavior breaks, but an agent or operator should consider a concrete deployment-related follow-up action.

Hard and minor entries may include recommended actions; those actions do not need a separate advisory entry.

## 2026-07-30 · minor

### A failed Responses WebSocket continuation drops its `previous_response_id`

When a WebSocket turn that carried `previous_response_id` fails with a 4xx or 5xx error, that response id is now evicted from the connection-local state the socket keeps for `store:false` chains, as the OpenResponses 2026-04-24 continuation rules require. A chain that previously survived a failed turn — retrying the same `previous_response_id` after an upstream rejection — now fails the retry with `previous_response_not_found`. Clients recover by starting a new response without `previous_response_id` and resending the full input context. Chains with `store:true` and a non-zero API-key retention window are unaffected: they still resolve from durable state, which is never evicted.

## 2026-07-30 · minor

### Responses WebSocket no longer sends `ping` keep-alive frames, and long turns need a client heartbeat

The Responses WebSocket transport no longer synthesizes a `{ "type": "ping" }` frame every 15 s while a turn is idle. `ping` is not a member of the OpenResponses 2026-04-24 streaming-event union, so a client that validated the stream against the union previously failed any turn long enough to produce one; clients that treated the frame as a liveness signal must stop expecting it. The Responses SSE transport is unchanged — its keep-alive was always an SSE comment line, invisible to the event stream.

The WebSocket case has a deployment consequence on Cloudflare. A turn that reasons for a long time now sends nothing at all over the socket, and Cloudflare's edge closes a WebSocket that has been idle in both directions; a measured probe against a Cloudflare-proxied endpoint was torn down at 125 s. Floway cannot replace the JSON frame with a protocol-level ping, because the Workers runtime does not expose ping/pong to Worker code (https://github.com/cloudflare/workerd/issues/3664). Recommended actions: clients holding a Floway Responses WebSocket should send a protocol-level ping roughly every 30 s — the runtime auto-replies with a pong, which resets the edge's idle timer; operators on an Enterprise Cloudflare account can additionally request a custom WebSocket idle timeout from Cloudflare support. Self-hosted deployments on the Node target are unaffected, as nothing between the client and the process enforces an idle timeout.

## 2026-07-30 · minor

### Responses WebSocket turns end on the terminal event, and `response.done` is gone

The Responses WebSocket transport no longer sends a trailing `{ "type": "response.done" }` frame. That frame was a Floway extension outside the OpenResponses streaming-event union; the terminal event (`response.completed`, `response.failed`, or `response.incomplete`) now carries the guarantee it advertised — it is flushed only after the turn's item and snapshot writes have committed and the event stream has drained, and it is the last frame of the turn. Clients that waited for `response.done` before sending the next `response.create` must wait for the terminal event instead; its `response.id` is the id to continue from.

## 2026-07-30 · minor

### Responses WebSocket error frames carry `status` instead of `status_code`

The JSON error envelope sent on the Responses WebSocket transport renamed its HTTP-style status key from `status_code` to `status`, matching the OpenResponses 2026-04-24 `WebSocketErrorEvent` contract. The nested `error` object (`type`, `code`, `message`, `param`) is unchanged, so clients that only read `error.code` need no adaptation; clients that read the numeric status off the envelope must read `status`.

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
