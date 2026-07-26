---
name: audit-copilot-workarounds
description: Use periodically to verify each Copilot workaround against the
  current upstream. Inventories provider registrations and reference URLs,
  dispatches parallel cluster audits, runs live probes, and produces focused
  deletion commits with experimental justification.
---

# Audit Copilot Workarounds

Workarounds rot. Revalidate them against the current Copilot upstream.

## Flow

1. Build the inventory from
   `packages/provider-copilot/src/interceptors/{chat-completions,messages,responses}/index.ts`
   and `packages/provider-copilot/src/defaults.ts`. Follow every registered
   interceptor and default-enabled shim to its implementation. The provider code
   and the reference URLs beside each workaround are the inventory; there is no
   separate documentation list to reconcile.
2. Group the inventory by source API, target API, and behavior so independent
   clusters can be investigated without overlapping edits.
3. Dispatch parallel read-only audits, one per cluster. Recheck the cited
   upstream or prior-art source, inspect current Copilot behavior, and record the
   exact code path that would be deleted if the workaround is obsolete.
4. Continue audit rounds until every open question requires either a live probe
   or a human policy decision.
5. Run the required live probes, then land each proven deletion with its tests
   and any provider-code reference cleanup. Hand unresolved policy decisions to
   the human.

## Extra constraints

- **Live probes follow `probing-copilot`** — credential discovery, token
  exchange, headers, and direct upstream calls all live there. Do not ask the
  human for credentials and do not route probes through Floway.
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
  Thresholds, floors, and retry counts must explicitly identify an empirical or
  prior-art basis and include the relevant permalink.
