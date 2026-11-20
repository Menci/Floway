// Notional USD per million tokens for comparing subscription value with direct
// API spend. Published API prices and estimates are identified below.
// Public ids own pricing: kimi-for-coding is K2.8 Preview, whereas its
// -highspeed sibling is K2.7 Code, so raw channel ids cannot identify a card.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// Refresh procedure: .agents/skills/fetching-models-pricing/.
import { modelPricing, tokenPricingEntry, type ModelPricing, type PriceVector } from '@floway-dev/protocols/common';

const fastPricing = (rates: PriceVector, fastRates: PriceVector): ModelPricing => modelPricing(
  tokenPricingEntry(rates),
  tokenPricingEntry(fastRates, { serviceTier: 'priority' }),
  tokenPricingEntry(fastRates, { serviceTier: 'fast' }),
);

const KIMI_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  // Highspeed doubles input, output and writes; cache reads stay at $0.20.
  // https://platform.kimi.ai/docs/pricing/chat
  // https://platform.kimi.ai/
  'kimi-k3.1-pro': fastPricing(
    { input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2', input_cache_write_1h_tokens: '4', output_tokens: '10' },
    { input_tokens: '4', input_cache_read_tokens: '0.2', input_cache_write_tokens: '4', input_cache_write_1h_tokens: '8', output_tokens: '20' },
  ),
  // The API publishes no fast K3 card. The estimated fast vector doubles each
  // published standard rate to value accelerated variants when they appear.
  // https://platform.kimi.ai/docs/pricing/chat
  // https://platform.kimi.ai/docs/pricing/batch
  'kimi-k3': fastPricing(
    { input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3', input_cache_write_1h_tokens: '6', output_tokens: '15' },
    { input_tokens: '6', input_cache_read_tokens: '0.6', input_cache_write_tokens: '6', input_cache_write_1h_tokens: '12', output_tokens: '30' },
  ),
  // Code currently exposes only Highspeed for this family and requires fast
  // mode. Keep the published standard API card as Base so discovery of a
  // standard lane can use the same public identity; both protocol fast-tier
  // spellings select the actual Highspeed rate, including doubled reads.
  // The K2 price table publishes no cache-write rate.
  // https://www.kimi.com/code/docs/en/kimi-code/models.html
  // https://platform.kimi.ai/docs/pricing/chat
  // https://platform.kimi.ai/docs/pricing/batch
  'kimi-k2.7-code': fastPricing(
    { input_tokens: '0.95', input_cache_read_tokens: '0.19', output_tokens: '4' },
    { input_tokens: '1.9', input_cache_read_tokens: '0.38', output_tokens: '8' },
  ),
  // K2.8 Preview values were supplied by the operator; there is no published
  // equivalent. The estimated fast vector doubles those supplied values.
  'kimi-k2.8-preview': fastPricing(
    { input_tokens: '0.95', input_cache_read_tokens: '0.25', output_tokens: '4' },
    { input_tokens: '1.9', input_cache_read_tokens: '0.5', output_tokens: '8' },
  ),
};

// Exact keys leave identities we do not publish unpriced, such as the withheld
// context-capped variant and every raw channel id.
// https://platform.kimi.ai/docs/models
// https://platform.kimi.ai/docs/pricing/chat
export const pricingForKimiCodePublicModelId = (modelId: string): ModelPricing | null =>
  KIMI_CODE_MODEL_PRICING[modelId] ?? null;
