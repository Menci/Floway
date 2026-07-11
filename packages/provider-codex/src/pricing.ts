// Per-public-model pricing table for the Codex (ChatGPT subscription)
// provider. Codex itself bills as a flat-fee subscription rather than per-token,
// but the gateway tracks usage cost as if the operator were paying OpenAI's
// public API rates — that lets the dashboard surface "value consumed vs. flat
// fee" so the operator can see whether a subscription is paying off relative
// to direct API spend. Values are USD per million tokens, aligned with
// the `Cost` schema in models.dev:
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
//
// Source of truth for OpenAI public API prices the table is derived from:
// https://developers.openai.com/api/docs/pricing
// Refresh procedure: .agents/skills/fetching-models-pricing/.
//
// Per-tier overrides cover the two OpenAI service-tier wire values reachable
// through the Codex CLI's `ServiceTier` enum (`priority` / `flex`):
//   - `flex` — discounted, latency-tolerant; the CLI sets `service_tier: "flex"`.
//     https://developers.openai.com/api/docs/guides/flex-processing
//   - `priority` — premium-priced, lower-latency lane; the CLI's `/fast` toggle
//     stamps `service_tier: "priority"`.
//     https://developers.openai.com/api/docs/guides/priority-processing
// https://github.com/openai/codex/blob/f774455c3a831dfab2c6f37a1f624b8097f6f2c2/codex-rs/protocol/src/config_types.rs#L445
// Whether a request actually goes through at the requested tier depends on
// what each model's catalog entry (`service_tiers` block in upstream
// `models.json`) accepts and on remaining capacity; OpenAI reports the
// actually-served tier in `usage.service_tier` and the gateway captures it
// onto `TokenUsage.tier` so cost compute picks the right row.
//
// Coverage: every slug the upstream catalog surfaces across current plans —
// the GPT-5.6 Sol / Terra / Luna family that shipped in July 2026, the
// preceding GPT-5.5 / 5.4 / 5.4-mini slugs, and the internal codex-auto-review
// entry. New slugs the upstream rolls out at higher plans (Pro / Team /
// Enterprise) should be added here so the dashboard reports their cost too.

import type { ModelPricing } from '@floway-dev/protocols/common';

const GPT_5_4_PRICING: ModelPricing = {
  input: 2.5,
  input_cache_read: 0.25,
  output: 15,
  tiers: {
    flex: { input: 1.25, input_cache_read: 0.13, output: 7.5 },
    priority: { input: 5, input_cache_read: 0.5, output: 30 },
  },
};

const CODEX_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  // GPT-5.6 family (Sol / Terra / Luna) shipped July 2026 and requires
  // codex-cli 0.144.0+ per the upstream models.json minimal_client_version.
  // Standard rates match models.dev + OpenRouter; each variant's catalog
  // entry advertises a `priority` service tier (no `flex` lane), and the
  // priority per-token rate is a flat 2× standard across the family —
  // distinct from GPT-5.5's 2.5× multiplier.
  ['gpt-5.6-sol', {
    input: 5,
    input_cache_read: 0.5,
    output: 30,
    tiers: {
      priority: { input: 10, input_cache_read: 1, output: 60 },
    },
  }],
  ['gpt-5.6-terra', {
    input: 2.5,
    input_cache_read: 0.25,
    output: 15,
    tiers: {
      priority: { input: 5, input_cache_read: 0.5, output: 30 },
    },
  }],
  ['gpt-5.6-luna', {
    input: 1,
    input_cache_read: 0.1,
    output: 6,
    tiers: {
      priority: { input: 2, input_cache_read: 0.2, output: 12 },
    },
  }],
  ['gpt-5.5', {
    input: 5,
    input_cache_read: 0.5,
    output: 30,
    tiers: {
      flex: { input: 2.5, input_cache_read: 0.25, output: 15 },
      priority: { input: 12.5, input_cache_read: 1.25, output: 75 },
    },
  }],
  ['gpt-5.4', GPT_5_4_PRICING],
  ['gpt-5.4-mini', {
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
    tiers: {
      flex: { input: 0.375, input_cache_read: 0.0375, output: 2.25 },
      priority: { input: 1.5, input_cache_read: 0.15, output: 9 },
    },
  }],
  // Internal review model gated under codex_cli_rs's auto-review feature. No
  // public price surface; billed as a notional clone of gpt-5.4 (closest
  // analogue we have).
  ['codex-auto-review', GPT_5_4_PRICING],
];

// Codex doesn't apply variant suffixes to model ids — the upstream's slug is
// the public id verbatim — so the modelKey persisted in `usage.model_key`
// matches the table key directly.
export const pricingForCodexModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CODEX_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
