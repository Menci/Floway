---
name: backfill-model-pricing
description: Use when the human asks to write or rewrite `usage.unit_price` for
  some slice of usage rows — typically backfilling NULL rows, or overwriting a
  time range after a price change. Operates on a live D1 environment, defaults
  to production.
---

# Backfill Model Pricing

The `usage` table holds one row per `(key_id, model, upstream, model_key, hour,
tier, input_tier, dimension)` with a `tokens` count and a `unit_price` snapshot
(USD per million tokens for that billing dimension). `tier` is the upstream-
stamped service tier and `input_tier` is the input-length pricing marker; both
select per-request overlays. `unit_price` is captured at write time; NULL means
pricing was unknown then. This skill recomputes it for a chosen slice using the
current provider pricing.

## Flow

1. **Pick the environment.** Default `--remote` (production). Announce which
   one before any write.

2. **Get intent.** Need: target model(s), owning upstream, time window on
   `usage.hour`, and write mode (fill-NULL-only vs overwrite). If the human
   gives an explicit time, make them name the timezone — `usage.hour` is a
   text bucket and `hour` strings are ambiguous on their own. Ask for
   whatever is missing; do not guess the model or upstream.

3. **If the human gave no instruction**, show them the menu: enabled
   upstreams, and `(upstream, model_key, dimension)` aggregates over rows with
   `unit_price IS NULL` including count and `MIN/MAX(hour)`. Let them pick a
   slice from that.

4. **Resolve pricing per `(upstream, model_key)`** by reading the provider's
   own pricing source — TS code under `src/data-plane/providers/<provider>/`
   or the upstream's `config` JSON in `upstreams`. That yields a `ModelPricing`
   (a partial map of BillingDimension → USD/1M). Different provider kinds
   resolve differently; let the code/data be the source of truth rather than
   carrying a copy here. If a model has no rule, stop and report — do not
   invent one.

5. **Derive the per-dimension unit price.** Fold the row's overlays into the
   snapshot first with `resolveEffectivePricing(pricing, tier, input_tier)`
   (`packages/protocols/src/common/models.ts`) — this applies the service-tier
   and input-length overrides for that bucket — then take
   `unitPriceForDimension(effective, dimension)`: a modality with no dedicated
   rate falls back to the bare text rate (`input_image → input`,
   `output_image → output`) and cached input falls back to uncached
   (`input_cache_read`/`input_cache_write → input`). Mirror that fallback when
   computing the value to write; a `null` result means leave `unit_price` NULL.

6. **Preview** the affected COUNT and a small sample, then write one UPDATE
   per `(slice, tier, input_tier, dimension)`. The `WHERE` filter pins
   `dimension = ?` (and the row's `tier` / `input_tier`) and encodes the write
   mode (add `unit_price IS NULL` for fill-only; omit it to overwrite). After
   each write, re-count the slice to prove it landed.

7. **Report** per slice: upstream, model_key, dimension, price written, rows
   updated.

## Cautions

- Production D1. Treat every UPDATE as a deploy-grade action.
- `unit_price` is a single REAL: USD per million tokens for that one
  dimension, already resolved through the fallback chain. Do not write a JSON
  blob and do not write a raw rate that ignores the modality/cached fallback.
- Cost is `SUM(tokens * unit_price) / 1e6`, so a wrong `unit_price` silently
  misreports cost in aggregation. Validate the resolved number before writing.
- Writing today's price into old rows is the intended behavior. If the human
  wants price-at-the-time, they must supply the rate.
