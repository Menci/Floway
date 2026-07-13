---
name: backfill-model-pricing
description: Write or rewrite usage.unit_price for a selected slice of live D1 usage rows, typically filling NULL rates or correcting a time range after a pricing change. Defaults to production.
---

# Backfill Model Pricing

`usage` stores one row per
`(key_id, model, upstream, model_key, hour, pricing_selector, dimension)`.
`tokens` is the count and `unit_price` is the request-time USD-per-million-
token rate snapshot. `pricing_selector` is canonical selector JSON; `{}`
is the base coordinate.

## Procedure

1. Announce the environment. Default to production (`--remote`).
2. Establish the exact model, upstream, hour range, timezone, dimensions, and
   write mode:
   - fill only rows where `unit_price IS NULL`; or
   - overwrite the selected range.
3. If intent is incomplete, show enabled upstreams and grouped NULL-rate rows
   by `(upstream, model_key, pricing_selector, dimension)`, including count
   and `MIN/MAX(hour)`. Do not guess.
4. Read the current provider rate source or the upstream's
   `config_json.models[].pricing`. Resolve one `ModelPricing` per
   `(upstream, model_key)`.
5. Match the stored `pricing_selector` exactly against
   `ModelPricing.entries` using canonical selector JSON.
   - Current runtime selector misses are stored as `{}` with Base rates.
   - A historical non-Base selector absent from today's catalog indicates
     catalog drift; stop and investigate rather than guessing its old rates.
   - Read only `entry.rates[dimension]`.
   - A missing dimension is unpriced; there is no cache, image, or other
     field-by-field fallback.
6. Preview the affected count and representative rows.
7. Execute one UPDATE per exact
   `(slice, pricing_selector, dimension)`. Include
   `unit_price IS NULL` only in fill mode.
8. Re-query every slice and report the selector, dimension, rate, rows updated,
   and remaining NULL count.

Use the local Wrangler dependency and read the D1 database name from
`wrangler.jsonc`. Never ask the human for credentials already available to
Wrangler.

## Safety

- Treat every production UPDATE as a deploy-grade mutation.
- Do not write a JSON rate vector into `unit_price`; it is one scalar.
- Do not map an obsolete selector to a newer “closest” threshold.
- Leave rows NULL when the current catalog has no exact entry or explicit
  dimension rate.
- Realized cost is `SUM(tokens * unit_price) / 1e6`; validate each scalar
  before writing.
- Writing today's documented rate into historical rows is intentional unless
  the human explicitly supplies price-at-the-time data.
