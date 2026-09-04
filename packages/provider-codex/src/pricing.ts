// Per-public-model pricing table for the Codex (ChatGPT subscription)
// provider. Codex itself bills as a flat-fee subscription rather than per-token,
// but Floway tracks usage cost as if the operator were paying OpenAI's public
// API rates. Values are USD per million tokens.
//
// Sources and refresh procedure:
// https://developers.openai.com/api/docs/pricing
// .agents/skills/fetching-models-pricing/

import { modelPricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

const GPT_5_4_PRICING = modelPricing(
  tokenPricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }),
  tokenPricingEntry({ input_tokens: '1.25', input_cache_read_tokens: '0.13', output_tokens: '7.5' }, { serviceTier: 'flex' }),
  tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '30' }, { serviceTier: 'priority' }),
  // OpenAI's whole-request long-context rate. No flex/priority combination is
  // published, so those selector misses resolve to the whole Base vector.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }, { inputTokens: { operator: 'gt', value: 272000 } }),
);

// GPT Image 2 bills text input, image input, and image output as distinct token
// modalities. Cached input uses the published text-cache rate here; image
// responses currently report modality splits for input/output tokens but do
// not expose a modality split for cached tokens.
// https://developers.openai.com/api/docs/pricing#image-generation
export const GPT_IMAGE_2_PRICING = modelPricing(
  tokenPricingEntry({
    input_tokens: '5',
    input_cache_read_tokens: '1.25',
    input_image_tokens: '8',
    output_image_tokens: '30',
  }),
);

const CODEX_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  // Announced on 2026-09-03 and rolling out first to enterprises in OpenAI's
  // Trusted Access Program; broader API and subscription access is coming in
  // the following days. The public model card already fixes the id, limits and
  // all six rate coordinates, so the notional table can price it before this
  // account's `/codex/models` catalog starts returning it. There is no
  // models.dev row to cross-check yet; OpenAI's Python SDK independently
  // recognizes the exact `gpt-6-astra` id.
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  // https://openai.com/index/gpt-6-astra/
  // https://github.com/openai/openai-python/blob/3cc8d784ad05f75a265012ee86638adaf93d8bf2/src/openai/types/shared/chat_model.py
  ['gpt-6-astra', modelPricing(
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }),
    tokenPricingEntry({ input_tokens: '20', input_cache_read_tokens: '2', input_cache_write_tokens: '25', output_tokens: '75' }, { inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '20', input_cache_read_tokens: '2', input_cache_write_tokens: '25', output_tokens: '100' }, { serviceTier: 'priority' }),
    tokenPricingEntry({ input_tokens: '40', input_cache_read_tokens: '4', input_cache_write_tokens: '50', output_tokens: '150' }, { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '37.5' }, { serviceTier: 'flex', inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // The GPT-5.6 family, refreshed from OpenAI's current card — the values
  // these replace were the launch rates, since cut across the board and by a
  // factor of five on Luna. OpenAI now publishes all four columns (standard,
  // flex, batch, fast mode) in both context bands, so the priority-long
  // combination that used to be deliberately absent is present here; flex
  // and batch quote the same numbers, and the entries carry the `flex`
  // coordinate because that is the one Codex can ask for. Priority is
  // recorded under its `priority` spelling even though OpenAI renamed the
  // lane to Fast mode on 2026-07-30, because `priority` is what responses
  // report back and therefore what billing selects on.
  // https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/0b2318a699fb140b7e568228e05d3212c9f095dc/providers/openai/models/gpt-5.6-sol.toml
  // https://github.com/openai/codex/blob/d2d00b6632dc991aa4471db0529773029cae5d68/codex-rs/models-manager/models.json
  ['gpt-5.6-sol', modelPricing(
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '20' }),
    tokenPricingEntry({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '30' }, { inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '40' }, { serviceTier: 'priority' }),
    tokenPricingEntry({ input_tokens: '16', input_cache_read_tokens: '1.6', input_cache_write_tokens: '20', output_tokens: '60' }, { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '10' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '15' }, { serviceTier: 'flex', inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-terra', modelPricing(
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '12' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '18' }, { inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '24' }, { serviceTier: 'priority' }),
    tokenPricingEntry({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '36' }, { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', output_tokens: '6' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '9' }, { serviceTier: 'flex', inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-luna', modelPricing(
    tokenPricingEntry({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '1.2' }),
    tokenPricingEntry({ input_tokens: '0.4', input_cache_read_tokens: '0.04', input_cache_write_tokens: '0.5', output_tokens: '1.8' }, { inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '0.4', input_cache_read_tokens: '0.04', input_cache_write_tokens: '0.5', output_tokens: '2.4' }, { serviceTier: 'priority' }),
    tokenPricingEntry({ input_tokens: '0.8', input_cache_read_tokens: '0.08', input_cache_write_tokens: '1', output_tokens: '3.6' }, { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '0.1', input_cache_read_tokens: '0.01', input_cache_write_tokens: '0.125', output_tokens: '0.6' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '0.9' }, { serviceTier: 'flex', inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // Codex's own model, absent from this table until now. OpenAI lists it in
  // the specialized-models card with a Fast mode column at double the
  // standard rates and no long-context band.
  // https://platform.openai.com/docs/pricing
  ['gpt-5.3-codex', modelPricing(
    tokenPricingEntry({ input_tokens: '1.75', input_cache_read_tokens: '0.175', output_tokens: '14' }),
    tokenPricingEntry({ input_tokens: '3.5', input_cache_read_tokens: '0.35', output_tokens: '28' }, { serviceTier: 'priority' }),
  )],
  ['gpt-5.5', modelPricing(
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '30' }),
    tokenPricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '12.5', input_cache_read_tokens: '1.25', output_tokens: '75' }, { serviceTier: 'priority' }),
  )],
  ['gpt-5.4', GPT_5_4_PRICING],
  ['gpt-5.4-mini', modelPricing(
    tokenPricingEntry({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' }),
    tokenPricingEntry({ input_tokens: '0.375', input_cache_read_tokens: '0.0375', output_tokens: '2.25' }, { serviceTier: 'flex' }),
    tokenPricingEntry({ input_tokens: '1.5', input_cache_read_tokens: '0.15', output_tokens: '9' }, { serviceTier: 'priority' }),
  )],
  // No public price surface; notional clone of gpt-5.4.
  ['codex-auto-review', GPT_5_4_PRICING],
];

export const pricingForCodexModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CODEX_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) return pricing;
  }
  return null;
};
