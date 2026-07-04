// Per-model notional pricing for the Cursor (subscription) provider. Cursor
// bills as a flat-fee subscription, but the gateway tracks usage cost as if
// each request were billed at Cursor's own usage-based (API-pool) rates — so
// the dashboard can surface "value consumed vs. flat fee". Like every other
// provider (copilot / codex / claude-code / custom / azure / ollama), cost is
// a static per-token table applied to the request's real token counts; nothing
// is fetched from the upstream. Values are USD per million tokens.
//
// Source of truth: Cursor's published model pricing (the API-pool rates),
// https://cursor.com/docs/models-and-pricing. The table keys the model ids
// Cursor returns (which the provider records verbatim as `modelKey = model.id`,
// e.g. `claude-opus-4-8`, `gpt-5.5`, `composer-2.5`). New ids the upstream
// rolls out should be added here. Refresh procedure:
// .agents/skills/fetching-models-pricing/.

import type { ModelPricing } from '@floway-dev/protocols/common';

// Anthropic families carry a cache-write price; the 4.5+ generation shares one
// rate card per tier (Opus 4.5–4.8 = $5/$25, every Sonnet = $3/$15).
const OPUS_PRICING: ModelPricing = { input: 5, input_cache_read: 0.5, input_cache_write: 6.25, output: 25 };
const SONNET_PRICING: ModelPricing = { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 };
const HAIKU_PRICING: ModelPricing = { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 };
const FABLE_PRICING: ModelPricing = { input: 10, input_cache_read: 1, input_cache_write: 12.5, output: 50 };

// OpenAI / composer / others: Cursor lists no cache-write rate (N/A).
const GPT_5_5_PRICING: ModelPricing = { input: 5, input_cache_read: 0.5, output: 30 };
const GPT_5_4_PRICING: ModelPricing = { input: 2.5, input_cache_read: 0.25, output: 15 };
const GPT_5_4_MINI_PRICING: ModelPricing = { input: 0.75, input_cache_read: 0.075, output: 4.5 };
const GPT_5_4_NANO_PRICING: ModelPricing = { input: 0.2, input_cache_read: 0.02, output: 1.25 };
const GPT_5_2_3_PRICING: ModelPricing = { input: 1.75, input_cache_read: 0.175, output: 14 };
const GPT_5_1_PRICING: ModelPricing = { input: 1.25, input_cache_read: 0.125, output: 10 };
const GPT_5_MINI_PRICING: ModelPricing = { input: 0.25, input_cache_read: 0.025, output: 2 };

const COMPOSER_2_PRICING: ModelPricing = { input: 0.5, input_cache_read: 0.2, output: 2.5 };
const COMPOSER_1_5_PRICING: ModelPricing = { input: 3.5, input_cache_read: 0.35, output: 17.5 };
const COMPOSER_1_PRICING: ModelPricing = { input: 1.25, input_cache_read: 0.125, output: 10 };

const GEMINI_3_PRO_PRICING: ModelPricing = { input: 2, input_cache_read: 0.2, output: 12 };
const GEMINI_3_FLASH_PRICING: ModelPricing = { input: 0.5, input_cache_read: 0.05, output: 3 };
const GEMINI_3_5_FLASH_PRICING: ModelPricing = { input: 1.5, input_cache_read: 0.15, output: 9 };
const GEMINI_2_5_FLASH_PRICING: ModelPricing = { input: 0.3, input_cache_read: 0.03, output: 2.5 };

const GLM_5_2_PRICING: ModelPricing = { input: 1.4, input_cache_read: 0.26, output: 4.4 };
const GROK_4_3_PRICING: ModelPricing = { input: 1.25, input_cache_read: 0.2, output: 2.5 };
const GROK_4_20_PRICING: ModelPricing = { input: 2, input_cache_read: 0.2, output: 6 };
const GROK_BUILD_PRICING: ModelPricing = { input: 1, input_cache_read: 0.2, output: 2 };
const KIMI_K2_5_PRICING: ModelPricing = { input: 0.6, input_cache_read: 0.1, output: 3 };

// The "Auto" routing pool has its own blended rate.
const AUTO_PRICING: ModelPricing = { input: 1.25, input_cache_read: 0.25, output: 6 };

// Ordered: a more-specific variant (mini / nano / codex-mini / a dotted
// version) must precede the family base so it wins the match. Separators vary
// (`gpt-5.4-mini`, `claude-opus-4-8`), so `[._-]?` bridges dot vs hyphen.
const CURSOR_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  ['auto', AUTO_PRICING],

  // Anthropic — every Opus 4.5+ shares a rate, as does every Sonnet.
  [/^claude-opus/i, OPUS_PRICING],
  [/^claude-sonnet/i, SONNET_PRICING],
  [/^claude-haiku/i, HAIKU_PRICING],
  [/^claude-fable/i, FABLE_PRICING],

  // OpenAI GPT-5 line. Nano/mini before the base; dotted versions before
  // families; codex-mini before the rest of the 5.1 line.
  [/^gpt-5[._-]?5/i, GPT_5_5_PRICING],
  [/^gpt-5[._-]?4-nano/i, GPT_5_4_NANO_PRICING],
  [/^gpt-5[._-]?4-mini/i, GPT_5_4_MINI_PRICING],
  [/^gpt-5[._-]?4/i, GPT_5_4_PRICING],
  [/^gpt-5[._-]?3/i, GPT_5_2_3_PRICING],
  [/^gpt-5[._-]?2/i, GPT_5_2_3_PRICING],
  [/^gpt-5[._-]?1-codex-mini/i, GPT_5_MINI_PRICING],
  [/^gpt-5[._-]?1/i, GPT_5_1_PRICING],
  [/^gpt-5-mini/i, GPT_5_MINI_PRICING],
  [/^gpt-5-codex/i, GPT_5_1_PRICING],
  [/^gpt-5$/i, GPT_5_1_PRICING],

  // Cursor's own composer family.
  [/^composer-1[._-]?5/i, COMPOSER_1_5_PRICING],
  [/^composer-1/i, COMPOSER_1_PRICING],
  [/^composer/i, COMPOSER_2_PRICING],

  // Google Gemini.
  [/^gemini-3[._-]?5-flash/i, GEMINI_3_5_FLASH_PRICING],
  [/^gemini-3[._-]?1-pro/i, GEMINI_3_PRO_PRICING],
  [/^gemini-3-pro/i, GEMINI_3_PRO_PRICING],
  [/^gemini-3-flash/i, GEMINI_3_FLASH_PRICING],
  [/^gemini-2[._-]?5-flash/i, GEMINI_2_5_FLASH_PRICING],

  // Other vendors Cursor exposes.
  [/^glm-5[._-]?2/i, GLM_5_2_PRICING],
  [/^grok-4[._-]?20/i, GROK_4_20_PRICING],
  [/^grok-4[._-]?3/i, GROK_4_3_PRICING],
  [/^grok-build/i, GROK_BUILD_PRICING],
  [/^kimi/i, KIMI_K2_5_PRICING],
];

export const pricingForCursorModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CURSOR_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
