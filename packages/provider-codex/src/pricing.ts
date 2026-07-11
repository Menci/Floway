// Per-public-model pricing table for the Codex (ChatGPT subscription)
// provider. Codex itself bills as a flat-fee subscription rather than per-token,
// but Floway tracks usage cost as if the operator were paying OpenAI's public
// API rates. Values are USD per million tokens.
//
// Sources and refresh procedure:
// https://developers.openai.com/api/docs/pricing
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
// .agents/skills/fetching-models-pricing/

import type { ModelPricing, PriceVector, PricingSelector } from '@floway-dev/protocols/common';

const cell = (rates: PriceVector, selector?: PricingSelector) => ({ ...(selector ? { selector } : {}), rates });
const pricing = (...cells: ReturnType<typeof cell>[]): ModelPricing => ({ cells });

const GPT_5_4_PRICING = pricing(
  cell({ input: 2.5, input_cache_read: 0.25, output: 15 }),
  cell({ input: 1.25, input_cache_read: 0.13, output: 7.5 }, { serviceTier: 'flex' }),
  cell({ input: 5, input_cache_read: 0.5, output: 30 }, { serviceTier: 'priority' }),
);

const CODEX_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  // GPT-5.6 is an explicit standard/priority × short/long grid. Standard
  // short/long values agree across the OpenAI pricing archive, models.dev and
  // LiteLLM. Priority-short agrees between models.dev's fast mode and
  // LiteLLM's `_priority` keys. Priority-long input/cache-read/output use
  // LiteLLM's `_above_272k_tokens_priority` entries; cache-write is explicitly
  // recorded as 1.25 × that cell's published input rate, following OpenAI's
  // family-wide cache-write formula. These are authored constants, not rates
  // derived by the resolver.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/6dfc39c81b6cd57a91c155aa7b4f68ed1b360da0/providers/openai/models/gpt-5.6-sol.toml
  // https://github.com/BerriAI/litellm/blob/6fa088224bc2022c7541ee44cf02c0bd6dd2942e/model_prices_and_context_window.json
  // https://github.com/openai/codex/blob/d2d00b6632dc991aa4471db0529773029cae5d68/codex-rs/models-manager/models.json
  // Cross-check only:
  // https://github.com/caozhiyuan/copilot-api/blob/5a28eee7ced4fda51b6b224fb8723df5e6534708/src/lib/token-usage/pricing.ts#L98-L148
  ['gpt-5.6-sol', pricing(
    cell({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 }),
    cell({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 60 }, { serviceTier: 'priority' }),
    cell({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }, { inputAboveTokens: 272000 }),
    cell({ input: 20, input_cache_read: 2, input_cache_write: 25, output: 90 }, { serviceTier: 'priority', inputAboveTokens: 272000 }),
  )],
  ['gpt-5.6-terra', pricing(
    cell({ input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 }),
    cell({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 }, { serviceTier: 'priority' }),
    cell({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 }, { inputAboveTokens: 272000 }),
    cell({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }, { serviceTier: 'priority', inputAboveTokens: 272000 }),
  )],
  ['gpt-5.6-luna', pricing(
    cell({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 }),
    cell({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 12 }, { serviceTier: 'priority' }),
    cell({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 }, { inputAboveTokens: 272000 }),
    cell({ input: 4, input_cache_read: 0.4, input_cache_write: 5, output: 18 }, { serviceTier: 'priority', inputAboveTokens: 272000 }),
  )],
  ['gpt-5.5', pricing(
    cell({ input: 5, input_cache_read: 0.5, output: 30 }),
    cell({ input: 2.5, input_cache_read: 0.25, output: 15 }, { serviceTier: 'flex' }),
    cell({ input: 12.5, input_cache_read: 1.25, output: 75 }, { serviceTier: 'priority' }),
  )],
  ['gpt-5.4', GPT_5_4_PRICING],
  ['gpt-5.4-mini', pricing(
    cell({ input: 0.75, input_cache_read: 0.075, output: 4.5 }),
    cell({ input: 0.375, input_cache_read: 0.0375, output: 2.25 }, { serviceTier: 'flex' }),
    cell({ input: 1.5, input_cache_read: 0.15, output: 9 }, { serviceTier: 'priority' }),
  )],
  // No public price surface; notional clone of gpt-5.4.
  ['codex-auto-review', GPT_5_4_PRICING],
];

export const pricingForCodexModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, modelPricing] of CODEX_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) return modelPricing;
  }
  return null;
};
