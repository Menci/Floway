import { test } from 'vitest';

import { withReferencePricing } from '../../../src/data-plane/providers/reference-pricing.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { pricingForClaudeCodeModelKey } from '@floway-dev/provider-claude-code';
import { pricingForCodexModelKey } from '@floway-dev/provider-codex';
import { pricingForCopilotPublicModelId } from '@floway-dev/provider-copilot';
import { pricingForOllamaModelKey } from '@floway-dev/provider-ollama';
import { assertEquals, assertExists, stubProviderModel } from '@floway-dev/test-utils';

test.each([undefined, false, true])('reference pricing is opt-in, matches upstream ids and preserves existing prices (%s)', enabled => {
  const manualPricing: ModelPricing = { entries: [{ rates: { input_tokens: '0' } }] };
  const upstreamPricing: ModelPricing = { entries: [{ rates: { input_tokens: '0.000001' } }] };
  const references = [
    ['gpt-5.4', pricingForCodexModelKey('gpt-5.4')],
    ['claude-opus-4-6', pricingForClaudeCodeModelKey('claude-opus-4-6')],
    ['gemini-2.5-pro', pricingForCopilotPublicModelId('gemini-2.5-pro')],
    ['deepseek-v4-pro', pricingForOllamaModelKey('deepseek-v4-pro')],
  ] as const;
  const models = [
    ...references.map(([upstreamModelId]) => stubProviderModel({ upstreamModelId, id: `alias-${upstreamModelId}` })),
    stubProviderModel({ upstreamModelId: 'gpt-5.4-mini', pricing: upstreamPricing }),
    stubProviderModel({ upstreamModelId: 'gpt-5.5', pricing: manualPricing }),
    stubProviderModel({ upstreamModelId: 'unknown-model', id: 'gpt-5.4' }),
  ];
  for (const [, pricing] of references) assertExists(pricing);

  assertEquals(withReferencePricing(models, enabled).map(model => model.pricing), [
    ...references.map(([, pricing]) => enabled ? pricing : undefined),
    upstreamPricing,
    manualPricing,
    undefined,
  ]);
  assertEquals(models[0].pricing, undefined);
});
