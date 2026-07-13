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
import { basePricing, modelPricing, pricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  ['claude-opus-4-5', basePricing({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 })],
  // Anthropic public Fast Mode pricing is 6× base for Opus 4.6 / 4.7.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  [/^claude-opus-4-[67]$/, modelPricing(
    pricingEntry({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }),
    pricingEntry({ input: 30, input_cache_read: 3, input_cache_write: 37.5, output: 150 }, { serviceTier: 'fast' }),
  )],
  ['claude-opus-4-8', modelPricing(
    pricingEntry({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 }),
    pricingEntry({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 }, { serviceTier: 'fast' }),
  )],
  ['claude-sonnet-5', basePricing({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 10 })],
  [/^claude-sonnet-4(-[56])?$/, basePricing({ input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 })],
  ['claude-haiku-4-5', basePricing({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 })],
  // GPT-5.6 standard short/long entries. Copilot exposes no priority/flex lane.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/6dfc39c81b6cd57a91c155aa7b4f68ed1b360da0/providers/openai/models/gpt-5.6-sol.toml
  // https://github.com/BerriAI/litellm/blob/6fa088224bc2022c7541ee44cf02c0bd6dd2942e/model_prices_and_context_window.json
  // Cross-check only:
  // https://github.com/caozhiyuan/copilot-api/blob/5a28eee7ced4fda51b6b224fb8723df5e6534708/src/lib/token-usage/pricing.ts#L98-L148
  ['gpt-5.6-sol', modelPricing(
    pricingEntry({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 30 }),
    pricingEntry({ input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 45 }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-terra', modelPricing(
    pricingEntry({ input: 2.5, input_cache_read: 0.25, input_cache_write: 3.125, output: 15 }),
    pricingEntry({ input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 22.5 }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-luna', modelPricing(
    pricingEntry({ input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 6 }),
    pricingEntry({ input: 2, input_cache_read: 0.2, input_cache_write: 2.5, output: 9 }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // Copilot's live catalog exposes a 1.05M context window for GPT-5.5/5.4;
  // OpenAI reprices the whole request above 272k input tokens.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  ['gpt-5.5', modelPricing(
    pricingEntry({ input: 5, input_cache_read: 0.5, output: 30 }),
    pricingEntry({ input: 10, input_cache_read: 1, output: 45 }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.4', modelPricing(
    pricingEntry({ input: 2.5, input_cache_read: 0.25, output: 15 }),
    pricingEntry({ input: 5, input_cache_read: 0.5, output: 22.5 }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.4-mini', basePricing({ input: 0.75, input_cache_read: 0.075, output: 4.5 })],
  ['gpt-5.4-nano', basePricing({ input: 0.2, input_cache_read: 0.02, output: 1.25 })],
  [/^gpt-5[.][23](-codex)?$/, basePricing({ input: 1.75, input_cache_read: 0.175, output: 14 })],
  ['gpt-5.1-codex-mini', basePricing({ input: 0.25, input_cache_read: 0.025, output: 2 })],
  [/^gpt-5[.]1/, basePricing({ input: 1.25, input_cache_read: 0.125, output: 10 })],
  ['gpt-5-mini', basePricing({ input: 0.25, input_cache_read: 0.025, output: 2 })],
  [/^gpt-4[.]1/, basePricing({ input: 2, input_cache_read: 0.5, output: 8 })],
  ['gpt-41-copilot', basePricing({ input: 2, input_cache_read: 0.5, output: 8 })],
  [/^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/, basePricing({ input: 2.5, input_cache_read: 1.25, output: 10 })],
  ['gpt-4-o-preview', basePricing({ input: 2.5, input_cache_read: 1.25, output: 10 })],
  [/^gpt-4o-mini/, basePricing({ input: 0.15, input_cache_read: 0.075, output: 0.6 })],
  [/^gpt-4(-0613)?$/, basePricing({ input: 30, output: 60 })],
  ['gpt-4-0125-preview', basePricing({ input: 10, output: 30 })],
  ['gpt-3.5-turbo', basePricing({ input: 0.5, output: 1.5 })],
  ['gpt-3.5-turbo-0613', basePricing({ input: 1.5, output: 2 })],
  // Google charges higher whole-request rates above 200k input tokens.
  // https://ai.google.dev/gemini-api/docs/pricing
  // https://github.com/sst/models.dev/blob/6dfc39c81b6cd57a91c155aa7b4f68ed1b360da0/providers/google/models/gemini-3.1-pro-preview.toml
  ['gemini-2.5-pro', basePricing({ input: 1.25, input_cache_read: 0.125, output: 10 })],
  ['gemini-3-flash-preview', basePricing({ input: 0.5, input_cache_read: 0.05, output: 3 })],
  ['gemini-3.1-pro-preview', modelPricing(
    pricingEntry({ input: 2, input_cache_read: 0.2, output: 12 }),
    pricingEntry({ input: 4, input_cache_read: 0.4, output: 18 }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],
  ['gemini-3.5-flash', basePricing({ input: 1.5, input_cache_read: 0.15, output: 9 })],
  [/^grok-code-fast/, basePricing({ input: 0.2, output: 1.5 })],
  ['goldeneye', basePricing({ input: 1.25, input_cache_read: 0.125, output: 10 })],
  ['raptor-mini', basePricing({ input: 0.25, input_cache_read: 0.025, output: 2 })],
  ['minimax-m2.5', basePricing({ input: 0.3, output: 1.2 })],
  [/^mai-code-1-flash/, basePricing({ input: 0.75, input_cache_read: 0.075, output: 4.5 })],
  [/^text-embedding-3-small/, basePricing({ input: 0.02, output: 0 })],
  ['text-embedding-ada-002', basePricing({ input: 0.1, output: 0 })],
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
