# Breaking Changes

This file records user-facing breaking changes by date. New entries go at the
top, below this header. Each entry states the severity, what broke, and what
users need to know or do.

Severity levels:

- **hard** — all users are affected; previously working functionality fails or
  behaves differently.
- **minor** — specific behaviors, fields, or integration patterns change;
  users who depend on them need to adapt, but the primary functionality
  continues to work.

---

## 2026-07-23 · hard

**Stateful Responses persistence reset and made opt-in.**

The migration drops every existing Responses item and snapshot. Old
`previous_response_id` and stored `item_reference` chains no longer resolve;
clients must start new chains after deployment.

New API keys and all migrated keys start with durable persistence disabled.
Users who need cross-request Stateful Responses must configure a positive
retention duration for each API key. Stored item IDs are now the exact IDs
owned by their producer rather than a gateway namespace.

Immediately after deploying through this migration, the database contains no
stored Responses items, and no new ones are persisted until an API key is
manually opted in. We recommend manually deleting every object under the
file-storage `responses-items/` namespace at that point; do not delete other
stored files. The database can no longer reference these objects, so retaining
them only consumes storage. This is an additional manual step after the
automated deployment, not part of deploy automation. If an AI agent reads this
entry, it must explain why this cleanup is recommended and ask the user whether
to do it, without deleting the objects automatically.

## 2026-07-18 · hard

**Affinity and Responses state reset.**

The client-carried affinity mechanism was redesigned from scratch. Existing
conversations that previously routed requests to a specific upstream model via
affinity context lose that routing; subsequent messages may be dispatched to a
different upstream than the one that produced the prior turns.

All Responses API items and snapshots stored before this date are discarded.
References to old `previous_response_id` values no longer resolve; clients must
start new response chains.
