// Per-public-model pricing for the Claude Code (Claude.ai subscription)
// provider. Claude Code subscriptions bill as a flat fee rather than per
// token, but the dashboard tracks notional cost as if the operator were
// paying Anthropic's public API rates — so the operator can see whether a
// subscription is paying off relative to direct API spend.
//
// Values are USD per million tokens, aligned with the `Cost` schema in
// models.dev:
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
//
// Source of truth verified 2026-06-19 against
// https://docs.claude.com/en/docs/about-claude/pricing. The cache ratios
// hold for every entry on that page: `input_cache_read = input * 0.1`,
// `input_cache_write = input * 1.25` (5-minute), `input_cache_write_1h =
// input * 2`.
//
// Keying: pre-4.6 models (4.5 / 4.1) return from /v1/models with a date
// suffix, so the upstream-key (the dispatcher's `modelKey`) is the dated
// id. 4.6+ and `claude-fable-5` return without one, so the alias is also
// the key.
//
// Fast mode: Anthropic offers a premium-priced inference tier on Opus 4.6,
// 4.7, and 4.8 only. The wire surfaces it as `usage.speed: 'fast'`, which
// the gateway folds into `TokenUsage.tier` and looks up under
// `ModelPricing.tiers.fast`. Per the docs, "prompt caching multipliers
// apply on top of fast mode pricing", so each fast-tier override carries
// its own cache rates derived from the override input rate (× 0.1 for read,
// × 1.25 for 5m write, × 2 for 1h write).

import type { ModelPricing } from '@floway-dev/protocols/common';

const OPUS_TIER: ModelPricing = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, input_cache_write_1h: 10, output: 25 };
const SONNET_TIER: ModelPricing = { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, input_cache_write_1h: 6, output: 15 };
// Sonnet 5 — Anthropic introductory pricing runs through 2026-08-31; the
// SONNET_TIER sticker rate takes over afterwards. Cache ratios follow the
// same 0.1× / 1.25× / 2× ratios documented above.
const SONNET_5_INTRO_TIER: ModelPricing = { input: 2, input_cache_read: 0.2, input_cache_write: 2.5, input_cache_write_1h: 4, output: 10 };
const HAIKU_TIER: ModelPricing = { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_cache_write_1h: 2, output: 5 };
const FABLE_TIER: ModelPricing = { input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 };
const OPUS_LEGACY_TIER: ModelPricing = { input: 15, input_cache_read: 1.5, input_cache_write: 18.75, input_cache_write_1h: 30, output: 75 };

const OPUS_46_47_TIER: ModelPricing = { ...OPUS_TIER, tiers: { fast: { input: 30, input_cache_read: 3, input_cache_write: 37.5, input_cache_write_1h: 60, output: 150 } } };
const OPUS_48_TIER: ModelPricing = { ...OPUS_TIER, tiers: { fast: { input: 10, input_cache_read: 1, input_cache_write: 12.5, input_cache_write_1h: 20, output: 50 } } };

const CLAUDE_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  // 4.6+ generation (alias is the upstream id).
  'claude-opus-4-8': OPUS_48_TIER,
  'claude-opus-4-7': OPUS_46_47_TIER,
  'claude-opus-4-6': OPUS_46_47_TIER,
  'claude-sonnet-5': SONNET_5_INTRO_TIER,
  'claude-sonnet-4-6': SONNET_TIER,
  'claude-fable-5': FABLE_TIER,
  // 4.5 generation (dated upstream id).
  'claude-sonnet-4-5-20250929': SONNET_TIER,
  'claude-opus-4-5-20251101': OPUS_TIER,
  'claude-haiku-4-5-20251001': HAIKU_TIER,
  // Pre-4.5 still served to some subscription tiers.
  'claude-opus-4-1-20250805': OPUS_LEGACY_TIER,
};

export const pricingForClaudeCodeModelKey = (modelKey: string): ModelPricing | null =>
  CLAUDE_CODE_MODEL_PRICING[modelKey] ?? null;
