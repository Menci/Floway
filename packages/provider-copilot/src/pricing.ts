// Per-public-model pricing table used by the Copilot provider. Keys target
// the public model id that survives Claude variant merging (e.g.
// `claude-opus-4-7`, `gpt-5.4`). `pricingForCopilotModelKey` strips raw-id
// variant suffixes (`-high`, `-xhigh`, `-1m`, `-1m-internal`, trailing date)
// using the same rules as `copilotPublicModelId` in model-name.ts so it can be
// fed the modelKey persisted in `usage.model_key`. Every entry carries
// explicit USD-per-million-token rates for its selector coordinate.
//
// Source of truth for Copilot pricing updates:
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// After changing this table, run the unit-price backfill for existing rows.
// Refresh procedure: .agents/skills/fetching-models-pricing/.
import { copilotPublicModelId } from './model-name.ts';
import { tokenBasePricing, tokenModelPricing, tokenPricingEntry as pricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  ['claude-opus-4-5', tokenBasePricing({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' })],
  // Anthropic public Fast Mode pricing is 6× base for Opus 4.6 / 4.7.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  [/^claude-opus-4-[67]$/, tokenModelPricing(
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }),
    pricingEntry({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }, { serviceTier: 'fast' }),
  )],
  ['claude-opus-4-8', tokenModelPricing(
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }),
    pricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }, { serviceTier: 'fast' }),
  )],
  ['claude-sonnet-5', tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '10' })],
  [/^claude-sonnet-4(-[56])?$/, tokenBasePricing({ input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3.75', output_tokens: '15' })],
  ['claude-haiku-4-5', tokenBasePricing({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', output_tokens: '5' })],
  // GPT-5.6 standard short/long entries. Copilot exposes no priority/flex lane.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/6dfc39c81b6cd57a91c155aa7b4f68ed1b360da0/providers/openai/models/gpt-5.6-sol.toml
  // https://github.com/BerriAI/litellm/blob/6fa088224bc2022c7541ee44cf02c0bd6dd2942e/model_prices_and_context_window.json
  // Cross-check only:
  // https://github.com/caozhiyuan/copilot-api/blob/5a28eee7ced4fda51b6b224fb8723df5e6534708/src/lib/token-usage/pricing.ts#L98-L148
  ['gpt-5.6-sol', tokenModelPricing(
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '30' }),
    pricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '45' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-terra', tokenModelPricing(
    pricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.125', output_tokens: '15' }),
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '22.5' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-luna', tokenModelPricing(
    pricingEntry({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', output_tokens: '6' }),
    pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '9' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // Copilot's live catalog exposes a 1.05M context window for GPT-5.5/5.4;
  // OpenAI reprices the whole request above 272k input tokens.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  ['gpt-5.5', tokenModelPricing(
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '30' }),
    pricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', output_tokens: '45' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.4', tokenModelPricing(
    pricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }),
    pricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.4-mini', tokenBasePricing({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' })],
  ['gpt-5.4-nano', tokenBasePricing({ input_tokens: '0.2', input_cache_read_tokens: '0.02', output_tokens: '1.25' })],
  [/^gpt-5[.][23](-codex)?$/, tokenBasePricing({ input_tokens: '1.75', input_cache_read_tokens: '0.175', output_tokens: '14' })],
  ['gpt-5.1-codex-mini', tokenBasePricing({ input_tokens: '0.25', input_cache_read_tokens: '0.025', output_tokens: '2' })],
  [/^gpt-5[.]1/, tokenBasePricing({ input_tokens: '1.25', input_cache_read_tokens: '0.125', output_tokens: '10' })],
  ['gpt-5-mini', tokenBasePricing({ input_tokens: '0.25', input_cache_read_tokens: '0.025', output_tokens: '2' })],
  [/^gpt-4[.]1/, tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.5', output_tokens: '8' })],
  ['gpt-41-copilot', tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.5', output_tokens: '8' })],
  [/^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, tokenBasePricing({ input_tokens: '2.5', input_cache_read_tokens: '1.25', output_tokens: '10' })],
  ['gpt-4-o-preview', tokenBasePricing({ input_tokens: '2.5', input_cache_read_tokens: '1.25', output_tokens: '10' })],
  [/^gpt-4o-mini/, tokenBasePricing({ input_tokens: '0.15', input_cache_read_tokens: '0.075', output_tokens: '0.6' })],
  [/^gpt-4(-0613)?$/, tokenBasePricing({ input_tokens: '30', output_tokens: '60' })],
  ['gpt-4-0125-preview', tokenBasePricing({ input_tokens: '10', output_tokens: '30' })],
  ['gpt-3.5-turbo', tokenBasePricing({ input_tokens: '0.5', output_tokens: '1.5' })],
  ['gpt-3.5-turbo-0613', tokenBasePricing({ input_tokens: '1.5', output_tokens: '2' })],
  // Google charges higher whole-request rates above 200k input tokens.
  // https://ai.google.dev/gemini-api/docs/pricing
  // https://github.com/sst/models.dev/blob/6dfc39c81b6cd57a91c155aa7b4f68ed1b360da0/providers/google/models/gemini-3.1-pro-preview.toml
  ['gemini-2.5-pro', tokenBasePricing({ input_tokens: '1.25', input_cache_read_tokens: '0.125', output_tokens: '10' })],
  ['gemini-3-flash-preview', tokenBasePricing({ input_tokens: '0.5', input_cache_read_tokens: '0.05', output_tokens: '3' })],
  ['gemini-3.1-pro-preview', tokenModelPricing(
    pricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '12' }),
    pricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', output_tokens: '18' }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],
  ['gemini-3.5-flash', tokenBasePricing({ input_tokens: '1.5', input_cache_read_tokens: '0.15', output_tokens: '9' })],
  [/^grok-code-fast/, tokenBasePricing({ input_tokens: '0.2', output_tokens: '1.5' })],
  ['goldeneye', tokenBasePricing({ input_tokens: '1.25', input_cache_read_tokens: '0.125', output_tokens: '10' })],
  ['raptor-mini', tokenBasePricing({ input_tokens: '0.25', input_cache_read_tokens: '0.025', output_tokens: '2' })],
  ['minimax-m2.5', tokenBasePricing({ input_tokens: '0.3', output_tokens: '1.2' })],
  [/^mai-code-1-flash/, tokenBasePricing({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' })],
  [/^text-embedding-3-small/, tokenBasePricing({ input_tokens: '0.02', output_tokens: '0' })],
  ['text-embedding-ada-002', tokenBasePricing({ input_tokens: '0.1', output_tokens: '0' })],
];

const matchPricing = (publicName: string): ModelPricing | null => {
  for (const [key, pricing] of COPILOT_MODEL_PRICING) {
    if (typeof key === 'string' ? publicName === key : key.test(publicName)) {
      return pricing;
    }
  }
  return null;
};

// Lookup by post-variant-merge public id (e.g. `claude-opus-4-7`).
export const pricingForCopilotPublicModelId = (publicName: string): ModelPricing | null => matchPricing(publicName);

// Lookup by raw upstream model id (e.g. `claude-opus-4-7-xhigh`,
// `claude-opus-4-5-20251101`). Variant suffix and date are stripped to derive
// the public id, then matched against the table.
export const pricingForCopilotModelKey = (modelKey: string): ModelPricing | null => matchPricing(copilotPublicModelId(modelKey));
