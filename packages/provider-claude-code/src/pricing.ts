// Per-public-model pricing for the Claude Code (Claude.ai subscription)
// provider. Values are notional USD per million tokens at Anthropic's public
// API rates, so an operator can compare subscription value with direct spend.
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
// https://docs.claude.com/en/docs/about-claude/pricing
//
// Prompt-cache ratios are input × 0.1 (read), × 1.25 (5-minute write), and
// × 2 (1-hour write). Fast mode is an explicit `serviceTier: 'fast'` entry for
// Opus 4.6–4.8; each entry records its own cache rates.

import { tokenBasePricing, tokenModelPricing, tokenPricingEntry as pricingEntry, type ModelPricing, type PriceVector } from '@floway-dev/protocols/common';

const fastPricing = (rates: PriceVector, fastRates: PriceVector): ModelPricing =>
  tokenModelPricing(pricingEntry(rates), pricingEntry(fastRates, { serviceTier: 'fast' }));

const OPUS_RATES = { input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', input_cache_write_1h_tokens: '10', output_tokens: '25' };
const SONNET_PRICING = tokenBasePricing({ input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3.75', input_cache_write_1h_tokens: '6', output_tokens: '15' });
// Sonnet 5 introductory pricing runs through 2026-08-31.
const SONNET_5_INTRO_PRICING = tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', input_cache_write_1h_tokens: '4', output_tokens: '10' });
const OPUS_PRICING = tokenBasePricing(OPUS_RATES);
const OPUS_46_47_PRICING = fastPricing(OPUS_RATES, { input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', input_cache_write_1h_tokens: '60', output_tokens: '150' });
const OPUS_48_PRICING = fastPricing(OPUS_RATES, { input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' });

const CLAUDE_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-8': OPUS_48_PRICING,
  'claude-opus-4-7': OPUS_46_47_PRICING,
  'claude-opus-4-6': OPUS_46_47_PRICING,
  'claude-sonnet-5': SONNET_5_INTRO_PRICING,
  'claude-sonnet-4-6': SONNET_PRICING,
  'claude-fable-5': tokenBasePricing({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', input_cache_write_1h_tokens: '20', output_tokens: '50' }),
  'claude-sonnet-4-5-20250929': SONNET_PRICING,
  'claude-opus-4-5-20251101': OPUS_PRICING,
  'claude-haiku-4-5-20251001': tokenBasePricing({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', input_cache_write_1h_tokens: '2', output_tokens: '5' }),
  'claude-opus-4-1-20250805': tokenBasePricing({ input_tokens: '15', input_cache_read_tokens: '1.5', input_cache_write_tokens: '18.75', input_cache_write_1h_tokens: '30', output_tokens: '75' }),
};

export const pricingForClaudeCodeModelKey = (modelKey: string): ModelPricing | null =>
  CLAUDE_CODE_MODEL_PRICING[modelKey] ?? null;
