// Per-public-model pricing table used by the Copilot provider. Keys target
// the public model id that survives Claude variant merging (e.g.
// `claude-opus-4-7`, `gpt-5.4`). Every entry carries explicit
// USD-per-million-token rates for its selector coordinate.
//
// Source of truth for Copilot pricing updates:
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// After changing this table, run the unit-price backfill for existing rows.
// Refresh procedure: .agents/skills/fetching-models-pricing/.
import { modelPricing, tokenBasePricing, tokenPricingEntry, type ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  ['claude-opus-4-5', tokenBasePricing({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' })],
  // Anthropic public Fast Mode pricing is 6× base for Opus 4.6 / 4.7.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  [/^claude-opus-4-[67]$/, modelPricing(
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }),
    tokenPricingEntry({ input_tokens: '30', input_cache_read_tokens: '3', input_cache_write_tokens: '37.5', output_tokens: '150' }, { serviceTier: 'fast' }),
  )],
  ['claude-opus-4-8', modelPricing(
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }),
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }, { serviceTier: 'fast' }),
  )],
  // Opus 5 lists at Opus 4.8 rates; Copilot bills it at provider API list price.
  // https://github.blog/changelog/2026-07-24-claude-opus-5-is-now-available-in-github-copilot/
  ['claude-opus-5', modelPricing(
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', input_cache_write_tokens: '6.25', output_tokens: '25' }),
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }, { serviceTier: 'fast' }),
  )],
  ['claude-sonnet-5', tokenBasePricing({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '10' })],
  [/^claude-sonnet-4(-[56])?$/, tokenBasePricing({ input_tokens: '3', input_cache_read_tokens: '0.3', input_cache_write_tokens: '3.75', output_tokens: '15' })],
  ['claude-haiku-4-5', tokenBasePricing({ input_tokens: '1', input_cache_read_tokens: '0.1', input_cache_write_tokens: '1.25', output_tokens: '5' })],
  // Two Copilot accounts began returning GPT-6 Astra on 2026-09-05 and served
  // a real `/responses` request as `model: "gpt-6-astra"` with
  // `service_tier: "default"`. Their catalogs quote exactly OpenAI's standard
  // short/long rates and publish no sibling raw variant, so Copilot gets those
  // two bands only — adding the priority or flex lanes here would claim a
  // GitHub path neither catalog exposes. models.dev has no Astra row yet.
  // https://developers.openai.com/api/docs/models/gpt-6-astra
  // https://openai.com/index/gpt-6-astra/
  ['gpt-6-astra', modelPricing(
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', input_cache_write_tokens: '12.5', output_tokens: '50' }),
    tokenPricingEntry({ input_tokens: '20', input_cache_read_tokens: '2', input_cache_write_tokens: '25', output_tokens: '75' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // GPT-5.6 Sol, and the lane Copilot publishes as the separate raw variant
  // `gpt-5.6-sol-fast` and this table reaches through the merged public id.
  // Rates are OpenAI's published ones for the tier each lane is served at, in
  // keeping with the rest of this table: it records what the same request
  // would have cost at the vendor, not what GitHub charges for it — `gpt-4.1`
  // is quoted here at OpenAI's $2/$0.50/$8 while Copilot serves it for zero.
  //
  // Which lane is which comes from Copilot's own catalog, which quotes models
  // in credits per million tokens (microsoft/vscode names the unit in
  // `agentModelPricing.ts`). Sol is quoted at 200/20/250/1000 and the `-fast`
  // variant at exactly double, and the variant's response reports
  // `service_tier: "priority"` — so the suffixed id is Sol's accelerated
  // lane, which OpenAI sells as Fast mode, and not a second model.
  // https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/0b2318a699fb140b7e568228e05d3212c9f095dc/providers/openai/models/gpt-5.6-sol.toml
  ['gpt-5.6-sol', modelPricing(
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '20' }),
    tokenPricingEntry({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '30' }, { inputTokens: { operator: 'gt', value: 272000 } }),
    tokenPricingEntry({ input_tokens: '8', input_cache_read_tokens: '0.8', input_cache_write_tokens: '10', output_tokens: '40' }, { serviceTier: 'priority' }),
    tokenPricingEntry({ input_tokens: '16', input_cache_read_tokens: '1.6', input_cache_write_tokens: '20', output_tokens: '60' }, { serviceTier: 'priority', inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // Terra and Luna at OpenAI's current standard rates; the values they
  // replace were the launch card OpenAI has since cut, Luna's by a factor of
  // five. Neither publishes a `-fast` sibling in Copilot's catalog, so
  // neither has an accelerated lane to price. Luna is also the one place
  // where Copilot and OpenAI disagree on the long-context boundary rather
  // than the rate — Copilot caps Luna's default band at 200k where OpenAI's
  // card steps every GPT-5.6 model at 272k — and the threshold here follows
  // the rate card it prices against.
  // https://platform.openai.com/docs/pricing
  // https://github.com/sst/models.dev/blob/9b6e58f1e296f12af4d06a04bb216dcf73baba5a/providers/openai/models/gpt-5.6-terra.toml
  ['gpt-5.6-terra', modelPricing(
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', input_cache_write_tokens: '2.5', output_tokens: '12' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', input_cache_write_tokens: '5', output_tokens: '18' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.6-luna', modelPricing(
    tokenPricingEntry({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '1.2' }),
    tokenPricingEntry({ input_tokens: '0.4', input_cache_read_tokens: '0.04', input_cache_write_tokens: '0.5', output_tokens: '1.8' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  // Copilot's live catalog exposes a 1.05M context window for GPT-5.5/5.4;
  // OpenAI reprices the whole request above 272k input tokens.
  // https://web.archive.org/web/20260709205359/https://platform.openai.com/docs/pricing
  ['gpt-5.5', modelPricing(
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '30' }),
    tokenPricingEntry({ input_tokens: '10', input_cache_read_tokens: '1', output_tokens: '45' }, { inputTokens: { operator: 'gt', value: 272000 } }),
  )],
  ['gpt-5.4', modelPricing(
    tokenPricingEntry({ input_tokens: '2.5', input_cache_read_tokens: '0.25', output_tokens: '15' }),
    tokenPricingEntry({ input_tokens: '5', input_cache_read_tokens: '0.5', output_tokens: '22.5' }, { inputTokens: { operator: 'gt', value: 272000 } }),
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
  ['gemini-3.1-pro-preview', modelPricing(
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.2', output_tokens: '12' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.4', output_tokens: '18' }, { inputTokens: { operator: 'gt', value: 200000 } }),
  )],
  ['gemini-3.5-flash', tokenBasePricing({ input_tokens: '1.5', input_cache_read_tokens: '0.15', output_tokens: '9' })],
  // Gemini 3.6, 3.7 and 3.8 Flash share one promotional rate card, halved
  // from the standard $1.50/$0.15/$7.50 through 2026-12-31 and reverting on
  // 2027-01-01 — recheck the trio after that date. All three are among the
  // Gemini 3 models Google excludes from the >200k tier: the Vertex table
  // lists identical rates in both columns, and Copilot's catalog quotes one
  // band whose `long_context` repeats the default. Gemini 3.8 Flash reached
  // GA on 2026-09-02 with this stable id; two Copilot accounts returned the
  // same 1,048,576-token capability and rate metadata.
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
  // https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
  // https://github.com/github/docs/blob/f067ad0f9840f1b4afb5a801a77f74ef70951189/data/tables/copilot/model-release-status.yml
  // https://cloud.google.com/vertex-ai/generative-ai/pricing
  [/^gemini-3\.[678]-flash$/, tokenBasePricing({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '3.75' })],
  // xAI reprices the whole request at 2× once the prompt reaches 200k tokens.
  // Cached-read is xAI's own published $0.30/$0.60; Copilot's catalog and
  // LiteLLM both carry $0.50/$1.00 for that metric, which the vendor contradicts.
  // https://web.archive.org/web/20260801110442/https://docs.x.ai/developers/pricing
  ['grok-4.5', modelPricing(
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.3', output_tokens: '6' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '0.6', output_tokens: '12' }, { inputTokens: { operator: 'gte', value: 200000 } }),
  )],
  // Grok 4.6 keeps 4.5's input and output rates and charges more for cached
  // reads. Here xAI, Copilot's catalog and models.dev all publish the same
  // $0.50/$1.00, so this entry carries no counterpart to the cached-read
  // conflict recorded on 4.5 above.
  ['grok-4.6', modelPricing(
    tokenPricingEntry({ input_tokens: '2', input_cache_read_tokens: '0.5', output_tokens: '6' }),
    tokenPricingEntry({ input_tokens: '4', input_cache_read_tokens: '1', output_tokens: '12' }, { inputTokens: { operator: 'gte', value: 200000 } }),
  )],
  [/^grok-code-fast/, tokenBasePricing({ input_tokens: '0.2', output_tokens: '1.5' })],
  ['goldeneye', tokenBasePricing({ input_tokens: '1.25', input_cache_read_tokens: '0.125', output_tokens: '10' })],
  ['raptor-mini', tokenBasePricing({ input_tokens: '0.25', input_cache_read_tokens: '0.025', output_tokens: '2' })],
  ['minimax-m2.5', tokenBasePricing({ input_tokens: '0.3', output_tokens: '1.2' })],
  // Microsoft sells no MAI-Code API, so Copilot's own catalog quote is the
  // only rate surface either of these has; the 1-Flash entry below already
  // reflects it. Unlike its predecessor, 1.1-Flash quotes a cache-write rate.
  // https://github.com/microsoft/vscode/blob/5582533430f001c356c9eb45d2de5faae08e7481/src/vs/platform/agentHost/common/agentModelPricing.ts
  ['mai-code-1.1-flash', tokenBasePricing({ input_tokens: '0.2', input_cache_read_tokens: '0.02', input_cache_write_tokens: '0.25', output_tokens: '1.2' })],
  [/^mai-code-1-flash/, tokenBasePricing({ input_tokens: '0.75', input_cache_read_tokens: '0.075', output_tokens: '4.5' })],
  [/^text-embedding-3-small/, tokenBasePricing({ input_tokens: '0.02', output_tokens: '0' })],
  ['text-embedding-ada-002', tokenBasePricing({ input_tokens: '0.1', output_tokens: '0' })],
  // No rule for `trajectory-compaction`, and none is coming: Copilot quotes
  // its internal compaction helper at zero, but this table records vendor
  // rates rather than Copilot's charges — the same reason `gpt-4.1` above
  // carries OpenAI's price and not the zero Copilot bills for it — and no
  // vendor sells that model.
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
