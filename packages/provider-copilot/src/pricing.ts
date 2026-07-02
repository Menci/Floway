// Per-public-model pricing table used by the Copilot provider. Keys target
// the public model id that survives Claude variant merging (e.g.
// `claude-opus-4-7`, `gpt-5.4`). `pricingForCopilotModelKey` strips raw-id
// variant suffixes (`-high`, `-xhigh`, `-1m`, `-1m-internal`, trailing date)
// using the same rules as `copilotPublicModelId` in model-name.ts so it can be
// fed the modelKey persisted in `usage.model_key`. Values are USD per million
// tokens, aligned with sst/models.dev `Cost`:
// https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts
//
// Source of truth for Copilot pricing updates:
// https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
// This table is the single source of truth going forward; edit it here when
// pricing changes. migrations/0011_usage_cost_snapshot.sql holds a frozen
// snapshot for one-shot historical cleanup and is deliberately not kept in
// sync — historical rows for newly-priced models are recovered by re-running
// the cost backfill against live D1, not by editing that migration.
//
// Refresh procedure: .agents/skills/fetching-models-pricing/.
import { copilotPublicModelId } from './model-name.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const COPILOT_MODEL_PRICING: readonly PricingRule[] = [
  // Opus 4.5 — no Fast Mode variant exposed by Copilot.
  [
    'claude-opus-4-5',
    {
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      output: 25,
    },
  ],
  // Opus 4.6 / 4.7 — Anthropic public Fast Mode pricing is 6× base.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  [
    /^claude-opus-4-[67]$/,
    {
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      output: 25,
      tiers: {
        fast: {
          input: 30,
          input_cache_read: 3,
          input_cache_write: 37.5,
          output: 150,
        },
      },
    },
  ],
  // Opus 4.8 — Anthropic public Fast Mode pricing is 2× base.
  [
    'claude-opus-4-8',
    {
      input: 5,
      input_cache_read: 0.5,
      input_cache_write: 6.25,
      output: 25,
      tiers: {
        fast: {
          input: 10,
          input_cache_read: 1,
          input_cache_write: 12.5,
          output: 50,
        },
      },
    },
  ],
  // Sonnet 5 — Anthropic introductory pricing through 2026-08-31; sticker is
  // $3/$15 (same as Sonnet 4 family) afterwards. Cross-checked against
  // OpenRouter (openrouter.ai/api/v1/models) and models.dev, both mirroring
  // Anthropic's live rate.
  [
    'claude-sonnet-5',
    {
      input: 2,
      input_cache_read: 0.2,
      input_cache_write: 2.5,
      output: 10,
    },
  ],
  [
    /^claude-sonnet-4(-[56])?$/,
    {
      input: 3,
      input_cache_read: 0.3,
      input_cache_write: 3.75,
      output: 15,
    },
  ],
  [
    'claude-haiku-4-5',
    {
      input: 1,
      input_cache_read: 0.1,
      input_cache_write: 1.25,
      output: 5,
    },
  ],
  ['gpt-5.5', { input: 5, input_cache_read: 0.5, output: 30 }],
  ['gpt-5.4', { input: 2.5, input_cache_read: 0.25, output: 15 }],
  ['gpt-5.4-mini', { input: 0.75, input_cache_read: 0.075, output: 4.5 }],
  ['gpt-5.4-nano', { input: 0.2, input_cache_read: 0.02, output: 1.25 }],
  [/^gpt-5[.][23](-codex)?$/, { input: 1.75, input_cache_read: 0.175, output: 14 }],
  ['gpt-5.1-codex-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  [/^gpt-5[.]1/, { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['gpt-5-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  [/^gpt-4[.]1/, { input: 2, input_cache_read: 0.5, output: 8 }],
  ['gpt-41-copilot', { input: 2, input_cache_read: 0.5, output: 8 }],
  [
    /^gpt-4o(-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/,
    {
      input: 2.5,
      input_cache_read: 1.25,
      output: 10,
    },
  ],
  ['gpt-4-o-preview', { input: 2.5, input_cache_read: 1.25, output: 10 }],
  [/^gpt-4o-mini/, { input: 0.15, input_cache_read: 0.075, output: 0.6 }],
  [/^gpt-4(-0613)?$/, { input: 30, output: 60 }],
  ['gpt-4-0125-preview', { input: 10, output: 30 }],
  ['gpt-3.5-turbo', { input: 0.5, output: 1.5 }],
  ['gpt-3.5-turbo-0613', { input: 1.5, output: 2 }],
  ['gemini-2.5-pro', { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['gemini-3-flash-preview', { input: 0.5, input_cache_read: 0.05, output: 3 }],
  ['gemini-3.1-pro-preview', { input: 2, input_cache_read: 0.2, output: 12 }],
  ['gemini-3.5-flash', { input: 1.5, input_cache_read: 0.15, output: 9 }],
  [/^grok-code-fast/, { input: 0.2, output: 1.5 }],
  ['goldeneye', { input: 1.25, input_cache_read: 0.125, output: 10 }],
  ['raptor-mini', { input: 0.25, input_cache_read: 0.025, output: 2 }],
  ['minimax-m2.5', { input: 0.3, output: 1.2 }],
  [/^text-embedding-3-small/, { input: 0.02, output: 0 }],
  ['text-embedding-ada-002', { input: 0.1, output: 0 }],
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
