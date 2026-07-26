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

`BILLING_METRICS` in `packages/protocols/src/common/pricing.ts` owns the
complete metric domain, and `BillingMetric` is derived from it. Read that array
before every operation and enumerate the metrics present in the
selected database slice; do not maintain another metric list in this procedure.
The repository read path rejects stored metric values outside that domain.

Realized cost is the sum of `quantity * unit_price` for priced metric rows. Both
operands are decimal strings in storage, and there is no additional scaling
step. Aggregation skips NULL-price rows: cost is NULL only when no metric row was
priced, while a non-NULL cost may still be partial when other metric rows remain
unpriced.

## Procedure

1. Announce the environment. Default to production (`--remote`).
2. Before planning or running an UPDATE, re-read the current implementations in
   `packages/gateway/src/repo/sql.ts` (`SqlUsageRepo` and usage row assembly),
   `packages/gateway/src/repo/types.ts` (the usage contracts), and
   `packages/gateway/src/control-plane/token-usage/aggregate.ts` (cost
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
   - An exact selector hit uses that entry. A selector miss in a catalog with a
     Base entry is recorded as `{}` with the whole Base vector.
   - A non-Base selector on an unpriced row is ordinary when no `ModelPricing`
     existed: runtime facts form the selector before rate lookup, and it is
     retained when no Base rates exist. It is not catalog drift by itself.
   - A priced sibling row for the same `(upstream, model_key)` proves that a
     catalog existed. If such a slice also contains an unpriced non-Base selector
     absent from today's catalog, stop and investigate historical catalog drift.
     Without a priced sibling, resolve today's catalog normally but never infer
     historical rates.
   - Read only the evaluated `entry.rates[metric]`; those values are already USD
     per base metric unit. Never transcribe a numeric literal from a provider
     `pricing.ts` into `unit_price`.
   - A missing metric is unpriced; there is no cache, image, audio, rerank, or
     other field-by-field fallback.
7. Preview the affected count and representative rows, including the current
   and proposed decimal-string `unit_price`.
8. Execute one UPDATE per exact `(slice, pricing_selector, metric)`. Include
   `unit_price IS NULL` only in fill mode, preserve NULL upstream matching with
   `COALESCE(upstream, '')`, and bind the new rate as a decimal string.
9. Re-query every slice and report the selector, metric, rate, rows updated, and
   remaining NULL count per metric. Compare those NULL counts with the expected
   metric set; a non-NULL aggregate cost does not prove the slice is fully
   priced. Independently validate decimal-string multiplication on
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
