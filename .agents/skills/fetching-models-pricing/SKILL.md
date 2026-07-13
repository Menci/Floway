---
name: fetching-models-pricing
description: Refresh per-model pricing tables for Floway providers whose upstream does not bill per token or publish usable token rates, especially Copilot, Codex, Claude Code, and Ollama. Manual research procedure; no script.
---

# Fetching Models Pricing

Maintain the notional per-token rate tables in:

| Provider | Table | Live catalog | Preferred rate source |
|---|---|---|---|
| Copilot | `packages/provider-copilot/src/pricing.ts` | Copilot `/models` | model vendor's first-party API |
| Codex | `packages/provider-codex/src/pricing.ts` | authenticated `/codex/models` | OpenAI API pricing |
| Claude Code | `packages/provider-claude-code/src/pricing.ts` | authenticated Anthropic `/v1/models` | Anthropic API pricing |
| Ollama | `packages/provider-ollama/src/pricing.ts` | `/api/tags` + `/api/show` | vendor API or a credible commodity host |

These providers are subscription-backed or self-hosted. Floway records
notional API-equivalent value so the usage dashboard remains comparable.

## Procedure

1. Fetch the provider's live catalog and diff its ids against the table's
   string and RegExp keys. Record new, retired, and renamed models.
2. Find a defensible rate source for every new id:
   - Prefer the model vendor's first-party API.
   - For open weights with no vendor API, use the cheapest credible commodity
     host that publishes the required dimensions.
   - For retired versions, use a permalink or dated archive from when that
     version was current.
3. Cross-check at least two sources. models.dev is useful as an independent
   comparison:

   ```bash
   curl -s https://models.dev/api.json | jq '.<provider>.models["<id>"].cost'
   ```

   OpenRouter prices below first-party rates are usually mirror-host prices,
   not the canonical vendor rate.
4. Edit the provider table. Use USD per million tokens and preserve the table's
   first-hit-wins ordering. Exact ids are preferable; use a RegExp only when
   every matched release genuinely shares one rate.
5. Return `null` when no defensible price exists. Never extrapolate from an
   adjacent version or silently substitute a similarly named model.
6. Increment `MODEL_CATALOG_REVISION` in
   `packages/gateway/src/data-plane/providers/models-cache.ts`. Static pricing
   is serialized inside cached `ProviderModel` rows; a revision mismatch makes
   every older row cold before TTL evaluation.
7. Add boundary tests for exact ids, aliases, dated releases, and RegExp
   coverage boundaries encoded by the table.
8. Run the affected provider tests, typecheck, lint, and the full test suite.
9. If an existing rate changed, use `backfill-model-pricing` for the intended
   historical usage slice. Cache revisioning changes future catalog snapshots;
   it does not rewrite recorded unit prices.

## Catalog revision policy

`MODEL_CATALOG_REVISION` versions the complete persisted `ProviderModel`
contract, not only pricing tables. Increment it for any code change that alters
code-derived catalog metadata or its serialized representation. Upstream-only
catalog changes do not require a bump because normal TTL refreshes fetch them.

The revision is global by design. A mismatch blocks on a fresh fetch and never
falls back to the incompatible stored row. Successful fetches overwrite the row
with the current revision; failed fetches leave the old row present but
ineligible.

## Model identity

- Copilot usage stores raw variant suffixes such as `-high`, `-xhigh`, and
  `-1m` in `model_key`; its pricing lookup normalizes them to the public id.
- Claude Code resolves pricing from the dated raw upstream id before catalog
  aliases are merged into public ids.
- Codex and Ollama use the raw upstream slug directly.

## Choosing a source

- DeepSeek, Z.ai, Anthropic, OpenAI, Mistral, Google, Kimi, and MiniMax models:
  use the vendor's first-party API price when available.
- Open weights without a vendor-operated API: compare credible commodity hosts
  such as DeepInfra, Groq, Together, and OpenRouter.
- Historical aliases that now point at another release: use a dated official
  page or Wayback snapshot from the relevant period.
- Models whose visible name cannot be tied to a release: leave unpriced.

## Sources to reject

- LiteLLM's zero-valued `ollama/*` entries: those zeroes are intentional
  placeholders, not market prices.
- Ollama library labels such as Light, Medium, High, or Extra High: they are
  subscription GPU-time weights, not token prices.
- A cheaper OpenRouter mirror when the vendor itself sells the model: that is a
  different host's price.
- Ambiguous name similarity without release-note evidence.

Every vendor constant must retain a permalink or stable official URL explaining
the selected rate. Record non-obvious source choices beside the table entry so
the next refresh does not have to reconstruct the decision.
