---
name: fetching-models-pricing
description: Refresh per-model pricing tables for Floway providers whose upstream does not bill per token or publish usable token rates, especially Copilot, Codex, Claude Code, and Ollama. Manual research procedure; no script.
---

# Fetching Models Pricing

Maintain the notional per-token rate cards in:

| Provider | Table | Live catalog |
|---|---|---|
| Copilot | `packages/provider-copilot/src/pricing.ts` | Copilot `/models` |
| Codex | `packages/provider-codex/src/pricing.ts` | authenticated `/codex/models` |
| Claude Code | `packages/provider-claude-code/src/pricing.ts` | authenticated Anthropic `/v1/models` |
| Ollama | `packages/provider-ollama/src/pricing.ts` | `/api/tags` + `/api/show` |

These providers are subscription-backed or self-hosted. Floway records
notional API-equivalent value so the usage dashboard remains comparable.

## Procedure

1. Fetch each maintained provider's live catalog and diff its ids against the
   table's string and RegExp keys. Record new, retired, and renamed models.
2. Find a defensible rate source for every new id:
   - Prefer the model vendor's first-party API.
   - For open weights with no vendor API, use a credible commodity host.
   - For retired versions, use a permalink or dated archive from when the
     version was current.
3. Cross-check at least two sources. models.dev's external field remains
   `cost`:
   `curl -s https://models.dev/api.json | jq '.<provider>.models["<id>"].cost'`.
   Treat OpenRouter prices below first-party rates as mirror-host prices, not
   the canonical vendor rate.
4. Author a `ModelPricing` with `basePricing`, `modelPricing`, and
   `pricingEntry`.

Each pricing entry is one exact selector coordinate plus explicit USD-per-
million-token rates:

```ts
modelPricing(
  pricingEntry({ input: 2.5, input_cache_read: 0.25, output: 15 }),
  pricingEntry(
    { input: 5, input_cache_read: 0.5, output: 22.5 },
    { inputTokens: { operator: 'gt', value: 272000 } },
  ),
)
```

Rules:

- Every entry for one model must define the same rate dimensions.
- Declare exactly one Base entry with no selector; compare every other entry's
  rate fields against Base.
- A missing exact selector uses the whole Base vector. Never merge entries or
  inherit individual cache/image rates from input/output. A rate dimension
  absent from Base is unpriced everywhere.
- `serviceTier` is an open-string equality coordinate.
- `inputTokens` is a whole-request `gt` or `gte` threshold, not a
  marginal token bucket.
- Threshold-only entries define global bands. Thresholds combined with
  equality coordinates apply only within that exact scope. Runtime selects the
  highest matching threshold from the union of global and matching-scope bands,
  then performs one exact rate lookup. Publish every documented Cartesian
  combination; leave undocumented combinations absent.
- Return `null` when no defensible rate exists. Do not extrapolate from an
  adjacent model.

5. Increment `MODEL_CATALOG_REVISION` in
   `packages/gateway/src/data-plane/providers/models-cache.ts` whenever any of
   the four embedded pricing tables changes. Static rates are persisted inside
   cached `ProviderModel` rows; the revision makes every older row cold on the
   next request.
6. Add boundary tests and prove selector misses return Base wholesale through
   `priceRequest`.
7. Run all four provider test suites, typecheck, lint, and the full test suite.
8. If an existing rate changed, use `backfill-model-pricing` for the intended
   historical slice.

## Provider-specific identity

- Copilot usage stores raw variant suffixes in `model_key`;
  `pricingForCopilotModelKey` normalizes them to the public id.
- Claude Code resolves pricing from the dated raw upstream id before catalog
  aliases are merged into public ids.
- Codex and Ollama use the raw upstream slug directly.

## Source cautions

- Ignore LiteLLM's zero-valued `ollama/*` namespace.
- Do not confuse Ollama subscription GPU weights with token prices.
- Verify ambiguous version names against release notes before sharing a rate.
- Document each vendor constant with a permalink or stable official URL.
