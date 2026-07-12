---
name: fetching-models-pricing
description: Refresh per-model pricing tables for Floway providers whose upstream does not bill per token or publish usable token rates, especially Copilot, Codex, and Ollama. Manual research procedure; no script.
---

# Fetching Models Pricing

Maintain the notional per-token rate cards in:

| Provider | Table | Live catalog |
|---|---|---|
| Copilot | `packages/provider-copilot/src/pricing.ts` | Copilot `/models` |
| Codex | `packages/provider-codex/src/pricing.ts` | authenticated `/codex/models` |
| Ollama | `packages/provider-ollama/src/pricing.ts` | `/api/tags` + `/api/show` |

These providers are subscription-backed or self-hosted. Floway records
notional API-equivalent value so the usage dashboard remains comparable.

## Procedure

1. Fetch the live provider catalog and diff its ids against the table's string
   and RegExp keys. Record new, retired, and renamed models.
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
- Absence means unpriced. Never inherit cache/image rates from input/output,
  and never inherit rates between selector coordinates.
- `serviceTier` is an open-string equality coordinate.
- `inputTokens` is a whole-request `gt` or `gte` threshold, not a
  marginal token bucket.
- A service-specific threshold entry requires the corresponding threshold-only
  entry. Publish every documented Cartesian combination; leave undocumented
  combinations absent.
- Return `null` when no defensible rate exists. Do not extrapolate from an
  adjacent model.

5. Add boundary and exact-missing tests through `priceRequest`.
6. Run provider tests, typecheck, lint, and the full test suite.
7. If an existing rate changed, use `backfill-model-pricing` for the intended
   historical slice.

## Provider-specific identity

- Copilot usage stores raw variant suffixes in `model_key`;
  `pricingForCopilotModelKey` normalizes them to the public id.
- Codex and Ollama use the raw upstream slug directly.

## Source cautions

- Ignore LiteLLM's zero-valued `ollama/*` namespace.
- Do not confuse Ollama subscription GPU weights with token prices.
- Verify ambiguous version names against release notes before sharing a rate.
- Document each vendor constant with a permalink or stable official URL.
