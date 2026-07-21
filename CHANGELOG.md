# Breaking Changes

This file records user-facing breaking changes by date. It is prepend-only:
new entries go at the top, below this header. Each entry states the date,
severity, what broke, and what users need to know or do.

Severity levels:

- **hard** — all users are affected; previously working functionality
  fails or behaves differently.
- **minor** — specific behaviors, fields, or integration patterns change;
  users who depend on them need to adapt, but the primary functionality
  continues to work.

---

## 2026-07-18 · hard

**Affinity and Responses state reset.**

The client-carried affinity mechanism was redesigned from scratch.
Existing conversations that previously routed requests to a specific
upstream model via affinity context will lose that routing — subsequent
messages may be dispatched to a different upstream than the one that
produced the prior turns.

All Responses API items and snapshots stored before this date are
discarded. References to old `previous_response_id` values will no
longer resolve; clients must start new response chains.
