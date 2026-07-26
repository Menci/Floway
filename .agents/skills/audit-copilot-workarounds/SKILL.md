---
name: audit-copilot-workarounds
description: Use periodically to verify each Copilot workaround against the
  current upstream. Inventories provider registrations and reference URLs,
  dispatches parallel cluster audits, runs live probes, and produces focused
  deletion or maintenance commits with experimental justification.
---

# Audit Copilot Workarounds

Workarounds and pinned wire mimicry rot. Revalidate them against the current
Copilot upstream.

## Build the inventory

The provider code and the reference URLs beside each workaround are the
inventory; there is no separate documentation list to reconcile.

1. Start from
   `packages/provider-copilot/src/interceptors/{chat-completions,messages,responses}/index.ts`
   and `packages/provider-copilot/src/defaults.ts`. Follow every registered
   interceptor and default-enabled shim to its implementation and tests.
2. Sweep the rest of `packages/provider-copilot/src` for non-pricing reference
   URLs and for vendor constants, thresholds, timeouts, retries, and pinned wire
   values that require a reference but may be missing one. Pricing citations
   belong to `fetching-models-pricing`; everything else remains in this audit.
3. Include provider-level request/result shaping and catalog shaping even when
   they are not interceptors. In particular, inspect `provider.ts`,
   `fetch-models.ts`, `known-models.ts`, `model-selection.ts`, and
   `merge-claude-variants.ts` together with their imports and tests.
4. Include the authentication fingerprint and management/data-plane behavior in
   `auth.ts`, plus Responses item identity and replay handling rooted at
   `interceptors/responses/item-id-membrane.ts`. Follow adjacent carrier and
   compaction modules rather than assuming the interceptor registry contains the
   whole workaround.
5. Record each item's owning module, reference URLs, affected source and target
   APIs, models, account scope, default flag state, tests, and exit condition:
   delete an obsolete workaround, refresh pinned mimicry, or retain it with
   current evidence.

## Audit flow

1. Group the inventory by source API, target API, and behavior so independent
   clusters can be investigated without overlapping edits.
2. Dispatch parallel read-only audits, one per cluster. Recheck the cited
   upstream or prior-art source, inspect current Copilot behavior, and record the
   exact code path that would be deleted or refreshed.
3. Continue audit rounds until every open question requires either a live probe
   or a human policy decision.
4. Run the required live probes, then land each proven deletion or maintenance
   update with its tests and reference cleanup. Hand unresolved policy decisions
   to the human.

## Extra constraints

- **Live probes follow `probing-copilot`** — credential discovery, token
  exchange, headers, proxy fallback order, and direct upstream calls all live
  there. Do not ask the human for credentials and do not route probes through
  Floway.
- **Full-matrix evidence.** Test every applicable model from `GET /models` on
  every account in D1; different accounts can diverge. One model on one account
  is never enough to delete a workaround.
- **Source references are leads, not proof.** A still-valid URL explains why a
  workaround exists; only current upstream behavior proves whether it remains
  necessary.
- **One workaround per deletion commit.** Never bundle independent removals.
- **Each deletion commit message must contain the live experiment conclusion**
  that justified it: accounts and models tested, values exercised, exact
  upstream error text when relevant, and the originating commit SHA being
  reverted.
- **When a policy value has no official upstream basis, say so in code.**
  Thresholds, floors, timeouts, retry counts, and pinned fingerprints must
  identify an empirical or prior-art basis and include the relevant permalink.
