// Per-public-model pricing for the Claude Code (Claude.ai subscription)
// provider. Values are notional USD per million tokens at Anthropic's public
// API rates, so an operator can compare subscription value with direct spend.
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
// https://docs.claude.com/en/docs/about-claude/pricing
//
// Prompt-cache writes are input × 1.25 (5-minute) and × 2 (1-hour). Reads are
// normally × 0.1, with model-specific reductions to × 0.05 on Opus 5.5 and
// × 0.025 on Fable 5.1. Fast mode is an explicit `serviceTier: 'fast'` entry
// whose cache rates are recorded with the same multiplier as token I/O.
//
// Refresh procedure: .agents/skills/fetching-models-pricing/.

import { modelPricing, tokenBasePricing, tokenPricingEntry, type ModelPricing, type PriceVector } from '@floway-dev/protocols/common';

const fastPricing = (rates: PriceVector, fastRates: PriceVector): ModelPricing =>
  modelPricing(tokenPricingEntry(rates), tokenPricingEntry(fastRates, { serviceTier: 'fast' }));

const OPUS_RATES = { input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', input_cache_write_1h_tokens: '10', output_tokens: '25' };
const SONNET_PRICING = tokenBasePricing({ input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3.75', input_cache_write_1h_tokens: '6', output_tokens: '15' });
// Sonnet 5 entered at a rate below the rest of the Sonnet line and kept it
// past the 2026-08-31 date it was first announced under; Anthropic's card now
// lists these as its standard rates.
const SONNET_5_PRICING = tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', input_cache_write_1h_tokens: '4', output_tokens: '10' });
const OPUS_PRICING = tokenBasePricing(OPUS_RATES);
const OPUS_FAST6X_PRICING = fastPricing(OPUS_RATES, { input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', input_cache_write_1h_tokens: '60', output_tokens: '150' });
const OPUS_FAST2X_PRICING = fastPricing(OPUS_RATES, { input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' });
const OPUS_5_5_PRICING = fastPricing(
  { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '5', input_cache_write_1h_tokens: '8', output_tokens: '20' },
  { input_tokens: '8', input_cache_read_tokens: '0.4', input_cache_write_tokens: '10', input_cache_write_1h_tokens: '16', output_tokens: '40' },
);
const FABLE_5_1_PRICING = tokenBasePricing({ input_tokens: '10', input_cache_read_tokens: '0.25', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' });

const CLAUDE_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  // https://platform.claude.com/docs/en/models/opus-5-5/overview
  // https://platform.claude.com/docs/en/about-claude/pricing
  // https://github.com/anomalyco/models.dev/blob/1ba7a9dff9a2be54e824d7211475b8d9d3b4c5de/providers/anthropic/models/claude-opus-5-5.toml
  'claude-opus-5-5': OPUS_5_5_PRICING,
  'claude-opus-5': OPUS_FAST2X_PRICING,
  'claude-opus-4-8': OPUS_FAST2X_PRICING,
  'claude-opus-4-7': OPUS_FAST6X_PRICING,
  'claude-opus-4-6': OPUS_FAST6X_PRICING,
  'claude-sonnet-5': SONNET_5_PRICING,
  'claude-sonnet-4-6': SONNET_PRICING,
  // Fable 5.1 keeps Fable 5's base rates while cutting cache reads to 0.025×.
  // https://platform.claude.com/docs/en/models/fable-5-1/overview
  // https://platform.claude.com/docs/en/about-claude/pricing
  // https://github.com/anomalyco/models.dev/blob/bf06cd2a3ae2922acd435ddc441ca5874f93ee8a/providers/anthropic/models/claude-fable-5-1.toml
  'claude-fable-5-1': FABLE_5_1_PRICING,
  'claude-fable-5': tokenBasePricing({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' }),
  'claude-sonnet-4-5-20250929': SONNET_PRICING,
  'claude-opus-4-5-20251101': OPUS_PRICING,
  'claude-haiku-4-5-20251001': tokenBasePricing({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', input_cache_write_1h_tokens: '2', output_tokens: '5' }),
  'claude-opus-4-1-20250805': tokenBasePricing({ input_tokens: '15', input_cache_read_tokens: '1.5', input_cache_write_tokens: '18.75', input_cache_write_1h_tokens: '30', output_tokens: '75' }),
};

export const pricingForClaudeCodeModelKey = (modelKey: string): ModelPricing | null =>
  CLAUDE_CODE_MODEL_PRICING[modelKey] ?? null;
