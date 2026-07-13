---
name: fetching-models-pricing
description: Refresh per-model pricing tables for Floway providers whose upstream does not bill per token or publish usable token rates, especially Copilot, Codex, Claude Code, and Ollama. Manual research procedure; no script.
---

# Fetching Models Pricing

Maintain the notional per-token rate cards in:

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
3. Cross-check at least two sources. models.dev remains useful as an independent
   comparison under its external `cost` field:

   ```bash
   curl -s https://models.dev/api.json | jq '.<provider>.models["<id>"].cost'
   ```

   OpenRouter prices below first-party rates are usually mirror-host prices,
   not the canonical vendor rate.
4. Author one `ModelPricing` with `modelPricing` and `pricingEntry`:

   ```ts
   modelPricing(
     pricingEntry({ input: 2.5, input_cache_read: 0.25, output: 15 }),
     pricingEntry(
       { input: 5, input_cache_read: 0.5, output: 22.5 },
       { inputTokens: { operator: 'gt', value: 272000 } },
     ),
   )
   ```

   Every entry is one exact selector coordinate plus explicit USD-per-million-
   token rates. Follow these invariants:

   - Declare exactly one Base entry without a selector.
   - Give every entry the same rate dimensions as Base.
   - Never merge entries or inherit individual cache/image rates from another
     dimension. A dimension absent from Base is unpriced everywhere.
   - Treat `serviceTier` as an open-string equality coordinate.
   - Treat `inputTokens` `gt` / `gte` thresholds as whole-request bands, not
     marginal token buckets.
   - Threshold-only entries are global. Thresholds combined with equality
     coordinates apply only inside that exact scope. Runtime selects the
     highest matching global or scoped threshold, then performs one exact rate
     lookup.
   - A missing exact selector uses the whole Base vector. Do not synthesize an
     undocumented Cartesian combination.
   - Return `null` when no defensible price exists. Never extrapolate from an
     adjacent version or similarly named model.
5. Increment `MODEL_CATALOG_REVISION` in
   `packages/gateway/src/data-plane/providers/models-cache.ts`. Static pricing
   is serialized inside cached `ProviderModel` rows; a mismatch makes every
   older row cold before TTL evaluation.
6. Add boundary tests for exact ids, aliases, dated releases, RegExp coverage,
   threshold edges, and Base fallback through `priceRequest`.
7. Run all affected provider tests, typecheck, lint, and the full test suite.
8. If an existing rate changed, use `backfill-model-pricing` for the intended
   historical usage slice. Catalog revisioning changes future snapshots; it
   does not rewrite recorded unit prices.

## Catalog Revision Policy

`MODEL_CATALOG_REVISION` versions the complete persisted `ProviderModel`
contract, not only pricing tables. Increment it for any code change that alters
code-derived catalog metadata or its serialized representation. Upstream-only
catalog changes do not require a bump because normal TTL refreshes fetch them.

The revision is global by design. A mismatch blocks on a fresh fetch and never
falls back to the incompatible stored row. Successful fetches overwrite the row
with the current revision; failed fetches leave the old row present but
ineligible.

## Provider Identity

- Copilot usage stores raw variant suffixes such as `-high`, `-xhigh`, and
  `-1m` in `model_key`; its pricing lookup normalizes them to the public id.
- Claude Code resolves pricing from the dated raw upstream id before catalog
  aliases are merged into public ids.
- Codex and Ollama use the raw upstream slug directly.

## Source Cautions

- Ignore LiteLLM's zero-valued `ollama/*` entries; those are placeholders, not
  market prices.
- Do not confuse Ollama library labels such as Light, Medium, High, or Extra
  High with token prices; they are subscription GPU-time weights.
- Do not use a cheaper OpenRouter mirror when the vendor itself sells the
  model; that is another host's price.
- Verify ambiguous version names against release notes before sharing a rate.
- Keep a permalink or stable official URL beside every vendor constant and
  document non-obvious source choices next to the table entry.
