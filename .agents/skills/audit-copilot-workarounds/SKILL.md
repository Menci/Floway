---
name: audit-copilot-workarounds
description: Use periodically to verify each documented workaround is still
  needed against current Copilot upstream. Inventories drift, dispatches
  parallel cluster audits, runs live probes, and produces deletion commits
  with experimental justification.
---

# Audit Copilot Workarounds

Workarounds rot. Re-validate them against current Copilot upstream.

## Flow

1. Inventory drift between `index.ts` registrations and AGENTS.md
   "Data Plane Workarounds".
2. Dispatch parallel read-only audits, one per source/target × API cluster.
3. Loop further agent rounds until remaining open questions are only
   "needs live probe" or "needs human decision".
4. Run live probes for the former.
5. Land deletion + doc commits. Hand the human the rest.

## Extra constraints

- **Live probes follow `probing-copilot`** — credential discovery, token
  exchange, headers, and direct upstream calls all live there. Don't ask the
  human for credentials and don't route probes through our gateway.
- **Full-matrix evidence.** Test every applicable model from `GET /models`,
  on every account in D1 (different account types may diverge). One model on
  one account is never enough to delete.
- **One workaround per deletion commit.** Never bundle.
- **Each deletion commit message must contain the live experiment
  conclusion** that justified it: which models tested, which values,
  exact upstream error text when relevant, and the originating commit
  sha being reverted.
- **When a policy value (threshold, floor, retry count) has no official
  upstream basis, the comment must say so explicitly** in addition to
  citing prior-art permalinks.
