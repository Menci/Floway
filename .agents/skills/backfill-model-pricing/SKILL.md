---
name: backfill-model-pricing
description: Write or rewrite usage.unit_price for a selected slice of live D1 usage rows, typically filling NULL rates or correcting a time range after a pricing change. Defaults to production.
---

# Backfill Model Pricing

`usage` stores one metric row per unique
`(key_id, model, COALESCE(upstream, ''), model_key, hour, pricing_selector, metric)`.
`quantity` is a canonical non-negative decimal string. `unit_price` is either
NULL or a canonical non-negative decimal string containing USD per one base
unit of that metric. `pricing_selector` is canonical selector JSON; `{}` is the
Base coordinate.

The seven metrics established by
`packages/gateway/migrations/0062_usage_billing_metrics.sql` are:

- `input_tokens`
- `input_cache_read_tokens`
- `input_cache_write_tokens`
- `input_cache_write_1h_tokens`
- `input_image_tokens`
- `output_tokens`
- `output_image_tokens`

Realized cost is `SUM(quantity * unit_price)`. Both operands are decimal
strings in storage, and there is no additional scaling step.

## Procedure

1. Announce the environment. Default to production (`--remote`).
2. Before planning or running an UPDATE, re-read the current implementations in
   `packages/gateway/src/repo/sql.ts` (`SqlUsageRepo` and usage row assembly)
   and `packages/gateway/src/control-plane/token-usage/aggregate.ts` (cost
   aggregation). They are the authority if this procedure and the runtime ever
   diverge.
3. Establish the exact model, upstream, hour range, timezone, metrics, and write
   mode:
   - fill only rows where `unit_price IS NULL`; or
   - overwrite the selected range.
4. If intent is incomplete, show enabled upstreams and grouped NULL-price rows
   by `(upstream, model_key, pricing_selector, metric)`, including count and
   `MIN/MAX(hour)`. Do not guess.
5. Read the current provider rate source or the upstream's
   `config_json.models[].pricing`. Resolve one `ModelPricing` per
   `(upstream, model_key)`.
6. Match the stored `pricing_selector` exactly against `ModelPricing.entries`
   using canonical selector JSON.
   - Current runtime selector misses are stored as `{}` with Base rates.
   - A historical non-Base selector absent from today's catalog indicates
     catalog drift; stop and investigate rather than guessing its old rates.
   - Read only `entry.rates[metric]`. These runtime rates are already USD per
     base metric unit.
   - When a provider source uses `tokenPricingEntry` or `tokenBasePricing`, its
     source literals are published token rates and the helper applies
     `perMillionTokenRates`; apply the same conversion rather than copying a
     source literal into `unit_price`.
   - A missing metric is unpriced; there is no cache, image, or other
     field-by-field fallback.
7. Preview the affected count and representative rows, including the current
   and proposed decimal-string `unit_price`.
8. Execute one UPDATE per exact `(slice, pricing_selector, metric)`. Include
   `unit_price IS NULL` only in fill mode, preserve NULL upstream matching with
   `COALESCE(upstream, '')`, and bind the new rate as a decimal string.
9. Re-query every slice and report the selector, metric, rate, rows updated, and
   remaining NULL count. Independently validate the realized-cost expression on
   representative rows.

Use the local Wrangler dependency and read the D1 database name from
`wrangler.jsonc`. Never ask the human for credentials already available to
Wrangler.

## Safety

- Treat every production UPDATE as a deploy-grade mutation.
- Do not write a JSON rate vector into `unit_price`; it is one scalar.
- Do not map an obsolete selector to a newer “closest” threshold.
- Leave rows NULL when the current catalog has no exact entry or explicit
  metric rate.
- Validate decimal-string multiplication without converting through JavaScript
  numbers or SQL floating-point arithmetic.
- Writing today's documented rate into historical rows is intentional unless
  the human explicitly supplies price-at-the-time data.
